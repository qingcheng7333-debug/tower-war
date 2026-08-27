/* ===== network.js — VibeHub Room + Lockstep 确定性同步 =====
 *
 * VibeHub SDK v3 提供房间身份、WebRTC P2P、VibeNet 中继、presence 与自动重连。
 * 本文件只负责游戏大厅协议和 Lockstep 指令队列，不实现自建信令、心跳或后端。
 * 同步模型：lockstep（严格 1v1、固定 30Hz、同 seed + 同指令序列）。
 * 角色映射：Host = 蓝方 player；Client = 红方 ai。
 */

// ---- 联机开关与角色 ----
let NET_ENABLED = false;
let NET_ROLE = null;             // 'host' | 'client'
let NET_ROOM = null;             // VibeHub Room 实例
let NET_ROOM_ID = null;
let NET_STATE = 'idle';          // 'idle' | 'hosting' | 'joined' | 'in_game'
let NET_MY_NAME = '';
let NET_OPP_NAME = '';
let NET_MY_READY = false;
let NET_OPP_READY = false;
let NET_MY_DECK = [];
let NET_OPP_DECK = [];
let NET_SEED = 0;
let NET_MODE = 'deck';          // 'classic' 全卡 / 'deck' 卡组
let NET_RECONNECTING = false;
let NET_HELLO_TIMER = null;      // Client 端 HELLO 重发定时器
const NET_HELLO_INTERVAL_MS = 1500;   // 重发间隔
const NET_HELLO_MAX_RETRY = 20;       // 最大重发次数（约 30s）

// ---- 回调注入（main.js 绑定；未绑定时安全跳过）----
let NET_CB_ON_LOBBY = null;
let NET_CB_ON_GAME_START = null;
let NET_CB_ON_DISCONNECT = null;

// ---- Lockstep 指令队列 ----
const NET_SYNC_DELAY_TICKS = 10;   // ≈333ms 延迟缓冲
let NET_CMD_SEQ = 0;
let NET_PENDING_EXEC = [];
let NET_REMOTE_SEQ = new Set();

// ==================================================================
// 一、VibeHub Room 会话层
// ==================================================================

function getVibeClient() {
    if (typeof TowerVibeHub === 'undefined' || typeof TowerVibeHub.getClient !== 'function') return null;
    return TowerVibeHub.getClient();
}

function requireVibeClient() {
    const vibe = getVibeClient();
    if (!vibe) {
        alert('⚠️ VibeHub 尚未初始化。请在 VibeHub 作品页面中打开游戏。');
        return null;
    }
    if (!vibe.isLoggedIn()) {
        alert('⚠️ 联机模式需要先登录 VibeHub。');
        return null;
    }
    return vibe;
}

function initNetworkLayer() {
    return !!requireVibeClient();
}

/** 生成适合显示的 6 位房间号；房间实际由 VibeHub Room 原子认领。 */
function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(6);
        globalThis.crypto.getRandomValues(bytes);
        for (const b of bytes) id += chars[b % chars.length];
    } else {
        for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}

function bindNetCallbacks(cbs) {
    cbs = cbs || {};
    NET_CB_ON_LOBBY = cbs.onLobby || null;
    NET_CB_ON_GAME_START = cbs.onGameStart || null;
    NET_CB_ON_DISCONNECT = cbs.onDisconnect || null;
}

function resetSessionState() {
    NET_ENABLED = false;
    NET_STATE = 'idle';
    NET_ROLE = null;
    NET_ROOM_ID = null;
    NET_RECONNECTING = false;
    NET_MODE = 'deck';
    NET_MY_READY = false;
    NET_OPP_READY = false;
    NET_OPP_NAME = '';
    NET_OPP_DECK = [];
    NET_PENDING_EXEC = [];
    NET_REMOTE_SEQ = new Set();
    stopHelloRetry();
}

/** 创建 VibeHub 房间（Host）。 */
async function netCreateRoom(name, deck, cbs) {
    const vibe = requireVibeClient();
    if (!vibe) return false;
    bindNetCallbacks(cbs);
    cleanupNetSession(false);
    NET_ROLE = 'host';
    NET_STATE = 'hosting';
    NET_MY_NAME = name || '房主';
    NET_MODE = cbs.onlineMode === 'classic' ? 'classic' : 'deck';
    NET_MY_DECK = Array.isArray(deck) ? [...deck] : [];
    NET_ROOM_ID = generateRoomId();
    try {
        await openVibeRoom(NET_ROOM_ID);
        await NET_ROOM.announce({
            open: true,
            listed: true,
            max: 2,
            mode: NET_MODE === 'classic' ? '经典联机·全卡' : '经典联机·卡组',
            hostName: NET_MY_NAME,
        });
        console.log('[NET] VibeHub Host 房间已创建:', NET_ROOM_ID);
        fireLobbyUpdate();
        return true;
    } catch (error) {
        console.error('[NET] 创建 VibeHub 房间失败：', error);
        cleanupNetSession(true);
        alert('⚠️ VibeHub 房间创建失败：' + (error && error.message ? error.message : error));
        return false;
    }
}

