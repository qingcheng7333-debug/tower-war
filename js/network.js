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
const NET_SYNC_DELAY_TICKS = 18;   // ≈600ms 延迟缓冲（联机两端一致性的核心：给对手指令留足到达时间）
let NET_CMD_SEQ = 0;
let NET_PENDING_EXEC = [];

// ---- INPUT 帧兼容层（第一阶段只确认/诊断，不执行 commands）----
let NET_LOCAL_INPUTS = new Map();
let NET_REMOTE_INPUTS = new Map();
let NET_INPUT_SEQ = 0;
let NET_REMOTE_INPUT_SEQ = new Set();
let NET_MAX_REMOTE_INPUT_SEQ = 0;
let NET_LAST_INPUT_TICK = -1;
let NET_REMOTE_INPUT_TICK = -1;
let NET_CONFIRMED_TICK = -1;
let NET_REMOTE_CONFIRMED_TICK = -1;


// ---- Lockstep 等待/校验（防画面分叉）----
let NET_REMOTE_TICK = -1;          // 对手最新已确认逻辑帧（SYNC 心跳携带；-1 = 尚未收到）
let NET_LAST_CMD_TICK = -1;        // 对手最新已下达指令的 genTick（远端无指令时判断「对手已确认到此帧」的依据）
const NET_FREEZE_TIMEOUT_MS = 5000; // 连续冻结超 5 秒（真实时间）无对手进展 → 判定失联（冻结期逻辑帧不推进，不能用帧计数计时；配合 CMD 重发 + SDK 自动重连，覆盖短暂网络抖动）
const NET_SYNC_MS = 900;           // 每 900ms 真实时间互发一次 SYNC 心跳（由 netRealtimeTick 定时器驱动，与 rAF/逻辑帧解耦：冻结期、页面隐藏时也能发）
const NET_CMD_ACK_TIMEOUT_MS = 600; // CMD 发出后 600ms 未收到 CMD_ACK → 重发（对端按 seq 去重，幂等）
const NET_REALTIME_TICK_MS = 300;  // 真实时间驱动定时器周期：CMD 重发检查 + SYNC 心跳
const NET_TICK_SYNC_MARGIN = 12;   // INPUT 软门控缓冲：我方 tick 最多领先对手 INPUT 进度 12 帧（≈400ms）。
                                   // 必须 < NET_SYNC_DELAY_TICKS(18)：错位上限 12 + 传输延迟 ≈2 帧 < 18 → 指令永不过期
