/* ===== ai.js — AI 智能决策 v3.2 ===== */

/**
 * 设计逻辑（主人制定）：
 * ───────────────────────────────────────
 * ① 即时反制（最高优先级）— 全部基于场上实体当前位置
 *    · 己方半场有巨人 → 哥布林贴脸围
 *    · 己方半场有飞龙 → 弓箭手远射
 *    · 己方半场有弓箭手 → 剑士贴身
 *    · 己方半场哥布林密集(≥5) → 箭雨清场
 *    · 兵群密集(≥5) → 火球
 * ② 三种战略模式 — 发育/防御/进攻，根据局势自动切换
 * ③ 精确位置 — 不同单位和反制场景有固定部署规则
 * ④ 费用管控 — 威胁等级预留 + 防溢出 + 攒费出核心牌
 */

// ===================================================================
//  1. 局势感知（完整版）
// ===================================================================

function gatherIntel() {
    const myTeam = 'ai';
    const enemyTeam = 'player';

    const enemies   = game.entities.filter(e => e.team === enemyTeam && e.hp > 0);
    const allies    = game.entities.filter(e => e.team === myTeam && e.hp > 0);

    // ---- 敌方分类 ----
    const enemyTroops    = enemies.filter(e => e.type === 'troop');
    const enemyFliers    = enemyTroops.filter(e => e.flying);
    const enemyGround    = enemyTroops.filter(e => !e.flying);
    const enemyBuildings = enemies.filter(e =>
        e.type === 'main_tower' || e.type === 'bastion'
        || e.type === 'tower' || e.type === 'barrack' || e.type === 'collector'
    );
    const enemyCount = enemies.length;

    // ---- 敌方防御塔 / 堡垒 / 主塔 ----
    const enemyTowers = enemies.filter(e =>
        e.type === 'bastion' || e.type === 'main_tower' || e.type === 'tower'
    );
    const enemyTowerCount = enemyTowers.length;
    let frontBlocked = false;
    for (const t of enemyTowers) {
        if (t.x - 150 < RIVER_RIGHT + 100) { frontBlocked = true; break; }
    }

    // ---- 敌方建筑统计 ----
    const enemyCollectorCount = enemyBuildings.filter(e => e.type === 'collector').length;
    const enemyBarrackCount   = enemyBuildings.filter(e => e.type === 'barrack').length;
    const enemyTowerCnt       = enemyBuildings.filter(e => e.type === 'tower' || e.type === 'bastion').length;
    const totalEnemyBuildings = enemyCollectorCount + enemyBarrackCount + enemyTowerCnt;

    // ---- 己方分类 ----
    const aiTroops    = allies.filter(e => e.type === 'troop');
    const aiBuildings = allies.filter(e =>
        e.type === 'main_tower' || e.type === 'bastion'
        || e.type === 'tower' || e.type === 'barrack' || e.type === 'collector'
    );
    const aiTroopCount = aiTroops.length;

    // ---- 己方建筑统计 ----
    const collectorCount = aiBuildings.filter(e => e.type === 'collector').length;
    const barrackCount   = aiBuildings.filter(e => e.type === 'barrack').length;
    const towerCount     = aiBuildings.filter(e => e.type === 'tower' || e.type === 'bastion').length;
    const totalAiBuildings = collectorCount + barrackCount + towerCount;

    // ---- 主塔威胁计算 ----
    let threatLevel = 0;
    let closestEnemyDist = Infinity;
    let closestEnemy = null;
    let enemyInMyHalf = false;

    for (const e of enemies) {
        if (e.type === 'spell') continue;
        const d = dist(e, AI_TOWER);
        if (d < closestEnemyDist) { closestEnemyDist = d; closestEnemy = e; }
        if (e.x > RIVER_RIGHT) enemyInMyHalf = true;
    }

    if (closestEnemyDist < 100)            threatLevel = 3;
    else if (closestEnemyDist < 220)       threatLevel = 2;
    else if (enemyInMyHalf)                threatLevel = 1;
    else if (enemyTroops.length > 0)       threatLevel = 1;

    // ---- 己方推进状态 ----
    let allyInEnemyHalf = false;
    let allyAvgX = 0;
    let allyAvgY = H / 2;
    if (aiTroops.length > 0) {
        allyAvgX = aiTroops.reduce((s, e) => s + e.x, 0) / aiTroops.length;
        allyAvgY = aiTroops.reduce((s, e) => s + e.y, 0) / aiTroops.length;
        if (allyAvgX < RIVER_LEFT) allyInEnemyHalf = true;
    }

    // ---- 特殊单位在场检查 ----
    const hasGiantOnField   = aiTroops.some(e => e.cardId === 'giant');
    const hasDragonOnField  = aiTroops.some(e => e.cardId === 'dragon');
    const hasHealerOnField  = aiTroops.some(e => e.cardId === 'healer');
    const hasArcherOnField  = aiTroops.some(e => e.cardId === 'archer');
    const hasWitchOnField   = aiTroops.some(e => e.cardId === 'night_witch');
    const hasHadesOnField   = aiTroops.some(e => e.cardId === 'hades');

    // ---- 前排肉盾检测 ----
    const aiTanks = aiTroops.filter(e =>
        e.cardId === 'giant' || e.cardId === 'swordman' || (e.maxHp && e.maxHp >= 1000)
    );
    const hasFrontline = aiTanks.length > 0;

    // ---- ★ 敌方兵种密集区域（供法术瞄准和反制检测）----
    // 通用兵群密集区（所有兵种）
    let bestSpellTarget = null;
    let bestSpellCount = 0;
    // 哥布林密集区（专门给箭雨反制用）
    let bestGoblinTarget = null;
    let bestGoblinCount = 0;

    if (enemyTroops.length >= 2) {
        const gridSize = 60;
        const density = {};
        const goblinDensity = {};
        for (const e of enemyTroops) {
            const key = `${Math.floor(e.x / gridSize)},${Math.floor(e.y / gridSize)}`;
            density[key] = (density[key] || 0) + 1;
            // 哥布林单独计数
            if (e.cardId === 'goblin_gang' || e.cardId === 'goblin') {
                goblinDensity[key] = (goblinDensity[key] || 0) + 1;
            }
        }
        for (const [key, count] of Object.entries(density)) {
            const [gx, gy] = key.split(',').map(Number);
            if (count > bestSpellCount) {
                bestSpellCount = count;
                bestSpellTarget = { x: gx * gridSize + gridSize / 2, y: gy * gridSize + gridSize / 2 };
            }
        }
        for (const [key, count] of Object.entries(goblinDensity)) {
            const [gx, gy] = key.split(',').map(Number);
            if (count > bestGoblinCount) {
                bestGoblinCount = count;
                bestGoblinTarget = { x: gx * gridSize + gridSize / 2, y: gy * gridSize + gridSize / 2 };
            }
        }
    }

    // ---- ★ 己方半场内的特定敌方兵种（供即时反制检测）----
    const giantInMyHalf   = enemyTroops.find(e => e.cardId === 'giant' && e.x > RIVER_RIGHT);
    const dragonInMyHalf  = enemyTroops.find(e => e.cardId === 'dragon' && e.x > RIVER_RIGHT);
    const archerInMyHalf  = enemyTroops.find(e => e.cardId === 'archer' && e.x > RIVER_RIGHT);
    const goblinsInMyHalf = enemyTroops.filter(e =>
        (e.cardId === 'goblin_gang' || e.cardId === 'goblin') && e.x > RIVER_RIGHT
    );

    // ---- 炮塔旁是否有医疗兵 ----
    let towerWithHealer = false;
    for (const t of enemyTowers) {
        for (const e of enemyTroops) {
            if (e.type === 'healer' && dist(e, t) < 80) {
                towerWithHealer = true;
                break;
            }
        }
        if (towerWithHealer) break;
    }

    // ---- ★ 模式判断 ----
    const openingPhase = game.time < 45;
    const isBuildingBehind = openingPhase || totalAiBuildings < totalEnemyBuildings - 2;
    const isEmergency      = threatLevel >= 3;
    const isDefensive      = enemyInMyHalf && threatLevel >= 2;
    const isOffensive      = !isBuildingBehind && !enemyInMyHalf && threatLevel <= 1;

    // ---- 圣水状态 ----
    const myElixir = game.elixir.ai;
    const elixirNearlyFull = myElixir >= 8;

    return {
        enemies, enemyCount,
        enemyTroops, enemyFliers, enemyGround, enemyBuildings,
        enemyTowers, enemyTowerCount, frontBlocked,
        enemyCollectorCount, enemyBarrackCount, enemyTowerCnt, totalEnemyBuildings,
        aiTroops, aiBuildings, aiTroopCount,
        collectorCount, barrackCount, towerCount, totalAiBuildings,
        aiTanks, hasFrontline,
        hasGiantOnField, hasDragonOnField, hasHealerOnField, hasArcherOnField, hasWitchOnField,
        threatLevel, closestEnemyDist, closestEnemy, enemyInMyHalf,
        allyInEnemyHalf, allyAvgX, allyAvgY,
        bestSpellTarget, bestSpellCount,
        bestGoblinTarget, bestGoblinCount,
        giantInMyHalf, dragonInMyHalf, archerInMyHalf, goblinsInMyHalf,
        towerWithHealer,
        hasTower: towerCount > 0,
        hasBarrack: barrackCount > 0,
        hasCollector: collectorCount > 0,
        isBuildingBehind, isEmergency, isDefensive, isOffensive,
        myElixir, elixirNearlyFull,
    };
}


