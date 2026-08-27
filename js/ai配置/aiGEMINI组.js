/**
 * 🤖 AI 行为组：GEMINI组（全卡牌掌控 · 天神算子）
 * 指导文件：aiGEMINI组.js
 * 
 * 核心特性：
 * 1. 英雄智能释放：武僧超脱反弹弹道、剑仙御剑穿透、女皇隐身爆头、狂战士锁血无敌、小王子护驾冲锋
 * 2. 动态禁魔与反坦：地狱塔融化巨坦、法术屏障免疫敌方火箭雷电、冰豆极限减速
 * 3. 天神下凡组合拳：超级骑士跃击 + 电磁炮核轰 + 冰冻4秒控场 + 狂暴/复制爆发
 */
window.AIGroupGEMINI = {
    name: 'GEMINI组',
    file: 'aiGEMINI组.js',
    makeDecision: async function () {
        if (game.gameOver || game.aiThinking) return;

        // ============ 1. 全域态势感知 ============
        const myTeam = 'ai';
        const enemyTeam = 'player';
        const enemies = game.entities.filter(e => e.team === enemyTeam && e.hp > 0);
        const allies = game.entities.filter(e => e.team === myTeam && e.hp > 0);

        const enemyTroops = enemies.filter(e => e.type === 'troop');
        const enemyFliers = enemyTroops.filter(e => e.flying);
        const enemyTanks = enemyTroops.filter(e => (e.maxHp && e.maxHp >= 1000) || e.targetMode === 'buildings');
        const enemyBuildings = enemies.filter(e => ['main_tower', 'bastion', 'tower', 'barrack', 'collector'].includes(e.type));
        const enemyTowers = enemies.filter(e => e.type === 'bastion' || e.type === 'main_tower');

        // 敌军过河判定
        const invadingEnemies = enemies.filter(e => e.type !== 'spell' && !e._headHidden && !e._stealthed && e.x > RIVER_RIGHT);
        const enemyCrossedRiver = invadingEnemies.length > 0;

        // 动态计算 AI 最远合法前线部署边界（随破堡推进）
        const aiLeftBound = game.bastionsLost.player >= 2 ? PLAYER_BASTIONS[0].x
                          : (game.bastionsLost.player >= 1 ? RIVER_LEFT : RIVER_RIGHT);

        // 卡牌就绪检查
        const isReady = (id) => {
            const c = CARDS[id];
            if (!c || game.elixir.ai < c.cost) return false;
            const cd = (game.cardCooldowns.ai || {})[id] || 0;
            return cd <= 0;
        };

        // ============ 2. 英雄主动技能智能释放（施放后不中断，允许同轮继续下兵）============
        const es = game.eliteSkills.ai || {};

        // ① 武僧【超脱】：反弹敌方弹道或残血自保
        const myMonk = allies.find(e => e.cardId === 'monk' && !e.isMirrored);
        if (myMonk && es.monk && es.monk.mode === 'skill' && es.monk.skillCdLeft <= 0 && game.elixir.ai >= 1) {
            const incomingSpellFlight = (game.fireballFlights && game.fireballFlights.some(f => f.team === 'player'))
                || (game.rocketFlights && game.rocketFlights.some(r => r.team === 'player' && !r.cloud))
                || (game.arrowRainFlights && game.arrowRainFlights.some(a => a.team === 'player'));
            const monkInDanger = myMonk.hp < myMonk.maxHp * 0.6 || enemies.some(en => dist(en, myMonk) <= 80);
            if (incomingSpellFlight || monkInDanger) {
                castActiveSkill('monk', 'ai'); // 施放后不 return，继续利用剩余圣水决策
            }
        }

        // ② 剑仙【御剑】：过河或遭遇战时升空突袭
        const mySwordImmortal = allies.find(e => e.cardId === 'sword_immortal' && !e.isMirrored);
        if (mySwordImmortal && es.sword_immortal && es.sword_immortal.mode === 'skill' && es.sword_immortal.skillCdLeft <= 0 && game.elixir.ai >= 2) {
            const nearEnemies = enemies.some(en => dist(en, mySwordImmortal) <= 150);
            if (mySwordImmortal.x < RIVER_RIGHT || nearEnemies) {
                castActiveSkill('sword_immortal', 'ai');
            }
        }

        // ③ 弓箭女皇【隐身】：锁定高价值目标时隐身爆发
        const myQueen = allies.find(e => e.cardId === 'bow_queen' && !e.isMirrored);
        if (myQueen && es.bow_queen && es.bow_queen.mode === 'skill' && es.bow_queen.skillCdLeft <= 0 && game.elixir.ai >= 1) {
            const hasGoodTarget = enemies.some(en => dist(en, myQueen) <= 135 && (en.fortification || en.hp >= 500));
            if (hasGoodTarget) {
                castActiveSkill('bow_queen', 'ai');
            }
        }

        // ④ 狂战士【爆发】：残血接战锁血无敌
        const myBerserker = allies.find(e => e.cardId === 'berserker' && !e.isMirrored);
        if (myBerserker && es.berserker && es.berserker.mode === 'skill' && es.berserker.skillCdLeft <= 0 && game.elixir.ai >= 3) {
            if (myBerserker.hp <= myBerserker.maxHp * 0.6 && enemies.some(en => dist(en, myBerserker) <= 40)) {
                castActiveSkill('berserker', 'ai');
            }
        }

        // ⑤ 冥王【召唤】：冥王等级 >= 2 且周围有敌人或防御塔时，瞬间召唤克隆骷髅大军！
        const myHades = allies.find(e => e.cardId === 'hades' && !e.isMirrored);
        if (myHades && es.hades && es.hades.mode === 'skill' && es.hades.skillCdLeft <= 0 && game.elixir.ai >= 1) {
            if ((myHades._level || 1) >= 2 && enemies.some(en => dist(en, myHades) <= 120)) {
                castActiveSkill('hades', 'ai');
            }
        }

        // ⑥ 哥布林神庙【神赐】：降至 <= 2 费立即召唤援军
        const esTemple = es.goblin_temple;
        if (esTemple && esTemple.mode === 'skill' && esTemple.skillCdLeft <= 0 && (esTemple.blessCost || 11) <= 2 && game.elixir.ai >= esTemple.blessCost) {
            castActiveSkill('goblin_temple', 'ai');
        }

        // ============ 3. 全局致命法术秒级反射（滚木起点动态化）============
        if (isReady('log')) {
            const groundInvaders = invadingEnemies.filter(e => !e.flying);
            if (groundInvaders.length >= 2) {
                groundInvaders.sort((a, b) => b.x - a.x); // 最右（最深入）的敌人
                const deepestX = groundInvaders[0].x;
                const avgY = groundInvaders.reduce((s, e) => s + e.y, 0) / groundInvaders.length;
                // 滚木起点置于最深入敌人右侧 40px，自右向左碾压
                const logStartX = Math.min(W - 30, Math.max(1000, deepestX + 40));
                if (canDeployHere('log', 'ai', logStartX, avgY, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('log', 'ai', logStartX, avgY);
                    return;
                }
            }
        }

        // ★ 剑雨：敌方密集度 >= 5 且带弹道预判瞬发
        if (isReady('arrows')) {
            const validEnemies = enemies.filter(e => e.hp > 0 && !e._headHidden && !e._stealthed && e.type !== 'spell');
            for (const pivot of validEnemies) {
                const cluster = validEnemies.filter(e => dist(e, pivot) <= 85);
                if (cluster.length >= 5) {
                    const avgX = cluster.reduce((s, e) => s + e.x, 0) / cluster.length;
                    const avgY = cluster.reduce((s, e) => s + e.y, 0) / cluster.length;
                    const leadX = Math.min(W - 30, Math.max(30, avgX + (avgX < 800 ? -25 : 30)));
                    if (canDeployHere('arrows', 'ai', leadX, avgY, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('arrows', 'ai', leadX, avgY);
                        return;
                    }
                }
            }
        }

        // ★ 大雷电：范围内有敌方高价值目标（主塔/电磁炮/地狱塔/大怪等总血量极高）
        if (isReady('thunder_spell') && game.elixir.ai >= 7) {
            const highValueEnemies = enemies.filter(e => e.hp >= 400 && !e._headHidden && !e._stealthed);
            if (highValueEnemies.length >= 2) {
                const targetPivot = highValueEnemies[0];
                if (canDeployHere('thunder_spell', 'ai', targetPivot.x, targetPivot.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('thunder_spell', 'ai', targetPivot.x, targetPivot.y);
                    return;
                }
            }
        }

        // ============ 4. 防守反击模式（过河敌军严惩）============
        if (enemyCrossedRiver) {
            invadingEnemies.sort((a, b) => b.x - a.x);
            const primaryThreat = invadingEnemies[0];
            const isFliying = !!primaryThreat.flying;
            const isTank = (primaryThreat.maxHp && primaryThreat.maxHp >= 1000) || primaryThreat.targetMode === 'buildings';

            // ① 重坦/攻城单位克星：中路下地狱塔锁定融化，配冰豆极致减速！
            if (isTank) {
                const hasInferno = allies.some(e => e.cardId === 'inferno_tower' && e.hp > 0);
                if (!hasInferno && isReady('inferno_tower')) {
                    const pullY = H / 2 + (primaryThreat.y < H / 2 ? -30 : 30);
                    if (canDeployHere('inferno_tower', 'ai', 1140, pullY, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('inferno_tower', 'ai', 1140, pullY);
                        return;
                    }
                }
                // 配合冰豆让大怪减速 80% 罚站
                if (isReady('ice_bean')) {
                    if (canDeployHere('ice_bean', 'ai', primaryThreat.x + 30, primaryThreat.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('ice_bean', 'ai', primaryThreat.x + 30, primaryThreat.y);
                        return;
                    }
                }
            }

            // ② 空中单位克星：雷电法师落地落雷打断，或猎人散弹贴脸对空爆发
            if (isFliying) {
                if (isReady('lightning_wizard')) {
                    if (canDeployHere('lightning_wizard', 'ai', primaryThreat.x + 25, primaryThreat.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('lightning_wizard', 'ai', primaryThreat.x + 25, primaryThreat.y);
                        return;
                    }
                }
                if (isReady('hunter')) {
                    if (canDeployHere('hunter', 'ai', 1230, primaryThreat.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('hunter', 'ai', 1230, primaryThreat.y);
                        return;
                    }
                }
            }

            // ③ 单体大怪克星：大皮卡 / 狂战士 / 守卫骷髅
            if (primaryThreat.hp >= 600 && isReady('big_pekka') && game.elixir.ai >= 7) {
                if (canDeployHere('big_pekka', 'ai', primaryThreat.x + 35, primaryThreat.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('big_pekka', 'ai', primaryThreat.x + 35, primaryThreat.y);
                    return;
                }
            }
            if (isReady('skeleton_guard')) {
                if (canDeployHere('skeleton_guard', 'ai', primaryThreat.x + 25, primaryThreat.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('skeleton_guard', 'ai', primaryThreat.x + 25, primaryThreat.y);
                    return;
                }
            }
            if (isReady('monk') && !allies.some(e => e.cardId === 'monk')) {
                if (canDeployHere('monk', 'ai', primaryThreat.x + 30, primaryThreat.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('monk', 'ai', primaryThreat.x + 30, primaryThreat.y);
                    return;
                }
            }
            return;
        }

        // ============ 5. 运营发育与法术庇护（安全期）============
        const myCollectors = allies.filter(e => e.cardId === 'elixir_collector' && e.hp > 0);
        const myEggs = allies.filter(e => e.cardId === 'dragon_egg' && e.hp > 0);
        const myBarriers = allies.filter(e => e.cardId === 'spell_barrier' && e.hp > 0);

        // ① 龙蛋速孵流：大后方下蛋，医疗兵直接贴身加血加速孵化 2600 血巨龙！
        if (myEggs.length === 0 && isReady('dragon_egg') && game.elixir.ai >= 8 && allies.length >= 2) {
            const eggY = rand() < 0.5 ? 180 : 520;
            if (canDeployHere('dragon_egg', 'ai', 1450, eggY, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                deploy('dragon_egg', 'ai', 1450, eggY);
                return;
            }
        }
        if (myEggs.length > 0 && isReady('healer')) {
            const egg = myEggs[0];
            if (canDeployHere('healer', 'ai', egg.x - 20, egg.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                deploy('healer', 'ai', egg.x - 20, egg.y);
                return;
            }
        }

        // ② 法术屏障护体：场上有圣水罐/龙蛋且无屏障时，部署法术屏障免疫敌方法术！
        if ((myCollectors.length > 0 || myEggs.length > 0) && myBarriers.length === 0 && isReady('spell_barrier')) {
            if (canDeployHere('spell_barrier', 'ai', 1350, 350, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                deploy('spell_barrier', 'ai', 1350, 350);
                return;
            }
        }

        // ③ 经济建设：圣水生成器
        if (myCollectors.length < 2 && isReady('elixir_collector') && game.elixir.ai >= 8) {
            const cy = rand() < 0.5 ? 120 : 580;
            if (canDeployHere('elixir_collector', 'ai', 1440, cy, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                deploy('elixir_collector', 'ai', 1440, cy);
                return;
            }
        }

        // ============ 6. 天神下凡：总攻推进组合拳 ============
        const targetBastions = enemies.filter(e => e.type === 'bastion' && e.hp > 0);
        targetBastions.sort((a, b) => a.hp - b.hp);
        const primaryTarget = targetBastions[0] || enemies.find(e => e.type === 'main_tower');
        const attackLaneY = primaryTarget ? primaryTarget.y : H / 2;

        // 检查主力领军大将
        const pushLeader = allies.find(e => ['super_knight', 'giant', 'big_pekka', 'sword_immortal', 'electro_cannon'].includes(e.cardId) && e.hp > 0);

        // ── 步骤 1：出动前排带头大哥（超级骑士跃击 / 剑仙仙剑 / 电磁炮核弹）──
        if (!pushLeader && game.elixir.ai >= 7) {
            if (isReady('super_knight')) {
                if (canDeployHere('super_knight', 'ai', RIVER_RIGHT + 30, attackLaneY, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('super_knight', 'ai', RIVER_RIGHT + 30, attackLaneY);
                    return;
                }
            }
            if (isReady('sword_immortal')) {
                if (canDeployHere('sword_immortal', 'ai', RIVER_RIGHT + 30, attackLaneY, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('sword_immortal', 'ai', RIVER_RIGHT + 30, attackLaneY);
                    return;
                }
            }
            if (isReady('electro_cannon')) {
                if (canDeployHere('electro_cannon', 'ai', 1150, attackLaneY, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('electro_cannon', 'ai', 1150, attackLaneY);
                    return;
                }
            }
        }

        // ── 步骤 2：大军过河协同火力与爆发法术 ──
        if (pushLeader) {
            // ① 冰冻法术控场：敌方塔下有防守群时直接冰冻 4 秒，让大军无伤拆塔！
            if (isReady('freeze_spell') && pushLeader.x < RIVER_RIGHT) {
                const defendersNearTarget = enemies.filter(en => en.hp > 0 && dist(en, primaryTarget) <= 90);
                if (defendersNearTarget.length >= 2) {
                    if (canDeployHere('freeze_spell', 'ai', primaryTarget.x, primaryTarget.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('freeze_spell', 'ai', primaryTarget.x, primaryTarget.y);
                        return;
                    }
                }
            }

            // ② 狂暴 / 复制法术爆发：主力大军抱团时复制一整支幻影部队 + 狂暴加速！
            const pushTroops = allies.filter(e => e.type === 'troop' && dist(e, pushLeader) <= 60);
            if (pushTroops.length >= 3 && pushLeader.x < RIVER_RIGHT + 100) {
                if (isReady('copy_spell')) {
                    if (canDeployHere('copy_spell', 'ai', pushLeader.x, pushLeader.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('copy_spell', 'ai', pushLeader.x, pushLeader.y);
                        return;
                    }
                }
                if (isReady('rage_spell')) {
                    if (canDeployHere('rage_spell', 'ai', pushLeader.x, pushLeader.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('rage_spell', 'ai', pushLeader.x, pushLeader.y);
                        return;
                    }
                }
            }

            // ③ 战斗天使 / 免伤法徒：跟随主力部队保驾护航
            if (isReady('battle_angel') && !allies.some(e => e.cardId === 'battle_angel')) {
                const ax = Math.min(W - 30, Math.max(aiLeftBound + 25, pushLeader.x + 35));
                if (canDeployHere('battle_angel', 'ai', ax, pushLeader.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('battle_angel', 'ai', ax, pushLeader.y);
                    return;
                }
            }
            if (isReady('immunity_disciple') && !allies.some(e => e.cardId === 'immunity_disciple')) {
                const ax = Math.min(W - 30, Math.max(aiLeftBound + 25, pushLeader.x + 40));
                if (canDeployHere('immunity_disciple', 'ai', ax, pushLeader.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('immunity_disciple', 'ai', ax, pushLeader.y);
                    return;
                }
            }

            // ④ 游侠穿透 / 弓箭女皇后排狙杀
            if (isReady('ranger')) {
                const rx = Math.min(W - 30, Math.max(aiLeftBound + 25, pushLeader.x + 50));
                if (canDeployHere('ranger', 'ai', rx, pushLeader.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('ranger', 'ai', rx, pushLeader.y);
                    return;
                }
            }
            if (isReady('bow_queen') && !allies.some(e => e.cardId === 'bow_queen')) {
                const qx = Math.min(W - 30, Math.max(aiLeftBound + 25, pushLeader.x + 45));
                if (canDeployHere('bow_queen', 'ai', qx, pushLeader.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('bow_queen', 'ai', qx, pushLeader.y);
                    return;
                }
            }

            // ⑤ 矿工直插敌后偷袭
            if (isReady('miner') && primaryTarget && game.elixir.ai >= 5) {
                if (canDeployHere('miner', 'ai', primaryTarget.x + 40, primaryTarget.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('miner', 'ai', primaryTarget.x + 40, primaryTarget.y);
                    return;
                }
            }
        }

        // ── 步骤 3：高费防溢出快攻 ──
        if (game.elixir.ai >= 8.5) {
            if (isReady('hog')) {
                if (canDeployHere('hog', 'ai', RIVER_RIGHT + 25, attackLaneY, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('hog', 'ai', RIVER_RIGHT + 25, attackLaneY);
                    return;
                }
            }
            if (isReady('shadow_assassin')) {
                if (canDeployHere('shadow_assassin', 'ai', RIVER_RIGHT + 25, attackLaneY, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('shadow_assassin', 'ai', RIVER_RIGHT + 25, attackLaneY);
                    return;
                }
            }
        }
    },
};

// 自注册进「人机选择」列表
if (typeof registerAIGroup === 'function') {
    registerAIGroup('GEMINI', AIGroupGEMINI);
}