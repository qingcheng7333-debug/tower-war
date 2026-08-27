/* ===== gameState.js — 游戏运行时状态管理 ===== */

/** 创建全新游戏状态对象（game 初始定义与 resetGame 共用同一工厂，避免字段写两遍） */
function createGameState(gameMode) {
    return {
        gameMode: gameMode || 'classic',      // 'classic' | 'api' —— 经典AI vs API AI
        // ── 阵营对称数据（联机前置：按 team 键索引；单机时 'ai' 键交给本地 AI 托管）──
        elixir: { player: 5.0, ai: 5.0 },          // 原 playerElixir/aiElixir
        maxElixir: 10,
        baseElixirRate: 1 / 2.8,
        elixirMultiplier: { player: 1.0, ai: 1.0 }, // 原 playerElixirMultiplier/aiElixirMultiplier
        bastionsLost: { player: 0, ai: 0 },         // 原 playerBastionsLost/aiBastionsLost
        lastBastionPromptLevel: 0,  // 0=未提示 1=已提示1.2x 2=已提示1.4x

        entities: [],
        bombs: [],
        gameOver: false,
        winner: null,
        time: 0,
        tick: 0,   // 当前逻辑帧号（Fixed Timestep；联机双方以此为准同步）
        // ---- 本地 UI 状态（联机前置：与核心战斗状态分离，不参与状态同步/快照）----
        // 收纳理由：这些字段是纯本地交互数据（选中/悬停/鼠标/失败提示），
        // 序列化同步时应排除；核心战斗状态（实体/圣水/特效/冷却）保持在 game 顶层。
        uiState: {
            selectedCardId: null,
            selectedCardId2: null,  // 双人模式 - 红方（上方玩家）选中卡牌
            deployFailReason: null, // 最近一次 deploy 失败的简要原因：'elixir'|'position'|'cooldown'|'invalid'|'elite_used'
            mouseX: 0,
            mouseY: 0,
            hoveredEntity: null,
            _lastClick: null,       // 技能卡双击判定窗口（ui.js 动态维护）
        },
        // lastDeployedCardId / lastDeployedCardId2 保留在顶层：镜像法术依赖它们，属于战斗数据（非纯 UI）
        lastDeployedCardId: null,  // 蓝方上一次部署的卡牌（供镜像法术使用）
        lastDeployedCardId2: null, // 红方上一次部署的卡牌（供镜像法术使用）
        aiDecisionTimer: 0,
        aiThinking: false,
        // ---- 可视化特效 ----
        projectiles: [],    // 弹道：{ x, y, tx, ty, char, size, speed, timer }
        spellEffects: [],   // 法术特效：{ x, y, char, size, timer, maxTimer }
        dmgNumbers: [],     // 伤害飘字：{ x, y, amount, color, timer, maxTimer }
        // ---- 部署延迟队列 ----
        deploying: [],      // { cardId, team, x, y, timer, totalDelay, isPlayer }
        // ---- 闪电链特效 ----
        lightningChains: [], // { points: [{x,y},...], timer, maxTimer }
        // ---- 落雷特效（雷电法师部署） ----
        deployLightnings: [], // { x, y, length, timer, maxTimer }
        // ---- 范围冲击特效（超级骑士部署） ----
        deployEffects: [], // { x, y, radius, timer, maxTimer }
        // ---- 穿透箭（游侠）----
        pierceArrows: [],
        // ---- 极速法术加速区域 ----
        speedZones: [],  // { x, y, radius, timer, maxTimer, team }
        // ---- 狂暴法术狂暴区域 ----
        rageZones: [],   // { x, y, radius, timer, maxTimer, team, boostDuration }
        // ---- 冰冻法术冰封区域 ----
        freezeZones: [], // { x, y, radius, timer, maxTimer }
        // ---- 🧪 哥布林魔咒诅咒领域 ----
        curseZones: [],  // { x, y, radius, timer, maxTimer, team, dps, tickTimer, bubbleTimer, bubbles[] }
        // ---- 🧭 烟引法术：引导待选点 + 活跃引导 ----
        smokeGuidePick: null, // { team, unitId } 已扣费、待选放烟点（引导中，无法取消）
        smokeGuides: [],      // { team, unitId, tx, ty, phase:'countdown'|'active', countdown, countdownMax, timer, maxTimer, isPlayer }
        lastSmokeGuide: null, // { team, unitId, tx, ty, time } 最近一次烟引记录（供镜像烟引特殊版续引导原目标）
        // ---- 箭雨三段延迟伤害 ----
        arrowRainStrikes: [], // { x, y, radius, team, damage, mul, strikesLeft, interval, timer }
        // ---- 🔥 火球术：从主塔抛物线飞向落点（落地结算伤害+击退+爆炸）----
        fireballFlights: [], // { x0, y0, x1, y1, x, y, team, radius, damage, mul, knockback, timer, maxTimer }
        // ---- 🚀 火箭法术：主塔开洞→火箭钻出垂直升空出屏→出屏等待→落点影子逼近→命中（5s，命中后蘑菇云尾段1s）----
        rocketFlights: [], // { x, y, team, radius, damage, mul, timer, maxTimer, tx, ty, cloud }
        // ---- 🪵 滚木：竖直木头（长65px厚7px）横向滚动560px（法术影响范围：长560px×宽65px；只打地面不影响空中；沿途伤害+击退，每敌仅结算一次）----
        logRolls: [], // { x, y, dir, team, halfW, damage, knockback, speed, distance, logLength, logWidth, startX, hitIds:Set }
        // ---- 地震法术三段延迟伤害（持续3秒，对建筑10倍）----
        earthquakeStrikes: [], // { x, y, radius, team, damage, buildingMul, strikesLeft, interval, timer }
        // ---- 大雷电：三道落雷延迟结算（每0.5秒一道，锁定生命值最高者）----
        thunderStrikes: [], // { x, y, radius, team, damage, towerDmgMul, targets, strikeIndex, interval, timer }
        // ---- 👑 小王子护驾：延迟1s召唤王子增援 ----
        princeGuardSpawns: [], // { ownerId, timer, x, y, dirX, dirY, team }
        // ---- 🦇 蝙蝠法术：延迟分批召唤（释放1秒后开始，每0.2秒出2只，共6只）----
        batSpawns: [], // { x, y, radius, team, wavesLeft, perWave, interval, timer }
        // ---- 🛢️ 哥布林飞桶：木桶从主塔抛物线飞向落点（落地摔出3只哥布林）----
        goblinBarrels: [], // { x0, y0, x1, y1, team, radius, count, timer, maxTimer }
        // ---- 🌧️ 箭雨：三波独立抛出（每波等 launchDelay 后完整「发射>飞行>落地特效+伤害」，共3段）----
        arrowRainFlights: [], // { x0, y0, x1, y1, team, radius, damage, mul, strikes, interval, arrows, launchDelay, timer, maxTimer }
        // ---- 卡牌冷却追踪 ----
        cardCooldowns: {
            player: {},
            ai: {}
        },
        // ---- 🕊️ 精英主动技能状态（通用机制，未来精英英雄共用）----
        // 每张带 activeSkill 的卡：{ mode: 'deploy'|'skill'|'used', cdLeft, skillCdLeft }
        //   deploy = 可部署（cdLeft 为死亡冷却，死亡后才开始计时）
        //   skill  = 已部署，卡牌变为技能（释放后进入技能冷却 skillCdLeft，冷却结束可再次释放）
        //   used   = （保留）技能已释放变黑；等精英死亡后恢复 deploy + 开始死亡冷却
        eliteSkills: (() => {
            const init = { player: {}, ai: {} };
            for (const id of CARD_IDS) {
                if (CARDS[id] && CARDS[id].activeSkill) {
                    init.player[id] = { mode: 'deploy', cdLeft: 0, skillCdLeft: 0 };
                    init.ai[id] = { mode: 'deploy', cdLeft: 0, skillCdLeft: 0 };
                }
            }
            return init;
        })(),
    };
}