// ===================================================================
//  2. 位置策略
// ===================================================================

function pickPosition(cardId, intel, target) {
    const card = CARDS[cardId];
    if (!card) return null;
    const rx = () => (rand() - 0.5) * 30;
    const ry = () => (rand() - 0.5) * 30;

    // ---- 侧翼Y（正面被炮塔挡时走上下路）----
    function getSideY() {
        if (intel.frontBlocked) {
            return rand() > 0.5 ? 120 + rand() * 60 : 400 + rand() * 60;
        }
        return intel.allyAvgY + rx() * 50;
    }

    // ---- 法术 ----
    if (card.type === 'spell') {
        if (target) {
            return { x: target.x + rx() * 10, y: target.y + ry() * 10 };
        }
        // 有兵群密集目标
        if (intel.bestSpellTarget && intel.bestSpellCount >= 5) {
            return { x: intel.bestSpellTarget.x + rx() * 15, y: intel.bestSpellTarget.y + ry() * 15 };
        }
        return null;
    }

    // ---- 收集器：主塔后方安全位置 ----
    if (card.type === 'collector') {
        return {
            x: AI_TOWER.x + 50 + rand() * 40,
            y: AI_TOWER.y + ry() * 60,
        };
    }

    // ---- 兵营：主塔侧后方 ----
    if (card.type === 'barrack') {
        return {
            x: AI_TOWER.x - 130 + rx() * 20,
            y: AI_TOWER.y + ry() * 60,
        };
    }

    // ---- 炮塔：主塔前方防御位 ----
    if (card.type === 'tower') {
        return {
            x: AI_TOWER.x - 80 + rx() * 20,
            y: AI_TOWER.y + ry() * 70,
        };
    }

    // ---- 治疗兵：跟部队后方 ----
    if (card.type === 'healer') {
        if (intel.aiTroops.length > 0) {
            const tank = intel.aiTanks.length > 0 ? intel.aiTanks[0] : null;
            if (tank) {
                return {
                    x: Math.min(tank.x - 40, AI_TOWER.x - 20) + rx() * 20,
                    y: tank.y + ry() * 20,
                };
            }
            return {
                x: Math.min(intel.allyAvgX, AI_TOWER.x - 20) + rx() * 20,
                y: intel.allyAvgY + ry() * 20,
            };
        }
        return { x: AI_TOWER.x - 40 + rx() * 20, y: AI_TOWER.y + ry() * 20 };
    }

    // ---- 兵种 ----

    // ① 骷髅海（对巨人贴脸围杀 / 常规）
    if (cardId === 'goblin_gang') {
        if (target && target.cardId === 'giant') {
            // 贴脸围巨人：围绕目标呈圆形散布
            const angle = rand() * 2 * Math.PI;
            const dist = 25 + rand() * 15;
            let px = target.x + Math.cos(angle) * dist;
            let py = target.y + Math.sin(angle) * dist;
            px = Math.min(W - 30, Math.max(30, px));
            py = Math.min(H - 30, Math.max(30, py));
            return { x: px, y: py };
        }
        // 常规
        if (intel.threatLevel >= 2) {
            return { x: AI_TOWER.x - 20 + rx() * 30, y: AI_TOWER.y + ry() * 70 };
        }
        if (intel.allyInEnemyHalf) {
            return { x: RIVER_RIGHT + 30 + rand() * 40, y: getSideY() };
        }
        return { x: AI_TOWER.x - 40 + rx() * 30, y: AI_TOWER.y + ry() * 60 };
    }

    // ② 弓箭手（远程压制飞龙 / 后排输出）
    if (cardId === 'archer') {
        if (target && target.cardId === 'dragon') {
            // 反制飞龙：弓箭手射程150 > 飞龙射程100+溅射55
            // ✅ 放己方安全后排白嫖，绝不跑去飞龙附近送死！
            // 优先放炮塔旁边（炮塔抗伤+弓箭手输出）
            if (intel.hasTower) {
                const towers = intel.aiBuildings.filter(e => e.type === 'tower');
                if (towers.length > 0) {
                    const t = towers[0];
                    return { x: t.x + 30 + rx() * 20, y: t.y + ry() * 30 };
                }
            }
            // 没炮塔就放主塔前方防御位
            return { x: AI_TOWER.x - 40 + rx() * 30, y: AI_TOWER.y + ry() * 60 };
        }
        // 常规：放在肉盾后方安全输出
        const tank = intel.aiTanks.length > 0 ? intel.aiTanks[0] : null;
        if (tank) {
            return {
                x: Math.min(tank.x - 40, AI_TOWER.x - 20) + rx() * 20,
                y: tank.y + ry() * 20,
            };
        }
        return { x: AI_TOWER.x - 60 + rx() * 20, y: AI_TOWER.y + ry() * 60 };
    }

    // ③ 剑士（贴身切弓箭手 / 肉盾）
    if (cardId === 'swordman') {
        if (target && target.cardId === 'archer') {
            // 反制弓箭手：贴身放
            const angle = rand() * 2 * Math.PI;
            const dist = 20 + rand() * 15;
            let px = target.x + Math.cos(angle) * dist;
            let py = target.y + Math.sin(angle) * dist;
            px = Math.min(W - 30, Math.max(30, px));
            py = Math.min(H - 30, Math.max(30, py));
            return { x: px, y: py };
        }
        // 常规：最前方
        if (intel.threatLevel >= 2) {
            return { x: AI_TOWER.x - 30 + rx() * 40, y: AI_TOWER.y + ry() * 70 };
        }
        if (intel.allyInEnemyHalf) {
            return { x: RIVER_RIGHT + 30 + rand() * 40, y: getSideY() };
        }
        return { x: AI_TOWER.x - 60 + rx() * 30, y: AI_TOWER.y + ry() * 60 };
    }

    // ④ 巨人（最前方肉盾）
    if (cardId === 'giant') {
        if (intel.allyInEnemyHalf) {
            return { x: RIVER_RIGHT + 20 + rand() * 30, y: getSideY() };
        }
        return { x: AI_TOWER.x - 100 + rx() * 20, y: AI_TOWER.y + ry() * 60 };
    }

    // ⑤ 野猪（快速突击，放河边冲建筑）
    if (cardId === 'hog') {
        if (intel.allyInEnemyHalf) {
            return { x: RIVER_RIGHT + 10 + rand() * 20, y: getSideY() };
        }
        return { x: AI_TOWER.x - 60 + rx() * 20, y: AI_TOWER.y + ry() * 60 };
    }

    // ⑦ 飞龙（常规）
    if (cardId === 'dragon') {
        if (intel.allyInEnemyHalf) {
            return { x: RIVER_RIGHT + 10 + rand() * 40, y: 80 + rand() * (H - 160) };
        }
        return { x: AI_TOWER.x - 50 + rx() * 40, y: AI_TOWER.y + ry() * 70 };
    }

    // ⑥ 暗夜女巫（中后排召唤单位，跟部队走）
    if (cardId === 'night_witch') {
        if (intel.allyInEnemyHalf) {
            // 过河后放后排安全位置持续召唤
            return { x: RIVER_RIGHT + 20 + rand() * 30, y: getSideY() };
        }
        // 己方半场：跟在肉盾后面
        const tank = intel.aiTanks.length > 0 ? intel.aiTanks[0] : null;
        if (tank) {
            return {
                x: Math.min(tank.x - 30, AI_TOWER.x - 30) + rx() * 20,
                y: tank.y + ry() * 20,
            };
        }
        return { x: AI_TOWER.x - 60 + rx() * 30, y: AI_TOWER.y + ry() * 60 };
    }

    // ⑦ 冥王（中排成长单位，放在己方半场安全位置）
    if (cardId === 'hades') {
        if (intel.allyInEnemyHalf) {
            return { x: RIVER_RIGHT + 20 + rand() * 20, y: getSideY() };
        }
        const tank = intel.aiTanks.length > 0 ? intel.aiTanks[0] : null;
        if (tank) {
            return {
                x: Math.min(tank.x - 20, AI_TOWER.x - 20) + rx() * 15,
                y: tank.y + ry() * 15,
            };
        }
        return { x: AI_TOWER.x - 50 + rx() * 30, y: AI_TOWER.y + ry() * 50 };
    }

    // 兜底
    return { x: AI_TOWER.x - 40 + rx() * 30, y: AI_TOWER.y + ry() * 60 };
}


