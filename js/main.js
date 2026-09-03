/* ===== main.js — 程序入口：页面切换、游戏循环、初始化 ===== */

// ---- DOM 元素 ----
const homePage = document.getElementById('homePage');
const gamePage = document.getElementById('gamePage');
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
// 显式挂载到全局，供其他文件引用
window.canvas = canvas;
window.ctx = ctx;

// ---- 画布尺寸同步：逻辑地图宽 W 开局被 resetGame 切换（🧪测试双人=1400，其余=1600），canvas 缓冲随之重设 ----
// canvas 无固定 CSS 宽（style.css 仅 display/margin），改 width 属性后显示尺寸与 getBoundingClientRect 自动跟随，
// ui.js 鼠标坐标映射（W/rect.width）保持正确；开局重设会清空画布，随后 draw() 全量重绘无残留
function syncCanvasSize() {
    canvas.width = W;
    canvas.height = H;
}

// ---- 页面切换：主页 → 全领对战（全部卡牌可用）----
document.getElementById('startGameBtn').addEventListener('click', () => {
    game.gameMode = 'classic';
    homePage.style.display = 'none';
    gamePage.style.display = 'flex';
    document.querySelector('.top-bar span:last-child').textContent = '🤖 人机（全卡）';
    renderCardPanel('classic'); // 全部卡牌
    resetGame();
    syncCanvasSize();
});

// ---- 页面切换：主页 → 卡组对战（仅卡组内的牌可用）----
document.getElementById('deckBattleBtn').addEventListener('click', () => {
    const deck = getActiveDeck();
    if (!deck || deck.cards.length === 0) {
        alert('请先在「卡组管理」中创建并选用一套卡组！');
        return;
    }

    game.gameMode = 'deck';
    homePage.style.display = 'none';
    gamePage.style.display = 'flex';
    document.querySelector('.top-bar span:last-child').textContent = '🤖 人机（卡组）';
    renderCardPanel('deck'); // 只显示卡组中的牌
    resetGame();
    syncCanvasSize();
});

// ---- 页面切换：主页 → AI对战（直接使用当前激活预设）----
document.getElementById('aiApiBtn').addEventListener('click', () => {
    const presets = getPresets();
    const activeId = getActivePresetId();
    let preset = null;

    if (activeId) {
        preset = presets.find(p => String(p.id) === activeId);
    }
    if (!preset && presets.length > 0) {
        preset = presets[0];
    }

    if (!preset) {
        alert('请先在「AI配置」中添加一个API配置！');
        return;
    }
    if (!preset.apiKey) {
        alert('当前配置未设置 API Key，请先到「AI配置」中编辑！');
        return;
    }
    if (!preset.apiKey.startsWith('sk-')) {
        alert('API Key 格式似乎不对，应以 sk- 开头');
        return;
    }

    startGameWithPreset(preset);
});

// ---- 页面切换：主页 → 双人（本机测试）----
document.getElementById('localMultiBtn').addEventListener('click', () => {
    game.gameMode = 'local_multi';
    homePage.style.display = 'none';
    gamePage.style.display = 'flex';
    document.querySelector('.top-bar span:last-child').textContent = '🎮 双人（本机测试）';

    // 显示上方红方 UI
    document.getElementById('topElixirBar').style.display = 'flex';
    document.getElementById('topCardPanel').style.display = 'flex';
    document.getElementById('topCardPanel').innerHTML = '';

    document.getElementById('topCardPanel').innerHTML = ''; // 清空重绘

    // 下方圣水标签改为蓝方
    document.getElementById('rightElixirLabel').innerHTML = '🔵 蓝方 圣水 <span id="aiElixirDisplay">5.0</span>';

    renderCardPanel('classic');    // 下方蓝方
    renderTopCardPanel('classic'); // 上方红方
    resetGame();
    syncCanvasSize();
});

// ---- 页面切换：主页 → 🧪 测试双人（本机）——gameMode 复用 'local_multi'（自动继承跳过AI/双面板/圣水冷却刷新等全部行为），
//      唯一差异：detect220=true → 发现锁敌收窄到220（config MODE_TEST_DETECT_R），圈外无敌原地待机 ----
document.getElementById('testLocalMultiBtn').addEventListener('click', () => {
    game.gameMode = 'local_multi';
    homePage.style.display = 'none';
    gamePage.style.display = 'flex';
    document.querySelector('.top-bar span:last-child').textContent = '🧪 测试双人（本机）';

    // 显示上方红方 UI
    document.getElementById('topElixirBar').style.display = 'flex';
    document.getElementById('topCardPanel').style.display = 'flex';
    document.getElementById('topCardPanel').innerHTML = '';

    // 下方圣水标签改为蓝方
    document.getElementById('rightElixirLabel').innerHTML = '🔵 蓝方 圣水 <span id="aiElixirDisplay">5.0</span>';

    renderCardPanel('classic');    // 下方蓝方
    renderTopCardPanel('classic'); // 上方红方
    resetGame(undefined, true);  // 🧪 测试双人：detect220 标记 + 整图缩窄（W=1400）由开局统一传入（工厂重建会重置字段，resetGame 内持久化）
    syncCanvasSize();
});

// ---- 页面切换：主页 → 🧪 测试模板1——照抄经典双人（本机）全套（标准图1600/标准河道/无桥无行军），仅两点差异：
//      ① detect220=true → 发现锁敌收窄 220/440（findTarget/火豆/出圈弃锁三处索敌 gate；圈内无敌原地待机，无行军兜底）
//      ② noBastion=true → 开局不创建四个堡垒（堡垒虚线同步不画；丢堡推进线因丢堡数恒0天然失效）----
document.getElementById('testTemplate1Btn').addEventListener('click', () => {
    game.gameMode = 'local_multi';
    homePage.style.display = 'none';
    gamePage.style.display = 'flex';
    document.querySelector('.top-bar span:last-child').textContent = '🧪 测试模板1';

    // 显示上方红方 UI
    document.getElementById('topElixirBar').style.display = 'flex';
    document.getElementById('topCardPanel').style.display = 'flex';
    document.getElementById('topCardPanel').innerHTML = '';

    // 下方圣水标签改为蓝方
    document.getElementById('rightElixirLabel').innerHTML = '🔵 蓝方 圣水 <span id="aiElixirDisplay">5.0</span>';

    renderCardPanel('classic');    // 下方蓝方
    renderTopCardPanel('classic'); // 上方红方
    resetGame(undefined, true, true);  // 🧪 模板1：detect220（索敌220/440）+ noBastion（无堡垒）；shrink220=false → 标准图
    syncCanvasSize();
});