/** 加入 VibeHub 房间（Client）。 */
async function netJoinRoom(roomId, name, deck, cbs) {
    const rid = String(roomId || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(rid)) {
        alert('⚠️ 请输入 6 位房间号（字母或数字）');
        return false;
    }
    const vibe = requireVibeClient();
    if (!vibe) return false;
    bindNetCallbacks(cbs);
    cleanupNetSession(false);
    NET_ROLE = 'client';
    NET_STATE = 'joined';
    NET_ROOM_ID = rid;
    NET_MY_NAME = name || '玩家';
    NET_MODE = cbs.onlineMode === 'classic' ? 'classic' : 'deck';
    NET_MY_DECK = Array.isArray(deck) ? [...deck] : [];
    try {
        await openVibeRoom(rid);
        // 注意：room.join() resolve 时 WebRTC DataChannel 往往尚未建立，
        // 此时 sendNet 会被 SDK 静默丢弃，因此不能只发一次 HELLO。
        // 先发一次，再靠 peer 'join' 事件（通道打开时触发）与重发定时器兜底。
        sendNet({ type: 'HELLO', name: NET_MY_NAME, deck: NET_MY_DECK });
        startHelloRetry();
        fireLobbyUpdate();
        return true;
    } catch (error) {
        console.error('[NET] 加入 VibeHub 房间失败：', error);
        cleanupNetSession(true);
        alert('⚠️ 加入房间失败：' + (error && error.message ? error.message : error));
        return false;
    }
}

async function openVibeRoom(roomId) {
    if (!initNetworkLayer()) throw new Error('VibeHub 客户端不可用');
    const vibe = getVibeClient();
    NET_ROOM = await vibe.room.join(roomId, {
        topology: 'mesh',
        realtime: false,
    });
    NET_ROOM.onMessage(onNetMessage);
    NET_ROOM.onPeer(onNetPeerEvent);
    return NET_ROOM;
}

function sendNet(message, peerId) {
    if (!NET_ROOM) return false;
    try {
        if (peerId) NET_ROOM.send(message, peerId);
        else NET_ROOM.send(message);
        return true;
    } catch (error) {
        console.warn('[NET] VibeHub 消息发送失败：', error);
        return false;
    }
}

/** 启动 HELLO 重发定时器：JOIN_ACK 到达前每 1.5s 补发一次，超时报连接失败。 */
function startHelloRetry() {
    stopHelloRetry();
    let tries = 0;
    NET_HELLO_TIMER = setInterval(() => {
        if (NET_ROLE !== 'client' || NET_STATE !== 'joined') {
            stopHelloRetry();
            return;
        }
        tries++;
        if (tries > NET_HELLO_MAX_RETRY) {
            stopHelloRetry();
            console.warn('[NET] HELLO 重发超时，连接失败');
            const cb = NET_CB_ON_DISCONNECT;
            cleanupNetSession(false);
            if (cb) cb('连接超时，未能与房主建立数据通道');
            return;
        }
        sendNet({ type: 'HELLO', name: NET_MY_NAME, deck: NET_MY_DECK });
    }, NET_HELLO_INTERVAL_MS);
}

function stopHelloRetry() {
    if (NET_HELLO_TIMER !== null) {
        clearInterval(NET_HELLO_TIMER);
        NET_HELLO_TIMER = null;
    }
}

function onNetMessage(data, fromPeerId) {
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    switch (data.type) {
        case 'HELLO':       onNetHello(data); break;
        case 'JOIN_ACK':    onNetJoinAck(data); break;
        case 'LOBBY_READY': onNetLobbyReady(data); break;
        case 'GAME_START':  onNetGameStart(data); break;
        case 'CMD':         onRemoteCommand(data); break;
        case 'LEAVE':       onNetPeerLost('对方已离开房间'); break;
        default: break;
    }
}