// ===================================================================
//  3. 卡牌选择
// ===================================================================

function chooseCard(intel) {
    const elixir = intel.myElixir;
    const has = (id) => CARDS[id] && getCardCost('ai', id) <= elixir;

    // =============================================================
    // ★ 第一层：即时反制（最高优先级，全部基于场上实体当前位置）
    // =============================================================

    // ① 己方半场有巨人 → 骷髅海贴脸围杀（3费换7费）
    if (intel.giantInMyHalf && has('goblin_gang') && elixir >= 3) {
        return 'goblin_gang';
    }

    // ② 己方半场有飞龙 → 弓箭手放远射（2费换4费）
    if (intel.dragonInMyHalf && has('archer') && elixir >= 2) {
        return 'archer';
    }

    // ③ 己方半场有弓箭手 → 剑士贴身近砍
    if (intel.archerInMyHalf && has('swordman') && elixir >= 3) {
        return 'swordman';
    }

    // ④ 己方半场哥布林密集（箭雨范围内≥5只）→ 箭雨清场
    if (intel.bestGoblinCount >= 5 && has('arrows') && elixir >= 3) {
        return 'arrows';
    }

    // ⑤ 兵群≥5密集 → 火球炸中心
    if (intel.bestSpellCount >= 5 && has('fireball') && elixir >= 4) {
        return 'fireball';
    }

    // =============================================================
    // ★ 第二层：费用过滤（战略模式用）
    // =============================================================

    let available;
    if (intel.threatLevel >= 2) {
        // 危险 → 有多少花多少
        available = CARD_IDS.filter(id => getCardCost('ai', id) <= elixir);
    } else if (intel.elixirNearlyFull) {
        // 快满了 → 花到剩 ≤ 2
        available = CARD_IDS.filter(id => getCardCost('ai', id) <= elixir - 1);
        if (available.length === 0) {
            available = CARD_IDS.filter(id => getCardCost('ai', id) <= elixir);
        }
    } else {
        // 正常 → 预留1费
        available = CARD_IDS.filter(id => getCardCost('ai', id) <= Math.floor(elixir));
    }
    if (available.length === 0) return null;

    const av = (id) => available.includes(id);

    // 场上已有盔甲铺数量（限制 AI 只铺1座）
    const aiArmorCount = intel.aiBuildings.filter(e => e.cardId === 'armor_smith').length;

    // =============================================================
    // ★ 第三层：战略模式
    // =============================================================

    // ---------- 0. 紧急防御（threatLevel ≥ 3）----------
    if (intel.isEmergency) {
        if (av('swordman')) return 'swordman';
        if (av('mage_tower') && elixir >= 4) return 'mage_tower';
        if (av('cannon_tower') && elixir >= 4) return 'cannon_tower';
        if (av('goblin_gang') && elixir >= 3) return 'goblin_gang';
        if (av('archer')) return 'archer';
        return null;
    }

    // ---------- 1. 发育模式（建筑落后 / 开局45秒内）----------
    if (intel.isBuildingBehind) {
        if (intel.collectorCount < 2 && av('elixir_collector') && elixir >= 4) {
            return 'elixir_collector';
        }
        if (intel.barrackCount < 1 && av('goblin_barrack') && elixir >= 5) {
            return 'goblin_barrack';
        }
        if (av('mage_tower') && elixir >= 4) {
            return 'mage_tower';
        }
        if (av('cannon_tower') && elixir >= 4) {
            return 'cannon_tower';
        }
        if (aiArmorCount < 1 && av('armor_smith') && elixir >= 5) {
            return 'armor_smith';
        }
        return null;
    }

    // ---------- 2. 防御模式（敌人进半场 + 威胁≥2）----------
    if (intel.isDefensive) {
        if (av('mage_tower') && elixir >= 4) {
            return 'mage_tower';
        }
        if (av('cannon_tower') && elixir >= 4) {
            return 'cannon_tower';
        }
        if (aiArmorCount < 1 && av('armor_smith') && elixir >= 5) {
            return 'armor_smith';
        }
        if (av('healer') && elixir >= 3 && !intel.hasHealerOnField) {
            return 'healer';
        }
        if (av('night_witch') && elixir >= 5 && !intel.hasWitchOnField) {
            return 'night_witch';
        }
        if (av('hades') && elixir >= 5 && !intel.hasHadesOnField) {
            return 'hades';
        }
        if (av('archer')) {
            return 'archer';
        }
        if (av('goblin_gang') && elixir >= 3) return 'goblin_gang';
        return null;
    }

    // ---------- 3. 进攻模式（建筑不落后 + 无威胁）----------
    if (intel.isOffensive) {
        if (!intel.hasGiantOnField) {
            if (av('giant') && elixir >= 7) return 'giant';
            if (av('hog') && elixir >= 4) return 'hog';
            return null;
        }
        if (av('hog') && elixir >= 4 && !intel.aiTroops.some(t => t.cardId === 'hog')) {
            return 'hog';
        }
        if (av('dragon') && elixir >= 4 && !intel.hasDragonOnField) {
            return 'dragon';
        }
        if (av('night_witch') && elixir >= 5 && !intel.hasWitchOnField) {
            return 'night_witch';
        }
        if (av('hades') && elixir >= 5 && !intel.hasHadesOnField) {
            return 'hades';
        }
        if (av('healer') && elixir >= 3 && !intel.hasHealerOnField &&
            intel.aiTroops.some(t => t.hp < t.maxHp * 0.6)) {
            return 'healer';
        }
        if (av('archer') && !intel.hasArcherOnField) {
            return 'archer';
        }
        if (intel.enemyTowerCount >= 2) {
            if (av('goblin_gang') && elixir >= 3) return 'goblin_gang';
        }
        if (av('giant') && elixir >= 7) return 'giant';
        if (av('swordman') && elixir >= 3) return 'swordman';
        if (av('goblin_gang') && elixir >= 3) return 'goblin_gang';
        return null;
    }

    // ---------- 兜底 ----------
    if (av('swordman')) return 'swordman';
    if (av('archer')) return 'archer';
    return null;
}