// ---- 主页：「更多后续（测试）」子菜单展开/收起（子项为占位，测试模板内容后续填充）----
document.getElementById('moreTestsBtn').addEventListener('click', () => {
    const list = document.getElementById('moreTestsList');
    const show = list.style.display === 'none';
    list.style.display = show ? 'flex' : 'none';
    document.getElementById('moreTestsBtn').textContent = (show ? '▼' : '▶') + ' 更多后续（测试）';
});

// ==================== 🔗 双人联机入口（全卡 / 卡组） ====================
const onlineModal = document.getElementById('onlineModal');
const onlineStatusText = document.getElementById('onlineStatusText');
const onlineDeckName = document.getElementById('onlineDeckName');
const onlineRoomArea = document.getElementById('onlineRoomArea');
const roomIdDisplay = document.getElementById('roomIdDisplay');
const onlineSelfName = document.getElementById('onlineSelfName');
const onlineSelfStatus = document.getElementById('onlineSelfStatus');
const onlineOppName = document.getElementById('onlineOppName');
const onlineOppStatus = document.getElementById('onlineOppStatus');
const onlineReadyBtn = document.getElementById('onlineReadyBtn');
const onlineStartBtn = document.getElementById('onlineStartBtn');
const onlineRoomList = document.getElementById('onlineRoomList');
const listRoomsBtn = document.getElementById('listRoomsBtn');

// 昵称记忆（localStorage）
const ONLINE_NAME_KEY = 'towerwar_online_name';
function getSavedOnlineName() {
    try { return localStorage.getItem(ONLINE_NAME_KEY) || ''; } catch (e) { return ''; }
}
function saveOnlineName(name) {
    try { localStorage.setItem(ONLINE_NAME_KEY, name); } catch (e) { /* ignore */ }
}

/** 打开联机大厅（全卡 / 卡组） */
async function openOnlineLobby(onlineMode) {
    if (typeof TowerVibeHub !== 'undefined' && TowerVibeHub.isPlatform() && !TowerVibeHub.isLoggedIn()) {
        const user = await TowerVibeHub.login();
        if (!user) return;
    }
    const nameInput = document.getElementById('onlineNameInput');
    if (!nameInput.value) nameInput.value = getSavedOnlineName() || '玩家' + Math.floor(1000 + Math.random() * 9000);
    const deck = getActiveDeck();
    onlineModal.dataset.mode = onlineMode;
    // 🐛 标题按模式动态显示（原来写死"卡组"，全卡入口进来也显示错）
    const onlineModalTitle = document.getElementById('onlineModalTitle');
    if (onlineModalTitle) onlineModalTitle.textContent = onlineMode === 'classic'
        ? '🔗 双人联机（全卡）' : '🔗 双人联机（卡组）';
    onlineDeckName.textContent = onlineMode === 'classic'
        ? '全部卡牌'
        : ((deck && deck.name) ? deck.name : '默认卡组（前15张）');
    resetOnlineLobbyUI();
    onlineModal.style.display = 'flex';
    refreshOnlineLobby();
    if (typeof TowerVibeHub !== 'undefined' && TowerVibeHub.isPlatform()) refreshPublicRooms();
}

document.getElementById('multiplayerBtn').addEventListener('click', () => openOnlineLobby('classic'));
document.getElementById('multiplayerDeckBtn').addEventListener('click', () => openOnlineLobby('deck'));

/** 关闭弹窗（顺带离开房间） */
function closeOnlineModal() {
    onlineModal.style.display = 'none';
    netLeaveRoom();
    resetOnlineLobbyUI();
}
document.getElementById('closeOnlineModalBtn').addEventListener('click', closeOnlineModal);
onlineModal.addEventListener('click', (e) => { if (e.target === onlineModal) closeOnlineModal(); });

/** 创建房间（Host） */
document.getElementById('createRoomBtn').addEventListener('click', () => {
    const name = (document.getElementById('onlineNameInput').value || '').trim() || '玩家';
    saveOnlineName(name);
    const onlineMode = onlineModal.dataset.mode || 'deck';
    const deckCards = onlineMode === 'classic' ? [...CARD_IDS] : getActiveDeckCards();
    if (onlineMode !== 'classic' && (!deckCards || deckCards.length === 0)) {
        alert('请先在「卡组管理」中创建并选用一套卡组！');
        return;
    }
    netCreateRoom(name, deckCards, {
        onlineMode,
        onLobby: refreshOnlineLobby,
        onGameStart: startOnlineBattle,
        onDisconnect: handleOnlineDisconnect,
    });
});

/** 加入房间（Client） */
document.getElementById('joinRoomBtn').addEventListener('click', () => {
    const name = (document.getElementById('onlineNameInput').value || '').trim() || '玩家';
    saveOnlineName(name);
    const rid = document.getElementById('joinRoomInput').value;
    const onlineMode = onlineModal.dataset.mode || 'deck';
    const deckCards = onlineMode === 'classic' ? [...CARD_IDS] : getActiveDeckCards();
    if (onlineMode !== 'classic' && (!deckCards || deckCards.length === 0)) {
        alert('请先在「卡组管理」中创建并选用一套卡组！');
        return;
    }
    netJoinRoom(rid, name, deckCards, {
        onlineMode,
        onLobby: refreshOnlineLobby,
        onGameStart: startOnlineBattle,
        onDisconnect: handleOnlineDisconnect,
    });
});

/** 查找 VibeHub 公开房间（仅房间发现，不承载实时对局状态） */
async function refreshPublicRooms() {
    if (!onlineRoomList) return;
    const vibe = typeof TowerVibeHub !== 'undefined' ? TowerVibeHub.getClient() : null;
    if (!vibe || !vibe.isLoggedIn()) {
        onlineRoomList.style.display = 'none';
        return;
    }
    onlineRoomList.style.display = 'block';
    onlineRoomList.textContent = '🔎 正在查找公开房间…';
    try {
        const rooms = await vibe.rooms.list();
        const available = (Array.isArray(rooms) ? rooms : []).filter(room =>
            room && room.open !== false && Number(room.players || 0) < Number(room.max || 2)
        );
        onlineRoomList.textContent = '';
        if (!available.length) {
            onlineRoomList.textContent = '暂无可加入的公开房间';
            return;
        }
        available.forEach(room => {
            const item = document.createElement('div');
            item.className = 'online-room-item';
            const label = document.createElement('span');
            label.textContent = `${room.mode || '经典联机'} · ${room.players || 0}/${room.max || 2} · ${room.roomId}`;
            const join = document.createElement('button');
            join.type = 'button';
            join.textContent = '加入';
            join.addEventListener('click', () => {
                document.getElementById('joinRoomInput').value = String(room.roomId || '');
            });
            item.append(label, join);
            onlineRoomList.appendChild(item);
        });
    } catch (error) {
        onlineRoomList.textContent = '公开房间查询失败，请直接输入房间号';
        console.warn('[VibeHub] 房间列表查询失败：', error);
    }
}