function onNetPeerEvent(event) {
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'join') {
        NET_RECONNECTING = false;
        // Client 端：对端通道刚打开，此刻发送必达 → 立即补发一次 HELLO
        if (NET_ROLE === 'client' && NET_STATE === 'joined') {
            sendNet({ type: 'HELLO', name: NET_MY_NAME, deck: NET_MY_DECK });
        }
        fireLobbyUpdate();
    } else if (event.type === 'connecting' || event.type === 'reconnecting') {
        NET_RECONNECTING = true;
        fireLobbyUpdate();
    } else if (event.type === 'relay') {
        fireLobbyUpdate();
    } else if (event.type === 'leave') {
        if (NET_STATE !== 'idle') onNetPeerLost('对方已离开房间');
    } else if (event.type === 'error') {
        console.warn('[NET] VibeHub Room 错误：', event.reason, event.detail || '');
        fireLobbyUpdate();
    }
}

// ==================================================================
// 二、大厅协议
// ==================================================================

function onNetHello(data) {
    if (NET_ROLE !== 'host' || NET_STATE === 'idle') return;
    NET_OPP_NAME = data.name || '对手';
    NET_OPP_DECK = Array.isArray(data.deck) ? data.deck : [];
    NET_OPP_READY = false;
    sendNet({
        type: 'JOIN_ACK',
        name: NET_MY_NAME,
        myDeck: NET_OPP_DECK,
        oppDeck: NET_MY_DECK,
    });
    fireLobbyUpdate();
}

function onNetJoinAck(data) {
    if (NET_ROLE !== 'client') return;
    stopHelloRetry();          // 握手成功，停止 HELLO 重发
    NET_OPP_NAME = data.name || '对手';
    NET_OPP_DECK = Array.isArray(data.oppDeck) ? data.oppDeck : [];
    if (Array.isArray(data.myDeck)) NET_MY_DECK = [...data.myDeck];
    NET_OPP_READY = false;
    fireLobbyUpdate();
}

function setOnlineReady(v) {
    if (!NET_ROOM || NET_STATE === 'idle') return;
    NET_MY_READY = !!v;
    sendNet({ type: 'LOBBY_READY', isReady: NET_MY_READY });
    fireLobbyUpdate();
}

function onNetLobbyReady(data) {
    NET_OPP_READY = !!data.isReady;
    fireLobbyUpdate();
}

function hostStartOnlineGame() {
    if (NET_ROLE !== 'host' || !NET_ROOM) return;
    if (!NET_OPP_READY || !NET_MY_READY) {
        alert('请先让双方都点击「准备」！');
        return;
    }
    NET_SEED = (Date.now() ^ ((globalThis.crypto && crypto.getRandomValues)
        ? crypto.getRandomValues(new Uint32Array(1))[0] : Math.floor(Math.random() * 0xFFFFFFFF))) >>> 0;
    const msg = {
        type: 'GAME_START',
        seed: NET_SEED,
        hostName: NET_MY_NAME,
        clientName: NET_OPP_NAME,
        hostDeck: NET_MY_DECK,
        clientDeck: NET_OPP_DECK,
        onlineMode: NET_MODE,
    };
    sendNet(msg);
    beginOnlineBattle(msg, true);
}

function onNetGameStart(data) {
    if (NET_ROLE !== 'client') return;
    beginOnlineBattle(data, false);
}

function beginOnlineBattle(msg, isHost) {
    NET_STATE = 'in_game';
    NET_ENABLED = true;
    NET_SEED = msg.seed >>> 0;
    NET_MODE = msg.onlineMode === 'classic' ? 'classic' : 'deck';
    if (isHost) {
        NET_MY_NAME = msg.hostName;
        NET_OPP_NAME = msg.clientName;
        NET_MY_DECK = msg.hostDeck || [];
        NET_OPP_DECK = msg.clientDeck || [];
    } else {
        NET_MY_NAME = msg.clientName;
        NET_OPP_NAME = msg.hostName;
        NET_MY_DECK = msg.clientDeck || [];
        NET_OPP_DECK = msg.hostDeck || [];
    }
    NET_CMD_SEQ = 0;
    NET_PENDING_EXEC = [];
    NET_REMOTE_SEQ = new Set();
    if (NET_CB_ON_GAME_START) {
        NET_CB_ON_GAME_START(NET_SEED, [...NET_MY_DECK], [...NET_OPP_DECK], NET_MY_NAME, NET_OPP_NAME, NET_MODE);
    }
}