const NET_HASH_TICKS = 120;        // 每 120 逻辑帧（4s）记录一次状态哈希，用于分叉检测
let NET_FREEZE_SINCE_MS = 0;       // 本轮连续冻结起始时刻（0=未冻结）；对手 INPUT 进展 / SYNC 进展即归零
let NET_LAST_SYNC_MS = 0;          // 上次发送 SYNC 心跳的真实时间
let NET_CMD_UNACKED = new Map();   // 已发送未确认的 CMD：seq → {msg, sentAt}（收到 CMD_ACK 或会话清理时移除）
let NET_REALTIME_TIMER = null;     // 真实时间驱动定时器（CMD 重发 + SYNC 心跳），模块加载即常驻
let NET_HASH_LOG = new Map();      // 本端哈希日志 tick → hash（收到对手哈希时比对）
let NET_OPP_HASH = new Map();      // 对手最近哈希缓存 tick → hash（本端滞后时，等本端记到同 tick 再比对）
let NET_DESYNC_WARNED = false;     // 分叉告警只提示一次，避免刷屏
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
    NET_LOCAL_INPUTS = new Map();
    NET_REMOTE_INPUTS = new Map();
    NET_INPUT_SEQ = 0;
    NET_REMOTE_INPUT_SEQ = new Set();
    NET_LAST_INPUT_TICK = -1;
    NET_REMOTE_INPUT_TICK = -1;
    NET_CONFIRMED_TICK = -1;
    NET_REMOTE_CONFIRMED_TICK = -1;
    NET_MAX_REMOTE_INPUT_SEQ = 0;
    NET_REMOTE_TICK = -1;
    NET_LAST_CMD_TICK = -1;
    NET_CMD_UNACKED.clear();
    NET_FREEZE_SINCE_MS = 0;
    NET_LAST_SYNC_MS = 0;
    NET_HASH_LOG = new Map();
    NET_OPP_HASH = new Map();
    NET_DESYNC_WARNED = false;
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
        case 'CMD_ACK':     onCmdAck(data); break;
        case 'INPUT':       onRemoteInput(data); break;
        case 'SYNC':        onNetSync(data); break;
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
        flushUnackedCmds(); // 通道（重）建立 → 立即补发未确认 CMD（重连恢复场景），不等重发超时
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
    NET_LOCAL_INPUTS = new Map();
    NET_REMOTE_INPUTS = new Map();
    NET_INPUT_SEQ = 0;
    NET_REMOTE_INPUT_SEQ = new Set();
    NET_LAST_INPUT_TICK = -1;
    NET_REMOTE_INPUT_TICK = -1;
    NET_CONFIRMED_TICK = -1;
    NET_REMOTE_CONFIRMED_TICK = -1;
    NET_MAX_REMOTE_INPUT_SEQ = 0;
    NET_REMOTE_TICK = -1;
    NET_LAST_CMD_TICK = -1;
    NET_CMD_UNACKED.clear();
    NET_FREEZE_SINCE_MS = 0;
    NET_LAST_SYNC_MS = 0;
    NET_HASH_LOG = new Map();
    NET_OPP_HASH = new Map();
    NET_DESYNC_WARNED = false;
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
    recordLocalInputCommand(genTick, fullCmd);
    const cmdMsg = { type: 'CMD', genTick, seq, cmd: fullCmd };
    sendNet(cmdMsg);
    // 登记未确认队列：600ms 内未收到 CMD_ACK 则由 netRealtimeTick 重发（对端按 seq 去重，幂等）
    NET_CMD_UNACKED.set(seq, { msg: cmdMsg, sentAt: Date.now() });
    return true;
}

/**
 * 🔗 联机预检：指令入队前的轻量校验，只做"当场就能判定"的检查（卡牌存在/圣水/冷却/卡组限制），
 * 让 ui 层的失败提示（deployFailReason → showGameTip）与失败处理逻辑在联机下也能生效——
 * 此前联机 dispatchCommand 恒返回 true，选中被清、提示永不出现，校验全部后置到 +18 tick 执行端。
 *
 * 确定性安全（Lockstep 不变量）：预检只决定"指令是否发送"——
 *   预检放行 → 两端在 +NET_SYNC_DELAY_TICKS 仍走 deploy()/castActiveSkill() 的完整校验，
 *              任一端失败则两端同样失败（同 tick 同状态），不产生分叉；
 *   预检拒绝 → 指令不发送，两端同样不执行，同样不分叉。
 * 预检刻意不查部署位置/屏障庇护（状态在 +18 tick 内可能变化，避免误拒正常落点）。
 */