if (listRoomsBtn) listRoomsBtn.addEventListener('click', refreshPublicRooms);

/** 复制房间号 */
document.getElementById('copyRoomIdBtn').addEventListener('click', () => {
    const rid = roomIdDisplay.textContent;
    if (!rid || rid === '------') return;
    try {
        navigator.clipboard.writeText(rid).then(() => showGameTip('📋 房间号已复制：' + rid));
    } catch (e) {
        showGameTip('📋 房间号：' + rid);
    }
});

/** 准备 / 取消准备 */
onlineReadyBtn.addEventListener('click', () => {
    setOnlineReady(!NET_MY_READY);
});

/** 开始对决（仅房主 + 双方就绪时显示） */
onlineStartBtn.addEventListener('click', () => {
    hostStartOnlineGame();
});

/** 离开房间 */
document.getElementById('onlineLeaveBtn').addEventListener('click', () => {
    netLeaveRoom();
    resetOnlineLobbyUI();
    refreshOnlineLobby();
});

/** 大厅 UI 重置为初始态 */
function resetOnlineLobbyUI() {
    onlineStatusText.textContent = onlineModal.dataset.mode === 'classic'
        ? '全卡联机：等待连接…' : '卡组联机：等待连接…';
    onlineRoomArea.style.display = 'none';
    if (onlineRoomList) { onlineRoomList.style.display = 'none'; onlineRoomList.textContent = ''; }
    document.getElementById('joinRoomInput').value = '';
    onlineReadyBtn.textContent = '✅ 准备';
    onlineReadyBtn.disabled = true;
    onlineStartBtn.style.display = 'none';
}

/** 大厅状态刷新（network 回调驱动） */
function refreshOnlineLobby() {
    if (NET_ROLE === 'host') {
        onlineStatusText.textContent = '🏠 已创建房间，等待对手加入…';
        onlineRoomArea.style.display = 'block';
        roomIdDisplay.textContent = NET_ROOM_ID;
        onlineSelfName.textContent = '🟦 ' + NET_MY_NAME + '（房主）';
        onlineOppName.textContent = NET_OPP_NAME ? '🟥 ' + NET_OPP_NAME : '🟥 等待加入…';
        onlineOppStatus.textContent = NET_OPP_NAME ? (NET_OPP_READY ? '已准备' : '未准备') : '等待加入…';
        onlineOppStatus.className = 'online-ready-state' + (NET_OPP_NAME ? (NET_OPP_READY ? ' ready' : '') : '');
    } else if (NET_ROLE === 'client') {
        onlineStatusText.textContent = NET_OPP_NAME ? '🚪 已加入房间' : '🚪 正在连接房主…';
        onlineRoomArea.style.display = 'block';
        roomIdDisplay.textContent = NET_ROOM_ID;
        onlineSelfName.textContent = '🟥 ' + NET_MY_NAME;
        onlineOppName.textContent = NET_OPP_NAME ? '🟦 ' + NET_OPP_NAME + '（房主）' : '🟦 连接中…';
        onlineOppStatus.textContent = NET_OPP_NAME ? (NET_OPP_READY ? '已准备' : '未准备') : '-';
        onlineOppStatus.className = 'online-ready-state' + (NET_OPP_NAME && NET_OPP_READY ? ' ready' : '');
    } else {
        onlineReadyBtn.textContent = '✅ 准备';
        onlineReadyBtn.disabled = true;
        onlineStartBtn.style.display = 'none';
        return;
    }
    // 自己的准备状态
    onlineSelfStatus.textContent = NET_MY_READY ? '已准备' : '未准备';
    onlineSelfStatus.className = 'online-ready-state' + (NET_MY_READY ? ' ready' : '');
    // 准备按钮：对手加入后才可点
    onlineReadyBtn.disabled = !NET_OPP_NAME;
    onlineReadyBtn.textContent = NET_MY_READY ? '✖ 取消准备' : '✅ 准备';
    // 开始按钮：仅房主 + 双方就绪
    onlineStartBtn.style.display = (NET_ROLE === 'host' && NET_MY_READY && NET_OPP_READY) ? 'inline-block' : 'none';
}

/** 断线统一处理 */
function handleOnlineDisconnect(reason) {
    resetOnlineLobbyUI();
    refreshOnlineLobby();
    if (gamePage.style.display === 'flex') goBackHome(); // 对局中断线 → 回主页
    alert('🔗 联机已断开：' + reason);
}

/** 进入联机对局（network GAME_START 回调） */
function startOnlineBattle(seed, myDeck, oppDeck, myName, oppName, onlineMode) {
    onlineModal.style.display = 'none';
    onlineMode = onlineMode || onlineModal.dataset.mode || 'deck';
    game.gameMode = 'online';
    homePage.style.display = 'none';
    gamePage.style.display = 'flex';
    document.querySelector('.top-bar span:last-child').textContent = onlineMode === 'classic'
        ? '🔗 联机对战（全卡）' : '🔗 联机对战（卡组）';

    // 显示上方红方 UI
    document.getElementById('topElixirBar').style.display = 'flex';
    document.getElementById('topCardPanel').style.display = 'flex';
    document.getElementById('topCardPanel').innerHTML = '';

    // 圣水标签：蓝方 = 我方，红方 = 对手（显示昵称）
    document.getElementById('rightElixirLabel').innerHTML = '🔵 ' + myName + ' 圣水 <span id="aiElixirDisplay">5.0</span>';
    const topLabel = document.querySelector('#topElixirBar span');
    if (topLabel) topLabel.innerHTML = '🔴 ' + oppName + ' 圣水 <span id="topPlayerElixirDisplay">5.0</span>';

    // 全卡模式显示全部卡牌；卡组模式显示双方各自卡组
    const panelMode = onlineMode === 'classic' ? 'classic' : 'deck';
    // 🔗 联机：卡组渲染到「自己可操作」的面板（Host=蓝方→下方 cardPanel，Client=红方→上方 topCardPanel）
    if (NET_ROLE === 'client') {
        renderTopCardPanel(panelMode, myDeck);
        document.getElementById('cardPanel').innerHTML = '';      // 清掉残留卡牌
        document.getElementById('cardPanel').style.display = 'none'; // 对方（蓝方）卡牌面板不显示
    } else {
        renderCardPanel(panelMode, myDeck);
        document.getElementById('topCardPanel').innerHTML = '';   // 清掉残留卡牌
        document.getElementById('topCardPanel').style.display = 'none'; // 对方（红方）卡牌面板不显示
    }
    resetGame(seed);
    syncCanvasSize();
    showGameTip('⚔️ 对决开始！');
}

