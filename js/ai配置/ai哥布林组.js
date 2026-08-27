/**
 * 🤖 AI 行为组：2哥布林组
 * 指导文件：ai哥布林组.js
 * 
 * 策略：根据局势分为四种模式（开局/发育/进攻/防守）
 * - 开局：前2.5分钟且无敌方过河，先铺神庙 + 圣水生成器 + 飞桶钻机试探
 * - 发育：敌方未过河且我方建筑落后，稳固神庙/小屋永动机防线与积攒优势
 * - 进攻：敌方未过河且态势良好，哥布林巨人一波流 + 飞桶钻机偷袭 + 哥布林魔咒滚雪球
 * - 防守：敌方过河，对敌通用属性克制（吹箭手对空、小屋中路拉扯、哥布林4角预判包夹）
 */
window.AIGroupGoblin = {
    name: '2哥布林组',
    file: 'ai哥布林组.js',
    makeDecision: async function () {
        if (game.gameOver || game.aiThinking) return;

        // ============ 1. 局势感知 ============
        const myTeam = 'ai';
        const enemyTeam = 'player';
        const enemies = game.entities.filter(e => e.team === enemyTeam && e.hp > 0);
        const allies = game.entities.filter(e => e.team === myTeam && e.hp > 0);

        // ---- 敌方分类 ----
        const enemyTroops = enemies.filter(e => e.type === 'troop');
        const enemyBuildings = enemies.filter(e =>
            e.type === 'main_tower' || e.type === 'bastion'
            || e.type === 'tower' || e.type === 'barrack' || e.type === 'collector'
        );

        // ---- 敌方建筑统计 ----
        const enemyCollectorCount = enemyBuildings.filter(e => e.type === 'collector').length;
        const enemyBarrackCount = enemyBuildings.filter(e => e.type === 'barrack').length;
        const enemyTowerCnt = enemyBuildings.filter(e => e.type === 'tower' || e.type === 'bastion').length;
        const totalEnemyBuildings = enemyCollectorCount + enemyBarrackCount + enemyTowerCnt;

        // ---- 己方分类 ----
        const aiBuildings = allies.filter(e =>
            e.type === 'main_tower' || e.type === 'bastion'
            || e.type === 'tower' || e.type === 'barrack' || e.type === 'collector'
        );

        // ---- 己方建筑统计 ----
        const collectorCount = aiBuildings.filter(e => e.type === 'collector').length;
        const barrackCount = aiBuildings.filter(e => e.type === 'barrack').length;
        const towerCount = aiBuildings.filter(e => e.type === 'tower' || e.type === 'bastion').length;
        const totalAiBuildings = collectorCount + barrackCount + towerCount;

        // ---- 敌军位置判断 ----
        const enemyCrossedRiver = enemies.some(e => e.type !== 'spell' && e.x > RIVER_RIGHT);
        const enemyInMyHalf = enemyCrossedRiver;

        // ---- 圣水生成器与神庙状态 ----
        const collectorCd = (game.cardCooldowns.ai || {})['elixir_collector'] || 0;
        const esTemple = (game.eliteSkills.ai || {})['goblin_temple'];
        const templeOnField = esTemple && esTemple.mode === 'skill';
        const templeReady = !esTemple || (esTemple.mode === 'deploy' && esTemple.cdLeft <= 0);

        // 统一卡牌可用性检查（费用够 + 冷却结束）
        const isReady = (id) => {
            const c = CARDS[id];
            if (!c || game.elixir.ai < c.cost) return false;
            const cd = (game.cardCooldowns.ai || {})[id] || 0;
            return cd <= 0;
        };

        // 动态计算 AI 最远合法前线部署边界（随破堡推进）
        const aiLeftBoundary = game.bastionsLost.player >= 2 ? PLAYER_BASTIONS[0].x
                             : (game.bastionsLost.player >= 1 ? RIVER_LEFT : RIVER_RIGHT);

        // ============ 2. 全局通用逻辑（每次决策优先检查）============

        // ★ 哥布林神庙：场上无神庙且可用时，立即在堡垒线后部署
        if (!templeOnField && templeReady && game.elixir.ai >= 1 && CARDS['goblin_temple']) {
            const chosenBastion = AI_BASTIONS[Math.floor(rand() * AI_BASTIONS.length)];
            for (let attempt = 0; attempt < 5; attempt++) {
                const offsetX = 30 + rand() * 80;
                const offsetY = (rand() - 0.5) * 120;
                const x = chosenBastion.x + offsetX;
                const y = chosenBastion.y + offsetY;
                if (x >= 1200 && canDeployHere('goblin_temple', 'ai', x, y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('goblin_temple', 'ai', x, y);
                    return;
                }
            }
        }

        // ★ 神赐技能：神庙在场且费用降至 <= 2 费时立即释放召援军（已修复传参 Bug）
        if (templeOnField) {
            const esTempleState = (game.eliteSkills.ai || {})['goblin_temple'];
            const blessCost = esTempleState.blessCost != null ? esTempleState.blessCost : 11;
            if (esTempleState.mode === 'skill' && esTempleState.skillCdLeft <= 0 && blessCost <= 2 && game.elixir.ai >= blessCost) {
                if (castActiveSkill('goblin_temple', 'ai')) {
                    return;
                }
            }
        }

        // ★ 剑雨全局反射：范围内敌军>=6时自动释放（带1.9秒弹道延时预判）
        if (isReady('arrows')) {
            const arrowsCard = CARDS['arrows'];
            const spellRadius = arrowsCard.radius || 85;
            const totalDelay = (arrowsCard.deployDelay || 0.5) + (arrowsCard.flightTime || 1.4);

            const validEnemies = enemies.filter(e => e.hp > 0 && !e._headHidden && !e._stealthed && e.type !== 'spell');
            if (validEnemies.length >= 6) {
                let bestCluster = null;
                let maxCount = 0;

                for (const pivot of validEnemies) {
                    const neighbors = validEnemies.filter(e => dist(e, pivot) <= spellRadius);
                    if (neighbors.length >= 6 && neighbors.length > maxCount) {
                        maxCount = neighbors.length;
                        bestCluster = neighbors;
                    }
                }

                if (bestCluster && maxCount >= 6) {
                    let sumPredX = 0, sumPredY = 0;
                    for (const u of bestCluster) {
                        let predX = u.x, predY = u.y;
                        let isAttacking = false;
                        if (u.targetId) {
                            const tgt = game.entities.find(en => en.id === u.targetId && en.hp > 0);
                            if (tgt && dist(u, tgt) - (tgt.hitRadius || 0) <= (u.range || 30)) isAttacking = true;
                        }
                        if (u.moveSpeed && !isAttacking) {
                            const speed = u.moveSpeed * (u.slowFactor || 1.0) * (u._speedBoosted ? 2.0 : 1.0) * (u._charging ? 3.0 : 1.0) * (u._rageTimer > 0 ? 1.3 : 1.0);
                            let destX = AI_TOWER.x, destY = AI_TOWER.y;
                            if (u.targetId) {
                                const tgt = game.entities.find(en => en.id === u.targetId && en.hp > 0);
                                if (tgt) { destX = tgt.x; destY = tgt.y; }
                            }
                            const dLen = Math.hypot(destX - u.x, destY - u.y);
                            if (dLen > 1) {
                                const travel = Math.min(dLen, speed * totalDelay);
                                predX += (destX - u.x) / dLen * travel;
                                predY += (destY - u.y) / dLen * travel;
                            }
                        }
                        sumPredX += predX;
                        sumPredY += predY;
                    }

                    const aimX = Math.min(W - 30, Math.max(30, sumPredX / bestCluster.length));
                    const aimY = Math.min(H - 30, Math.max(30, sumPredY / bestCluster.length));
                    if (canDeployHere('arrows', 'ai', aimX, aimY, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('arrows', 'ai', aimX, aimY);
                        return;
                    }
                }
            }
        }

        // ============ 3. 模式判定 ============
        let mode;
        const openingPhase = game.time < 150 && !enemyInMyHalf;

        if (enemyCrossedRiver) {
            mode = 'defense';
        } else if (openingPhase) {
            mode = 'opening';
        } else if (totalEnemyBuildings >= totalAiBuildings + 2) {
            mode = 'develop';
        } else {
            mode = 'attack';
        }

        // ============ 4. 开局行为（前150秒平稳发育）============
        if (mode === 'opening') {
            const elixir = game.elixir.ai;

            // 步骤1：圣水>=7 铺圣水生成器
            if (elixir >= 7 && isReady('elixir_collector')) {
                for (let attempt = 0; attempt < 8; attempt++) {
                    const x = 1220 + rand() * 250;
                    const y = 80 + rand() * (H - 160);
                    if (canDeployHere('elixir_collector', 'ai', x, y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('elixir_collector', 'ai', x, y);
                        return;
                    }
                }
            }

            // 步骤2：圣水>=9 时防溢出轮转消耗
            if (elixir >= 9) {
                const enemyTargets = enemies.filter(e => e.type === 'bastion' || e.type === 'main_tower');
                while (game.elixir.ai >= 9) {
                    const optionDefs = [
                        { id: 'goblin_cage',   needsTarget: false },
                        { id: 'armor_smith',   needsTarget: false },
                        { id: 'goblin_barrel', needsTarget: true  },
                        { id: 'goblin_drill',  needsTarget: true  },
                        { id: 'healer',        needsTarget: false },
                    ];
                    const available = optionDefs.filter(opt => {
                        if (!isReady(opt.id)) return false;
                        if (opt.needsTarget && enemyTargets.length === 0) return false;
                        return true;
                    });

                    if (available.length === 0) break;
                    const picked = available[Math.floor(rand() * available.length)];
                    const cardId = picked.id;
                    let x, y;

                    if (cardId === 'goblin_cage') {
                        x = RIVER_RIGHT + rand() * (AI_BASTIONS[0].x - RIVER_RIGHT - 50);
                        y = 60 + rand() * (H - 120);
                    } else if (cardId === 'armor_smith') {
                        x = 1220 + rand() * 200;
                        y = 80 + rand() * (H - 160);
                    } else if (cardId === 'goblin_barrel') {
                        const target = enemyTargets[Math.floor(rand() * enemyTargets.length)];
                        x = target.x + (rand() - 0.5) * 30;
                        y = target.y + (rand() - 0.5) * 30;
                    } else if (cardId === 'goblin_drill') {
                        const target = enemyTargets[Math.floor(rand() * enemyTargets.length)];
                        x = target.x + (rand() - 0.5) * 80;
                        y = target.y + (rand() - 0.5) * 80;
                    } else if (cardId === 'healer') {
                        x = 1240 + rand() * 100;
                        y = 200 + rand() * 300;
                    }

                    if (canDeployHere(cardId, 'ai', x, y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy(cardId, 'ai', x, y);
                        return;
                    }
                }
            }
        }

        // ============ 5. 防守模式（对敌通用属性识别）============
        if (mode === 'defense') {
            const invadingEnemies = enemies.filter(e => e.hp > 0 && !e._headHidden && !e._stealthed && e.type !== 'spell' && e.x > RIVER_RIGHT);
            if (invadingEnemies.length === 0) return;

            invadingEnemies.sort((a, b) => b.x - a.x);
            const target = invadingEnemies[0];

            // ① 哥布林 / 团伙 贴脸预判十字包夹
            const deploySurround = (cardId) => {
                const deployDelay = CARDS[cardId].deployDelay || 1.0;
                let predX = target.x, predY = target.y;

                let isAttacking = false;
                if (target.targetId) {
                    const tgt = game.entities.find(en => en.id === target.targetId && en.hp > 0);
                    if (tgt && dist(target, tgt) - (tgt.hitRadius || 0) <= (target.range || 30)) isAttacking = true;
                }
                if (target.moveSpeed && !isAttacking) {
                    const speed = target.moveSpeed * (target.slowFactor || 1.0) * (target._speedBoosted ? 2.0 : 1.0) * (target._charging ? 3.0 : 1.0) * (target._rageTimer > 0 ? 1.3 : 1.0);
                    let destX = AI_TOWER.x, destY = AI_TOWER.y;
                    if (target.targetId) {
                        const tgt = game.entities.find(en => en.id === target.targetId && en.hp > 0);
                        if (tgt) { destX = tgt.x; destY = tgt.y; }
                    }
                    const dLen = Math.hypot(destX - target.x, destY - target.y);
                    if (dLen > 1) {
                        const travel = Math.min(dLen, speed * deployDelay);
                        predX += (destX - target.x) / dLen * travel;
                        predY += (destY - target.y) / dLen * travel;
                    }
                }

                const offsets = [[0, 0], [10, 0], [-10, 0], [0, 10], [0, -10]];
                for (const [ox, oy] of offsets) {
                    const x = Math.min(W - 30, Math.max(RIVER_RIGHT + 30, predX + ox));
                    const y = Math.min(H - 30, Math.max(30, predY + oy));
                    if (canDeployHere(cardId, 'ai', x, y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy(cardId, 'ai', x, y);
                        return true;
                    }
                }
                return false;
            };

            // ② 吹箭手 堡垒后方/侧翼安全对空风筝
            const deployBlowgunKite = () => {
                const cardId = 'goblin_blowgun';
                const isTopLane = target.y < H / 2;
                const candidateY = isTopLane ? 160 : 540;

                for (let attempt = 0; attempt < 8; attempt++) {
                    const idealX = Math.max(1220, Math.min(1420, target.x + 110 + (rand() - 0.5) * 40));
                    const idealY = candidateY + (rand() - 0.5) * 60;
                    const x = Math.min(W - 30, Math.max(1210, idealX));
                    const y = Math.min(H - 30, Math.max(40, idealY));

                    const d = Math.hypot(x - target.x, y - target.y);
                    if (d <= 135 && d >= 60) {
                        if (canDeployHere(cardId, 'ai', x, y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                            deploy(cardId, 'ai', x, y);
                            return true;
                        }
                    }
                }
                // 兜底放在堡垒正后方（已修复下标 Bug）
                const targetBastion = isTopLane ? AI_BASTIONS[0] : AI_BASTIONS[1];
                for (let attempt = 0; attempt < 5; attempt++) {
                    const x = targetBastion.x + 40 + rand() * 50;
                    const y = targetBastion.y + (rand() - 0.5) * 50;
                    if (canDeployHere(cardId, 'ai', x, y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy(cardId, 'ai', x, y);
                        return true;
                    }
                }
                return false;
            };

            // ③ 哥布林小屋 / 牢笼 中路黄金拉扯
            const deployPullBuilding = (cardId) => {
                const hutRange = (CARDS[cardId] && CARDS[cardId].spawnRange) || 125;
                const pullY = H / 2 + (target.y < H / 2 ? -35 : 35);
                const idealX = target.x + 95;

                for (let attempt = 0; attempt < 8; attempt++) {
                    const x = Math.min(1180, Math.max(RIVER_RIGHT + 40, idealX + (rand() - 0.5) * 30));
                    const y = pullY + (rand() - 0.5) * 60;
                    const d = Math.hypot(x - target.x, y - target.y);
                    if (d >= 60 && d <= hutRange - 5) {
                        if (canDeployHere(cardId, 'ai', x, y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                            deploy(cardId, 'ai', x, y);
                            return true;
                        }
                    }
                }
                return false;
            };

            // ④ 哥布林爆破手 抛物线轰炸
            const deployBomberDefense = () => {
                const cardId = 'goblin_bomber';
                const isTopLane = target.y < H / 2;
                const candidateY = isTopLane ? 170 : 530;

                for (let attempt = 0; attempt < 6; attempt++) {
                    const x = Math.min(1350, Math.max(1210, target.x + 90 + (rand() - 0.5) * 30));
                    const y = candidateY + (rand() - 0.5) * 60;
                    const d = Math.hypot(x - target.x, y - target.y);
                    if (d <= 105 && d >= 50) {
                        if (canDeployHere(cardId, 'ai', x, y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                            deploy(cardId, 'ai', x, y);
                            return true;
                        }
                    }
                }
                return false;
            };

            // 属性克制分发
            const isFlying = !!target.flying;
            const isBuildingTargeter = target.targetMode === 'buildings';
            const nearbyClusterCount = invadingEnemies.filter(e => dist(e, target) <= 60).length;

            if (isFlying) {
                if (isReady('goblin_blowgun') && deployBlowgunKite()) return;
                if (isBuildingTargeter && isReady('goblin_hut') && deployPullBuilding('goblin_hut')) return;
                if (isReady('goblin_crew') && deploySurround('goblin_crew')) return;
                return;
            }

            if (isBuildingTargeter) {
                const hasPullBuilding = allies.some(e => (e.cardId === 'goblin_hut' || e.cardId === 'goblin_cage') && e.hp > 0 && e.x < 1200);
                if (!hasPullBuilding) {
                    if (isReady('goblin_hut') && deployPullBuilding('goblin_hut')) return;
                    if (isReady('goblin_cage') && deployPullBuilding('goblin_cage')) return;
                }
                if (isReady('goblin_pack') && deploySurround('goblin_pack')) return;
                if (isReady('goblin_crew') && deploySurround('goblin_crew')) return;
                if (isReady('goblin_blowgun') && deployBlowgunKite()) return;
                return;
            }

            if (nearbyClusterCount >= 3) {
                if (isReady('goblin_bomber') && deployBomberDefense()) return;
                if (isReady('goblin_curse') && canDeployHere('goblin_curse', 'ai', target.x, target.y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                    deploy('goblin_curse', 'ai', target.x, target.y);
                    return;
                }
            }

            if (isReady('goblin_pack') && deploySurround('goblin_pack')) return;
            if (isReady('goblin_crew') && deploySurround('goblin_crew')) return;
            if (isReady('goblin_blowgun') && deployBlowgunKite()) return;
            if (isReady('goblin_cage') && deployPullBuilding('goblin_cage')) return;
            if (isReady('goblin_hut') && deployPullBuilding('goblin_hut')) return;

            return;
        }

        // ============ 6. 发育模式（敌未过河，稳固防线）============
        if (mode === 'develop') {
            const elixir = game.elixir.ai;
            const enemyTowers = enemies.filter(e => e.type === 'bastion' || e.type === 'main_tower');

            // 溢水防浪费 (>= 8.5)
            if (elixir >= 8.5) {
                const shouldHarass = rand() < 0.25;
                if (shouldHarass && enemyTowers.length > 0) {
                    const targetTower = enemyTowers[Math.floor(rand() * enemyTowers.length)];
                    if (isReady('goblin_barrel')) {
                        const bx = targetTower.x + (rand() - 0.5) * 20;
                        const by = targetTower.y + (rand() - 0.5) * 20;
                        if (canDeployHere('goblin_barrel', 'ai', bx, by, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                            deploy('goblin_barrel', 'ai', bx, by);
                            return;
                        }
                    }
                    if (isReady('goblin_drill')) {
                        const dir = targetTower.team === 'player' ? 1 : -1;
                        const dx = Math.min(W - 30, Math.max(30, targetTower.x + dir * 50 + (rand() - 0.5) * 30));
                        const dy = Math.min(H - 30, Math.max(30, targetTower.y + (rand() - 0.5) * 40));
                        if (canDeployHere('goblin_drill', 'ai', dx, dy, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                            deploy('goblin_drill', 'ai', dx, dy);
                            return;
                        }
                    }
                }

                // 推荐沉底大怪
                const deployDeepBack = (cardId) => {
                    for (let attempt = 0; attempt < 8; attempt++) {
                        const x = 1440 + rand() * 80;
                        const y = 140 + rand() * (H - 280);
                        if (canDeployHere(cardId, 'ai', x, y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                            deploy(cardId, 'ai', x, y);
                            return true;
                        }
                    }
                    return false;
                };

                if (isReady('goblin_giant') && deployDeepBack('goblin_giant')) return;
                if (isReady('goblin_bomber') && deployDeepBack('goblin_bomber')) return;
            }

            // 核心永动机：哥布林小屋 + 医疗兵
            const myHuts = allies.filter(e => e.cardId === 'goblin_hut' && e.hp > 0);
            const myHealers = allies.filter(e => e.cardId === 'healer' && e.hp > 0);

            if (myHuts.length > 0 && myHealers.length < myHuts.length && isReady('healer')) {
                const targetHut = myHuts[0];
                for (let attempt = 0; attempt < 6; attempt++) {
                    const hx = Math.min(W - 30, Math.max(30, targetHut.x + 25 + (rand() - 0.5) * 20));
                    const hy = Math.min(H - 30, Math.max(30, targetHut.y + (rand() - 0.5) * 40));
                    if (canDeployHere('healer', 'ai', hx, hy, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('healer', 'ai', hx, hy);
                        return;
                    }
                }
            }

            if (myHuts.length === 0 && isReady('goblin_hut') && elixir >= 5) {
                for (let attempt = 0; attempt < 8; attempt++) {
                    const isTop = rand() < 0.5;
                    const hx = 1080 + rand() * 100;
                    const hy = isTop ? (140 + rand() * 100) : (460 + rand() * 100);
                    if (canDeployHere('goblin_hut', 'ai', hx, hy, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('goblin_hut', 'ai', hx, hy);
                        return;
                    }
                }
            }

            // 经济建设与加盾
            if (collectorCount < 2 && isReady('elixir_collector') && elixir >= 7) {
                for (let attempt = 0; attempt < 8; attempt++) {
                    const cx = 1240 + rand() * 220;
                    const cy = 80 + rand() * (H - 160);
                    if (canDeployHere('elixir_collector', 'ai', cx, cy, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('elixir_collector', 'ai', cx, cy);
                        return;
                    }
                }
            }

            const armorCount = allies.filter(e => e.cardId === 'armor_smith' && e.hp > 0).length;
            if (armorCount < 1 && isReady('armor_smith') && elixir >= 5) {
                for (let attempt = 0; attempt < 6; attempt++) {
                    const ax = 1220 + rand() * 180;
                    const ay = 100 + rand() * (H - 200);
                    if (canDeployHere('armor_smith', 'ai', ax, ay, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('armor_smith', 'ai', ax, ay);
                        return;
                    }
                }
            }

            // 次级防线牢笼
            const cageCount = allies.filter(e => e.cardId === 'goblin_cage' && e.hp > 0).length;
            if (cageCount === 0 && isReady('goblin_cage') && elixir >= 6) {
                for (let attempt = 0; attempt < 6; attempt++) {
                    const cx = RIVER_RIGHT + 30 + rand() * (AI_BASTIONS[0].x - RIVER_RIGHT - 60);
                    const cy = 80 + rand() * (H - 160);
                    if (canDeployHere('goblin_cage', 'ai', cx, cy, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('goblin_cage', 'ai', cx, cy);
                        return;
                    }
                }
            }

            return;
        }

        // ============ 7. 进攻模式（哥布林军团全面进攻）============
        if (mode === 'attack') {
            const elixir = game.elixir.ai;

            // 1. 择路机制：优先选择血量更低的残血堡垒
            const enemyBastions = enemies.filter(e => e.type === 'bastion' && e.hp > 0);
            const enemyMainTower = enemies.find(e => e.type === 'main_tower' && e.hp > 0);

            let attackTargetY = H / 2;
            let primaryTargetBuilding = enemyMainTower;

            if (enemyBastions.length > 0) {
                enemyBastions.sort((a, b) => a.hp - b.hp);
                primaryTargetBuilding = enemyBastions[0];
                attackTargetY = primaryTargetBuilding.y;
            }

            // 2. 前排核心：哥布林巨人推进
            const activeGiant = allies.find(e => e.cardId === 'goblin_giant' && e.hp > 0);

            if (!activeGiant && isReady('goblin_giant') && elixir >= 6) {
                for (let attempt = 0; attempt < 6; attempt++) {
                    const gx = RIVER_RIGHT + 25 + rand() * 40;
                    const gy = attackTargetY + (rand() - 0.5) * 40;
                    if (canDeployHere('goblin_giant', 'ai', gx, gy, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('goblin_giant', 'ai', gx, gy);
                        return;
                    }
                }
            }

            // 3. 巨人协同护航（跟兵点位随破堡动态前压）
            if (activeGiant) {
                // 3a. 巨人近塔抗伤 -> 飞桶 / 钻机直取防御塔
                if (activeGiant.x < RIVER_RIGHT && primaryTargetBuilding) {
                    if (isReady('goblin_barrel')) {
                        const bx = primaryTargetBuilding.x + (rand() - 0.5) * 15;
                        const by = primaryTargetBuilding.y + (rand() - 0.5) * 15;
                        if (canDeployHere('goblin_barrel', 'ai', bx, by, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                            deploy('goblin_barrel', 'ai', bx, by);
                            return;
                        }
                    }
                    if (isReady('goblin_drill')) {
                        const dir = primaryTargetBuilding.team === 'player' ? 1 : -1;
                        const dx = Math.min(W - 30, Math.max(30, primaryTargetBuilding.x + dir * 45));
                        const dy = primaryTargetBuilding.y + (rand() - 0.5) * 30;
                        if (canDeployHere('goblin_drill', 'ai', dx, dy, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                            deploy('goblin_drill', 'ai', dx, dy);
                            return;
                        }
                    }
                }

                // 3b. 哥布林魔咒滚雪球
                const frontEnemies = enemies.filter(e => e.hp > 0 && dist(e, activeGiant) <= 120);
                if (frontEnemies.length >= 2 && isReady('goblin_curse')) {
                    const avgX = frontEnemies.reduce((s, e) => s + e.x, 0) / frontEnemies.length;
                    const avgY = frontEnemies.reduce((s, e) => s + e.y, 0) / frontEnemies.length;
                    if (canDeployHere('goblin_curse', 'ai', avgX, avgY, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('goblin_curse', 'ai', avgX, avgY);
                        return;
                    }
                }

                // 3c. 治疗兵跟随（动态前线边界）
                const hasHealer = allies.some(e => e.cardId === 'healer' && dist(e, activeGiant) <= 120 && e.hp > 0);
                if (!hasHealer && isReady('healer') && activeGiant.hp < activeGiant.maxHp * 0.9) {
                    const hx = Math.min(W - 30, Math.max(aiLeftBoundary + 25, activeGiant.x + 35));
                    const hy = activeGiant.y + (rand() - 0.5) * 30;
                    if (canDeployHere('healer', 'ai', hx, hy, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('healer', 'ai', hx, hy);
                        return;
                    }
                }

                // 3d. 吹箭手护航（动态前线边界）
                const hasBlowgun = allies.some(e => e.cardId === 'goblin_blowgun' && dist(e, activeGiant) <= 140 && e.hp > 0);
                if (!hasBlowgun && isReady('goblin_blowgun')) {
                    const bx = Math.min(W - 30, Math.max(aiLeftBoundary + 25, activeGiant.x + 45));
                    const by = activeGiant.y + (rand() - 0.5) * 40;
                    if (canDeployHere('goblin_blowgun', 'ai', bx, by, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('goblin_blowgun', 'ai', bx, by);
                        return;
                    }
                }

                // 3e. 爆破手后排清障（动态前线边界）
                if (isReady('goblin_bomber') && elixir >= 5) {
                    const bx = Math.min(W - 30, Math.max(aiLeftBoundary + 25, activeGiant.x + 40));
                    const by = activeGiant.y + (rand() - 0.5) * 30;
                    if (canDeployHere('goblin_bomber', 'ai', bx, by, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('goblin_bomber', 'ai', bx, by);
                        return;
                    }
                }

                // 3f. 团伙跟随冲锋（动态前线边界）
                if (isReady('goblin_crew') && elixir >= 5) {
                    const cx = Math.min(W - 30, Math.max(aiLeftBoundary + 25, activeGiant.x + 30));
                    const cy = activeGiant.y + (rand() - 0.5) * 30;
                    if (canDeployHere('goblin_crew', 'ai', cx, cy, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('goblin_crew', 'ai', cx, cy);
                        return;
                    }
                }
            }

            // 4. 巨人空窗期的持续施压与桥头快攻
            if (!activeGiant && elixir >= 5) {
                if (isReady('goblin_barrel') && primaryTargetBuilding) {
                    const bx = primaryTargetBuilding.x + (rand() - 0.5) * 20;
                    const by = primaryTargetBuilding.y + (rand() - 0.5) * 20;
                    if (canDeployHere('goblin_barrel', 'ai', bx, by, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('goblin_barrel', 'ai', bx, by);
                        return;
                    }
                }
                if (isReady('goblin_drill') && primaryTargetBuilding) {
                    const dir = primaryTargetBuilding.team === 'player' ? 1 : -1;
                    const dx = Math.min(W - 30, Math.max(30, primaryTargetBuilding.x + dir * 50));
                    const dy = primaryTargetBuilding.y + (rand() - 0.5) * 40;
                    if (canDeployHere('goblin_drill', 'ai', dx, dy, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('goblin_drill', 'ai', dx, dy);
                        return;
                    }
                }
                if (isReady('goblin_crew')) {
                    const cx = RIVER_RIGHT + 30;
                    const cy = attackTargetY + (rand() - 0.5) * 50;
                    if (canDeployHere('goblin_crew', 'ai', cx, cy, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('goblin_crew', 'ai', cx, cy);
                        return;
                    }
                }
                if (isReady('goblin_pack')) {
                    const px = RIVER_RIGHT + 30;
                    const py = attackTargetY + (rand() - 0.5) * 50;
                    if (canDeployHere('goblin_pack', 'ai', px, py, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy('goblin_pack', 'ai', px, py);
                        return;
                    }
                }
            }

            return;
        }

        return;
    },
};