function precheckCommand(cmd) {
    const team = cmd.team || myOnlineTeam();
    if (cmd.type === 'DEPLOY') {
        const cardId = cmd.cardId;
        if (typeof cardId !== 'string' || !CARDS[cardId]) {
            game.uiState.deployFailReason = 'invalid';
            return false;
        }
        const elixir = game.elixir[team] || 0;
        if (cardId === 'mirror') {
            // 镜像法术：费用=被复制卡动态费用+1（公式统一走 getMirrorCost），复制对象不存在即无效
            const lastId = getMirrorCopiedCard(team);
            if (!lastId || !CARDS[lastId]) {
                game.uiState.deployFailReason = 'invalid';
                return false;
            }
            if (elixir < getMirrorCost(team, lastId)) {
                game.uiState.deployFailReason = 'elixir';
                return false;
            }
            if (getMirrorCooldown(team) > 0) {
                game.uiState.deployFailReason = 'cooldown';
                return false;
            }
            if (isCardLockedByDeck(team, 'mirror')) {
                game.uiState.deployFailReason = 'invalid';
                return false;
            }
            return true;
        }
        if (elixir < getCardCost(team, cardId)) {
            game.uiState.deployFailReason = 'elixir';
            return false;
        }
        if (((game.cardCooldowns[team] || {})[cardId] || 0) > 0) {
            game.uiState.deployFailReason = 'cooldown';
            return false;
        }
        if (isCardLockedByDeck(team, cardId)) {
            game.uiState.deployFailReason = 'invalid';
            return false;
        }
        return true;
    }
    if (cmd.type === 'SKILL') {
        // 技能：槽位存在且处于技能态、技能冷却完毕、圣水足够（镜像槽 key='mirror_'+卡id，与 castActiveSkill 同协议）
        const skillKey = cmd.skillKey;
        if (typeof skillKey !== 'string') return false;
        const realId = skillKey.indexOf('mirror_') === 0 ? skillKey.slice(7) : skillKey;
        const card = CARDS[realId];
        if (!card || !card.activeSkill) return false;
        const st = (game.eliteSkills[team] || {})[skillKey];
        if (!st || st.mode !== 'skill' || st.skillCdLeft > 0) return false;
        const skillCost = (card.activeSkill.id === 'goblin_bless' && st.blessCost != null)
            ? Math.max(1, st.blessCost)
            : card.activeSkill.cost;
        if ((game.elixir[team] || 0) < skillCost) return false;
        return true;
    }
    return true;
}

function dispatchCommand(cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return false;
    if (isOnlineMode()) {
        if (!precheckCommand(cmd)) return false; // 🔗 联机预检：当场可判定的失败即时反馈（确定性论证见函数头注释）
        return queueCommand(cmd);
    }
    switch (cmd.type) {
        case 'DEPLOY': return deploy(cmd.cardId, cmd.team, cmd.x, cmd.y);
        case 'SKILL': return castActiveSkill(cmd.skillKey, cmd.team);
        default: return false;
    }
}

function onRemoteCommand(data) {
    if (!isOnlineMode() || !data || !data.cmd || typeof data.cmd.type !== 'string') return;
    const seq = Number.isInteger(data.seq) ? data.seq : 0;
    if (seq <= 0) return;
    sendNet({ type: 'CMD_ACK', seq }); // 收到即回执（重复 seq 也回，防 ACK 丢失导致发送方无限重发）
    if (NET_REMOTE_SEQ.has(seq)) return; // 重发去重：同一 seq 的指令只入队一次
    const team = data.cmd.team;
    if (team !== oppOnlineTeam()) return;
    const genTick = Number.isInteger(data.genTick) ? data.genTick : -1;
    if (genTick < 0 || genTick > game.tick + 600) return;
    NET_REMOTE_SEQ.add(seq);
    if (genTick > NET_LAST_CMD_TICK) NET_LAST_CMD_TICK = genTick;
    scheduleNetExec(data.cmd, genTick + NET_SYNC_DELAY_TICKS, seq, team);
}

function isValidInputCommand(cmd, team) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return false;
    if (cmd.team !== team) return false;
    if (cmd.type === 'DEPLOY') {
        return typeof cmd.cardId === 'string' && Number.isFinite(cmd.x) && Number.isFinite(cmd.y);
    }
    if (cmd.type === 'SKILL') return typeof cmd.skillKey === 'string';
    return false;
}