// ---- AI配置管理（弹出预设选择弹窗）----
document.getElementById('aiConfigBtn').addEventListener('click', () => {
    renderPresetList();
    document.getElementById('aiPresetModal').style.display = 'flex';
});

// ---- 🎮 人机选择（AI行为组：测试组 / 哥布林组）----
document.getElementById('modeSelectBtn').addEventListener('click', () => {
    renderAiGroupList();
    document.getElementById('aiGroupModal').style.display = 'flex';
});
document.getElementById('closeAiGroupModalBtn').addEventListener('click', () => {
    document.getElementById('aiGroupModal').style.display = 'none';
});

// ==================== 整活霸屏：关于我们 / 检查更新（共用一套 overlay） ====================
const aboutOverlay = document.getElementById('aboutOverlay');
const aboutCharImg = aboutOverlay.querySelector('.about-overlay-char');
const aboutDialogText = aboutOverlay.querySelector('.about-dialog-text');
const aboutDialogNext = aboutOverlay.querySelector('.about-dialog-next');
const aboutOptions = document.getElementById('aboutOptions');
let overlayMode = null; // 当前由哪个入口打开：'about' | 'update'

// 通用：切图（同图不闪烁）+ 换字幕
function showOverlayStep(img, text) {
    if (aboutCharImg.getAttribute('src') !== img) {
        aboutCharImg.style.opacity = 0;
        aboutCharImg.onload = () => { aboutCharImg.style.opacity = 1; };
        aboutCharImg.src = img;
    } else {
        aboutCharImg.style.opacity = 1;
    }
    aboutDialogText.textContent = text;
}

// ---- 关于我们：线性流程 ----
const aboutSteps = [
    { img: '整活/jk左.png',       text: '真麻煩呢…' },
    { img: '整活/jk左蓝.png',     text: '哎哎，變個颜色先☆˶> x <˶.⁺' },
    { img: '整活/jk站比耶.png',   text: 'どう？可愛いでしょ？♡', right: true },
    { img: '整活/jk欸.png',       text: '人家可是大品牌創作哦！', right: true },
    { img: '整活/jk提问.png',     text: '猜猜看〜 誰の作品かな？', right: true },
    { img: '整活/jk傲娇.png',     text: '才不告诉你呢', right: true },
    { img: '整活/jk欸.png',       text: 'でもね…お願いしてくれたら？……なんて、教えないもん！求我就告诉你哦！', right: true },
    { img: '整活/jk撩裙.png',     text: '我介莫可爱ᗜ֊ᗜ', right: true },
    { img: '整活/jk臭美.png',     text: '你别想知道是豆包搓出来的~ へへ', right: true },
    { img: '整活/jk糟糕.png',     text: 'ああ、やばい😰', right: true },
    { img: '整活/jk糟糕.png',     text: '被你發現了๑ᵒᯅᵒ๑', right: true },
    { img: '整活/jk半蹲可怜.png', text: '你不會嫌棄我吧( ๑ŏ ﹏ ŏ๑ )', right: true },
    { img: '整活/jk蹲可怜.png',   text: '哎…', right: true },
    { img: '整活/jk抱膝.png',     text: '（期待未續……）', right: true },
];
let aboutStepIndex = 0;
function showAboutStep(i) {
    aboutStepIndex = i;
    const step = aboutSteps[i];
    aboutCharImg.classList.toggle('char-right', !!step.right);
    showOverlayStep(step.img, step.text);
    aboutDialogNext.style.display = 'block';
    aboutOptions.style.display = 'none';
}

function showAboutStep(i) {
    aboutStepIndex = i;
    const step = aboutSteps[i];
    // 位置：第3步起人物站到对称的右边
    aboutCharImg.classList.toggle('char-right', !!step.right);
    // 换图：先淡出，新图加载完淡入（同图则直接恢复，避免卡在半透明）
    const src = step.img;
    if (aboutCharImg.getAttribute('src') !== src) {
        aboutCharImg.style.opacity = 0;
        aboutCharImg.onload = () => { aboutCharImg.style.opacity = 1; };
        aboutCharImg.src = src;
    } else {
        aboutCharImg.style.opacity = 1;
    }
    aboutDialogText.textContent = step.text;
}

// ---- 检查更新：分支剧情（女仆在右边，选项显示在对话框上方右侧）----
const updateFlow = {
    start: [
        { img: '整活/女仆扭捏.png', text: '主、主人…… ええ？！' },
        { img: '整活/女仆道歉.png', text: 'ご、ごめん…ご主人様！還沒做好…' },
        { options: [
            { label: '想看战败CG', goto: 'cg' },
            { label: '點個關注',   goto: 'like' },
            { label: '（離開）',   goto: 'leave' },
        ] },
    ],
    cg: [
        { img: '整活/女仆弯腰捂嘴.png', text: '咦…' },
        { img: '整活/女仆弯腰2.png',    text: '（主人果然是変態、ロリコン、クズ、雑魚呢）' },
        { img: '整活/女仆拒绝.png',     text: 'あっ…ダメダメ！这个不可以(˃ ˂ഃ )' },
        { options: [
            { label: '那怎樣才可以？', goto: 'ask' },
            { label: '查看好感度',     goto: 'affection' },
        ] },
    ],
    ask: [
        { img: '整活/女仆思考.png', text: '我想想熬…' },
        { img: '整活/女仆嫌弃.png', text: '（这是儲值項目吧，我才不要和變態大叔做那種事情呢…）' },
        { img: '整活/女仆拒绝.png', text: '無可奉告！' },
    ],
    affection: [
        { img: '整活/女仆嫌弃.png', text: '还没充钱呢，不给看 ( ⩌⤚⩌)' },
        { img: '整活/女仆嫌弃.png', text: '当前好感度：-10086' },
    ],
    like: [
        { img: '整活/女仆开心捂嘴.png', text: 'ahaha，开心呀^^' },
        { img: '整活/女仆尴尬.png',     text: '（待って…我們好像沒賬號耶…）' },
        { img: '整活/女仆注目.png',     text: '主人玩得开心啦，下次再来吧' },
    ],
    leave: [
        { img: '整活/女仆注目.png', text: '主人要走了嗎？' },
        { img: '整活/女仆告别.png', text: 'Have fun~我等你喲♡' },
    ],
};
let updateCurFlow = null;
let updateIdx = 0;

function showUpdateStep() {
    const step = updateCurFlow[updateIdx];
    if (step.options) {
        // 选项步：不显示「繼續》」，选项渲染在对话框上方右侧；点对话框不推进
        aboutDialogNext.style.display = 'none';
        aboutOptions.innerHTML = '';
        step.options.forEach(o => {
            const b = document.createElement('div');
            b.className = 'about-option';
            b.textContent = o.label;
            b.addEventListener('click', (e) => {
                e.stopPropagation(); // 不触发 overlay 的退出/推进
                updateCurFlow = updateFlow[o.goto];
                updateIdx = 0;
                showUpdateStep();
            });
            aboutOptions.appendChild(b);
        });
        aboutOptions.style.display = 'flex';
    } else {
        aboutCharImg.classList.add('char-right'); // 女仆站右边
        showOverlayStep(step.img, step.text);
        aboutDialogNext.style.display = 'block';
        aboutOptions.style.display = 'none';
    }
}