// ===================================================================
//  4. 主入口
// ===================================================================

/**
 * 🤖 AI 行为组：1测试组（原 ai.js 经典人机逻辑）
 * 指导文件：ai测试组.js
 */
window.AIGroupTest = {
    name: '1测试组',
    file: 'ai测试组.js',
    makeDecision: async function () {
    if (game.gameOver || game.aiThinking) return;

    const intel = gatherIntel();

    const cardId = chooseCard(intel);
    if (!cardId) return;

    // ★ 确定反制目标（全部基于场上实体当前位置）
    let target = null;

    if (cardId === 'goblin_gang' && intel.giantInMyHalf) {
        // 哥布林围巨人 → 目标=巨人当前位置
        target = { x: intel.giantInMyHalf.x, y: intel.giantInMyHalf.y, cardId: 'giant' };
    } else if (cardId === 'archer' && intel.dragonInMyHalf) {
        // 弓箭手射飞龙 → 目标=飞龙当前位置
        target = { x: intel.dragonInMyHalf.x, y: intel.dragonInMyHalf.y, cardId: 'dragon' };
    } else if (cardId === 'swordman' && intel.archerInMyHalf) {
        // 剑士切弓箭手 → 目标=弓箭手当前位置
        target = { x: intel.archerInMyHalf.x, y: intel.archerInMyHalf.y, cardId: 'archer' };
    } else if (cardId === 'arrows' && intel.bestGoblinTarget && intel.bestGoblinCount >= 5) {
        // 箭雨清哥布林 → 目标=哥布林密集区中心
        target = { x: intel.bestGoblinTarget.x, y: intel.bestGoblinTarget.y, cardId: 'goblin_gang' };
    } else if (cardId === 'fireball' && intel.bestSpellTarget && intel.bestSpellCount >= 5) {
        // 火球炸兵群 → 目标=兵群密集区中心
        target = { x: intel.bestSpellTarget.x, y: intel.bestSpellTarget.y, cardId: null };
    }

    let x, y;
    for (let attempt = 0; attempt < 5; attempt++) {
        const pos = pickPosition(cardId, intel, target);
        if (!pos) {
            // 法术没目标 → 不放
            return;
        }
        x = Math.min(W - 30, Math.max(30, pos.x));
        y = Math.min(H - 30, Math.max(30, pos.y));

        if (canDeployHere(cardId, 'ai', x, y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
            deploy(cardId, 'ai', x, y);
            return;
        }
    }

    // 兜底
    let fallbackX, fallbackY;
    if (CARDS[cardId].type === 'spell') {
        fallbackX = RIVER_RIGHT + 30 + rand() * (W - RIVER_RIGHT - 80);
        fallbackY = 50 + rand() * (H - 100);
    } else {
        fallbackX = RIVER_RIGHT + 40 + rand() * (W - RIVER_RIGHT - 120);
        fallbackY = 60 + rand() * (H - 120);
    }
    if (canDeployHere(cardId, 'ai', fallbackX, fallbackY, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
        deploy(cardId, 'ai', fallbackX, fallbackY);
    }
    }, // ← 原 aiMakeDecision 结束
};