// ---- 全局游戏状态对象 ----
let game = createGameState('classic');

// ---- 实体 ID 计数器 ----
let entityIdCounter = 1;

// ---- 重置所有状态 ----
function resetGame(seed) {
    setRandomSeed(seed !== undefined ? seed : (Date.now() >>> 0));  // 联机前置：开局同步种子（单机用时间戳）
    game = createGameState(game.gameMode);  // 保留当前模式
    entityIdCounter = 1;

    // ---- 开局创建双方主塔（建筑，不可被治疗）----
    const mainTowerSpawns = [
        { t: 'player', x: PLAYER_TOWER.x, y: PLAYER_TOWER.y },
        { t: 'ai',     x: AI_TOWER.x,     y: AI_TOWER.y },
    ];
    for (const s of mainTowerSpawns) {
        game.entities.push(createEntity({
            type: 'main_tower', team: s.t, cardId: 'main_tower', fortification: true,
            x: s.x, y: s.y,
            hp: 5000, maxHp: 5000,
            shield: 2000, maxShield: 2000,  // 🛡️ 主塔护盾2000（通用护盾机制）：护盾未破前伤害全被吸收，护盾破碎后召唤主塔守卫
            atk: 0, atkSpeed: 0, atkCooldown: 0,
            range: 0,
            hitRadius: 28,  // 受击半径（匹配圆形视觉半径r=28，贴边即可攻击）
        }));
    }

    // ---- 开局创建双方的堡垒（每边两个）----
    const bastionSpawns = [
        { t: 'player', x: PLAYER_BASTION_TOP.x,    y: PLAYER_BASTION_TOP.y },
        { t: 'player', x: PLAYER_BASTION_BOTTOM.x, y: PLAYER_BASTION_BOTTOM.y },
        { t: 'ai',     x: AI_BASTION_TOP.x,        y: AI_BASTION_TOP.y },
        { t: 'ai',     x: AI_BASTION_BOTTOM.x,     y: AI_BASTION_BOTTOM.y },
    ];
    for (const s of bastionSpawns) {
        game.entities.push(createEntity({
            type: 'bastion', team: s.t, cardId: 'bastion', fortification: true,
            x: s.x, y: s.y,
            hp: BASTION_STATS.hp, maxHp: BASTION_STATS.hp,
            atk: BASTION_STATS.atk, atkSpeed: BASTION_STATS.atkSpeed, atkCooldown: 0,
            range: BASTION_STATS.range,
            hitRadius: 28,  // 受击半径（匹配圆形视觉半径r=28，贴边即可攻击）
        }));
    }

    // 清除卡牌选中状态（上下都清）——DOM 操作归 ui.js（基础框架第6条）
    clearCardSelection();
}

