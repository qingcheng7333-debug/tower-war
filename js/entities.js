/* ===== entities.js — 实体创建与基础操作 ===== */

/** 创建实体（分配唯一 id，合并基础属性） */
function createEntity(base) {
    // 通用护盾字段兜底：任何实体创建统一带上 shield/maxShield（无盾则0），
    // 未来带盾卡牌只需在配置里加 shield 即可自动生效
    return { ...base, id: entityIdCounter++, shield: base.shield || 0, maxShield: base.shield || 0,
             _chargeTimer: base._chargeTimer || 0,
             // 渲染插值基准：上一逻辑帧位置（main.js 每帧投影绘制用，联机 Fixed Timestep 配套）
             prevX: base.x ?? 0, prevY: base.y ?? 0 };
}

/** 🔮 法术屏障：检查 (x,y) 是否落在【敌方】法术屏障的庇护范围内（敌方不能在该区域释放法术） */
function isSpellBlockedByBarrier(casterTeam, x, y) {
    const enemyTeam = casterTeam === 'player' ? 'ai' : 'player';
    const barrierRange = (CARDS.spell_barrier && CARDS.spell_barrier.barrierRange) || 200;
    for (const e of game.entities) {
        if (e.cardId === 'spell_barrier' && e.team === enemyTeam && e.hp > 0) {
            if (Math.hypot(e.x - x, e.y - y) <= barrierRange) return true;
        }
    }
    return false;
}

/** 部署卡牌：先检查费用、冷却和位置，再加入部署延迟队列 */
/** 🛕 哥布林神庙·在场判定：本体/镜像槽 mode==='skill'（场上每方最多1座神庙，先查本体再查镜像） */
function isTempleOnField(team) {
    const esT = game.eliteSkills[team] || {};
    return !!(esT['goblin_temple'] && esT['goblin_temple'].mode === 'skill')
        || !!(esT['mirror_goblin_temple'] && esT['mirror_goblin_temple'].mode === 'skill');
}

/** 🛕 哥布林神庙·神赐减费：使用哥布林卡牌 → 在场神庙的神赐费用-1（最低1费）
 *  神庙在场判定：本体/镜像槽 mode==='skill'（场上每方最多1座神庙，先查本体再查镜像） */
function applyTempleBlessDiscount(team) {
    if (!isTempleOnField(team)) return;
    const esT = game.eliteSkills[team] || {};
    const tKey = (esT['goblin_temple'] && esT['goblin_temple'].mode === 'skill') ? 'goblin_temple' : 'mirror_goblin_temple';
    const t = esT[tKey];
    t.blessCost = Math.max(1, (t.blessCost != null ? t.blessCost : 11) - 1);
}

/** 🔮 法术屏障费用递增：场上每多1座己方屏障，费用+2（部署时动态计算） */
function getCardCost(team, cardId) {
    const base = (CARDS[cardId] && CARDS[cardId].cost) || 0;
    if (cardId !== 'spell_barrier') return base;
    const count = game.entities.filter(e => e.cardId === 'spell_barrier' && e.team === team && e.hp > 0).length;
    return base + count * 2;
}