function pruneInputFrames() {
    // confirmed 未锚定时（-1）没有 prune 下限，用当前 tick 兜底，防止 Map 无界增长
    const minTick = Math.max(
        NET_CONFIRMED_TICK - NET_INPUT_KEEP_TICKS,
        game.tick - (NET_INPUT_KEEP_TICKS + NET_INPUT_FUTURE_TICKS),
        0
    );
    for (const tick of NET_LOCAL_INPUTS.keys()) if (tick < minTick) NET_LOCAL_INPUTS.delete(tick);
    for (const tick of NET_REMOTE_INPUTS.keys()) if (tick < minTick) NET_REMOTE_INPUTS.delete(tick);
    if (NET_REMOTE_INPUT_SEQ.size > 2048) {
        // seq 集合属于远端命名空间，用远端已见最大 seq 兜底裁剪（不能错用本地 NET_INPUT_SEQ）
        const keepFrom = Math.max(0, NET_MAX_REMOTE_INPUT_SEQ - 2048);
        NET_REMOTE_INPUT_SEQ = new Set([...NET_REMOTE_INPUT_SEQ].filter(seq => seq >= keepFrom));
    }
    if (NET_REMOTE_SEQ.size > 2048) {
        // CMD 重发去重集合同样只增不减：按已见最大 seq 保留最新段，防长局无界增长。
        //   被裁掉的旧 seq 理论上存在"极旧 CMD 重发被再执行一次"的窗口，但该窗口远大于输入缓冲保留期，
        //   实际由 onRemoteCommand 的 genTick 时界检查兜底（过期指令不入队）
        let maxSeq = 0;
        for (const seq of NET_REMOTE_SEQ) if (seq > maxSeq) maxSeq = seq;
        const keepCmdFrom = Math.max(0, maxSeq - 2048);
        NET_REMOTE_SEQ = new Set([...NET_REMOTE_SEQ].filter(seq => seq >= keepCmdFrom));
    }
}

function updateConfirmedInputTick() {
    // 锚定：confirmed 从 -1 起步时，取双方都存在的最早 tick 作为确认起点。
    // 应对重连/中途重置后起步 tick 非 0 的情况，确认进度不再卡死在 -1。
    if (NET_CONFIRMED_TICK < 0) {
        for (const t of NET_LOCAL_INPUTS.keys()) {
            if (NET_REMOTE_INPUTS.has(t)) { NET_CONFIRMED_TICK = t - 1; break; }
        }
    }
    while (NET_LOCAL_INPUTS.has(NET_CONFIRMED_TICK + 1) &&
           NET_REMOTE_INPUTS.has(NET_CONFIRMED_TICK + 1)) {
        NET_CONFIRMED_TICK++;
    }
    pruneInputFrames();
}

// ---- 本地 INPUT 帧生命周期：记录 → 封存（唯一发送点）----
// 记录阶段只写本地 Map，不发送、不定 seq；flushLocalInputFrame 在 canAdvanceTick()
// 推进前封存：分配唯一 seq、一次性发送，之后该帧不可变。
// 这样「同 tick 多条指令 / 空帧」都恰好发出一帧，远端无需「同 tick 替换」语义。

/** 记录本 tick 的一条本地指令（由 queueCommand 调用；只记录，不发送） */
function recordLocalInputCommand(tick, cmd) {
    if (!isOnlineMode() || !Number.isInteger(tick) || tick < 0) return;
    if (!isValidInputCommand(cmd, myOnlineTeam())) return;
    let frame = NET_LOCAL_INPUTS.get(tick);
    if (!frame) {
        frame = { type: 'INPUT', tick, seq: 0, commands: [], sent: false };
        NET_LOCAL_INPUTS.set(tick, frame);
    }
    if (frame.sent) return;                  // 异常路径：帧已封存则不追加，保证已发帧不可变
    if (frame.commands.length >= 32) return; // 与远端校验上限一致
    frame.commands.push({ ...cmd, team: myOnlineTeam() });
}

/** 封存并提交 tick 的本地 INPUT 帧（含空帧）；每 tick 只发送一次 */
function flushLocalInputFrame(tick) {
    if (!isOnlineMode() || !Number.isInteger(tick) || tick < 0) return;
    let frame = NET_LOCAL_INPUTS.get(tick);
    if (!frame) {
        frame = { type: 'INPUT', tick, seq: 0, commands: [], sent: false };
        NET_LOCAL_INPUTS.set(tick, frame);
    }
    if (frame.sent) return;
    frame.sent = true;
    frame.seq = ++NET_INPUT_SEQ;             // 封存时才分配 seq：每次传输必有唯一 seq
    NET_LAST_INPUT_TICK = Math.max(NET_LAST_INPUT_TICK, tick);
    sendNet({ type: 'INPUT', tick: frame.tick, seq: frame.seq, commands: frame.commands });
    updateConfirmedInputTick();
}

