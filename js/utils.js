/* ===== utils.js — 纯工具函数（无副作用） ===== */

// ⚠️ PRNG 例外登记：以下 rand()/setRandomSeed() 是本文件唯一的有状态工具。
//    状态为模块级种子变量（非 game 对象），不违反「不得读写 game」约束；
//    它是联机确定性的核心（同种子两端随机完全一致），与 update.js 圣水 DOM 特例对等登记。

// ---- 联机前置：确定性 PRNG（Mulberry32）----
let __prngSeed = (Date.now() >>> 0) || 1;   // 默认种子：系统时间戳（单机行为与旧版随机无感知差异）

/** 设置随机种子（每局初始化时调用；联机开局同步一个数字种子即可两端一致） */
function setRandomSeed(seed) {
    __prngSeed = (seed >>> 0) || 1;
}

/** 获取当前随机种子（联机开局同步用） */
function getRandomSeed() {
    return __prngSeed >>> 0;
}

/** Mulberry32 伪随机数（返回 [0,1)，替代游戏逻辑内所有 Math.random()） */
function rand() {
    __prngSeed = (__prngSeed + 0x6D2B79F5) | 0;
    let t = Math.imul(__prngSeed ^ (__prngSeed >>> 15), 1 | __prngSeed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---- 联机前置：阵营对称化工具 ----

/** 返回对方阵营键（'player' ↔ 'ai'；未来联机时本机绑定其一、远端绑定另一） */
function opponentTeam(team) {
    return team === 'player' ? 'ai' : 'player';
}

// ---- 联机前置：坐标系统与视角翻转抽象（Screen ↔ World）----
// 世界坐标 = 逻辑层统一坐标（蓝方下方 Y 大、红方上方 Y 小）；
// 屏幕坐标 = 当前视角下的渲染坐标。
// isFlipped=true 表示当前视角为红方（上下镜像：y → H - y；x 不翻转，横屏左右方向不变）。
// 逻辑层（update.js / entities.js）始终使用世界坐标，渲染层未来通过此函数做视角适配。

/** 世界坐标 → 屏幕坐标 */
function worldToScreen(x, y, isFlipped) {
    return isFlipped ? { x: x, y: H - y } : { x: x, y: y };
}

/** 屏幕坐标 → 世界坐标（点击/交互反算用） */
function screenToWorld(sx, sy, isFlipped) {
    return isFlipped ? { x: sx, y: H - sy } : { x: sx, y: sy };
}

/** 计算两点距离 */
function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 🧭 判断实体是否为可被烟引引导的友军单位：存活、同阵营、非建筑（兵种/召唤物/守卫均可） */
function isFriendlyTroop(e, team) {
    if (!e || e.hp <= 0 || e.team !== team) return false;
    if (e.type === 'tower' || e.type === 'barrack' || e.type === 'collector'
        || e.type === 'bastion' || e.type === 'main_tower') return false;
    return true;
}

/** 检查坐标是否在己方可部署区域
 *  - aiBastionsLost: 敌方(AI)堡垒被摧毁数（影响玩家可部署区）
 *  - playerBastionsLost: 己方(玩家)堡垒被摧毁数（影响AI可部署区）
 *  - 默认0: 不扩展，仅己方半场
 *  - ≥1: 扩展到河界对岸
 *  - ≥2: 扩展到敌方堡垒虚线
 *  - riverL/riverR: 河道左右边界（可选，默认标准河道；🧪测试双人（本机）传入缩窄河道 MODE_TEST_RIVER_*）
 *  - aiBastionTopX: 敌方(AI)堡垒线 x（可选，默认标准 1200；🧪测试双人传入 MODE_TEST_AI_BASTION_TOP.x=1050，随整图缩窄）
 */
function isInHalf(x, y, isPlayer, aiBastionsLost = 0, playerBastionsLost = 0, riverL = RIVER_LEFT, riverR = RIVER_RIGHT, aiBastionTopX = AI_BASTION_TOP.x) {
    if (x < 30 || x > W - 30 || y < 30 || y > H - 30) return false;

    if (isPlayer) {
        let rightBoundary = riverL;
        if (aiBastionsLost >= 2) rightBoundary = aiBastionTopX;
        else if (aiBastionsLost >= 1) rightBoundary = riverR;

        // 河道仅在边界未扩展过河时保持不可部署
        if (rightBoundary <= riverL && x > riverL && x < riverR) return false;
        return x < rightBoundary;
    } else {
        let leftBoundary = riverR;
        if (playerBastionsLost >= 2) leftBoundary = PLAYER_BASTION_TOP.x;
        else if (playerBastionsLost >= 1) leftBoundary = riverL;

        if (leftBoundary >= riverR && x > riverL && x < riverR) return false;
        return x > leftBoundary;
    }
}

/** 检查部署合法性（纯函数：所有可变状态均由调用方传入，不读写 game）
 *  - entities：实体列表（建筑重叠检测用），由调用方传入（如 game.entities）
 *  - aiBastionsLost / playerBastionsLost：堡垒摧毁数，决定可部署区边界扩展（默认 0=未丢堡）
 *  - riverL/riverR：河道左右边界（可选，默认标准河道；🧪测试双人（本机）传入缩窄河道，透传给 isInHalf）
 *  - aiBastionTopX：敌方(AI)堡垒线 x（可选，默认标准；🧪测试双人传入缩窄坐标，透传给 isInHalf）
 *  - 建筑类部署时额外检查：不能与其他已有建筑/堡垒/主塔重叠
 */
function canDeployHere(cardId, team, x, y, entities, aiBastionsLost = 0, playerBastionsLost = 0, riverL = RIVER_LEFT, riverR = RIVER_RIGHT, aiBastionTopX = AI_BASTION_TOP.x) {
    const card = CARDS[cardId];
    if (!card) return false;
    if (x < 30 || x > W - 30 || y < 30 || y > H - 30) return false;
    // 法术 & 任意位置标记卡（如矿工/钻机）：不受半场/河流限制，可部署于任意位置（例外：halfOnly 法术如滚木按军队规则限己方半场）
    if ((card.type === 'spell' && !card.halfOnly) || card.anywhere) {
        // ★ 建筑类全图可放（如哥布林钻机）仍需避开已有建筑/堡垒/主塔，避免重叠
        if (card.type === 'tower' || card.type === 'barrack' || card.type === 'collector') {
            return !overlapsBuilding(cardId, x, y, entities);
        }
        return true;
    }
    // 堡垒摧毁数由调用方传入，决定可部署区的边界扩展
    if (!isInHalf(x, y, team === 'player', aiBastionsLost, playerBastionsLost, riverL, riverR, aiBastionTopX)) return false;

    // ★ 建筑类部署：检查是否与已有建筑/堡垒/主塔重叠
    if (card.type === 'tower' || card.type === 'barrack' || card.type === 'collector'
        || card.type === 'bastion' || card.type === 'main_tower') {
        return !overlapsBuilding(cardId, x, y, entities);
    }

    return true;
}

/** 建筑重叠检查：返回 true 表示与已有建筑/堡垒/主塔重叠（不可部署） */
function overlapsBuilding(cardId, x, y, entities) {
    const eList = entities || [];
    const buildingTypes = new Set(['tower', 'barrack', 'collector', 'bastion', 'main_tower']);
    for (const e of eList) {
        if (e.hp <= 0) continue;
        if (!buildingTypes.has(e.type)) continue;
        const dist = Math.hypot(x - e.x, y - e.y);
        const minDist = 15 + getEntityHalfSize(e);  // 建筑半宽15 + 对方半宽
        if (dist < minDist) return true;
    }
    return false;
}

/** 获取实体碰撞半宽（用于部署重叠检测） */
function getEntityHalfSize(e) {
    if (e.type === 'bastion' || e.type === 'main_tower') return 28;
    return 15;  // 普通建筑（tower / barrack / collector 均为 30x30 方块）
}