// ---- 入口 & 统一交互 ----
document.getElementById('aboutUsBtn').addEventListener('click', () => {
    overlayMode = 'about';
    showAboutStep(0);
    aboutOverlay.style.display = 'flex';
});
document.getElementById('checkUpdateBtn').addEventListener('click', () => {
    overlayMode = 'update';
    updateCurFlow = updateFlow.start;
    updateIdx = 0;
    showUpdateStep();
    aboutOverlay.style.display = 'flex';
});
aboutOverlay.addEventListener('click', (e) => {
    if (e.target.closest('.about-option')) return; // 选项已自行处理
    if (e.target.closest('.about-overlay-dialog')) {
        if (overlayMode === 'about') {
            // 点对话框内：进入下一步
            if (aboutStepIndex < aboutSteps.length - 1) showAboutStep(aboutStepIndex + 1);
        } else if (overlayMode === 'update') {
            const step = updateCurFlow[updateIdx];
            if (!step.options) {
                // 对话步：点对话框推进；剧情结束则关闭
                if (updateIdx < updateCurFlow.length - 1) {
                    updateIdx++;
                    showUpdateStep();
                } else {
                    aboutOverlay.style.display = 'none';
                }
            }
            // 选项步：点对话框什么都不发生
        }
        return;
    }
    // 点选项/对话框以外：退出
    aboutOverlay.style.display = 'none';
});

// ---- 渲染人机选择列表（当前组打 ✅，点击即切换并持久化）----
function renderAiGroupList() {
    const container = document.getElementById('aiGroupList');
    container.innerHTML = '';
    const current = getSelectedAIGroup();
    for (const gid in AI_GROUPS) {
        const g = AI_GROUPS[gid];
        const isActive = current === gid;
        const item = document.createElement('div');
        item.className = 'preset-item' + (isActive ? ' selected' : '');
        item.style.cursor = 'pointer';
        item.innerHTML = `
            <div class="preset-info">
                <div class="preset-name">${g.module.name}${isActive ? ' ✅' : ''}</div>
                <div class="preset-meta"><span class="preset-key">📄 ${g.module.file || gid}</span></div>
            </div>`;
        item.onclick = () => {
            setSelectedAIGroup(gid);
            renderAiGroupList();
        };
        container.appendChild(item);
    }
    // 已创建但未加载成功的自定义组（文件没放好/语法错误）→ 灰色提示
    getCustomGroupRecords().forEach(rec => {
        if (AI_GROUPS[rec.id]) return;
        const item = document.createElement('div');
        item.className = 'preset-item';
        item.style.opacity = '0.55';
        item.innerHTML = `
            <div class="preset-info">
                <div class="preset-name">${rec.name}</div>
                <div class="preset-meta"><span class="preset-key">⚠️ 未加载：请将 ${rec.file} 放入 js/ai配置/ 目录（语法正确后刷新即可）</span></div>
            </div>`;
        container.appendChild(item);
    });
}