/** 远端 INPUT 帧到达：校验 + 去重 + 记录（第一阶段只做确认/诊断，不执行 commands） */
function onRemoteInput(data) {
    if (!isOnlineMode() || !Number.isInteger(data.tick) || !Number.isInteger(data.seq) ||
        data.seq <= 0 || !Array.isArray(data.commands)) return;
    const minTick = Math.max(0, game.tick - NET_INPUT_PAST_TICKS); // 允许 tick 0，确认链从开局对称推进
    if (data.tick < minTick || data.tick > game.tick + NET_INPUT_FUTURE_TICKS ||
        NET_REMOTE_INPUT_SEQ.has(data.seq) || NET_REMOTE_INPUTS.has(data.tick)) return;
    const team = oppOnlineTeam();
    if (!team || data.commands.length > 32 ||
        data.commands.some(cmd => !isValidInputCommand(cmd, team))) return;
    NET_REMOTE_INPUT_SEQ.add(data.seq);
    if (data.seq > NET_MAX_REMOTE_INPUT_SEQ) NET_MAX_REMOTE_INPUT_SEQ = data.seq;
    NET_REMOTE_INPUTS.set(data.tick, {
        type: 'INPUT', tick: data.tick, seq: data.seq,
        commands: data.commands.map(cmd => ({ ...cmd, team }))
    });
    if (data.tick > NET_REMOTE_INPUT_TICK) {
        NET_REMOTE_INPUT_TICK = data.tick;
        NET_FREEZE_SINCE_MS = 0; // 对手 INPUT 有进展 → 冻结计时归零（INPUT 30Hz 粒度，比 SYNC 心跳更准）
    }
    updateConfirmedInputTick();
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

/** 🔗 当前联机局是否为卡组模式（NET_MODE='deck'）；未联机时恒 false。
 *  供 entities.js 的 isCardLockedByDeck 做联机卡组校验（卡组以 NET_MY_DECK/NET_OPP_DECK 为准） */
function isOnlineDeckMode() {
    return isOnlineMode() && NET_MODE === 'deck';
}

/* ================================================================
 * 🔒 Lockstep 门控：canAdvanceTick()
 * 本帧是否允许推进逻辑（main.js 主循环每 tick 调用一次）。
 * 原理：以对手 INPUT 帧的实时进度做软门控 —— 我方 tick 最多领先对手
 *   「最新已到达 INPUT tick」+ NET_TICK_SYNC_MARGIN 帧，超出即冻结等待。
 *   - 对手正常推进时：INPUT 每 tick 实时到达，等待通常 <100ms，无感；
 *   - 对手挂起/掉线时：INPUT 停 → 我方领先缓冲后冻结，5 秒无进展 → 断线。
 * 价值：把两端 tick 错位钳制在缓冲帧内（< 指令延迟缓冲 18 帧），从源头杜绝
 *   「tick 错位 → 指令过期 → 冻结死锁」——过期指令在 Lockstep 语义下既不能
 *   立即执行（错 tick 执行 = 分叉）也不能等待（永远等不到正确 tick = 死锁）。
 * 单机模式恒 true。
 * ================================================================ */
function canAdvanceTick() {
    if (!isOnlineMode()) return true;
    // INPUT 帧封存点：即将推进本 tick，本地输入不再变化 → 在此统一提交（含空帧）。
    // 放在 tick<10 早退之前，保证从 tick 0 起每帧都有 INPUT（对端确认链从开局对称推进）。
    flushLocalInputFrame(game.tick);

    // 开局前 10 帧不设卡（等待双方 resetGame 完成与首轮 SYNC 交换）
    if (game.tick < 10) return true;

    // 软门控：领先对手 INPUT 进度超过缓冲 → 冻结等待（对手 INPUT 一到即恢复）。
    // NET_REMOTE_INPUT_TICK = -1 表示尚未收到对手任何 INPUT（tick≥10 时理论必已到达，防御兜底）。
    if (NET_REMOTE_INPUT_TICK >= 0 && game.tick >= NET_REMOTE_INPUT_TICK + NET_TICK_SYNC_MARGIN) {
        if (NET_FREEZE_SINCE_MS === 0) {
            NET_FREEZE_SINCE_MS = Date.now();
            showGameTip('⏳ 正在等待对手同步…'); // 让玩家区分「在等」与「已断」
        }
        else if (Date.now() - NET_FREEZE_SINCE_MS >= NET_FREEZE_TIMEOUT_MS) {
            NET_FREEZE_SINCE_MS = 0;
            const cb = NET_CB_ON_DISCONNECT;
            cleanupNetSession(false);
            if (cb) cb('等待对手超时，连接已断开');
        }
        return false;
    }
    // 未触发门控 → 正常推进。SYNC 心跳只负责连接监控/哈希校验，不参与推进门控。
    return true;
}

/** 主循环每帧调用（rAF 驱动）：仅记录哈希日志；SYNC 心跳与 CMD 重发已迁至 netRealtimeTick（真实时间定时器，页面隐藏/掉帧时也保活） */
function onLogicTick() {
    if (!isOnlineMode()) return;
    // 哈希日志：每 NET_HASH_TICKS 帧记录一份（冻结期 tick 不变不会重复记录）
    if (game.tick > 0 && game.tick % NET_HASH_TICKS === 0 && !NET_HASH_LOG.has(game.tick)) {
        NET_HASH_LOG.set(game.tick, computeStateHash());
        // 反向比对：对手心跳先到（本端滞后）时，此刻补上延迟的比对
        const oppHash = NET_OPP_HASH.get(game.tick);
        if (oppHash !== undefined && oppHash !== NET_HASH_LOG.get(game.tick) && !NET_DESYNC_WARNED) {
            NET_DESYNC_WARNED = true;
            console.warn('[NET] 状态哈希分叉 @tick', game.tick, '我方', NET_HASH_LOG.get(game.tick), '对方', oppHash);
            showGameTip('⚠️ 检测到两端画面不一致，建议双方刷新后重开一局');
        }
        // 日志只留最近 8 条，防内存增长
        if (NET_HASH_LOG.size > 8) {
            const oldest = NET_HASH_LOG.keys().next().value;
            NET_HASH_LOG.delete(oldest);
        }
    }
}

/** 真实时间驱动定时器（300ms，模块常驻）：CMD 未确认重发 + SYNC 心跳。
 *  与 rAF 解耦：页面隐藏/掉帧时浏览器仍以 ≥1s 节流调用本函数，心跳与补发不中断。 */
function netRealtimeTick() {
    if (!NET_ROOM || NET_STATE === 'idle') return;
    const now = Date.now();
    // 1) CMD 重发：超过确认超时未收到 CMD_ACK → 原样重发（对端按 seq 去重，幂等）
    if (NET_CMD_UNACKED.size > 0) {
        NET_CMD_UNACKED.forEach((entry, seq) => {
            if (now - entry.sentAt < NET_CMD_ACK_TIMEOUT_MS) return;
            entry.sentAt = now;
            sendNet(entry.msg);
            console.warn('[NET] CMD 未收到确认，重发 seq=' + seq);
        });
    }
    // 2) SYNC 心跳（自 onLogicTick 迁入；冻结等待期也照发，避免双方互相冻死）
    if (isOnlineMode() && now - NET_LAST_SYNC_MS >= NET_SYNC_MS) {
        NET_LAST_SYNC_MS = now;
        const msg = {
            type: 'SYNC',
            tick: game.tick,
            confirmedTick: NET_CONFIRMED_TICK,
            lastInputTick: NET_LAST_INPUT_TICK,
            lastCmdTick: NET_LAST_CMD_TICK
        };
        // 附带最近 2 份哈希（[tick,hash] 数组）：覆盖两端推进速度差一档（落后一方）的情况
        if (NET_HASH_LOG.size > 0) {
            msg.hashes = [...NET_HASH_LOG.entries()].slice(-2);
        }
        sendNet(msg);
    }
}

/** 通道（重）建立后立即补发全部未确认 CMD（重连恢复场景，不等重发超时）。 */
function flushUnackedCmds() {
    if (NET_CMD_UNACKED.size === 0) return;
    const now = Date.now();
    NET_CMD_UNACKED.forEach((entry) => {
        entry.sentAt = now;
        sendNet(entry.msg);
    });
}

/** 对手确认收到 CMD → 从未确认队列移除 */
function onCmdAck(data) {
    if (!data || !Number.isInteger(data.seq)) return;
    NET_CMD_UNACKED.delete(data.seq);
}

NET_REALTIME_TIMER = setInterval(netRealtimeTick, NET_REALTIME_TICK_MS);

/** 对手 SYNC 心跳/哈希到达 */
function onNetSync(data) {
    if (!isOnlineMode() || !Number.isInteger(data.tick)) return;
    // 哈希校验：对手 hashes=[[tick,hash],...] 与本端日志同 tick 比对；本端滞后的先缓存，等本端记到同 tick 再反向比对
    if (Array.isArray(data.hashes) && !NET_DESYNC_WARNED) {
        for (const [hTick, hVal] of data.hashes) {
            if (!Number.isInteger(hTick) || !Number.isInteger(hVal)) continue;
            NET_OPP_HASH.set(hTick, hVal);
            if (NET_OPP_HASH.size > 8) {
                const oldestOpp = NET_OPP_HASH.keys().next().value;
                NET_OPP_HASH.delete(oldestOpp);
            }
            const myHash = NET_HASH_LOG.get(hTick);
            if (myHash !== undefined && myHash !== hVal) {
                NET_DESYNC_WARNED = true;
                console.warn('[NET] 状态哈希分叉 @tick', hTick, '我方', myHash, '对方', hVal);
                showGameTip('⚠️ 检测到两端画面不一致，建议双方刷新后重开一局');
                break;
            }
        }
    }
    if (data.tick > NET_REMOTE_TICK) {
        NET_REMOTE_TICK = data.tick;
        NET_FREEZE_SINCE_MS = 0;
    }
    if (Number.isInteger(data.confirmedTick) && data.confirmedTick > NET_REMOTE_CONFIRMED_TICK) {
        NET_REMOTE_CONFIRMED_TICK = data.confirmedTick;
    }
    if (Number.isInteger(data.lastInputTick) && data.lastInputTick > NET_REMOTE_INPUT_TICK) {
        NET_REMOTE_INPUT_TICK = data.lastInputTick;
    }
    if (Number.isInteger(data.lastCmdTick) && data.lastCmdTick > NET_LAST_CMD_TICK) {
        NET_LAST_CMD_TICK = data.lastCmdTick;
    }
}

/** 状态哈希：轻量折叠成 32 位整数（联机分叉检测用）。
 *  覆盖面：tick/圣水/实体/弹道 + 冷却/精英槽/部署队列/阵营数据/烟引 pending/各领域队列——
 *  此前仅实体+弹道，冷却或领域类状态分叉时哈希不报警（检测盲区）。
 *  确定性要求：所有对象键一律按 CARD_IDS 固定顺序遍历，禁止 for-in（key 顺序依赖插入史） */
function computeStateHash() {
    let h = 2166136261 >>> 0;
    const mix = (n) => {
        h = (Math.imul(h, 16777619) ^ (n | 0)) >>> 0;
    };
    const mixStr = (s) => {
        const str = String(s == null ? '' : s);
        for (let i = 0; i < str.length; i++) mix(str.charCodeAt(i));
        mix(0x9e37); // 串分隔符：防 "ab"+"c" 与 "a"+"bc" 折叠同值
    };
    const mixNum = (n) => mix(Number.isFinite(n) ? Math.round(n * 10) : -99999);
    const mixMode = (st) => { // 精英槽折叠：mode 短码 + 死亡冷却 + 技能冷却 + 神庙神赐费用
        if (!st) return;
        mix(st.mode === 'deploy' ? 1 : st.mode === 'skill' ? 2 : 3);
        mixNum(st.cdLeft);
        mixNum(st.skillCdLeft);
        mixNum(st.blessCost != null ? st.blessCost : -1);
    };
    mix(game.tick);
    mix(Math.round(game.elixir.player * 10));
    mix(Math.round(game.elixir.ai * 10));
    if (Array.isArray(game.entities)) {
        for (const e of game.entities) {
            mix(e.id); mix(e.hp); mix(Math.round(e.x)); mix(Math.round(e.y));
        }
    }
    if (Array.isArray(game.projectiles)) {
        for (const pr of game.projectiles) {
            mix(pr.x !== undefined ? Math.round(pr.x * 10) : 0);
            mix(pr.y !== undefined ? Math.round(pr.y * 10) : 0);
        }
    }
    // ---- 扩展覆盖面（以下全部为影响逻辑确定性的状态）----
    mixStr(game.lastDeployedCardId || '');
    mixStr(game.lastDeployedCardId2 || '');
    mix(game.bastionsLost ? game.bastionsLost.player : -1);
    mix(game.bastionsLost ? game.bastionsLost.ai : -1);
    for (const team of ['player', 'ai']) {
        const cds = game.cardCooldowns[team] || {};
        for (const id of CARD_IDS) mixNum(cds[id]);
        mixNum(cds.mirror); // 镜像冷却单独记键
    }
    for (const team of ['player', 'ai']) {
        const es = game.eliteSkills[team] || {};
        for (const id of CARD_IDS) {
            if (es[id]) { mixStr(id); mixMode(es[id]); }
            const mkey = 'mirror_' + id;
            if (es[mkey]) { mixStr(mkey); mixMode(es[mkey]); }
        }
    }
    if (Array.isArray(game.deploying)) {
        mix(game.deploying.length);
        for (const d of game.deploying) {
            mixStr(d.cardId || '');
            mix(d.team === 'player' ? 1 : 2);
            mixNum(d.timer); mixNum(d.x); mixNum(d.y);
        }
    }
    for (const team of ['player', 'ai']) {
        const p = game.smokePending && game.smokePending[team];
        if (p) { mixStr('sp' + team); mixNum(p.timer); }
        const mp = game.mirrorSmokePending && game.mirrorSmokePending[team];
        if (mp) { mixStr('mp' + team); mixNum(mp.timer); }
    }
    // 领域/延迟结算类队列：长度 + timer 总和（轻量折叠，足以反映"有无/进度"分叉）
    for (const key of ['speedZones', 'rageZones', 'freezeZones', 'curseZones', 'poisonZones',
        'hurricaneZones', 'scholarClouds', 'scholarHurricanes', 'windZones', 'windFields', 'snowTrails', 'smokeGuides', 'arrowRainStrikes', 'earthquakeStrikes',
        'thunderStrikes', 'princeGuardSpawns', 'jessieStakeSpawns', 'batSpawns']) {
        const arr = game[key];
        if (!Array.isArray(arr)) { mix(-1); continue; }
        mix(arr.length);
        let timerSum = 0;
        for (const z of arr) timerSum += (z && z.timer) || 0;
        mix(Math.round(timerSum * 10));
    }
    return h >>> 0;
}

/** 🔗 当前玩家的阵营：Host=蓝方(player)，Client=红方(ai)；未联机时返回 null */
function myOnlineTeam() {
    if (!NET_ROLE || !isOnlineMode()) return null;
    return NET_ROLE === 'host' ? 'player' : 'ai';
}

/** 🔗 对手的阵营：与 myOnlineTeam 相反；未联机时返回 null */
function oppOnlineTeam() {
    if (!NET_ROLE || !isOnlineMode()) return null;
    return NET_ROLE === 'host' ? 'ai' : 'player';
}

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