function netLeaveRoom() {
    if (NET_ROOM) {
        try { sendNet({ type: 'LEAVE' }); } catch (e) { /* ignore */ }
        try { NET_ROOM.leave(); } catch (e) { /* ignore */ }
    }
    cleanupNetSession(false);
}

// ==================================================================
// 三、Lockstep 指令队列
// ==================================================================

function queueCommand(cmd) {
    if (!isOnlineMode()) return true;
    if (!cmd || typeof cmd.type !== 'string') return false;
    const team = cmd.team || myOnlineTeam();
    if (team !== myOnlineTeam()) return false;
    const genTick = game.tick;
    const seq = ++NET_CMD_SEQ;
    const fullCmd = { ...cmd, team };
    scheduleNetExec(fullCmd, genTick + NET_SYNC_DELAY_TICKS, seq, team);
    sendNet({ type: 'CMD', genTick, seq, cmd: fullCmd });
    return true;
}

function dispatchCommand(cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return false;
    if (isOnlineMode()) return queueCommand(cmd);
    switch (cmd.type) {
        case 'DEPLOY': return deploy(cmd.cardId, cmd.team, cmd.x, cmd.y);
        case 'SKILL': return castActiveSkill(cmd.skillKey, cmd.team);
        default: return false;
    }
}

function onRemoteCommand(data) {
    if (!isOnlineMode() || !data || !data.cmd || typeof data.cmd.type !== 'string') return;
    const seq = Number.isInteger(data.seq) ? data.seq : 0;
    if (seq <= 0 || NET_REMOTE_SEQ.has(seq)) return;
    const team = data.cmd.team;
    if (team !== oppOnlineTeam()) return;
    const genTick = Number.isInteger(data.genTick) ? data.genTick : -1;
    if (genTick < 0 || genTick > game.tick + 600) return;
    NET_REMOTE_SEQ.add(seq);
    scheduleNetExec(data.cmd, genTick + NET_SYNC_DELAY_TICKS, seq, team);
}

function scheduleNetExec(cmd, execTick, seq, team) {
    const entry = { execTick, team, seq, cmd };
    const teamRank = team === 'player' ? 0 : 1;
    let lo = 0, hi = NET_PENDING_EXEC.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const e = NET_PENDING_EXEC[mid];
        const eRank = e.team === 'player' ? 0 : 1;
        if (e.execTick < entry.execTick ||
            (e.execTick === entry.execTick && (eRank < teamRank ||
            (eRank === teamRank && e.seq < entry.seq)))) lo = mid + 1;
        else hi = mid;
    }
    NET_PENDING_EXEC.splice(lo, 0, entry);
}

function executeDueNetCommands() {
    if (!isOnlineMode()) return;
    const nowTick = game.tick;
    const due = [];
    const rest = [];
    for (const entry of NET_PENDING_EXEC) {
        if (entry.execTick <= nowTick) due.push(entry);
        else rest.push(entry);
    }
    NET_PENDING_EXEC = rest;
    for (const entry of due) executeNetCmd(entry.cmd);
}

function executeNetCmd(cmd) {
    if (!cmd || typeof cmd.type !== 'string') return;
    switch (cmd.type) {
        case 'DEPLOY': deploy(cmd.cardId, cmd.team, cmd.x, cmd.y); break;
        case 'SKILL': castActiveSkill(cmd.skillKey, cmd.team); break;
        default: break;
    }
}

// ==================================================================
// 四、门控 / 清理
// ==================================================================

function setNetworkEnabled(v) { NET_ENABLED = !!v; }
function isOnlineMode() { return NET_ENABLED && game.gameMode === 'online'; }
function canAdvanceTick() { return true; }

function onNetPeerLost(reason) {
    if (NET_STATE === 'idle') return;
    console.warn('[NET] VibeHub 对端离开：', reason);
    const cb = NET_CB_ON_DISCONNECT;
    cleanupNetSession(false);
    if (cb) cb(reason);
}

function cleanupNetSession(cleanAll) {
    if (NET_ROOM) {
        try { NET_ROOM.leave(); } catch (e) { /* ignore */ }
    }
    NET_ROOM = null;
    resetSessionState();
    if (cleanAll) {
        NET_CB_ON_LOBBY = null;
        NET_CB_ON_GAME_START = null;
        NET_CB_ON_DISCONNECT = null;
    }
}

function fireLobbyUpdate() {
    if (NET_CB_ON_LOBBY) NET_CB_ON_LOBBY();
}