// ---- ➕ 新建 AI 行为组（下载模板文件，内容自己编写）----
function sanitizeGroupId(raw) {
    return String(raw || '').trim()
        .replace(/[\\/:*?"<>|]/g, '')                  // 文件名非法字符
        .replace(/\s+/g, '')                            // 去空白
        .replace(/[^\u4e00-\u9fa5A-Za-z0-9_-]/g, '');   // 只保留中文/字母/数字/下划线/短横线
}

function downloadAiGroupTemplate(name, id) {
    const file = 'ai' + id + '.js';
    const content = buildAiGroupTemplate(name, id, file);
    const blob = new Blob([content], { type: 'text/javascript;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    return file;
}

document.getElementById('createAiGroupBtn').addEventListener('click', () => {
    const input = prompt(`输入新 AI 行为组名字，将下载模板文件（内容需要自己编写）
例如：哥布林大师 → 下载 ai哥布林大师.js`);
    if (input === null) return;
    const id = sanitizeGroupId(input);
    if (!id) {
        alert('名字无效：只支持中文/字母/数字/下划线/短横线，且不能包含空格和 \\ / : * ? " < > |');
        return;
    }
    if (AI_GROUPS[id]) {
        alert('「' + id + '」已存在（内置或已创建过），请换一个名字');
        return;
    }
    const name = id + '组';
    const file = 'ai' + id + '.js';
    // 防止与内置组文件重名（如取名「测试组」→ ai测试组.js 会覆盖内置组）
    if (Object.values(AI_BUILTIN_FILES).includes(file)) {
        alert('该名字与内置组文件同名（' + file + '），请换一个名字');
        return;
    }
    downloadAiGroupTemplate(name, id);
    addCustomGroupRecord({ id, name, file });
    alert(`✅ 模板已下载：${file}

下一步：
① 打开该文件，自己编写行为逻辑（参考 js/ai配置/ai测试组.js）
② 保存到游戏的 js/ai配置/ 目录
③ 刷新页面 → 本列表出现「${name}」→ 点击选中即可生效`);
    renderAiGroupList();
});

// ---- 🔄 刷新：重新探测 js/ai配置/ 目录中的 AI 组文件并刷新列表 ----
// 原理：逐个重新加载 内置组(ai测试组/ai哥布林组/aiGEMINI组) + 记录过的自定义 aixx.js ——
//       能加载并自注册成功的保留为选项，文件缺失/语法错误（未识别）的自动移除。
let refreshingGroups = false;
document.getElementById('refreshAiGroupBtn').addEventListener('click', () => {
    refreshAiGroups();
});

function refreshAiGroups() {
    if (refreshingGroups) return;
    const pending = [];
    // 自定义组：全部重新探测（已注册的也能验证文件是否还在）
    getCustomGroupRecords().forEach(rec => pending.push({ id: rec.id, file: rec.file, kind: 'custom' }));
    // 内置组：全部重新探测
    Object.keys(AI_BUILTIN_FILES).forEach(id => pending.push({ id, file: AI_BUILTIN_FILES[id], kind: 'builtin' }));
    if (pending.length === 0) {
        renderAiGroupList();
        return;
    }
    refreshingGroups = true;
    let done = 0;
    const finish = () => {
        done++;
        if (done < pending.length) return;
        refreshingGroups = false;
        // 未识别（文件缺失/语法错误/未自注册）的自定义记录：从配置列表删除
        const kept = getCustomGroupRecords().filter(rec => AI_GROUPS[rec.id]);
        localStorage.setItem(AI_CUSTOM_GROUPS_KEY, JSON.stringify(kept));
        renderAiGroupList();
    };
    pending.forEach(p => {
        const s = document.createElement('script');
        s.src = 'js/ai配置/' + p.file + '?v=' + Date.now();
        s.onload = () => {
            // 内置组：文件加载成功 → 重新注册（删除后恢复立即生效）；自定义组由文件内 registerAIGroup 自注册
            if (p.kind === 'builtin') {
                const objName = AI_BUILTIN_GLOBALS[p.id];
                const g = objName && typeof window[objName] !== 'undefined' ? window[objName] : null;
                if (g) AI_GROUPS[p.id] = { module: g };
            }
            finish();
        };
        s.onerror = () => {
            delete AI_GROUPS[p.id]; // 文件不存在 → 从列表移除（内置/自定义通用）
            finish();
        };
        document.head.appendChild(s);
    });
}

// ---- 渲染预设列表 ----
function renderPresetList() {
    const presets = getPresets();
    const container = document.getElementById('presetList');
    const activeId = getActivePresetId();

    container.innerHTML = '';
    if (presets.length === 0) {
        container.innerHTML = '<div style="color:#666; text-align:center; padding:30px;">暂无配置，请点击「添加配置」新建</div>';
        return;
    }

    presets.forEach((preset, index) => {
        const item = document.createElement('div');
        const isActive = activeId === String(preset.id);
        item.className = 'preset-item' + (isActive ? ' selected' : '');

        const keyDisplay = preset.apiKey
            ? preset.apiKey.slice(0, 8) + '…' + preset.apiKey.slice(-4)
            : '未设置 Key';

        item.innerHTML = `
            <div class="preset-info">
                <div class="preset-name">${index + 1}. ${preset.name || '未命名'}${isActive ? ' ✅' : ''}</div>
                <div class="preset-meta">
                    <span class="preset-key">🔑 ${keyDisplay}</span>
                    <span>🌐 ${preset.model || '默认'}</span>
                </div>
            </div>
            <div class="preset-actions">
                <button class="preset-btn" data-id="${preset.id}" data-action="test">🧪 测试</button>
                <button class="preset-btn" data-id="${preset.id}" data-action="edit">✎ 编辑</button>
                <button class="preset-btn danger" data-id="${preset.id}" data-action="delete">✕</button>
            </div>
        `;

        // 点击整行 = 设为激活（不进入游戏，纯管理）
        item.addEventListener('click', (e) => {
            if (e.target.closest('.preset-actions')) return;
            const presets = getPresets();
            const p = presets.find(p => String(p.id) === String(preset.id));
            if (p) {
                setActivePreset(p.id);
                renderPresetList();
            }
        });

        // 🧪 测试按钮
        item.querySelector('.preset-btn[data-action="test"]').addEventListener('click', (e) => {
            e.stopPropagation();
            testSinglePreset(preset, item);
        });

        // ✎ 编辑按钮
        item.querySelector('.preset-btn[data-action="edit"]').addEventListener('click', (e) => {
            e.stopPropagation();
            openEditModal(preset);
        });

        // ✕ 删除按钮
        item.querySelector('.preset-btn.danger').addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`确定删除配置「${preset.name}」吗？`)) {
                deletePreset(preset.id);
                renderPresetList();
            }
        });

        container.appendChild(item);
    });
}

/** 测试单个预设连接 */
async function testSinglePreset(preset, itemEl) {
    const resultDiv = document.createElement('div');
    resultDiv.className = 'preset-test-result';
    resultDiv.innerHTML = '<span style="color:#94a3b8;">⏳ 测试中...</span>';
    // 插入到操作按钮下方
    const actions = itemEl.querySelector('.preset-actions');
    const oldResult = itemEl.querySelector('.preset-test-result');
    if (oldResult) oldResult.remove();
    actions.after(resultDiv);

    const safetyTimer = setTimeout(() => {
        resultDiv.innerHTML = '<span style="color:#f87171;">❌ 连接超时</span>';
    }, 15000);

    const res = await testLlmConnection(
        preset.apiKey,
        preset.baseUrl || 'https://api.openai.com/v1',
        preset.model || 'gpt-4o-mini',
        preset.proxyUrl || ''
    );
    clearTimeout(safetyTimer);

    if (res.success) {
        resultDiv.innerHTML = `<span style="color:#4ade80;">✅ 连接成功 · ${res.latency}ms</span>`;
    } else {
        resultDiv.innerHTML = `<span style="color:#f87171;">❌ 连接失败${res.latency !== null ? `（${res.latency}ms）` : ''}：${res.error}</span>`;
    }
}

/** 用指定预设开始 AI 对战 */
function startGameWithPreset(preset) {
    if (!preset.apiKey) {
        alert('该配置未设置 API Key，请先编辑！');
        return;
    }
    if (!preset.apiKey.startsWith('sk-')) {
        alert('API Key 格式似乎不对，应以 sk- 开头');
        return;
    }

    applyPreset(preset);
    document.getElementById('aiPresetModal').style.display = 'none';

    game.gameMode = 'api';
    homePage.style.display = 'none';
    gamePage.style.display = 'flex';
    document.querySelector('.top-bar span:last-child').textContent = '🤖 AI对战 (LLM)';
    renderCardPanel('deck'); // 只显示卡组中的牌
    resetGame();
}

// ---- 编辑/添加弹窗 ----
let editingPresetId = null; // null = 新增模式

function openEditModal(preset) {
    editingPresetId = preset ? preset.id : null;
    document.getElementById('editModalTitle').textContent = preset
        ? `📝 编辑配置 - ${preset.name}`
        : '📝 添加新配置';
    document.getElementById('editName').value      = preset ? preset.name : '';
    document.getElementById('editApiKey').value     = preset ? preset.apiKey : '';
    document.getElementById('editBaseUrl').value    = preset ? preset.baseUrl : '';
    document.getElementById('editProxyUrl').value   = preset ? preset.proxyUrl : '';
    document.getElementById('editModel').value      = preset ? preset.model : '';
    document.getElementById('aiEditModal').style.display = 'flex';
}

// 保存
document.getElementById('savePresetBtn').addEventListener('click', () => {
    const name    = document.getElementById('editName').value.trim();
    const apiKey  = document.getElementById('editApiKey').value.trim();
    const baseUrl = document.getElementById('editBaseUrl').value.trim() || 'https://api.openai.com/v1';
    const proxyUrl= document.getElementById('editProxyUrl').value.trim();
    const model   = document.getElementById('editModel').value.trim() || 'gpt-4o-mini';

    if (!name) { alert('请输入配置名称！'); return; }
    if (!apiKey) { alert('请输入 API Key！'); return; }
    if (!apiKey.startsWith('sk-')) { alert('API Key 格式似乎不对，应以 sk- 开头'); return; }

    savePreset({
        id: editingPresetId,
        name,
        apiKey,
        baseUrl,
        proxyUrl,
        model,
    });

    document.getElementById('aiEditModal').style.display = 'none';
    renderPresetList(); // 刷新列表
});