function deploy(cardId, team, x, y) {
    const card = CARDS[cardId];
    if (!card) {
        game.uiState.deployFailReason = 'invalid';
        return false;
    }

    // ★ 镜像法术：复制上一次部署的卡牌（费用+1）
    if (cardId === 'mirror') {
        const lastId = getMirrorCopiedCard(team);
        if (!lastId || lastId === 'mirror' || !CARDS[lastId]) {
            game.uiState.deployFailReason = 'invalid';
            return false;
        }
        const origCard = CARDS[lastId];
        // 🔮 镜像复制屏障：费用跟随屏障动态费用+1（屏障6→镜像7，屏障8→镜像9）
        const mirrorCost = (lastId === 'spell_barrier' ? getCardCost(team, lastId) : origCard.cost) + 1;
        const elixir = team === 'player' ? game.elixir.player : game.elixir.ai;
        if (elixir < mirrorCost) {
            game.uiState.deployFailReason = 'elixir';
            return false;
        }
        // ★ 卡组模式：镜像法术同样受卡组限制（需卡组包含镜像法术，避免绕过卡组检查）
        if (game.gameMode === 'deck' && team === 'player') {
            const deckCards = getActiveDeckCards();
            if (!deckCards.includes('mirror')) {
                game.uiState.deployFailReason = 'invalid';
                return false;
            }
        }
        if (game.gameMode === 'api') {
            const deckCards = getActiveDeckCards();
            if (!deckCards.includes('mirror')) {
                game.uiState.deployFailReason = 'invalid';
                return false;
            }
        }
        // 检查镜像自身的冷却
        const cd = getMirrorCooldown(team);
        if (cd > 0) {
            game.uiState.deployFailReason = 'cooldown';
            return false;
        }
        // 🪞 镜像精英占用检查：技能槽、场上实体、部署队列三处任一存在即拒绝，避免覆盖已有镜像状态
        const mirrorEliteState = getMirrorState(team);
        const mirrorEliteOccupied = !!mirrorEliteState.eliteSkillKey
            || game.entities.some(e => e.cardId === lastId && e.team === team
                && e.isMirrored && e.hp > 0 && !e.isCopy)
            || game.deploying.some(d => d.cardId === lastId && d.team === team && d.isMirrored);
        if (origCard.activeSkill && mirrorEliteOccupied) {
            game.uiState.deployFailReason = 'elite_used';
            return false;
        }
        // ★ ⛺ 镜像营地拆除：镜像上次部署的营地，点击己方已部署营地 → 消耗镜像标价（原价+1）直接拆除
        if (lastId === 'camp') {
            const ownCamp = game.entities.find(e => e.cardId === 'camp' && e.team === team && e.hp > 0
                && Math.abs(e.x - x) <= 15 && Math.abs(e.y - y) <= 15);
            if (ownCamp) {
                if (team === 'player') game.elixir.player -= mirrorCost;
                else game.elixir.ai -= mirrorCost;
                ownCamp.hp = 0; // 标记死亡 → update.js 统一清理；被收编成员下一帧因营地消失自动解除🚩
                // ★ 镜像拆除营地同样进入冷却（继承营地冷却），不能无限拆
                setMirrorCooldown(team, origCard.cooldown || 0);
                return true;
            }
        }
        // 检查部署位置（使用原始卡牌的规则）
        if (!canDeployHere(lastId, team, x, y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
            game.uiState.deployFailReason = 'position';
            return false;
        }
        // 🔮 法术屏障：敌方不能在庇护范围内释放法术（镜像复制法术同样受限）
        if (CARDS[lastId].type === 'spell' && isSpellBlockedByBarrier(team, x, y)) {
            game.uiState.deployFailReason = 'barrier';
            return false;
        }
        // 🛕 哥布林神庙：镜像复制同样受"每方最多1座"限制（场上/部署延迟在途都算）
        if (lastId === 'goblin_temple') {
            const hasTemple = game.entities.some(e => e.cardId === 'goblin_temple' && e.team === team && e.hp > 0)
                || game.deploying.some(d => d.cardId === 'goblin_temple' && d.team === team);
            if (hasTemple) {
                game.uiState.deployFailReason = 'temple_limit';
                return false;
            }
        }

        // ★ 🧭 镜像复制烟引：走新流程（扣镜像费2 → 0.2s延迟 → 套buff进pending → 12s内放烟）
        //   镜像烟引 pending 期间镜像卡锁定为烟引下烟态（0费🧭+倒计时），不跟随 lastDeployedCardId 变化
        if (lastId === 'smoke_guide') {
            if (game.mirrorSmokePending[team]) {     // 镜像烟引使用独立 pending，不能影响原烟引
                game.uiState.deployFailReason = 'invalid';
                return false;
            }
            // 扣镜像费（烟引1费+1=2费）
            if (team === 'player') game.elixir.player -= mirrorCost;
            else game.elixir.ai -= mirrorCost;
            // 镜像冷却继承烟引（15s），但 pending 期间不读秒——放烟/超时才真正开始
            clearMirrorCooldown(team);   // 先清除，pending 结束时再设
            // 加入部署延迟队列（用烟引的0.2s延迟）
            game.deploying.push({
                cardId: 'smoke_guide', team, x, y,
                timer: CARDS.smoke_guide.deployDelay || 0.2,
                totalDelay: CARDS.smoke_guide.deployDelay || 0.2,
                isPlayer: team === 'player',
                isMirrored: true,
                isSmokePhase1: true,
            });
            return true;
        }

        // 扣除圣水（按镜像费用）
        if (team === 'player') game.elixir.player -= mirrorCost;
        else game.elixir.ai -= mirrorCost;
        // 🛕 哥布林神庙·神赐：镜像复制哥布林卡也计入「使用哥布林卡」→ 在场神庙神赐费用-1
        if (origCard.goblin) applyTempleBlessDiscount(team);

        // ★ 镜像冷却：继承被复制卡的冷却（复制冷却3s的卡 → 镜像也黑3s；期间使用其他卡不影响镜像冷却）
        //   🕊️ 精英卡特殊：镜像精英在场期间镜像卡是技能卡、不读秒；等镜像精英死亡后才开始读秒（update.js 死亡结算设置）
        let mirrorDeployToken = null;
        if (origCard.activeSkill) {
            clearMirrorCooldown(team);
            // 立即预创建镜像槽：部署延迟结束前镜像卡即变为技能卡，防止延迟窗口内重复部署出多个镜像
            const es = game.eliteSkills[team] || {};
            mirrorDeployToken = nextMirrorDeployToken();
            es['mirror_' + lastId] = { mode: 'skill', cdLeft: 0, skillCdLeft: 0, blessCost: origCard.activeSkill.cost, mirrorDeployToken };
        } else {
            setMirrorCooldown(team, origCard.cooldown || 0);
        }

        // 记录敌方部署信息（供 AI 使用）
        if (team === 'player') {
            game.lastEnemyDeploy = { cardId: lastId, x, y, time: game.time };
        }

        // 加入部署延迟队列（使用原始卡牌的延迟）
        const delay = origCard.deployDelay || 0.5;
        game.deploying.push({
            cardId: lastId,
            team,
            x,
            y,
            timer: delay,
            totalDelay: delay,
            isPlayer: team === 'player',
            isMirrored: true,
            mirrorDeployToken: origCard.activeSkill ? mirrorDeployToken : null,
            templeBlessed: !!(origCard.goblin && isTempleOnField(team))   // 🛕 神庙接收提示：镜像复制哥布林卡且神庙在场
        });

        return true;
    }

    // ★ 卡组对战：玩家只能部署卡组中的卡牌
    if (game.gameMode === 'deck' && team === 'player') {
        const deckCards = getActiveDeckCards();
        if (!deckCards.includes(cardId)) {
            game.uiState.deployFailReason = 'invalid';
            return false;
        }
    }
    // ★ AI对战：双方都只能部署卡组中的卡牌
    if (game.gameMode === 'api') {
        const deckCards = getActiveDeckCards();
        if (!deckCards.includes(cardId)) {
            game.uiState.deployFailReason = 'invalid';
            return false;
        }
    }

    // ★ 🧭 烟引法术·第一段（选范围→套buff进pending）：
    //    点击地图 → 扣费 → 0.2s部署延迟后给范围内（radius=85同极速）友军套🧭闪烁buff → 进入12s pending
    //    不进冷却（等放烟或超时才进冷却）；不注册 lastDeployedCardId（放烟那一刻才注册，防镜像 pending 期间误触发复制）
    if (cardId === 'smoke_guide') {
        const elixirS = team === 'player' ? game.elixir.player : game.elixir.ai;
        if (elixirS < card.cost) {
            game.uiState.deployFailReason = 'elixir';
            return false;
        }
        const cdS = (game.cardCooldowns[team] || {})['smoke_guide'] || 0;
        if (cdS > 0) {
            game.uiState.deployFailReason = 'cooldown';
            return false;
        }
        // 🔮 法术屏障：敌方不能在庇护范围内放烟（第一段选范围也受限）
        if (isSpellBlockedByBarrier(team, x, y)) {
            game.uiState.deployFailReason = 'barrier';
            return false;
        }
        // ★ 同一方已有 pending → 不可重复（防止叠加）
        if (game.smokePending[team]) {
            game.uiState.deployFailReason = 'invalid';
            return false;
        }
        // 扣费（此时不进冷却，不注册 lastDeployedCardId）
        if (team === 'player') game.elixir.player -= card.cost;
        else game.elixir.ai -= card.cost;
        // 加入部署延迟队列（0.2s后由 finishDeployItem 套buff进pending）
        game.deploying.push({
            cardId: 'smoke_guide', team, x, y,
            timer: card.deployDelay || 0.2,
            totalDelay: card.deployDelay || 0.2,
            isPlayer: team === 'player',
            isSmokePhase1: true,   // ★ 烟引第一段标记（finishDeployItem 据此走 pending 逻辑）
        });
        return true;
    }

    // 🔮 法术屏障费用递增：场上每多1座己方屏障费用+2（动态费用）
    const deployCost = getCardCost(team, cardId);
    const elixir = team === 'player' ? game.elixir.player : game.elixir.ai;
    if (elixir < deployCost) {
        game.uiState.deployFailReason = 'elixir';
        return false;
    }

    // ★ 检查冷却：冷却未结束则无法部署
    const cd = (game.cardCooldowns[team] || {})[cardId] || 0;
    if (cd > 0) {
        game.uiState.deployFailReason = 'cooldown';
        return false;
    }

    // 🕊️ 精英主动技能：卡牌处于「技能」模式（已部署）或技能已用（变黑）→ 不可部署；死亡恢复 deploy 后才有部署资格
    if (card.activeSkill) {
        const es = game.eliteSkills[team] || {};
        const st = es[cardId];
        if (st && st.mode !== 'deploy') {
            game.uiState.deployFailReason = 'elite_used';
            return false;
        }
    }

    // 🛕 哥布林神庙：每方最多同时存在1座（含🪞镜像复制、部署延迟在途），场上/在途已有神庙则拒绝部署
    if (cardId === 'goblin_temple') {
        const hasTemple = game.entities.some(e => e.cardId === 'goblin_temple' && e.team === team && e.hp > 0)
            || game.deploying.some(d => d.cardId === 'goblin_temple' && d.team === team);
        if (hasTemple) {
            game.uiState.deployFailReason = 'temple_limit';
            return false;
        }
    }

    // ★ ⛺ 临时营地拆除：选中营地卡点击己方已部署的营地 → 消耗圣水（与部署同费）直接拆除该营地
    if (cardId === 'camp') {
        const ownCamp = game.entities.find(e => e.cardId === 'camp' && e.team === team && e.hp > 0
            && Math.abs(e.x - x) <= 15 && Math.abs(e.y - y) <= 15);
        if (ownCamp) {
            if (team === 'player') game.elixir.player -= card.cost;
            else game.elixir.ai -= card.cost;
            ownCamp.hp = 0; // 标记死亡 → update.js 统一清理；被收编成员下一帧因营地消失自动解除🚩
            return true;
        }
    }

    if (!canDeployHere(cardId, team, x, y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
        game.uiState.deployFailReason = 'position';
        return false;
    }

    // 🔮 法术屏障：敌方不能在庇护范围内释放法术
    if (card.type === 'spell' && isSpellBlockedByBarrier(team, x, y)) {
        game.uiState.deployFailReason = 'barrier';
        return false;
    }

    // 扣除圣水
    if (team === 'player') game.elixir.player -= deployCost;
    else game.elixir.ai -= deployCost;
    // 🛕 哥布林神庙·神赐：使用哥布林卡牌 → 在场神庙神赐费用-1（最低1费）
    if (card.goblin) applyTempleBlessDiscount(team);

    // ★ 设置冷却（圣水扣除时立即触发，不等部署延迟结束）
    // 🕊️ 精英主动技能：冷却由 eliteSkills 管理（死亡后才开始计时），不写入 cardCooldowns，
    //    避免技能卡上误显示部署冷却（部署后卡牌应立即变为技能卡）
    if (!card.activeSkill) game.cardCooldowns[team][cardId] = card.cooldown;

    // 🕊️ 精英卡在扣费并进入部署延迟时立即切换为技能态，锁住卡牌，防止延迟期间重复部署。
    //    技能真正释放前仍由 castActiveSkill 检查场上实体是否已经生成。
    if (card.activeSkill) {
        const es = game.eliteSkills[team] || {};
        const key = cardId;
        const oldState = es[key] || {};
        es[key] = {
            mode: 'skill',
            cdLeft: 0,
            skillCdLeft: 0,
            blessCost: oldState.blessCost != null ? oldState.blessCost : card.activeSkill.cost,
        };
    }

    // ★ 记录玩家（敌方）的最后部署信息，供 AI 即时反制使用
    if (team === 'player') {
        game.lastEnemyDeploy = { cardId, x, y, time: game.time };
    }

    // ★ 记录上一次部署的卡牌ID（供镜像法术使用，按阵营分开）
    if (team === 'player') game.lastDeployedCardId = cardId;
    else game.lastDeployedCardId2 = cardId;

    // 加入部署延迟队列，延迟结束后才真正生成
    const delay = card.deployDelay || 0.5;
    game.deploying.push({
        cardId,
        team,
        x,
        y,
        timer: delay,
        totalDelay: delay,
        isPlayer: team === 'player',
        templeBlessed: !!(card.goblin && isTempleOnField(team))   // 🛕 神庙接收提示：哥布林卡且神庙在场
    });

    return true;
}

/** 🧭 烟引：创建一条活跃引导（放烟点）。先出现部署延迟样式的计时环，结束后冒烟10秒并引导友军 */
function startSmokeGuide(team, unitId, tx, ty) {
    const countdown = CARDS.smoke_guide.deployDelay || 0.8;   // 计时特效时长（参考部署延迟，与卡牌配置一致）
    game.smokeGuides.push({
        team,
        unitId,
        tx, ty,
        phase: 'countdown',
        countdown,
        countdownMax: countdown,
        timer: 0,
        maxTimer: 0,
        isPlayer: team === 'player',
    });
}

/** 🥷 部署哥布林团伙：3只哥布林投矛手 + 3只近战哥布林（蓝方投矛手在左/哥布林在右，红方镜像） */
function spawnGoblinCrew(item) {
    const isPlayer = item.team === 'player';
    for (let i = 0; i < 6; i++) {
        const isThrower = i < 3;
        const tpl = isThrower ? GOBLIN_THROWER_TEMPLATE : GOBLIN_MELEE_TEMPLATE;
        // 蓝方：投矛手左列 + 近战哥布林右列，每列3只纵向排列（矛/刀 两排）；红方镜像（投矛手右列 + 哥布林左列）
        const dir = isPlayer ? (isThrower ? -1 : 1) : (isThrower ? 1 : -1);
        const idx = i % 3;
        const spawnX = Math.min(W - 30, Math.max(30, item.x + dir * 26));
        const spawnY = Math.min(H - 30, Math.max(30, item.y + (idx - 1) * 26));
        // 统一走 createSummon：精确坐标传 x/y（jitter 0 保持原位），模板字段自动透传
        const entity = createSummon(tpl, isThrower ? 'goblin_thrower' : 'goblin_melee', spawnX, spawnY, item.team,
            { jitterX: 0, jitterY: 0, extra: item.isMirrored ? { isMirrored: true } : {} });
        game.entities.push(entity);
    }
}

/** 🥷 部署哥布林（2费）：4只近战哥布林（小刀），竖排两列（蓝方左列在前/红方镜像） */
function spawnGoblinPack(item) {
    const isPlayer = item.team === 'player';
    const tpl = GOBLIN_MELEE_TEMPLATE;
    for (let i = 0; i < 4; i++) {
        const col = i % 2;         // 0=左列 1=右列
        const row = Math.floor(i / 2); // 0=前 1=后
        const dir = isPlayer ? (col === 0 ? -1 : 1) : (col === 0 ? 1 : -1);
        const spawnX = Math.min(W - 30, Math.max(30, item.x + dir * 22));
        const spawnY = Math.min(H - 30, Math.max(30, item.y + (row - 0.5) * 30));
        // 统一走 createSummon：精确坐标传 x/y（jitter 0 保持原位），模板字段自动透传
        const entity = createSummon(tpl, 'goblin_melee', spawnX, spawnY, item.team,
            { jitterX: 0, jitterY: 0, extra: item.isMirrored ? { isMirrored: true } : {} });
        game.entities.push(entity);
    }
}

/** 🪵 部署木桶卫队：6名护卫纵向一列，间距加大，保持整齐阵型向前推进 */
function spawnBarrelGuard(item) {
    const tpl = BARREL_GUARD_TEMPLATE;
    const count = 6;
    const spacing = 75; // 超大间距：6名护卫纵向展开约375px
    const minY = 30, maxY = H - 30;
    const span = (count - 1) * spacing;
    // 先整体规划队列，再根据部署点贴向最近边缘；不对每个成员单独夹紧，避免重叠
    let firstY;
    if (item.y - span / 2 < minY) {
        // 贴近上边：最上方成员以安全边界为基准，向下依次排开
        firstY = minY;
    } else if (item.y + span / 2 > maxY) {
        // 贴近下边：最下方成员以安全边界为基准，向上依次排开
        firstY = maxY - span;
    } else {
        // 中部部署：以部署点为中心排列
        firstY = item.y - span / 2;
    }
    const spawnX = Math.min(W - 30, Math.max(30, item.x));
    for (let i = 0; i < count; i++) {
        const spawnY = firstY + i * spacing;
        const entity = createSummon(tpl, 'barrel_guard', spawnX, spawnY, item.team,
            { jitterX: 0, jitterY: 0, extra: item.isMirrored ? { isMirrored: true } : {} });
        game.entities.push(entity);
    }
}

/** 完成一个部署延迟项（由 update.js 在倒计时归零时调用） */
function finishDeployItem(item) {
    const card = CARDS[item.cardId];
    if (!card) return;

    // 🪞 二次防重复：延迟部署真正生成前再次确认镜像精英未被同类镜像实体/部署占用。
    //    防止重复指令或延迟队列重复项覆盖同一个 mirror_技能槽；普通镜像兵种不受此限制。
    if (item.isMirrored && card.activeSkill && !item._mirrorValidated) {
        const state = getMirrorEliteSkillState(item.team, item.cardId);
        const tokenMatches = !!state && state.mirrorDeployToken === item.mirrorDeployToken;
        const duplicateEntity = game.entities.some(e => e.cardId === item.cardId
            && e.team === item.team && e.isMirrored && e.hp > 0 && !e.isCopy);
        const duplicateDeploy = game.deploying.some(d => d !== item && d.isMirrored
            && d.cardId === item.cardId && d.team === item.team);
        // 技能槽令牌必须匹配当前部署项；已有实体或其他在途项存在时，当前项取消且不触碰合法项状态
        if (!tokenMatches || duplicateEntity || duplicateDeploy) return;
        item._mirrorValidated = true;
    }

    // ★ 矿工/哥布林钻机 三段式部署：部署延迟结束后 → ①土堆从己方主塔挖地道前进(tunnelTime)抵达部署点 → ②原地潜伏(digTime) → ③真正生成实体破土出现
    //   全程纯特效（无实体、不参与碰撞/推动），不可被锁定，AOE/溅射仍可波及
    if (item.cardId === 'miner' || item.cardId === 'goblin_drill') {
        if (!item._tunnelDone) {
            // ① 挖掘前进段：土堆从己方主塔一路挖向部署点（找不到主塔时兜底原地开始）
            const tunnelTime = CARDS[item.cardId].tunnelTime || 2;
            const mainTower = game.entities.find(e => e.type === 'main_tower' && e.team === item.team && e.hp > 0);
            const x0 = mainTower ? mainTower.x : item.x;
            const y0 = mainTower ? mainTower.y : item.y;
            game.spellEffects.push({
                x: item.x, y: item.y,
                x0: x0, y0: y0,
                type: 'miner_tunnel',
                timer: tunnelTime, maxTimer: tunnelTime,
                isPlayer: item.isPlayer,
            });
            game.deploying.push({
                cardId: item.cardId, team: item.team, x: item.x, y: item.y,
                timer: tunnelTime, totalDelay: tunnelTime,
                isPlayer: item.isPlayer, _tunnelDone: true,
            });
            return;
        }
        if (!item._dugSpawn) {
            // ② 原地潜伏段：土堆抵达部署点，从无到有隆起成型（digTime 秒后破土）
            const digTime = CARDS[item.cardId].digTime || 0.6;
            game.spellEffects.push({
                x: item.x, y: item.y,
                type: 'miner_dig',
                timer: digTime, maxTimer: digTime,
                isPlayer: item.isPlayer,
            });
            game.deploying.push({
                cardId: item.cardId, team: item.team, x: item.x, y: item.y,
                timer: digTime, totalDelay: digTime,
                isPlayer: item.isPlayer, _tunnelDone: true, _dugSpawn: true,
            });
            return;
        }
        // ③ 破土段：落到下方对应类型（troop/tower）生成逻辑，实体生成即破土现身
    }

    if (card.type === 'troop') {
        // ★ 哥布林团伙：3投矛手 + 3近战哥布林 分组列阵（蓝方投矛手在左/哥布林在右，红方镜像）
        if (item.cardId === 'goblin_crew') {
            spawnGoblinCrew(item);
            return;
        }
        // ★ 哥布林（2费）：4只近战哥布林 竖排两列
        if (item.cardId === 'goblin_pack') {
            spawnGoblinPack(item);
            return;
        }
        // ★ 木桶卫队：6名木桶护卫横向排成一排，使用独立模板和建模
        if (item.cardId === 'barrel_guard') {
            spawnBarrelGuard(item);
            return;
        }
        const count = card.count || 1;
        const spread = count > 4 ? 22 : 14;
        const gangSpawnRadius = 50;   // 骷髅海：在部署点周围范围内随机召唤
        // ★ 复用基础单位模板（如骷髅海→通用哥布林），卡牌自身不保留独立数值；
        //   有独立属性的卡牌（女巫/暗夜女巫等）一律用自身属性，避免 spawnUnit 误覆盖部署模板
        const unit = (card.hp ? card : ((card.spawnUnit && BASE_UNITS[card.spawnUnit]) || card));
        for (let i = 0; i < count; i++) {
            let spawnX, spawnY;
            if (item.cardId === 'goblin_gang') {
                // ★ 骷髅海：范围内召唤（圆形区域内随机分布，而非一字排开）
                const ang = rand() * Math.PI * 2;
                const r = Math.sqrt(rand()) * gangSpawnRadius;
                spawnX = item.x + Math.cos(ang) * r;
                spawnY = item.y + Math.sin(ang) * r;
            } else if (item.cardId === 'tram_squad' || item.cardId === 'skeleton_guard' || item.cardId === 'fly_swarm') {
                // ★ 电车小队/守卫骷髅/苍蝇海：部署点周围圆形区域内随机分散（不排成一排，更分散）
                const ang = rand() * Math.PI * 2;
                const r = Math.sqrt(rand()) * 50;
                spawnX = item.x + Math.cos(ang) * r;
                spawnY = item.y + Math.sin(ang) * r;
            } else {
                spawnX = item.x + (count > 1 ? (i - (count - 1) / 2) * spread : 0);
                spawnY = item.y + (count > 1 ? (rand() - 0.5) * 28 : 0);
            }
            spawnX = Math.min(W - 30, Math.max(30, spawnX));
            spawnY = Math.min(H - 30, Math.max(30, spawnY));
            const entity = createEntity({
                type: 'troop', team: item.team, cardId: item.cardId,
                x: spawnX, y: spawnY,
                hp: unit.hp, maxHp: unit.hp,
                atk: unit.atk, atkSpeed: unit.atkSpeed, atkCooldown: 0,
                moveSpeed: unit.moveSpeed, range: unit.range,
                targetMode: unit.targetMode, targetId: null,
                flying: unit.flying || false,
                groundOnly: unit.groundOnly || false,
                splash: unit.splash || 0,
                shotCount: unit.shotCount || 1,
                shield: unit.shield || 0,
                canHitAir: unit.canHitAir || false,
            });
            // 暗夜女巫/女巫：附带召唤计时器
            if (item.cardId === 'night_witch' || item.cardId === 'witch') {
                entity.spawnTimer = 0;
            }
            // 冥王：灵魂计数器与等级
            if (item.cardId === 'hades') {
                entity._souls = 0;
                entity._level = 1;
                entity._soulsPerLevel = 7;
                entity._maxLevel = 10;
                entity._baseHp = entity.hp;
                entity._baseAtk = entity.atk;
            }
            // 地狱飞龙：光束灼烧字段初始化（攻击模式复用地狱塔）
            if (item.cardId === 'inferno_dragon') {
                entity._beamSwitchCooldown = 0;
                entity._beamTimer = 0;
                entity._beamTargetId = null;
            }
            // 攻城人：自爆标记
            if (item.cardId === 'siege_man') {
                entity.isSiege = true;
            }
            // 冰豆：标记为冰豆
            if (item.cardId === 'ice_bean') {
                entity._iceBean = true;
            }
            // 火豆：标记为火豆
            if (item.cardId === 'fire_bean') {
                entity._fireBean = true;
            }
            // 幽灵：初始隐身 + 计时器
            if (item.cardId === 'ghost') {
                entity._stealthed = true;
                entity._stealthTimer = 0;
            }
            // 矿工：潜伏阶段为纯土堆特效（无实体，不可被锁定/推动），实体生成即破土现身；对主塔/堡垒伤害 1/3
            if (item.cardId === 'miner') {
                entity.towerDmgMul = unit.towerDmgMul || 1 / 3;
            }
            // 骑士：冲锋倒计时3.5秒
            if (item.cardId === 'knight') {
                entity._chargeTimer = 3.5;
                entity._charging = false;
            }
            // 电磁炮：蓄能计时器
            if (item.cardId === 'electro_cannon') {
                entity._chargeTimer = 0;
                entity._chargeMax = card.chargeTime;
            }
            // 浪人：反弹就绪计时器（0=就绪可格挡反弹）
            if (item.cardId === 'ronin') {
                entity._reflectTimer = 0;
            }
            // 雷电法师：部署时触发落雷法术
            if (item.cardId === 'lightning_wizard') {
                const spell = card.deploySpell;
                if (spell) {
                    const radius = spell.radius || 38;
                    const damage = spell.damage || 50;
                    const length = spell.length || 150;
                    // 对范围内所有敌人造成伤害
                    for (let e of game.entities) {
                        if (e.team === item.team || e.hp <= 0 || e._headHidden) continue;
                        if (dist(e, { x: item.x, y: item.y }) <= radius) {
                            e.hp -= calcActualDmg(damage, null, e); // 部署法术无攻击者狂暴，目标减伤统一收口（框架第13条）
                            // 眩晕效果：范围内敌方单位被眩晕1秒
                            if (spell.stunDuration > 0) {
                                e._stunTimer = spell.stunDuration;
                            }
                        }
                    }
                    // 添加落雷特效（从天而降）
                    game.deployLightnings.push({
                        x: item.x, y: item.y,
                        length: length,
                        timer: 0.35,
                        maxTimer: 0.35
                    });
                    // 范围提示：淡红色小环（同群攻，静态真实范围）
                    game.deployEffects.push({ x: item.x, y: item.y, radius: radius, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
                }
            }
            // 超级骑士：跳跃状态
            if (item.cardId === 'super_knight') {
                entity._leapCharging = false;
                entity._leapTimer = 0;
                entity._leapTargetId = null;
            }
            // 暗影刺客：突袭状态（参考超骑跃击——距离85~105px触发，短暂隐身+蓄力1秒冲刺双倍伤害）
            if (item.cardId === 'shadow_assassin') {
                entity._assaultCharging = false;
                entity._assaultTimer = 0;
                entity._assaultTargetId = null;
            }
            // 超级骑士：部署时范围伤害 + 击退 + 从天而降虚影
            if (item.cardId === 'super_knight') {
                // 从天而降的虚影（下落轨迹）
                const shadowCount = 5;
                for (let i = 0; i < shadowCount; i++) {
                    game.spellEffects.push({
                        x: item.x,
                        y: item.y - 160 + i * 35,
                        char: '🦸', size: 10 + i * 4,
                        timer: 0.08 + i * 0.06,
                        maxTimer: 0.38,
                        color: `rgba(255,200,80,${0.15 + i * 0.08})`,
                    });
                }
                // 落地前最后一刻的大虚影
                game.spellEffects.push({
                    x: item.x, y: item.y,
                    char: '💥', size: 36,
                    timer: 0.15, maxTimer: 0.15,
                });

                const spell = card.deploySpell;
                if (spell) {
                    const radius = spell.radius || 40;
                    const damage = spell.damage || 120;
                    const knockback = spell.knockback || 15;
                    // 对范围内所有敌人造成伤害并击退
                    for (let e of game.entities) {
                        if (e.team === item.team || e.hp <= 0 || e._headHidden) continue;
                        const d = dist(e, { x: item.x, y: item.y });
                        if (d <= radius && d > 0) {
                            e.hp -= calcActualDmg(damage, null, e); // 部署法术无攻击者狂暴，目标减伤统一收口（框架第13条）
                            // 击退仅兵种生效（参考迫击炮/火球，建筑不被推）：标记剩余位移向量，由 update.js 帧驱动渐进滑动应用（位移式击退，不是瞬移；框架第11条：坐标推进只在 update.js）
                            if (e.moveSpeed !== undefined && !e.fortification) {
                                const angle = Math.atan2(e.y - item.y, e.x - item.x);
                                e._kbX = Math.cos(angle) * knockback;
                                e._kbY = Math.sin(angle) * knockback;
                            }
                        }
                    }
                    // 添加范围冲击特效
                    game.deployEffects.push({
                        x: item.x, y: item.y,
                        radius: radius,
                        timer: 0.4,
                        maxTimer: 0.4
                    });
                    // 范围提示：淡红色小环（同群攻，静态真实范围）
                    game.deployEffects.push({ x: item.x, y: item.y, radius: radius, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
                }
            }
            // 巨龙蛋：初始1/4血量 + 蛋标记
            if (item.cardId === 'dragon_egg') {
                entity.hp = entity.maxHp / 4;  // 出场1/4血量
                entity._isEgg = true;
                entity._eggPulseTimer = 0;
                entity._hasRegen = true;  // ❤️‍🩹 常驻自回buff
            }
            // 战斗天使：登场时触发持续1.2秒治疗（每0.3秒一次共4次，每次20；绿色光环仅治疗期间显示）
            if (item.cardId === 'battle_angel') {
                entity._healActive = card.healDuration || 1.2;    // 治疗光环持续窗口
                entity._healTicks = card.healTicks || 4;          // 剩余治疗次数
                entity._healTickTimer = card.healInterval || 0.3; // 首帧即触发第1次
                entity._healAmount = card.deployHeal || 20;       // 每次治疗量
                game.spellEffects.push({ x: item.x, y: item.y, char: '💚', size: 30, timer: 0.5, maxTimer: 0.5 });
            }
            // 🪞 镜像法术产物标记（供精英技能/死亡恢复逻辑区分；镜像精英渲染与本体完全一致，不受影响）
            if (item.isMirrored) entity.isMirrored = true;
            game.entities.push(entity);
            // ★ 矿工破土特效（土堆消失、矿工现身）
            if (item.cardId === 'miner') {
                game.spellEffects.push({ x: entity.x, y: entity.y, char: '⛏️', size: 24, timer: 0.5, maxTimer: 0.5 });
                game.spellEffects.push({ x: entity.x, y: entity.y, char: '💥', size: 16, timer: 0.3, maxTimer: 0.3 });
            }
        }
    } else if (card.type === 'healer') {
        const entity = createEntity({
            type: 'healer', team: item.team, cardId: item.cardId,
            x: item.x, y: item.y, hp: card.hp, maxHp: card.hp,
            healAmount: card.healAmount, healSpeed: card.healSpeed,
            healCooldown: 0, moveSpeed: card.moveSpeed,
            range: card.range, targetId: null,
        });
        if (item.isMirrored) entity.isMirrored = true; // 🪞 镜像法术产物标记
        game.entities.push(entity);
    } else if (card.type === 'tower') {
        const entity = createEntity({
            type: 'tower', team: item.team, cardId: item.cardId,
            x: item.x, y: item.y, hp: card.hp, maxHp: card.hp,
            atk: card.atk, atkSpeed: card.atkSpeed, atkCooldown: 0,
            range: card.range, splash: card.splash || 0,
            minRange: card.minRange || 0,
            onlyGround: card.onlyGround || false,
            flying: card.flying || false,   // 🕊️ 空中塔（如法术屏障）：实体带 flying 标记，地面/滚木/地震等只对地伤害全部免疫
            hitRadius: 15,  // 受击半径（匹配30×30视觉半宽，贴边即可攻击）
        });
        // 地狱塔：光束灼烧字段初始化
        if (item.cardId === 'inferno_tower') {
            entity._beamSwitchCooldown = 0;
            entity._beamTimer = 0;
            entity._beamTargetId = null;
        }
        // 盔甲铺：蓄力字段初始化（_chargeMax 必须取自 config.chargeMax，
        // 否则 update.js 中 _chargeTimer >= _chargeMax 永远为 false，蓄满后无法加盾）
        if (item.cardId === 'armor_smith') {
            entity._chargeTimer = 0;
            entity._chargeMax = card.chargeMax;
            entity.shieldAmount = card.shieldAmount; // 护盾量随 config 同步，改数值无需再动代码
        }
        if (item.isMirrored) entity.isMirrored = true; // 🪞 镜像法术产物标记（镜像神庙死亡后正确恢复镜像卡）
        game.entities.push(entity);
    } else if (card.type === 'barrack') {
        const entity = createEntity({
            type: 'barrack', team: item.team, cardId: item.cardId,
            x: item.x, y: item.y, hp: card.hp, maxHp: card.hp,
            spawnTimer: 0, spawnInterval: card.spawnInterval,
            spawnCount: card.spawnCount, spawnUnit: card.spawnUnit,
            hitRadius: 15,  // 受击半径（匹配30×30视觉半宽，贴边即可攻击）
        });
        if (item.isMirrored) entity.isMirrored = true; // 🪞 镜像法术产物标记
        game.entities.push(entity);
    } else if (card.type === 'collector') {
        const entity = createEntity({
            type: 'collector', team: item.team, cardId: item.cardId,
            x: item.x, y: item.y, hp: card.hp, maxHp: card.hp,
            generateTimer: 0, generateInterval: card.generateInterval,
            hitRadius: 15,  // 受击半径（匹配30×30视觉半宽，贴边即可攻击）
        });
        if (item.isMirrored) entity.isMirrored = true; // 🪞 镜像法术产物标记
        game.entities.push(entity);
    } else if (card.type === 'spell') {
        // ★ 🧭 烟引第一段：0.2s延迟结束 → 给范围内友军套🧭闪烁buff + 进入12s pending（不走 applySpellDamage）
        if (item.isSmokePhase1) {
            const radius = CARDS.smoke_guide.radius || 85;
            const unitIds = [];
            for (const e of game.entities) {
                if (!isFriendlyTroop(e, item.team)) continue;
                if (Math.hypot(e.x - item.x, e.y - item.y) <= radius) {
                    unitIds.push(e.id);
                }
            }
            // 范围提示环（淡红 static，同其他法术）
            game.deployEffects.push({ x: item.x, y: item.y, radius, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
            // ★ 无友军也正常走流程（0个buff友军不影响法术执行，同其他法术空放一样正常结算）
            // 🤖 AI/自动托管路径（classic/api 模式电脑方）：取消12s等待，直接圈内友军全部引导去点击处（行为：1个单位→全部圈内单位）
            const aiAuto = item.team === 'ai' && game.gameMode !== 'local_multi' && game.gameMode !== 'online';
            if (aiAuto) {
                for (const uid of unitIds) startSmokeGuide(item.team, uid, item.x, item.y);
                if (item.isMirrored) {
                    setMirrorCooldown(item.team, CARDS.smoke_guide.cooldown);
                } else {
                    game.cardCooldowns[item.team]['smoke_guide'] = CARDS.smoke_guide.cooldown;
                }
                if (item.team === 'player') game.lastDeployedCardId = 'smoke_guide';
                else game.lastDeployedCardId2 = 'smoke_guide';
                return;
            }
            // 人类路径：圈内友军套 🧭 闪烁 buff；镜像与原烟引分别记账
            for (const e of game.entities) {
                if (unitIds.includes(e.id)) {
                    if (item.isMirrored) e._smokePendingBuffMirror = true;
                    else e._smokePendingBuff = true;
                }
            }
            // 进入对应 pending 槽（镜像烟引不得覆盖原烟引）
            const pendingBucket = item.isMirrored ? game.mirrorSmokePending : game.smokePending;
            pendingBucket[item.team] = {
                team: item.team,
                unitIds,
                timer: CARDS.smoke_guide.pendingDuration || 12,
                maxTimer: CARDS.smoke_guide.pendingDuration || 12,
                isMirror: !!item.isMirrored,
            };
            return;
        }
        applySpellDamage(item.cardId, item.team, item.x, item.y);
    }

    // 🕊️ 精英主动技能（通用收尾，覆盖所有类型——含 tower 建筑精英如哥布林神庙）：
    //    本体 → es[cardId]；镜像 → es['mirror_'+cardId]（镜像法术卡作为镜像精英的独立卡载体）
    if (card.activeSkill) {
        const es = game.eliteSkills[item.team] || {};
        const key = item.isMirrored ? 'mirror_' + item.cardId : item.cardId;
        const state = es[key];
        // 部署阶段已经建立技能态；这里只补建异常缺失的状态，并保留镜像部署令牌。
        if (!state) {
            es[key] = {
                mode: 'skill', cdLeft: 0, skillCdLeft: 0,
                blessCost: card.activeSkill.cost,
                ...(item.mirrorDeployToken != null ? { mirrorDeployToken: item.mirrorDeployToken } : {}),
            };
        }
    }
}

/**
 * 通用召唤函数：按模板在 (x,y) 周围随机偏移生成召唤物
 * @param {object} tpl    单位模板（hp/atk/atkSpeed/moveSpeed/range/targetMode 等）
 * @param {string} cardId 生成的卡牌 ID
 * @param {number} x,y    召唤中心点
 * @param {string} team   阵营
 * @param {object} [opts] { jitterX/jitterY 矩形抖动 | spread:'circle'+radius 圆形均匀分布, extra: 附加字段 }
 */
function createSummon(tpl, cardId, x, y, team, opts) {
    opts = opts || {};
    let sx = x, sy = y;
    if (opts.spread === 'circle') {
        const ang = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * (opts.radius || 50);
        sx = x + Math.cos(ang) * r;
        sy = y + Math.sin(ang) * r;
    } else {
        sx = x + (rand() - 0.5) * (opts.jitterX || 0);
        sy = y + (rand() - 0.5) * (opts.jitterY || 0);
    }
    // 🧩 通用字段透传：模板里有的战斗/行为字段一律带出（flying/canHitAir/_isSpawned/splash/shotCount/groundOnly/hitRadius/category），
    // 召唤点无需再手动补 extra；extra 仍可显式覆盖
    const passthrough = {};
    for (const k of ['flying', 'groundOnly', 'splash', 'shotCount', 'canHitAir', 'hitRadius', '_isSpawned', 'category']) {
        if (tpl[k] !== undefined) passthrough[k] = tpl[k];
    }
    return createEntity({
        type: 'troop', team: team, cardId: cardId,
        x: sx, y: sy,
        hp: tpl.hp, maxHp: tpl.hp,
        atk: tpl.atk, atkSpeed: tpl.atkSpeed, atkCooldown: 0,
        moveSpeed: tpl.moveSpeed, range: tpl.range,
        targetMode: tpl.targetMode, targetId: null,
        shield: tpl.shield || 0, // 召唤模板带盾则召唤物同样带盾（通用护盾机制）
        ...passthrough,
        ...(opts.extra || {}),
    });
}

/** 创建一只蝙蝠（由暗夜女巫召唤） */
function createBat(x, y, team) {
    return createSummon(BAT_TEMPLATE, 'bat', x, y, team, { jitterX: 30, jitterY: 20 });
}

/** 创建一只猎犬幼崽（熔岩猎犬幼崽：飞行、可对空、无攻击偏好；建模参照熔岩猎犬等比缩小到骷髅大小） */
function createLavaPup(x, y, team) {
    return createSummon(LAVA_PUP_TEMPLATE, 'lava_pup', x, y, team, { jitterX: 30, jitterY: 20 });
}

/** 创建一只骷髅（由女巫召唤，复用骷髅海白色建模，近战炮灰） */
function createSkeleton(x, y, team) {
    // ★ 分布参考电车小队部署：召唤点周围半径50圆形区域内随机分散（圆内均匀分布）
    return createSummon(GOBLIN_TEMPLATE, 'goblin', x, y, team, { spread: 'circle', radius: 50 });
}

/** 创建哥布林投矛手（召唤物模板：远程直线投矛弹道，可对空；召唤途径待定） */
function createGoblinThrower(x, y, team) {
    return createSummon(GOBLIN_THROWER_TEMPLATE, 'goblin_thrower', x, y, team, { jitterX: 20, jitterY: 15 });
}

/** 创建哥布林（召唤物模板：近战小刀，单体；召唤途径待定） */
function createGoblinMelee(x, y, team) {
    return createSummon(GOBLIN_MELEE_TEMPLATE, 'goblin_melee', x, y, team, { jitterX: 20, jitterY: 15 });
}

/** 创建王子增援（召唤物模板：剑士建模+盔甲纹路，近战；护驾技能召唤，可精确指定位置） */
function createPrinceReinforcement(x, y, team, opts) {
    return createSummon(PRINCE_REINFORCEMENT_TEMPLATE, 'prince_reinforcement', x, y, team, Object.assign({ jitterX: 20, jitterY: 15 }, opts || {}));
}

/** 创建一只小虫（由巫师🐛标记死亡后召唤） */
function createWorm(x, y, team) {
    return createSummon(WORM_TEMPLATE, 'worm', x, y, team, { jitterX: 16, jitterY: 12 });
}

/** 创建送水人（由大送水人死亡分裂而来） */
function createCraftedWaterCarrier(x, y, team) {
    return createSummon(CRAFTED_WATER_CARRIER_TEMPLATE, 'crafted_water_carrier', x, y, team, { jitterX: 24, jitterY: 16 });
}

/** 创建小送水人（由送水人死亡分裂而来） */
function createSmallWaterCarrier(x, y, team) {
    return createSummon(SMALL_WATER_CARRIER_TEMPLATE, 'small_water_carrier', x, y, team, { jitterX: 20, jitterY: 14 });
}

/** 法术伤害/效果：对范围内敌方实体和主塔造成伤害 + 法术特效；蝙蝠法术、极速法术特殊处理 */
function applySpellDamage(cardId, casterTeam, x, y) {
    const card = CARDS[cardId];
    if (!card) return;

    // 范围提示：淡红色static环（法术体系范围，叠加不覆盖原特效；镜像法术无radius跳过）
    if (card.radius) {
        game.deployEffects.push({ x, y, radius: card.radius, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
    }

    // ---- 🪵 滚木：竖直木头（长65px厚7px）以释放点为中心横向滚动560px（法术影响范围：长560px×宽65px=剑仙攻击范围直径；只影响地面单位，不影响空中），沿途每个接触的敌人仅结算一次（90伤害+30px平滑击退；主塔/堡垒伤害减半）----
    if (cardId === 'log') {
        const dir = casterTeam === 'player' ? 1 : -1;
        game.logRolls.push({
            x, y, dir, team: casterTeam,
            halfW: card.radius || 32.5,         // 影响范围宽的一半（剑仙攻击范围直径65 → ±32.5）
            damage: card.damage || 90,
            mul: card.towerDmgMul || 0.5,       // 主塔/堡垒（防御工事）法术伤害减半
            knockback: card.knockback || 30,
            speed: card.rollSpeed || 250,
            distance: card.rollDistance || 560, // 法术影响范围长度：滚动560px后消失
            logLength: card.logLength || 65,    // 木头本体长度（竖直方向）
            logWidth: card.logWidth || 7,       // 木头本体宽度（滚动方向厚度）
            hitIds: new Set(),                  // 每个敌人仅结算一次
            startX: x,
        });
        // 释放瞬间特效：落点处淡淡滚木虚影（提示起始位置）
        game.spellEffects.push({ x, y, char: '🪵', size: 16, timer: 0.5, maxTimer: 0.5, color: 'rgba(150,105,60,0.55)' });
        return;
    }

    // ---- 极速法术：创建加速区域 ----
    if (cardId === 'speed_spell') {
        game.speedZones.push({
            x, y,
            radius: card.radius,
            timer: card.zoneDuration,
            maxTimer: card.zoneDuration,
            team: casterTeam,
            speedBoost: card.speedBoost,
            boostDuration: card.boostDuration,
        });
        // ✨ 小红圈持续到法术结束：静态环 timer 延长至加速区域结束（同蝙蝠法术）
        const ring = game.deployEffects[game.deployEffects.length - 1];
        if (ring && ring.static) { ring.timer = card.zoneDuration; ring.maxTimer = card.zoneDuration; }
        // 部署提示特效
        game.spellEffects.push({ x, y, char: '⚡', size: 44, timer: 0.8, maxTimer: 0.8 });
        for (let i = 0; i < 8; i++) {
            game.spellEffects.push({
                x: x + (rand() - 0.5) * card.radius * 2,
                y: y + (rand() - 0.5) * card.radius * 2,
                char: '⚡', size: 14 + rand() * 12,
                timer: 0.3 + rand() * 0.4,
                maxTimer: 0.7,
            });
        }
        return;
    }

    // ---- 狂暴法术：对范围内敌军造成30伤害 + 留下狂暴区域（友方攻速/移速/蓄力/出兵提升30%，持续4.5秒）----
    if (cardId === 'rage_spell') {
        const radius = card.radius || 48;
        const damage = card.damage || 30;
        const zoneDuration = card.zoneDuration || 4.5;
        // 对范围内敌方实体造成伤害（不冻结；未露头的电磁塔无敌不受影响；主塔/堡垒伤害减半）
        for (let e of game.entities) {
            if (e.team === casterTeam || e.hp <= 0 || e._headHidden) continue;
            if (dist(e, { x, y }) <= radius) {
                const dmg = calcActualDmg(e.fortification ? damage * (card.towerDmgMul || 0.5) : damage, null, e); // 法术伤害统一收口（框架第13条），无攻击者狂暴
                e.hp -= dmg;
                spawnDmgNum(e.x, e.y - 20, dmg);
            }
        }
        // 狂暴区域（持续4.5秒，每0.5秒脉冲施加一次持续1.5秒的狂暴buff）
        game.rageZones.push({
            x, y,
            radius: radius,
            timer: zoneDuration,
            maxTimer: zoneDuration,
            team: casterTeam,
            boostDuration: card.boostDuration || 1.5,
            rageTick: card.rageTick || 0.5,
            pulseTimer: 0,
        });
        // ✨ 小红圈持续到法术结束：静态环 timer 延长至狂暴区域结束（同蝙蝠法术）
        const ring = game.deployEffects[game.deployEffects.length - 1];
        if (ring && ring.static) { ring.timer = zoneDuration; ring.maxTimer = zoneDuration; }
        // 部署提示特效
        game.spellEffects.push({ x, y, char: '😡', size: 44, timer: 0.8, maxTimer: 0.8 });
        for (let i = 0; i < 8; i++) {
            game.spellEffects.push({
                x: x + (rand() - 0.5) * radius * 2,
                y: y + (rand() - 0.5) * radius * 2,
                char: '😡', size: 14 + rand() * 12,
                timer: 0.3 + rand() * 0.4,
                maxTimer: 0.7,
            });
        }
        return;
    }

    // ---- 复制法术：复制范围内所有友军兵种（建筑/堡垒/主塔不复制），复制体HP=1、特性全同、纯亮蓝色建模 ----
    if (cardId === 'copy_spell') {
        const radius = card.radius || 48;
        // 部署提示特效：亮蓝脉冲 + 粒子
        game.spellEffects.push({ x, y, char: '🔷', size: 44, timer: 0.7, maxTimer: 0.7, isPulse: true });
        for (let i = 0; i < 10; i++) {
            game.spellEffects.push({
                x: x + (rand() - 0.5) * radius * 2,
                y: y + (rand() - 0.5) * radius * 2,
                char: '🔷', size: 12 + rand() * 10,
                timer: 0.3 + rand() * 0.4,
                maxTimer: 0.7,
            });
        }
        // 收集范围内友军兵种（只复制 troop / healer，建筑/堡垒/主塔一律不复制；复制体不可再被复制）
        const targets = [];
        for (let e of game.entities) {
            if (e.hp <= 0 || e.team !== casterTeam) continue;
            if (e.type !== 'troop' && e.type !== 'healer') continue;
            if (e.isCopy) continue;   // 🔷 复制体不会被复制法术复制
            if (dist(e, { x, y }) > radius) continue;
            targets.push(e);
        }
        for (const e of targets) {
            // 浅拷贝本体全部属性（攻击/移速/射程/技能等特性完全一致），再重置战斗状态为"刚部署"
            const copy = { ...e };
            copy.id = entityIdCounter++;
            copy.hp = 1;
            copy.maxHp = 1;
            // 🔷 复制体护盾：仅当本体带盾时压为1（有则1、无则0）——不给无盾单位白送护盾
            copy.shield = (e.maxShield || 0) > 0 ? 1 : 0;
            copy.maxShield = copy.shield;
            copy.isCopy = true;   // 渲染层据此画纯亮蓝色建模
            // 🚩 复制体不继承营地成员状态：清掉 🚩/归属/巡逻中心/轨道（防止浅拷贝把本体的营地标记带过来 → 复制体占名额/乱巡逻）
            copy._campFlag = false;
            copy._campId = undefined;
            copy._patrolX = undefined; copy._patrolY = undefined; copy._patrolDir = undefined;
            copy._patrolR = undefined;
            // 🗡️ 复制体不继承剑仙飞剑：清掉技能状态（防止浅拷贝共享 _swords 数组 → 两把剑仙共用飞剑/互相污染角度）
            copy._swords = undefined; copy._swordTimer = undefined;
            // 🔧 引用类型字段保险：浅拷贝会让 Set/数组（如未来穿透箭类命中标记）与本体共享引用，
            //    一律重建独立副本；当前实体字段均为标量，本段零行为影响
            for (const k of Object.keys(copy)) {
                const v = copy[k];
                if (v instanceof Set) copy[k] = new Set(v);
                else if (Array.isArray(v)) copy[k] = v.slice();
            }
            // 位置微偏移，避免与本体完全重叠
            copy.x = Math.min(W - 30, Math.max(30, e.x + (rand() - 0.5) * 24));
            copy.y = Math.min(H - 30, Math.max(30, e.y + (rand() - 0.5) * 24));
            // 战斗状态归零（等同刚部署，不继承本体进行中的动作/冷却）
            copy.targetId = null;
            copy.atkCooldown = 0;
            copy.freezeTimer = 0;
            copy.slowFactor = 1.0;
            copy._speedBoosted = false;
            copy._stunTimer = 0;
            copy._recoilTimer = 0;
            copy._stealthed = false;
            copy._charging = false;      copy._chargeTimer = 0;
            copy._leapCharging = false;  copy._leapTimer = 0; copy._leapTargetId = null;
            copy._assaultCharging = false; copy._assaultTimer = 0; copy._assaultTargetId = null;
            copy._healTicks = 0;         copy._healActive = 0;
            // 技能单位初始状态（与刚部署时一致）
            if (copy.cardId === 'knight') { copy._chargeTimer = 3.5; copy._charging = false; }
            if (copy.cardId === 'night_witch') copy.spawnTimer = 0;
            if (copy.cardId === 'hades') copy._souls = 0;
            if (copy.cardId === 'ghost') { copy._stealthed = true; copy._stealthTimer = 0; }
            // 矿工复制体：直接破土现身（潜伏期无实体可复制，且前面已重置 _stealthed=false）
            if (copy.cardId === 'dragon_egg') copy._isEgg = true;
            if (copy.cardId === 'electro_cannon') { copy._chargeTimer = 0; }
            game.entities.push(copy);
        }
        return;
    }

    // ---- 冰冻法术：范围30伤害 + 冻结4秒（暂停一切行动）----
    if (cardId === 'freeze_spell') {
        const radius = card.radius || 48;
        const freezeDuration = card.freezeDuration || 4;
        const damage = card.damage || 30;
        // 对范围内敌方实体造成伤害并冻结（未露头的电磁塔无敌不受影响；主塔/堡垒伤害减半）
        for (let e of game.entities) {
            if (e.team === casterTeam || e.hp <= 0 || e._headHidden) continue;
            if (dist(e, { x, y }) <= radius) {
                const dmg = calcActualDmg(e.fortification ? damage * (card.towerDmgMul || 0.5) : damage, null, e); // 法术伤害统一收口（框架第13条），无攻击者狂暴
                e.hp -= dmg;
                spawnDmgNum(e.x, e.y - 20, dmg);
                // ❄️ 冻结：暂停一切行动（移动/攻击/蓄力/召唤/生产），解冻后恢复
                e.freezeTimer = Math.max(e.freezeTimer || 0, freezeDuration);
                // 冻结瞬间打断进行中的蓄力/跳跃/冲锋蓄能
                e._leapCharging = false;
                e._leapTimer = 0;
                e._leapTargetId = null;
                e._chargeTimer = 0;
                e._charging = false;
            }
        }
        // 特效：静态冰蓝色区域（持续与冻结时间一致，4秒）
        game.freezeZones.push({
            x, y,
            radius: radius,
            timer: freezeDuration,
            maxTimer: freezeDuration,
        });
        // ✨ 小红圈持续到法术结束：静态环 timer 延长至冻结区域结束（同蝙蝠法术）
        const ring = game.deployEffects[game.deployEffects.length - 1];
        if (ring && ring.static) { ring.timer = freezeDuration; ring.maxTimer = freezeDuration; }
        // 部署提示特效
        game.spellEffects.push({ x, y, char: '🧊', size: 40, timer: 0.8, maxTimer: 0.8 });
        for (let i = 0; i < 6; i++) {
            const angle = rand() * 2 * Math.PI;
            const r = rand() * radius * 0.5;
            game.spellEffects.push({
                x: x + Math.cos(angle) * r,
                y: y + Math.sin(angle) * r,
                char: '❄️', size: 14 + rand() * 8,
                timer: 0.4 + rand() * 0.5,
                maxTimer: 0.9,
            });
        }
        return;
    }

    // ---- 蝙蝠法术：延迟分批召唤（释放1秒后开始，每0.2秒出2只，共6只）----
    if (cardId === 'bat_spell') {
        // 延迟分批召唤事件：由 update.js 帧循环处理（同箭雨/大雷电分段机制）
        game.batSpawns.push({
            x, y,
            radius: card.radius || 38,
            team: casterTeam,
            wavesLeft: card.spawnWaves || 3,
            perWave: card.spawnPerWave || 2,
            interval: card.spawnInterval || 0.3,
            timer: card.spawnStartDelay || 1.0, // 首波延迟1秒
        });
        // ✨ 小红圈持续到法术结束：把开头通用淡红静态环延长至最后一波蝙蝠出完（与召唤完成同步消失）
        const ring = game.deployEffects[game.deployEffects.length - 1];
        const spawnTotal = (card.spawnStartDelay || 1.0) + ((card.spawnWaves || 3) - 1) * (card.spawnInterval || 0.3);
        if (ring && ring.static) {
            ring.timer = spawnTotal;
            ring.maxTimer = spawnTotal;
        }
        // 释放瞬间特效：小蝙蝠虚影淡出（轻微，不夸张）
        for (let i = 0; i < 3; i++) {
            game.spellEffects.push({
                x: x + (rand() - 0.5) * card.radius * 2,
                y: y + (rand() - 0.5) * card.radius * 2,
                char: '🦇', size: 16,
                timer: 0.4 + rand() * 0.3,
                maxTimer: 0.6,
            });
        }
        return;
    }

    // ---- 🛢️ 哥布林飞桶：从己方主塔飞出木桶，抛物线飞向目标点，落地摔出3只近战哥布林（120°均匀分布）----
    if (cardId === 'goblin_barrel') {
        const flightTime = card.flightTime || 1.5;
        // 起点：己方主塔（找不到主塔时兜底从落点正上方高空坠下）
        const mainTower = game.entities.find(e => e.type === 'main_tower' && e.team === casterTeam && e.hp > 0);
        const x0 = mainTower ? mainTower.x : x;
        const y0 = mainTower ? mainTower.y : Math.max(30, y - 150);
        // 飞行事件：由 update.js 帧循环推进，落地时生成哥布林
        game.goblinBarrels.push({
            x0, y0, x1: x, y1: y,
            team: casterTeam,
            radius: card.radius || 38,
            count: card.goblinCount || 3,
            timer: flightTime, maxTimer: flightTime,
        });
        // ✨ 小红圈持续到法术结算完：静态环 timer 延长至木桶落地（同火球/火箭）
        const ring = game.deployEffects[game.deployEffects.length - 1];
        if (ring && ring.static) { ring.timer = flightTime; ring.maxTimer = flightTime; }
        // 释放瞬间特效：落点处淡淡木桶虚影（提示落地位置，轻微不夸张）
        game.spellEffects.push({ x, y, char: '🛢️', size: 16, timer: 0.5, maxTimer: 0.5, color: 'rgba(210,170,100,0.55)' });
        return;
    }

    // ---- 🧪 哥布林魔咒：暗绿诅咒领域（持续6秒，每秒1次对圈内所有敌人造成10点伤害）----
    if (cardId === 'goblin_curse') {
        const radius = card.radius || 48;
        game.curseZones.push({
            x, y,
            radius: radius,
            timer: card.duration || 6,
            maxTimer: card.duration || 6,
            team: casterTeam,
            dps: card.dps || 10,
            towerDmgMul: card.towerDmgMul || 0.5, // 对主塔/堡垒伤害减半
            tickTimer: 0,
            bubbleTimer: 0.3, // 首个绿泡稍快冒出
            bubbles: [],
        });
        // ✨ 小红圈持续到法术结束：静态环 timer 延长至魔咒领域结束（同蝙蝠法术）
        const ring = game.deployEffects[game.deployEffects.length - 1];
        if (ring && ring.static) { ring.timer = card.duration || 6; ring.maxTimer = card.duration || 6; }
        // 部署提示特效：暗绿脉冲 + 小绿泡粒子
        game.spellEffects.push({ x, y, char: '🧪', size: 44, timer: 0.8, maxTimer: 0.8, isPulse: true });
        for (let i = 0; i < 10; i++) {
            game.spellEffects.push({
                x: x + (rand() - 0.5) * radius * 2,
                y: y + (rand() - 0.5) * radius * 2,
                char: '🫧', size: 12 + rand() * 10,
                timer: 0.4 + rand() * 0.5,
                maxTimer: 0.9,
            });
        }
        return;
    }

    // ---- 飓风法术：1.5秒飓风领域——持续向中心牵引圈内敌人，每0.5秒一跳8伤害（共3跳24，不影响建筑）----
    if (cardId === 'hurricane') {
        const radius = card.radius || 105;
        const damage = card.damage || 8;
        const duration = card.duration || 1.5;
        const tickInterval = card.tickInterval || 0.5;
        const pullAndDamage = () => {
            for (let e of game.entities) {
                if (e.team === casterTeam || e.hp <= 0 || e.fortification || e._headHidden) continue;
                // 仅对有移动能力的兵种生效（排除建筑/防御工事）
                if (e.moveSpeed === undefined) continue;
                if (dist(e, { x, y }) <= radius) {
                    const dmg = calcActualDmg(damage, null, e); // 法术伤害统一收口（框架第13条），无攻击者狂暴
                    e.hp -= dmg;
                    spawnDmgNum(e.x, e.y - 20, dmg);
                    // 标记拉拢（持续牵引：每次跳伤都刷新拉拢计时到下一跳之后）
                    e._pullToX = x;
                    e._pullToY = y;
                    e._pullTimer = Math.min(tickInterval + 0.1, 0.6);
                }
            }
        };
        // 第一跳立即结算（t=0），之后每0.5秒一跳（t=0.5、t=1.0），共3跳24伤害
        pullAndDamage();
        game.hurricaneZones.push({
            x, y,
            radius,
            timer: duration,
            maxTimer: duration,
            tickTimer: tickInterval,
            tickInterval,
            pullAndDamage,
        });
        // ✨ 小红圈持续到法术结束：静态环 timer 延长至飓风领域结束（同蝙蝠法术）
        const ring = game.deployEffects[game.deployEffects.length - 1];
        if (ring && ring.static) { ring.timer = duration; ring.maxTimer = duration; }
        // 法术特效：中央风眼（小🌪️ + 周围🌀粒子向中心靠拢消失）
        game.spellEffects.push({ x, y, char: '🌪️', size: 24, timer: 0.7, maxTimer: 0.7 });
        for (let i = 0; i < 8; i++) {
            const angle = rand() * 2 * Math.PI;
            const r = rand() * radius * 0.5;
            game.spellEffects.push({
                x: x + Math.cos(angle) * r,
                y: y + Math.sin(angle) * r,
                centerX: x,
                centerY: y,
                char: '🌀', size: 14 + rand() * 12,
                timer: 0.3 + rand() * 0.3,
                maxTimer: 0.6,
            });
        }
        return;
    }

    // ---- 🌧️ 箭雨：分三波抛出，每波完整动画「主塔发射>飞行>落地特效+伤害」，间隔0.3s，三波相互独立 ----
    if (cardId === 'arrows') {
        const flightTime = card.flightTime || 1.4;
        const interval = card.strikeInterval || 0.3;
        // 起点：己方主塔（找不到主塔时兜底从落点正上方高空坠下）
        const mainTower = game.entities.find(e => e.type === 'main_tower' && e.team === casterTeam && e.hp > 0);
        const x0 = mainTower ? mainTower.x : x;
        const y0 = mainTower ? mainTower.y : Math.max(30, y - 150);
        const waveCount = card.strikes || 3;
        for (let i = 0; i < waveCount; i++) {
            // 每波3支箭：以落点为中心向四周随机散布（最大30 < 范围85，不会散出范围），飞行中越飞越散
            const arrows = [];
            for (let j = 0; j < 3; j++) {
                const ang = rand() * Math.PI * 2;
                const rr = 30 * Math.sqrt(rand());
                arrows.push({ latX: Math.cos(ang) * rr, latY: Math.sin(ang) * rr });
            }
            // 每波完全独立：launchDelay 倒计时结束才开始自己的飞行（第i波延迟 i*interval 出发），落地结算一段伤害
            game.arrowRainFlights.push({
                x0, y0, x1: x, y1: y,
                team: casterTeam,
                radius: card.radius,
                damage: card.damage,
                mul: card.towerDmgMul || 0.5,
                strikes: 1,
                interval: 0,
                arrows,
                launchDelay: i * interval,
                timer: flightTime, maxTimer: flightTime,
            });
        }
        // 释放瞬间特效：落点处淡淡箭束虚影（提示落地位置，轻微不夸张）
        game.spellEffects.push({ x, y, char: '།', size: 16, timer: 0.5, maxTimer: 0.5, color: 'rgba(255,255,255,0.5)' });
        // ✨ 小红圈持续到法术结算完：静态环 timer 延长至最后一波箭落地（flightTime + (波数-1)*间隔）
        {
            const ring = game.deployEffects[game.deployEffects.length - 1];
            const total = flightTime + (waveCount - 1) * interval;
            if (ring && ring.static) { ring.timer = total; ring.maxTimer = total; }
        }
        return;
    }

    // ---- 地震法术：持续3秒三段伤害，对建筑5倍 ----
    if (cardId === 'earthquake') {
        // 落点起震特效
        game.spellEffects.push({ x, y, char: '💥', size: 36, timer: 0.5, maxTimer: 0.5 });
        game.spellEffects.push({ x, y, char: '🌍', size: 30, timer: 0.7, maxTimer: 0.7 });
        // 三段延迟结算（每1.5秒一段，共3段，持续3秒）
        game.earthquakeStrikes.push({
            x, y,
            radius: card.radius,
            team: casterTeam,
            damage: card.damage,
            buildingMul: card.towerDmgMul || 10,   // 对普通建筑10倍伤害（主塔/堡垒除外）
            strikesLeft: card.strikes || 3,
            interval: card.strikeInterval || 1.5,
            timer: 0, // 第一段在下一帧立即触发
        });
        // ✨ 小红圈持续到法术结算完：静态环 timer 延长至第三段地震结束（3段×1.5s=4.5s）
        {
            const ring = game.deployEffects[game.deployEffects.length - 1];
            const total = (card.strikes || 3) * (card.strikeInterval || 1.5);
            if (ring && ring.static) { ring.timer = total; ring.maxTimer = total; }
        }
        return;
    }

    // ---- 大雷电：锁定范围内生命值最高的3名敌方单位，每0.5秒劈下一道雷 ----
    if (cardId === 'thunder_spell') {
        const radius = card.radius || 48;
        // 收集范围内敌方单位（不锁定隐身单位，排除已死亡/隐藏单位）
        const candidates = game.entities.filter(e =>
            e.team !== casterTeam && e.hp > 0 && !e._headHidden && !e._stealthed
            && dist(e, { x, y }) <= radius
        );
        // 按生命值降序取前3名
        const targets = candidates.sort((a, b) => b.hp - a.hp).slice(0, card.topHpTargets || 3);
        // 范围内无单位 → 不劈
        if (targets.length === 0) return;
        // 落点预警特效：冲击圈 + 雷云标识
        game.deployEffects.push({ x, y, radius, timer: 0.4, maxTimer: 0.4 });
        game.spellEffects.push({ x, y, char: '🌩️', size: 30, timer: 0.6, maxTimer: 0.6 });
        // 三道雷延迟结算（每0.5秒一道）
        game.thunderStrikes.push({
            x, y,
            radius,
            team: casterTeam,
            damage: card.damage,
            towerDmgMul: card.towerDmgMul || 0.25,  // 防御工事（主塔/堡垒）伤害为原伤害1/4
            targets,
            strikeIndex: 0,
            interval: card.strikeInterval || 0.5,
            timer: 0.5, // 第一道雷延迟0.5秒劈下，此后每0.5秒一道（即0.5s/1.0s/1.5s）
        });
        return;
    }

    // ---- ⚡ 小电：立即结算（范围同火球术38px），45伤害 + 眩晕0.5秒，雷电落地特效 ----
    if (cardId === 'small_lightning') {
        const radius = card.radius || 38;
        for (let e of game.entities) {
            if (e.team === casterTeam || e.hp <= 0 || e._headHidden) continue;
            if (dist(e, { x, y }) <= radius) {
                // 防御工事伤害按 towerDmgMul（默认0.5），普通建筑与兵种满伤害；统一走 calcActualDmg（框架第13条）
                const dmg2 = calcActualDmg(e.fortification ? card.damage * (card.towerDmgMul || 0.5) : card.damage, null, e);
                e.hp -= dmg2;
                spawnDmgNum(e.x, e.y - 20, dmg2);
                // 💫 眩晕0.5秒（同大雷电/电磁塔，塔类眩晕同样暂停攻击）
                e._stunTimer = Math.max(e._stunTimer || 0, card.stunDuration || 0.5);
            }
        }
        // 雷电落地特效（同大雷电落雷特效）：落雷 + ⚡ + 冲击圈
        game.deployLightnings.push({ x, y, length: 150, timer: 0.35, maxTimer: 0.35 });
        game.spellEffects.push({ x, y, char: '⚡', size: 30, timer: 0.25, maxTimer: 0.25 });
        game.deployEffects.push({ x, y, radius: 24, timer: 0.3, maxTimer: 0.3 });
        return;
    }

    // ---- 🔥 火球术：从主塔抛物线飞向落点（部署延迟结束后起抛，飞行结束落地结算伤害+击退+爆炸）----
    if (cardId === 'fireball') {
        const flightTime = card.flightTime || 1.4;
        // 起点：己方主塔（找不到主塔时兜底从落点正上方高空坠下）
        const mainTower = game.entities.find(e => e.type === 'main_tower' && e.team === casterTeam && e.hp > 0);
        const x0 = mainTower ? mainTower.x : x;
        const y0 = mainTower ? mainTower.y : Math.max(30, y - 150);
        // 飞行事件：x/y 为落点（武僧超脱弹走后改写为大本营坐标），落地时结算
        game.fireballFlights.push({
            x0, y0, x1: x, y1: y,
            x, y,
            team: casterTeam,
            radius: card.radius,
            damage: card.damage,
            mul: card.towerDmgMul || 0.5,
            knockback: 15,   // ★ 火球击退（参考超骑落地击退）
            timer: flightTime, maxTimer: flightTime,
        });
        // ✨ 小红圈持续到法术结算完：静态环 timer 延长至火球落地（同火箭弹道全程显示）
        const ring = game.deployEffects[game.deployEffects.length - 1];
        if (ring && ring.static) { ring.timer = flightTime; ring.maxTimer = flightTime; }
        // 释放瞬间特效：落点处淡淡火球虚影（提示落地位置，轻微不夸张）
        game.spellEffects.push({ x, y, char: '🔥', size: 16, timer: 0.5, maxTimer: 0.5, color: 'rgba(255,120,30,0.5)' });
        return;
    }

    // ---- 🚀 火箭法术：主塔圆心开洞慢慢扩大→火箭钻出垂直升空出屏→出屏等1s→落点影子越来越大→5s命中（740伤害，主塔/堡垒1/3，范围同火球，命中后蘑菇云1s）----
    if (cardId === 'rocket') {
        const flightTime = card.flightTime || 5;
        // 发射起点：己方主塔圆心（找不到主塔时兜底用落点）
        const mainTower = game.entities.find(e => e.type === 'main_tower' && e.team === casterTeam && e.hp > 0);
        game.rocketFlights.push({
            x, y, team: casterTeam,
            radius: card.radius,
            damage: card.damage,
            mul: card.towerDmgMul || 1 / 3,
            knockback: card.knockback || 30, // 火箭击退（比火球更强）
            timer: flightTime, maxTimer: flightTime,
            tx: mainTower ? mainTower.x : x,
            ty: mainTower ? mainTower.y : y,
            cloud: false,
        });
        // 释放瞬间特效：落点处淡淡火箭虚影（提示落点，轻微不夸张）
        game.spellEffects.push({ x, y, char: '🚀', size: 16, timer: 0.5, maxTimer: 0.5, color: 'rgba(255,255,255,0.5)' });
        // 淡红范围提示圈：从释放开始持续整个弹道（flightTime），火箭落地时随弹道结束同步消失
        game.deployEffects.push({ x, y, radius: card.radius, timer: flightTime, maxTimer: flightTime, color: AOE_RING_COLOR, static: true });
        return;
    }

    // ---- 通用伤害法术：立即结算（其他未特判的伤害法术走这里）----
    const radius = card.radius, damage = card.damage, mul = card.towerDmgMul || 0.5;
    for (let e of game.entities) {
        if (e.team === casterTeam || e._headHidden) continue;
        if (dist(e, { x, y }) <= radius) {
            // 防御工事（主塔/堡垒）受法术伤害减半（towerDmgMul），普通建筑和兵种满伤害；统一走 calcActualDmg 吃目标减伤（框架第13条），无攻击者狂暴
            const dmg2 = calcActualDmg(e.fortification ? damage * mul : damage, null, e);
            e.hp -= dmg2;
            spawnDmgNum(e.x, e.y - 20, dmg2);
        }
    }

    // 注意：此处不清理死亡实体，统一由 update.js 每帧过滤
}

/* ═══════════════════════════════════════════════════════════════
 * 🕊️ 精英主动技能（通用机制，未来精英英雄共用）
 * 状态机：deploy（可部署）→ 部署生成 → skill（卡牌变技能）→ 释放 → used（变黑）
 *         → 精英死亡 → 恢复 deploy + 开始死亡冷却（cdLeft 递减）→ 可再次部署
 * ═══════════════════════════════════════════════════════════════ */

/** 释放精英主动技能（由 ui.js 点击技能卡调用；team: 'player'|'ai'） */
function castActiveSkill(cardId, team) {
    // 🪞 镜像槽：'mirror_' 前缀 → 技能目标为镜像精英（镜像卡独立释放）；否则目标为本体（互不影响）
    const isMirrorSlot = typeof cardId === 'string' && cardId.indexOf('mirror_') === 0;
    const realCardId = isMirrorSlot ? cardId.slice(7) : cardId;
    const card = CARDS[realCardId];
    if (!card || !card.activeSkill) return false;
    const es = game.eliteSkills[team] || {};
    const st = es[cardId];
    if (!st || st.mode !== 'skill') return false;      // 未部署
    if (st.skillCdLeft > 0) return false;              // ⏳ 技能冷却中

    // 🛕 神赐动态费用：神庙在场时每用1张哥布林卡减1费（最低1费），此处按当前费用扣
    let skillCost = card.activeSkill.cost;
    if (card.activeSkill.id === 'goblin_bless' && st && st.blessCost != null) {
        skillCost = Math.max(1, st.blessCost);
    }
    // 圣水检查（技能费用）
    const elixir = team === 'player' ? game.elixir.player : game.elixir.ai;
    if (elixir < skillCost) return false;

    // 场上必须有存活的目标精英：本体槽找本体（!isMirrored），镜像槽找镜像精英（isMirrored）
    const unit = game.entities.find(e => e.cardId === realCardId && e.team === team && e.hp > 0 && !e.isCopy && (isMirrorSlot ? e.isMirrored : !e.isMirrored));
    if (!unit) return false;

    // 扣费 + 技能状态：🖤 单次技能（singleUse）→ 用完即黑（mode='used'，等精英死亡恢复 deploy + 死亡冷却）
    //                否则进入技能冷却（卡牌保持技能态，冷却结束可再次释放）
    if (team === 'player') game.elixir.player -= skillCost;
    else game.elixir.ai -= skillCost;
    if (card.activeSkill.singleUse) {
        st.mode = 'used';
        st.skillCdLeft = 0;
    } else {
        st.skillCdLeft = card.activeSkill.cooldown || 30;   // ⏳ 技能冷却（读卡牌 activeSkill.cooldown，冥王40s/剑仙35s/狂战士20s）
    }

    // 施加技能效果
    applyActiveSkill(unit, card.activeSkill);
    // 🛕 神赐：释放后费用恢复基础11费（下次重新从11开始减费）
    if (card.activeSkill.id === 'goblin_bless' && st) st.blessCost = card.activeSkill.cost;
    return true;
}

/** 精英主动技能效果施加（按技能 id 分发；新增精英技能在此扩展） */
function applyActiveSkill(unit, skill) {
    if (skill.id === 'sword_ride') {
        // 🕊️ 御剑：剑飞到脚下、脚下新增阴影、变为空中单位；持续 duration 秒（9）后自动落回地面
        unit._rideSword = true;
        unit.flying = true;
        unit._rideTimer = skill.duration || 10;
        // 释放特效：金色文字「起劍！」（0.8s淡出）
        game.spellEffects.push({
            type: 'swordRide', x: unit.x, y: unit.y, team: unit.team,
            char: '起劍！', size: 15, color: '#ffd700',
            timer: 0.8, maxTimer: 0.8,
        });
    } else if (skill.id === 'hades_summon') {
        // ☠️ 召唤：根据冥王当前等级，在周围召唤 等级+2 只骷髅（最少3、最多12）
        const count = Math.min(Math.max((unit._level || 1) + 2, 3), 12);
        for (let i = 0; i < count; i++) {
            // createSkeleton：召唤点周围半径50圆形区域内随机分散（同女巫召唤骷髅）
            const sk = createSkeleton(unit.x, unit.y, unit.team);
            // 🔷 冥王召唤骷髅 = 克隆法术复制体：锁血1滴（isCopy触发全局锁血保险+半透明亮蓝幻影渲染）、其他属性与骷髅全同
            sk.isCopy = true;
            sk.hp = 1;
            sk.maxHp = 1;
            game.entities.push(sk);
        }
        // 释放特效：紫色文字「召唤！」（0.8s淡出）
        game.spellEffects.push({
            type: 'hadesSummon', x: unit.x, y: unit.y, team: unit.team,
            char: '召唤！', size: 13, color: '#9b59b6',
            timer: 0.8, maxTimer: 0.8,
        });
    } else if (skill.id === 'prince_guard') {
        // 👑 护驾：1s后在小王子前方一点点召唤王子增援，增援快速冲锋105px（沿途50伤害+击退，参考暗影刺客冲刺/超骑击退）
        // 冲锋方向：优先朝小王子当前攻击目标的方向，否则默认朝敌方主塔方向
        let dirX = 0, dirY = 0;
        if (unit.targetId) {
            const t = game.entities.find(en => en.id === unit.targetId && en.hp > 0);
            if (t) {
                const dd = Math.hypot(t.x - unit.x, t.y - unit.y) || 1;
                dirX = (t.x - unit.x) / dd;
                dirY = (t.y - unit.y) / dd;
            }
        }
        if (!dirX && !dirY) dirX = unit.team === 'player' ? 1 : -1; // 无目标时默认朝敌方方向
        game.princeGuardSpawns.push({
            ownerId: unit.id,   // 记录召唤者：1s内小王子阵亡则取消召唤
            timer: 1.0,         // ⏱️ 延迟1秒后召唤
            x: unit.x, y: unit.y,
            dirX: dirX, dirY: dirY,
            team: unit.team,
        });
        // 🛡️ 护驾施法期间小王子暂停移动1秒（与召唤倒计时同步解除），避免增援召唤到小王子身后把它挤到前面
        unit._holdMove = 1.0;
        // 释放特效：金色文字「Guards!」（0.8s淡出）
        game.spellEffects.push({
            type: 'princeGuard', x: unit.x, y: unit.y, team: unit.team,
            char: 'Guards!', size: 14, color: '#e67e22',
            timer: 0.8, maxTimer: 0.8,
        });
    } else if (skill.id === 'berserk_burst') {
        // 💥 爆发：0.6s 施法蓄力后进入爆发状态（背后浮现暗色虚影+血红眼睛，持续6s）；buff 数值见 update.js
        unit._berserkCast = 0.6;
        game.spellEffects.push({
            type: 'berserkBurst', x: unit.x, y: unit.y, team: unit.team,
            char: 'フィニッシュ！', size: 15, color: '#e74c3c',
            timer: 0.8, maxTimer: 0.8,
        });
    } else if (skill.id === 'monk_transcend') {
        // 🧘 超脱：0.6s 前摇（止步诵念，手移到嘴的位置）→ 全身冒青色光晕持续5s（渲染读 _transcendTimer），
        //    期间减伤70%且不移动不攻击（状态机与减伤见 update.js 帧循环）
        unit._transcendChant = 0.6;
        game.spellEffects.push({
            type: 'monkTranscend', x: unit.x, y: unit.y, team: unit.team,
            char: '卍！', size: 15, color: '#00e5ff',
            timer: 0.8, maxTimer: 0.8,
        });
    } else if (skill.id === 'stealth') {
        // 🌫️ 隐身：0.5s 施法蓄力 → 进入隐身（不可被锁定）+ 攻击力提升200%，持续4s（计时与数值见 update.js 帧循环）
        unit._queenStealthCast = 0.5;
        game.spellEffects.push({
            type: 'stealth', x: unit.x, y: unit.y, team: unit.team,
            char: '隐身！', size: 13, color: '#a29bfe',
            timer: 0.8, maxTimer: 0.8,
        });
    } else if (skill.id === 'goblin_bless') {
        // 🛕 神赐：费用已按减费动态计算（castActiveSkill 按 blessCost 扣费并重置11），
        //    释放金色祈祷文「Maglubiyet grash!」+ 神庙上方一缕金光向下照亮（0.8s）
        game.spellEffects.push({
            type: 'goblinBless', x: unit.x, y: unit.y, team: unit.team,
            char: 'Maglubiyet grash!', size: 13, color: '#ffd700',
            timer: 0.8, maxTimer: 0.8,
        });
        // 🌟 神赐召唤：1/3概率召唤3只哥布林投矛手，2/3概率召唤哥布林巨人（直接引用两个模板，统一走 createSummon，不重复写创建逻辑）
        const blessSpawns = rand() < 1 / 3
            ? [{ tpl: GOBLIN_THROWER_TEMPLATE, cardId: 'goblin_thrower', n: 3 }]
            : [{ tpl: CARDS.goblin_giant, cardId: 'goblin_giant', n: 1 }];
        for (const bs of blessSpawns) {
            for (let i = 0; i < bs.n; i++) {
                game.entities.push(createSummon(bs.tpl, bs.cardId, unit.x, unit.y, unit.team, { spread: 'circle', radius: 40 }));
            }
        }
    }
}