/**
 * 联机前置：导出纯净的战场状态快照（可 JSON 序列化，不含本地 UI 交互状态）。
 * 用途：联机状态同步 / 调试快照 / 观战广播。核心战斗数据（实体/圣水/特效队列/冷却）全量导出。
 * 注意：logRolls 的 hitIds 为 Set，JSON 序列化时会退化为 {}——未来联机序列化时需按需转换。
 */
function getBattleStateSnapshot() {
    const g = game;
    return {
        version: 1,
        tick: g.tick,
        time: g.time,
        gameMode: g.gameMode,
        gameOver: g.gameOver,
        winner: g.winner,
        // 阵营对称数据
        elixir: { player: g.elixir.player, ai: g.elixir.ai },
        elixirMultiplier: { player: g.elixirMultiplier.player, ai: g.elixirMultiplier.ai },
        bastionsLost: { player: g.bastionsLost.player, ai: g.bastionsLost.ai },
        lastDeployedCardId: g.lastDeployedCardId,
        lastDeployedCardId2: g.lastDeployedCardId2,
        cardCooldowns: g.cardCooldowns,
        eliteSkills: g.eliteSkills,
        // 实体与部署队列
        entities: g.entities.map(e => ({ ...e })),
        deploying: g.deploying,
        // 特效队列（视觉一致性）
        projectiles: g.projectiles, spellEffects: g.spellEffects, dmgNumbers: g.dmgNumbers,
        lightningChains: g.lightningChains, deployLightnings: g.deployLightnings,
        deployEffects: g.deployEffects, pierceArrows: g.pierceArrows,
        speedZones: g.speedZones, rageZones: g.rageZones, freezeZones: g.freezeZones,
        curseZones: g.curseZones, smokeGuides: g.smokeGuides,
        arrowRainStrikes: g.arrowRainStrikes, fireballFlights: g.fireballFlights,
        rocketFlights: g.rocketFlights, logRolls: g.logRolls,
        earthquakeStrikes: g.earthquakeStrikes, thunderStrikes: g.thunderStrikes,
        princeGuardSpawns: g.princeGuardSpawns, batSpawns: g.batSpawns,
        goblinBarrels: g.goblinBarrels, arrowRainFlights: g.arrowRainFlights,
        bombs: g.bombs, fishingLines: g.fishingLines,
    };
}