// 取消编辑
document.getElementById('cancelEditBtn').addEventListener('click', () => {
    document.getElementById('aiEditModal').style.display = 'none';
});

// 测试连接（编辑弹窗中）
document.getElementById('testPresetBtn').addEventListener('click', async () => {
    const apiKey  = document.getElementById('editApiKey').value.trim();
    const baseUrl = document.getElementById('editBaseUrl').value.trim() || 'https://api.openai.com/v1';
    const proxyUrl= document.getElementById('editProxyUrl').value.trim();
    const model   = document.getElementById('editModel').value.trim() || 'gpt-4o-mini';
    const resultDiv = document.getElementById('editTestResult');

    if (!apiKey) { resultDiv.innerHTML = '<span style="color:#f87171;">⚠️ 请先输入 API Key</span>'; return; }
    resultDiv.innerHTML = '<span style="color:#94a3b8;">⏳ 测试中（最长等待8秒）...</span>';

    const safetyTimer = setTimeout(() => {
        resultDiv.innerHTML = '<span style="color:#f87171;">❌ 连接超时，请检查地址是否正确</span>';
    }, 15000);

    const res = await testLlmConnection(apiKey, baseUrl, model, proxyUrl);
    clearTimeout(safetyTimer);

    if (res.success) {
        resultDiv.innerHTML = `<span style="color:#4ade80;">✅ 连接成功！延迟：${res.latency}ms</span>`;
    } else {
        resultDiv.innerHTML = `<span style="color:#f87171;">❌ 连接失败${res.latency !== null ? `（${res.latency}ms）` : ''}：${res.error}</span>`;
    }
});

// ---- 添加新配置 ----
document.getElementById('addPresetBtn').addEventListener('click', () => {
    openEditModal(null); // null = 新增模式
});

// ---- 关闭预设选择弹窗 ----
document.getElementById('closePresetModalBtn').addEventListener('click', () => {
    document.getElementById('aiPresetModal').style.display = 'none';
});

// 点击弹窗外部关闭（点击遮罩层）
document.getElementById('aiPresetModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
        e.currentTarget.style.display = 'none';
    }
});
document.getElementById('aiEditModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
        e.currentTarget.style.display = 'none';
    }
});

// ---- 页面切换：游戏 → 主页 ----
/** 返回主页（联机时顺带断开 P2P 会话） */
function goBackHome() {
    if (NET_ROLE || isOnlineMode()) netLeaveRoom();
    // 隐藏双人模式顶部UI
    document.getElementById('topElixirBar').style.display = 'none';
    document.getElementById('topCardPanel').style.display = 'none';
    // 恢复下方卡牌面板显示（联机 Client 模式下曾被隐藏）
    document.getElementById('cardPanel').style.display = '';
    // 恢复下方圣水标签为 AI
    document.getElementById('rightElixirLabel').innerHTML = 'AI 圣水 <span id="aiElixirDisplay">5.0</span>';
    // 重置联机状态（避免残留角色标记影响下次进入）
    game.gameMode = 'classic';
    gamePage.style.display = 'none';
    homePage.style.display = 'flex';
}
document.getElementById('backToHomeBtn').addEventListener('click', goBackHome);

// ---- 帧率限制设置（0=不限制，60/30，localStorage 记忆）----
let fpsLimit = 0;
try {
    fpsLimit = parseInt(localStorage.getItem('towerwar_fps_limit') || '0', 10) || 0;
    if (!fpsLimit && typeof TOWERWAR_USERDATA !== 'undefined' && TOWERWAR_USERDATA.settings) {
        // 本地无设置：回退读取「個人データ.js」（私人数据文件，可删除）中的设置
        fpsLimit = parseInt(TOWERWAR_USERDATA.settings.fpsLimit || '0', 10) || 0;
    }
} catch (e) { fpsLimit = 0; }
let lastFrameTs = 0;

// ---- 游戏循环（Fixed Timestep：逻辑固定 30Hz tick，渲染 rAF + 插值）----
let lastTimestamp = 0;      // 上一渲染帧时间戳
let tickAccumulator = 0;    // 累计未消费的逻辑时间（秒）

function gameLoop(ts) {
    requestAnimationFrame(gameLoop);   // 先注册下一帧，跳帧时才不会断循环
    // 帧率上限：rAF 时间节流（未到间隔就跳过本帧；0=不限制）——只管渲染帧率，与逻辑 tick 解耦
    if (fpsLimit > 0) {
        if (ts - lastFrameTs < 1000 / fpsLimit) return;
        lastFrameTs = ts;
    }
    if (gamePage.style.display === 'flex') {
        if (!lastTimestamp) lastTimestamp = ts;
        tickAccumulator += Math.min(0.1, (ts - lastTimestamp) / 1000);
        lastTimestamp = ts;

        // 逻辑帧推进：固定步长 FIXED_DELTA；联机只在已到期远程输入缺失时等待
        // +1e-9 容差：消除浮点累积到 1/30 边界时偶尔卡一帧的抖动（Fixed Timestep 经典问题）
        let steps = 0;
        let froze = false;
        while (tickAccumulator + 1e-9 >= FIXED_DELTA && steps < MAX_STEPS_PER_FRAME) {
            if (!canAdvanceTick()) {
                froze = true;
                // 🔗 Lockstep 等待远程输入：保留累积时间，恢复后只消费必要的逻辑步。
                // 设为一个逻辑步以内，避免网络恢复后出现追帧，同时保留插值连续性。
                tickAccumulator = Math.min(tickAccumulator, FIXED_DELTA);
                break;
            }
            update(FIXED_DELTA);            // ⭐ 恒定步长，不再传变长 delta
            tickAccumulator -= FIXED_DELTA;
            steps++;
        }
        if (steps >= MAX_STEPS_PER_FRAME) tickAccumulator = 0; // 防螺旋死亡（卡顿后不追帧）
        if (steps > 0 || froze) onLogicTick();  // 🔗 本逻辑帧推进后（或冻结期间）由 network.js 决定是否发 SYNC 心跳/哈希

        // 渲染插值：alpha ∈ [0,1)，距上一逻辑帧的进度（render.js draw 内做坐标投影）
        draw(Math.min(1, tickAccumulator / FIXED_DELTA));  // draw() 内部末尾已自动调用 drawHoverUI()
    } else {
        lastTimestamp = 0;
        tickAccumulator = 0;
    }
}

// ---- 启动！----
setupUI();
requestAnimationFrame(gameLoop);

// ---- 帧率设置绑定（主页设置栏）----
(function initFpsSetting() {
    const sel = document.getElementById('fpsLimitSelect');
    if (!sel) return;
    sel.value = String(fpsLimit);
    sel.addEventListener('change', () => {
        fpsLimit = parseInt(sel.value, 10) || 0;
        try { localStorage.setItem('towerwar_fps_limit', String(fpsLimit)); } catch (e) { /* ignore */ }
    });
})();

// ===================================================================
// 💾 导出数据文件（個人データ.js）：把当前预设/卡组/设置打包下载
// ⚠️ 生成的文件包含 API Key，分享游戏前请删除「個人データ.js」！
// ===================================================================
function exportUserDataFile() {
    // ⚠️ 先弹确认子界面（写明使用方法与风险，防止误触），确认后才真正导出
    const modal = document.getElementById('exportConfirmModal');
    if (modal) { modal.style.display = 'flex'; return; }
    // 兜底：页面没有确认界面时直接导出
    doExportUserDataFile();
}

/** 真正执行导出（下载「個人データ.js」） */
function doExportUserDataFile() {
    const safeGet = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };
    const data = {
        presets: safeGet(() => (typeof getPresets === 'function' ? getPresets() : []), []),
        activePresetId: safeGet(() => localStorage.getItem('towerwar_active_preset_id'), null),
        decks: safeGet(() => (typeof getDecks === 'function' ? getDecks() : []), []),
        activeDeckId: safeGet(() => localStorage.getItem('towerwar_active_deck_id'), null),
        settings: {
            fpsLimit: safeGet(() => parseInt(localStorage.getItem('towerwar_fps_limit') || '0', 10) || 0, 0)
        }
    };
    const content = `/* ============================================================
 * 個人データ.js — ⚠️ 私人数据文件（分享游戏前请删除本文件！）
 * ============================================================
 * 本文件由游戏主页「💾 导出数据文件」按钮自动生成。
 * ⚠️ 包含 AI 预设（含 API Key）、卡组、设置等私人数据！
 * 把游戏分享给他人前，请删除本文件（游戏会自动回退内置默认）。
 * ============================================================ */
window.TOWERWAR_USERDATA = ${JSON.stringify(data, null, 4)};
`;
    try {
        const blob = new Blob([content], { type: 'text/javascript;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '個人データ.js';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        alert('✅ 已导出「個人データ.js」（含你的预设/卡组/设置）\n\n⚠️ 该文件包含 API Key！\n分享游戏前请删除「個人データ.js」，或直接不发送该文件。');
    } catch (e) {
        alert('❌ 导出失败（浏览器限制）：' + e.message);
    }
}

// ---- 导出确认子界面按钮绑定（等 DOM 就绪再绑，防止弹窗在脚本之后解析导致绑定失败）----
(function initExportModal() {
    function bind() {
        const modal = document.getElementById('exportConfirmModal');
        if (!modal) return;
        const confirmBtn = document.getElementById('exportConfirmBtn');
        const cancelBtn  = document.getElementById('exportCancelBtn');
        if (confirmBtn) confirmBtn.addEventListener('click', () => { modal.style.display = 'none'; doExportUserDataFile(); });
        if (cancelBtn)  cancelBtn.addEventListener('click', () => { modal.style.display = 'none'; });
        // 点击遮罩空白处关闭
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
        // Esc 键关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.display === 'flex') modal.style.display = 'none';
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();


// ===================================================================
// 📥 导入数据文件（個人データ.js）：选择文件 → 识别数据 → 写入浏览器本地
// 用于换电脑/换浏览器时把导出的数据搬回来；导入后刷新页面生效。
// ===================================================================
function importUserDataFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.js,application/javascript,text/javascript';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) { document.body.removeChild(input); return; }
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const text = String(reader.result || '');
                const objText = extractUserdataObject(text);
                if (!objText) throw new Error('未识别到 TOWERWAR_USERDATA 数据，请确认选择的是导出的「個人データ.js」文件');
                let obj = null;
                try { obj = JSON.parse(objText); }
                catch (e1) {
                    try { obj = new Function('return (' + objText + ');')(); }
                    catch (e2) { throw new Error('数据格式无法解析，文件可能已损坏'); }
                }
                let nPreset = 0, nDeck = 0;
                if (Array.isArray(obj.presets)) {
                    if (typeof setPresets === 'function') setPresets(obj.presets);
                    nPreset = obj.presets.length;
                }
                if (obj.activePresetId !== undefined && obj.activePresetId !== null) {
                    try { localStorage.setItem('towerwar_active_preset_id', String(obj.activePresetId)); } catch (e) {}
                }
                if (Array.isArray(obj.decks)) {
                    if (typeof setDecks === 'function') setDecks(obj.decks);
                    nDeck = obj.decks.length;
                }
                if (obj.activeDeckId !== undefined && obj.activeDeckId !== null) {
                    try { localStorage.setItem('towerwar_active_deck_id', String(obj.activeDeckId)); } catch (e) {}
                }
                if (obj.settings && obj.settings.fpsLimit !== undefined) {
                    try { localStorage.setItem('towerwar_fps_limit', String(obj.settings.fpsLimit)); } catch (e) {}
                }
                alert('✅ 导入成功！\n\n预设 ' + nPreset + ' 个 / 卡组 ' + nDeck + ' 套 / 设置已恢复\n\n请刷新页面（F5）让数据生效。');
            } catch (e) {
                alert('❌ 导入失败：' + e.message);
            }
            document.body.removeChild(input);
        };
        reader.onerror = () => { alert('❌ 读取文件失败'); document.body.removeChild(input); };
        reader.readAsText(file);
    });

    input.click();
}

/** 从文件文本中提取 window.TOWERWAR_USERDATA = {...} 的对象字面量（括号配对，容错嵌套） */
function extractUserdataObject(text) {
    const idx = text.indexOf('window.TOWERWAR_USERDATA');
    if (idx < 0) return null;
    const eq = text.indexOf('=', idx);
    if (eq < 0) return null;
    const start = text.indexOf('{', eq);
    if (start < 0) return null;
    let depth = 0, inStr = false, strCh = '';
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (c === '\\') { i++; continue; }
            if (c === strCh) inStr = false;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
}

// ---- 导出数据文件按钮绑定（主页配置区）----
(function initExportDataBtn() {
    const btn = document.getElementById('exportDataBtn');
    if (btn) btn.addEventListener('click', exportUserDataFile);
    const imp = document.getElementById('importDataBtn');
    if (imp) imp.addEventListener('click', importUserDataFile);
})();
