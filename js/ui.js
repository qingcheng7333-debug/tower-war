/* ===== ui.js — 玩家交互事件处理 ===== */

/** 🔗 联机阵营操作守卫：Host 只能操作蓝方(player)，Client 只能操作红方(ai)；单机恒 true */
function canOperateTeam(team) {
    if (!isOnlineMode()) return true;
    return team === myOnlineTeam();
}

/** 清除卡牌选中状态（上下两方都清）——DOM 操作统一归 ui.js（基础框架第6条） */
function clearCardSelection() {
    document.querySelectorAll('.card-btn').forEach(b => b.classList.remove('selected'));
    document.querySelectorAll('#topCardPanel .card-btn').forEach(b => b.classList.remove('selected'));
}

/** 解析技能卡当前状态（镜像/精英）：返回 { mode, skill, cardName, cdLeft, skillKey, mirror } 或 null */
function resolveSkillState(team, id) {
    const skills = team === 'ai' ? (game.eliteSkills.ai || {}) : (game.eliteSkills.player || {});
    if (id === 'mirror') {
        for (const k in skills) if (k.indexOf('mirror_') === 0) {
            const st = skills[k];
            const mCard = CARDS[k.slice(7)];
            if (!mCard) return null;
            return { mode: st.mode, skill: mCard.activeSkill, cardName: mCard.name, cdLeft: st.skillCdLeft || 0, skillKey: k, mirror: true };
        }
        return null;
    }
    const st = skills[id];
    const card = CARDS[id];
    if (!st || !card || !card.activeSkill) return null;
    return { mode: st.mode, skill: card.activeSkill, cardName: card.name, cdLeft: st.skillCdLeft || 0, skillKey: id, mirror: false };
}

/** 判断某卡当前是否处于"技能卡"状态（已部署精英技能可用/已用；渲染层也用它过滤部署预览） */
function isSkillCardState(team, id) {
    const s = resolveSkillState(team, id);
    return !!(s && (s.mode === 'skill' || s.mode === 'used'));
}

/** 技能卡统一交互：单击=选中/取消（可取消，根治"失灵"），300ms内双击=释放技能；释放失败保留选中 */
function handleSkillCardClick(id, btn, team, isDbl) {
    if (!canOperateTeam(team)) return; // 🔗 联机：只能操作己方阵营
    const s = resolveSkillState(team, id);
    if (!s) return;
    const selKey = team === 'ai' ? 'selectedCardId2' : 'selectedCardId';
    const panelSel = team === 'ai' ? '#topCardPanel .card-btn' : '#cardPanel .card-btn';

    // 已释放：单击即提示（不进入选中/双击，保持原交互），同时清掉可能的残留选中
    if (s.mode === 'used') {
        game.uiState._lastClick = null;
        if (game.uiState[selKey]) {
            game.uiState[selKey] = null;
            document.querySelectorAll(panelSel).forEach(b => b.classList.remove('selected'));
        }
        showGameTip(s.mirror
            ? `『${s.skill.name}』已释放，镜像精英阵亡后恢复`
            : `『${s.skill.name}』已释放，${s.cardName}阵亡后卡牌恢复`);
        return;
    }
    if (s.mode !== 'skill') return;

    // 双击 → 释放技能
    if (isDbl) {
        game.uiState._lastClick = null; // 无论成败都重置双击窗口，后续"再单击"即为取消
        // 本体在场检查（部署延迟中/刚阵亡槽未恢复 → 准确提示，不误报圣水不足）
        const unit = game.entities.find(e => e.cardId === (s.mirror ? s.skillKey.slice(7) : id)
            && e.team === team && e.hp > 0 && !e.isCopy && (s.mirror ? e.isMirrored : !e.isMirrored));
        if (!unit) {
            showGameTip(`『${s.cardName}』尚未就绪…`);
            return; // 保留选中
        }
        if (dispatchCommand({ type: 'SKILL', skillKey: s.skillKey, team })) {
            // 释放成功：清除选中
            game.uiState[selKey] = null;
            document.querySelectorAll(panelSel).forEach(b => b.classList.remove('selected'));
        } else if (s.cdLeft > 0) {
            showGameTip(`『${s.skill.name}』冷却中 ${Math.ceil(s.cdLeft)}s`);
        } else {
            showGameTip(`圣水不足，无法释放『${s.skill.name}』`);
        }
        // 释放失败：保留选中（可再单击取消）
        return;
    }

    // 单击 → 选中 / 取消（两侧选中统一管理，杜绝"预览取消不掉"）
    if (game.uiState[selKey] === id) {
        game.uiState._lastClick = null; // 取消后重置双击窗口
        game.uiState[selKey] = null;
        document.querySelectorAll(panelSel).forEach(b => b.classList.remove('selected'));
        // ★ 引导提示：该技能卡靠"双击"释放（与全局黄色提示同款）
        showGameTip('双击释放技能哦');
    } else {
        game.uiState.selectedCardId = null;
        game.uiState.selectedCardId2 = null;
        document.querySelectorAll('#cardPanel .card-btn, #topCardPanel .card-btn').forEach(b => b.classList.remove('selected'));
        game.uiState[selKey] = id;
        btn.classList.add('selected');
    }
}

/** 根据模式渲染卡牌面板（全领=全部卡牌，卡组=只显示卡组中的牌） */
function renderCardPanel(mode, deckCards) {
    const panel = document.getElementById('cardPanel');
    panel.innerHTML = '';

    // 决定显示哪些卡牌 ID
    let cardIds;
    if (mode === 'classic') {
        // 全领对战：显示全部卡牌
        cardIds = CARD_IDS;
    } else if (Array.isArray(deckCards) && deckCards.length) {
        // 🔗 联机：精确显示该方卡组
        cardIds = deckCards;
    } else {
        // 卡组对战 / AI 对战：只显示当前激活卡组里的卡牌
        cardIds = getActiveDeckCards();
    }

    // ★ 布局由CSS统一控制（flex-wrap + max-width放15张），不干预
    
    cardIds.forEach(id => {
        const card = CARDS[id];
        if (!card) return; // 容错
        if (isOnlineMode() && id === 'smoke_guide') return; // 🔗 联机：烟引暂禁用（同步复杂度高）

        const btn = document.createElement('div');
        btn.className = 'card-btn';
        btn.dataset.cardId = id;
        // 根据卡牌类型加颜色分类（精锐=金色优先，其次法术/建筑/兵种）
        if (card.category === 'elite') btn.classList.add('card-type-elite');
        else if (card.type === 'spell') btn.classList.add('card-type-spell');
        else if (card.type === 'tower' || card.type === 'barrack' || card.type === 'collector') btn.classList.add('card-type-building');
        else btn.classList.add('card-type-troop');
        btn.innerHTML = `<span class="card-cost">${card.cost}</span>${card.icon}<br>${card.name}`;

        // ★ 镜像法术标记
        if (id === 'mirror') {
            btn.classList.add('card-mirror');
        }

        // ★ 冷却覆盖层
        const cdOverlay = document.createElement('div');
        cdOverlay.className = 'card-cooldown-overlay';
        cdOverlay.textContent = '';
        btn.appendChild(cdOverlay);

        btn.addEventListener('click', () => {
            if (game.gameOver) return;
            if (!canOperateTeam('player')) return; // 🔗 联机：蓝方仅房主可操作

            // ★ 统一记录"上次点击"（技能卡双击判定用；点过其他卡/地图会覆盖，避免误判双击）
            const now = Date.now();
            const prev = game.uiState._lastClick;
            game.uiState._lastClick = { id, isSkill: isSkillCardState('player', id), time: now };
            const isDbl = !!(prev && prev.isSkill && prev.id === id && now - prev.time <= 300);

            // 🕊️🪞 技能卡统一交互：单击=选中（可再单击取消），300ms内双击=释放技能
            //    （🧭 烟引 pending 中选技能卡：只收预览，pending 后台继续计时）
            if (isSkillCardState('player', id)) {
                handleSkillCardClick(id, btn, 'player', isDbl);
                return;
            }

            // ★ 冷却中的卡牌不可选中（镜像法术冷却来源特殊=继承被复制卡冷却，点击时给出提示避免"没反应"）
            const cd = id === 'mirror' ? getMirrorCooldown('player') : ((game.cardCooldowns.player || {})[id] || 0);
            if (cd > 0) {
                if (id === 'mirror') showGameTip(`镜像法术冷却中 ${Math.ceil(cd)}s`);
                return;
            }

            // 🧭 烟引/镜像烟引 pending 中：点烟引卡或镜像卡 = 普通法术式 toggle（已选中时再点=放弃选中；pending 后台继续计时）
            const pendingPlayer = id === 'mirror' ? getSmokePending('player', true) : getSmokePending('player', false);
            if ((id === 'smoke_guide' || id === 'mirror') && pendingPlayer) {
                if (game.uiState.selectedCardId === id) {
                    game.uiState.selectedCardId = null;
                    document.querySelectorAll('.card-btn').forEach(b => b.classList.remove('selected'));
                } else {
                    game.uiState.selectedCardId = id;
                    document.querySelectorAll('.card-btn').forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                }
                showGameTip(`🧭 烟引待放烟中（${Math.ceil(pendingPlayer.timer)}s），点击地图放烟`);
                return;
            }

            if (game.uiState.selectedCardId === id) {
                // 取消选中
                game.uiState.selectedCardId = null;
                document.querySelectorAll('.card-btn').forEach(b => b.classList.remove('selected'));
            } else {
                // 选中新卡牌（pending 中选其他卡：只收预览、pending 后台继续计时）
                game.uiState.selectedCardId = id;
                document.querySelectorAll('.card-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
            }
        });

        panel.appendChild(btn);
    });
}

/** 渲染上方（红方）卡牌面板 */
function renderTopCardPanel(mode, deckCards) {
    const panel = document.getElementById('topCardPanel');
    if (!panel) return;
    panel.innerHTML = '';

    let cardIds;
    if (mode === 'classic') cardIds = CARD_IDS;
    else if (Array.isArray(deckCards) && deckCards.length) cardIds = deckCards; // 🔗 联机：精确显示该方卡组
    else cardIds = getActiveDeckCards();

    cardIds.forEach(id => {
        const card = CARDS[id];
        if (!card) return;
        if (isOnlineMode() && id === 'smoke_guide') return; // 🔗 联机：烟引暂禁用

        const btn = document.createElement('div');
        btn.className = 'card-btn';
        btn.dataset.cardId = id;
        // 根据卡牌类型加颜色分类（精锐=金色优先，其次法术/建筑/兵种）
        if (card.category === 'elite') btn.classList.add('card-type-elite');
        else if (card.type === 'spell') btn.classList.add('card-type-spell');
        else if (card.type === 'tower' || card.type === 'barrack' || card.type === 'collector') btn.classList.add('card-type-building');
        else btn.classList.add('card-type-troop');
        btn.innerHTML = `<span class="card-cost">${card.cost}</span>${card.icon}<br>${card.name}`;

        // ★ 镜像法术标记（红方）
        if (id === 'mirror') {
            btn.classList.add('card-mirror');
        }

        // 冷却覆盖层
        const cdOverlay = document.createElement('div');
        cdOverlay.className = 'card-cooldown-overlay';
        cdOverlay.textContent = '';
        btn.appendChild(cdOverlay);

        btn.addEventListener('click', () => {
            if (game.gameOver) return;
            if (!canOperateTeam('ai')) return; // 🔗 联机：红方仅加入者可操作

            // ★ 统一记录"上次点击"（技能卡双击判定用；点过其他卡/地图会覆盖，避免误判双击）
            const now = Date.now();
            const prev = game.uiState._lastClick;
            game.uiState._lastClick = { id, isSkill: isSkillCardState('ai', id), time: now };
            const isDbl = !!(prev && prev.isSkill && prev.id === id && now - prev.time <= 300);

            // 🕊️🪞 技能卡统一交互：单击=选中（可再单击取消），300ms内双击=释放技能
            //    （🧭 烟引 pending 中选技能卡：只收预览，pending 后台继续计时）
            if (isSkillCardState('ai', id)) {
                handleSkillCardClick(id, btn, 'ai', isDbl);
                return;
            }

            // 冷却判断（红方复用 ai 冷却槽；镜像法术冷却来源特殊=继承被复制卡冷却，点击时给出提示避免"没反应"）
            const cd = id === 'mirror' ? getMirrorCooldown('ai') : ((game.cardCooldowns.ai || {})[id] || 0);
            if (cd > 0) {
                if (id === 'mirror') showGameTip(`镜像法术冷却中 ${Math.ceil(cd)}s`);
                return;
            }

            // 🧭 烟引/镜像烟引 pending 中：点烟引卡或镜像卡 = 普通法术式 toggle（已选中时再点=放弃选中；pending 后台继续计时）
            const pendingAi = id === 'mirror' ? getSmokePending('ai', true) : getSmokePending('ai', false);
            if ((id === 'smoke_guide' || id === 'mirror') && pendingAi) {
                if (game.uiState.selectedCardId2 === id) {
                    game.uiState.selectedCardId2 = null;
                    document.querySelectorAll('#topCardPanel .card-btn').forEach(b => b.classList.remove('selected'));
                } else {
                    // 选中红方烟引 → 取消蓝方选中
                    game.uiState.selectedCardId = null;
                    document.querySelectorAll('#cardPanel .card-btn').forEach(b => b.classList.remove('selected'));
                    game.uiState.selectedCardId2 = id;
                    document.querySelectorAll('#topCardPanel .card-btn').forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                }
                showGameTip(`🧭 烟引待放烟中（${Math.ceil(pendingAi.timer)}s），点击地图放烟`);
                return;
            }

            if (game.uiState.selectedCardId2 === id) {
                // 取消选中
                game.uiState.selectedCardId2 = null;
                document.querySelectorAll('#topCardPanel .card-btn').forEach(b => b.classList.remove('selected'));
            } else {
                // 选中红方卡牌 → 取消蓝方选中
                game.uiState.selectedCardId = null;
                document.querySelectorAll('#cardPanel .card-btn').forEach(b => b.classList.remove('selected'));
                // 选中红方卡牌
                game.uiState.selectedCardId2 = id;
                document.querySelectorAll('#topCardPanel .card-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
            }
        });

        panel.appendChild(btn);
    });
}

/** 初始化 UI：绑定鼠标事件（卡牌面板由 renderCardPanel / renderTopCardPanel 单独渲染） */
function setupUI() {
    // ---- 画布鼠标移动：更新坐标 + 悬停检测 ----
    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const scaleX = W / rect.width;
        const scaleY = H / rect.height;
        game.uiState.mouseX = (e.clientX - rect.left) * scaleX;
        game.uiState.mouseY = (e.clientY - rect.top) * scaleY;
        updateHover();
    });

    // ---- 画布点击：部署选中卡牌 ----
    canvas.addEventListener('click', (e) => {
        if (game.gameOver) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = W / rect.width;
        const scaleY = H / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;

        // ★ 任何地图点击都会打断"技能卡双击"判定窗口（防止点完地图后误判双击释放）
        game.uiState._lastClick = { id: null, isSkill: false, time: Date.now() };

        // 优先蓝方（下方玩家；🔗 联机：仅房主可操作蓝方）
        if (canOperateTeam('player') && game.uiState.selectedCardId) {
            // 🧭 烟引：两段式引导交互（不走 deploy 常规路径）
            //    镜像烟引 pending 中：镜像卡=「下烟」载体，点地图同样走放烟交互（不重复部署）
            const _p = getSmokePending('player', game.uiState.selectedCardId === 'mirror');
            if (game.uiState.selectedCardId === 'smoke_guide' || (game.uiState.selectedCardId === 'mirror' && _p)) {
                handleSmokeGuideClick('player', x, y);
                return;
            }
            // ★ 技能卡选中时点地图 = 取消选中（技能卡无需落子部署，且不残留预览）
            if (isSkillCardState('player', game.uiState.selectedCardId)) {
                game.uiState.selectedCardId = null;
                document.querySelectorAll('#cardPanel .card-btn').forEach(b => b.classList.remove('selected'));
                return;
            }
            if (dispatchCommand({ type: 'DEPLOY', team: 'player', cardId: game.uiState.selectedCardId, x, y })) {
                // 🧭 烟引第一阶段（选范围套buff）部署成功后：保持选中烟引卡
                //    → 预览无缝切换为「下烟」阶段（虚线箭头），继续放烟流程，无需重新点卡
                if (game.uiState.selectedCardId !== 'smoke_guide') {
                    game.uiState.selectedCardId = null;
                    document.querySelectorAll('#cardPanel .card-btn').forEach(b => b.classList.remove('selected'));
                }
            } else {
                // 部署失败：位置无效保留选中方便换位置；其余失败清空选中并提示，避免选中状态/预览残留造成"点了没反应/再次点击还是预览"
                const failReason = game.uiState.deployFailReason;
                game.uiState.deployFailReason = null;
                if (failReason !== 'position' && failReason !== 'barrier') {
                    game.uiState.selectedCardId = null;
                    document.querySelectorAll('#cardPanel .card-btn').forEach(b => b.classList.remove('selected'));
                    if (failReason === 'elixir') showGameTip('圣水不足，无法部署');
                    else if (failReason === 'invalid') showGameTip('无法部署：没有可复制的卡牌或卡牌不可用');
                    else if (failReason === 'cooldown') showGameTip('卡牌冷却中');
                    else if (failReason === 'temple_limit') showGameTip('己方最多同時存在1座神廟');
                    else showGameTip('部署失败');
                } else if (failReason === 'barrier') {
                    showGameTip('🔮 敌方法术屏障笼罩该区域，无法释放法术');
                }
            }
            return;
        }

        // 红方（上方玩家；🔗 联机：仅加入者可操作红方）
        if (canOperateTeam('ai') && game.uiState.selectedCardId2) {
            // 🧭 烟引：两段式引导交互（红方双人模式同样支持）
            //    镜像烟引 pending 中：镜像卡=「下烟」载体，点地图同样走放烟交互（不重复部署）
            const _p = getSmokePending('ai', game.uiState.selectedCardId2 === 'mirror');
            if (game.uiState.selectedCardId2 === 'smoke_guide' || (game.uiState.selectedCardId2 === 'mirror' && _p)) {
                handleSmokeGuideClick('ai', x, y);
                return;
            }
            // ★ 技能卡选中时点地图 = 取消选中（技能卡无需落子部署，且不残留预览）
            if (isSkillCardState('ai', game.uiState.selectedCardId2)) {
                game.uiState.selectedCardId2 = null;
                document.querySelectorAll('#topCardPanel .card-btn').forEach(b => b.classList.remove('selected'));
                return;
            }
            if (dispatchCommand({ type: 'DEPLOY', team: 'ai', cardId: game.uiState.selectedCardId2, x, y })) {
                // 🧭 烟引第一阶段（选范围套buff）部署成功后：保持选中烟引卡
                //    → 预览无缝切换为「下烟」阶段（虚线箭头），继续放烟流程，无需重新点卡
                if (game.uiState.selectedCardId2 !== 'smoke_guide') {
                    game.uiState.selectedCardId2 = null;
                    document.querySelectorAll('#topCardPanel .card-btn').forEach(b => b.classList.remove('selected'));
                }
            } else {
                // 部署失败：同上，清空选中并提示（位置无效保留选中）
                const failReason = game.uiState.deployFailReason;
                game.uiState.deployFailReason = null;
                if (failReason !== 'position' && failReason !== 'barrier') {
                    game.uiState.selectedCardId2 = null;
                    document.querySelectorAll('#topCardPanel .card-btn').forEach(b => b.classList.remove('selected'));
                    if (failReason === 'elixir') showGameTip('圣水不足，无法部署');
                    else if (failReason === 'invalid') showGameTip('无法部署：没有可复制的卡牌或卡牌不可用');
                    else if (failReason === 'cooldown') showGameTip('卡牌冷却中');
                    else if (failReason === 'temple_limit') showGameTip('己方最多同時存在1座神廟');
                    else showGameTip('部署失败');
                } else if (failReason === 'barrier') {
                    showGameTip('🔮 敌方法术屏障笼罩该区域，无法释放法术');
                }
            }
        }
    });

    // ---- 鼠标离开画布：清除悬停 ----
    canvas.addEventListener('mouseleave', () => {
        game.uiState.hoveredEntity = null;
    });
}

/** 刷新上方（红方）卡牌冷却 */
function refreshTopCardCooldowns() {
    const panel = document.getElementById('topCardPanel');
    if (!panel) return;
    const cooldowns = game.cardCooldowns.ai || {};
    panel.querySelectorAll('.card-btn').forEach(btn => {
        const id = btn.dataset.cardId;
        if (!id) return;
        const card = CARDS[id];
        if (card && card.activeSkill) return; // 🕊️ 精英卡冷却由 eliteSkills 管理，不走普通冷却
        if (btn.dataset.mirrorSkill) return;  // 🪞 镜像精英技能卡：冷却由镜像槽管理（技能冷却/已用在 updateSingleMirror 显示）
        // 🧭 烟引：pending 已结束（放烟/超时）但卡面仍被改写过 → 恢复原卡面
        if (id === 'smoke_guide' && btn.dataset.smokePendingState && !getSmokePending('ai', false)) {
            btn.dataset.smokePendingState = '';
            btn.innerHTML = `<span class="card-cost">${card.cost}</span>${card.icon}<br>${card.name}<span class="card-cooldown-overlay"></span>`;
        }
        const cd = cooldowns[id] || 0;
        const overlay = btn.querySelector('.card-cooldown-overlay');
        // 🧭 烟引 pending：卡面变「0费⬇️+倒计时」（非黑，无冷却覆盖层；倒计时实时刷新）
        if (id === 'smoke_guide' && getSmokePending('ai', false)) {
            const secs = Math.ceil(getSmokePending('ai', false).timer);
            if (btn.dataset.smokePendingState !== String(secs)) {
                btn.dataset.smokePendingState = String(secs);
                btn.innerHTML = `<span class="card-cost">0</span>⬇️<br>下烟 ${secs}s<span class="card-cooldown-overlay"></span>`;
            }
            btn.classList.remove('on-cooldown');
            return;
        }
        btn.dataset.smokePendingState = '';
        // 🔮 法术屏障：动态费用显示（场上每多1座己方屏障费用+2）
        if (id === 'spell_barrier') {
            const costEl = btn.querySelector('.card-cost');
            if (costEl) {
                const curCost = getCardCost('ai', id);
                const shown = parseInt(costEl.textContent, 10);
                if (!isNaN(shown) && shown !== curCost) costEl.textContent = curCost;
            }
        }
        if (cd > 0) {
            btn.classList.add('on-cooldown');
            if (overlay) overlay.textContent = cd.toFixed(1) + 's';
        } else {
            btn.classList.remove('on-cooldown');
            if (overlay) overlay.textContent = '';
        }
    });
}

/** 🕊️ 刷新精英技能卡牌状态（每帧由 refreshCardCooldowns 调用）：
 *  skill = 卡面变为技能名+技能费（金色发光，可点击释放；释放后进入技能冷却，倒计时结束可再次释放）
 *  used  = 卡面变黑（已用，等待精英阵亡恢复）
 *  deploy = 正常卡面；cdLeft>0 时半透明 + 死亡冷却倒计时（死亡后才开始）
 */
function refreshEliteSkillCards() {
    refreshEliteSkillPanel('#cardPanel', 'player');
    refreshEliteSkillPanel('#topCardPanel', 'ai');
}

/** 刷新单个卡牌面板中的精英技能卡 */
function refreshEliteSkillPanel(selector, team) {
    const panel = document.querySelector(selector);
    if (!panel) return;
    const es = (game.eliteSkills || {})[team] || {};
    panel.querySelectorAll('.card-btn').forEach(btn => {
        const id = btn.dataset.cardId;
        const card = CARDS[id];
        if (!card || !card.activeSkill) return;
        const st = es[id];
        if (!st) return;

        // 🛕 技能费动态显示：神庙神赐费用随使用哥布林卡递减（blessCost），其他精英回退卡牌基础费
        const skillCost = st.blessCost != null ? st.blessCost : card.activeSkill.cost;

        // 状态未变化则跳过（避免每帧重建 DOM 造成闪烁/开销）；blessCost 变化也需重渲染（费用数字联动）
        const stateKey = st.mode + '|' + (st.skillCdLeft > 0 ? Math.ceil(st.skillCdLeft) : 0) + '|' + (st.cdLeft > 0 ? Math.ceil(st.cdLeft) : 0) + '|' + (st.blessCost != null ? st.blessCost : 0);
        if (btn.dataset.esState === stateKey) return;
        btn.dataset.esState = stateKey;

        // 清除旧状态类
        btn.classList.remove('card-skill-mode', 'card-skill-used', 'card-skill-cd');
        const overlay = btn.querySelector('.card-cooldown-overlay');

        let face;
        if (st.mode === 'skill') {
            // 技能卡：显示技能图标/名称/技能费，金色发光
            face = `<span class="card-cost">${skillCost}</span><span class="card-icon">${card.activeSkill.icon}</span><br><span class="card-name">${card.activeSkill.name}</span>`;
            btn.classList.add('card-skill-mode');
            if (st.skillCdLeft > 0) {
                // ⏳ 技能冷却中：半透明灰化 + 倒计时
                btn.classList.add('card-skill-cd');
                if (overlay) overlay.textContent = Math.ceil(st.skillCdLeft) + 's';
            } else if (overlay) overlay.textContent = '';
        } else if (st.mode === 'used') {
            // 已用：变黑
            face = `<span class="card-cost">${skillCost}</span><span class="card-icon">✖</span><br><span class="card-name">已用</span>`;
            btn.classList.add('card-skill-used');
            if (overlay) overlay.textContent = '';
        } else {
            // deploy：正常卡面；死亡冷却倒计时（精英死亡后才开始）
            face = `<span class="card-cost">${card.cost}</span><span class="card-icon">${card.icon}</span><br><span class="card-name">${card.name}</span>`;
            if (st.cdLeft > 0) {
                btn.classList.add('card-skill-cd');
                if (overlay) overlay.textContent = Math.ceil(st.cdLeft) + 's';
            } else if (overlay) overlay.textContent = '';
        }

        btn.innerHTML = face;
        if (overlay) btn.appendChild(overlay); // 覆盖层重新挂回（absolute 定位，位置由 CSS 决定）
    });
}

/** 🧭 烟引法术·新状态机交互（由 canvas 点击调用）：
 *  阶段0（选中卡）：预览 = 极速同款大圈(radius=85)，点地图任意处 → 扣1费 → 0.2s部署延迟
 *  阶段1（pending 中，12s倒计时）：点地图 = 选放烟点 → 校验敌方兵种/屏障 → 圈内友军全部
 *        startSmokeGuide 去该点 → buff停闪稳显 → 进冷却15s → 注册 lastDeployedCardId
 *  阶段2（超时/放烟后）：清理 pending；期间选其他卡只收预览、pending 后台继续计时
 *  ★ 该函数只处理「第一段扣费」（阶段0→阶段1），放烟点选择由 handleSmokeReleaseClick 执行 */
function handleSmokeGuideClick(team, x, y) {
    const card = CARDS.smoke_guide;
    if (!card) return;
    // 阶段1（pending 放烟中）→ 交给 handleSmokeReleaseClick（选放烟点）
    //    （镜像 pending 同理：镜像卡此时就是「下烟」载体，交互完全一致）
    const selectedId = team === 'player' ? game.uiState.selectedCardId : game.uiState.selectedCardId2;
    const isMirror = selectedId === 'mirror';
    if (getSmokePending(team, isMirror)) {
        handleSmokeReleaseClick(team, x, y);
        return;
    }
    // 阶段0：扣1费 → 0.2s部署延迟 → 套buff进pending（由 finishDeployItem 完成）
    dispatchCommand({ type: 'DEPLOY', team, cardId: 'smoke_guide', x, y });
}

/** 🧭 烟引·阶段2：pending 中点击地图 = 选放烟点
 *  圈内所有 buff 友军 startSmokeGuide 去该点（改变🧭buff为引导特殊状态）→ 进冷却 → 清 pending */
function handleSmokeReleaseClick(team, x, y) {
    const card = CARDS.smoke_guide;
    if (!card) return;
    const selectedId = team === 'player' ? game.uiState.selectedCardId : game.uiState.selectedCardId2;
    const isMirror = selectedId === 'mirror';
    const pendingBucket = isMirror ? game.mirrorSmokePending : game.smokePending;
    const pend = getSmokePending(team, isMirror);
    if (!pend) return;
    // 🔮 法术屏障：敌方不能在庇护范围内放烟（同其他法术的通用规则）
    if (isSpellBlockedByBarrier(team, x, y)) {
        showGameTip('🔮 敌方法术屏障笼罩该区域，无法释放法术');
        return;
    }
    // 🧭 过滤仍存活的 buff 友军 → 全部引导去放烟点（行为同 AI：圈内友军全引导）
    // ★ 无友军存活也正常走流程，且烟点照常出烟特效（真正法术：空放也有视觉效果）
    let guided = 0;
    for (const uid of pend.unitIds) {
        const e = game.entities.find(ent => ent.id === uid && ent.hp > 0 && ent.team === team);
        if (!e) continue;
        guided++;
        if (isMirror) e._smokePendingBuffMirror = false;
        else e._smokePendingBuff = false; // 🧭 buff 停闪（pending 闪烁结束）
        startSmokeGuide(team, uid, x, y);
        e._smokeGuide = true;        // 🧭 立即稳显（不等 countdown→active）
    }
    if (guided === 0) startSmokeGuide(team, null, x, y); // 纯特效引导：无友军时烟点也出烟
    // 进冷却（15s；镜像烟引冷却继承15s）+ 注册 lastDeployedCardId（供镜像复制）
    const cd = card.cooldown;
    if (isMirror) setMirrorCooldown(team, cd);
    else game.cardCooldowns[team]['smoke_guide'] = cd;
    if (team === 'player') game.lastDeployedCardId = 'smoke_guide';
    else game.lastDeployedCardId2 = 'smoke_guide';
    // 清对应 pending，原烟引与镜像烟引互不影响
    pendingBucket[team] = null;
    // 清选中态（放烟完成）
    const selKey = team === 'player' ? 'selectedCardId' : 'selectedCardId2';
    const panelSel = team === 'player' ? '#cardPanel .card-btn' : '#topCardPanel .card-btn';
    game.uiState[selKey] = null;
    document.querySelectorAll(panelSel).forEach(b => b.classList.remove('selected'));
}

/** 轻量提示浮字（技能释放失败等场景，自动淡出） */
let _gameTipTimer = null;
function showGameTip(text) {
    let el = document.getElementById('gameTip');
    if (!el) {
        el = document.createElement('div');
        el.id = 'gameTip';
        el.style.cssText = 'position:fixed;left:50%;top:36%;transform:translateX(-50%);background:rgba(15,15,35,.85);color:#ffd700;padding:8px 18px;border-radius:10px;font-size:15px;font-weight:bold;z-index:9999;pointer-events:none;transition:opacity .35s;border:1px solid rgba(255,215,0,.4);white-space:nowrap;';
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(_gameTipTimer);
    _gameTipTimer = setTimeout(() => { el.style.opacity = '0'; }, 1600);
}

/** 更新镜像法术卡牌的显示内容（每帧更新，让按钮动态反映上一次部署的卡牌） */
function updateMirrorCardDisplay() {
    // 更新蓝方（玩家）镜像
    updateSingleMirror('#cardPanel .card-btn.card-mirror', getMirrorCopiedCard('player'), 'player');
    // 更新红方镜像（AI 或玩家2，用自己的记录）
    updateSingleMirror('#topCardPanel .card-btn.card-mirror', getMirrorCopiedCard('ai'), 'ai');
}

/** 更新单个镜像按钮的显示（🪞 镜像精英在场时，镜像卡变为该精英的独立技能卡——镜像与本体互不影响） */
function updateSingleMirror(selector, lastCardId, team) {
    const mirrorBtn = document.querySelector(selector);
    if (!mirrorBtn) return;

    // 🪞 当前在场的镜像精英：遍历镜像槽（存在 = 镜像精英在场）。
    //    镜像技能卡的显示**只由镜像精英决定**，与最近部署的卡牌无关（使用其他卡不会刷新镜像卡）
    const mirrorState = getMirrorState(team);
    const mirrorCardId = mirrorState.eliteSkillKey ? mirrorState.eliteSkillKey.slice(7) : null;
    if (mirrorCardId && CARDS[mirrorCardId] && CARDS[mirrorCardId].activeSkill) {
        const st = mirrorState.eliteSkill;
        const origCard = CARDS[mirrorCardId];
        // 清除可能残留的部署冷却样式（镜像法术自身冷却），技能卡冷却由镜像槽管理
        mirrorBtn.classList.remove('on-cooldown', 'card-skill-used', 'card-skill-cd');
        if (st.mode === 'skill') {
            // 技能卡：显示技能图标/名称/技能费，金色发光（保留 overlay 元素用于显示技能冷却秒数）
            // 🛕 技能费动态显示：镜像神庙神赐费用同样随使用哥布林卡递减（blessCost），其他精英回退卡牌基础费
            const mSkillCost = st.blessCost != null ? st.blessCost : origCard.activeSkill.cost;
            mirrorBtn.innerHTML = `<span class="card-cost">${mSkillCost}</span><span class="card-icon">${origCard.activeSkill.icon}</span><br><span class="card-name">🪞${origCard.activeSkill.name}</span><span class="card-cooldown-overlay"></span>`;
            mirrorBtn.classList.add('card-skill-mode', 'mirror-active');
            const overlay = mirrorBtn.querySelector('.card-cooldown-overlay');
            if (st.skillCdLeft > 0) {
                mirrorBtn.classList.add('card-skill-cd');
                if (overlay) overlay.textContent = Math.ceil(st.skillCdLeft) + 's';
            } else if (overlay) overlay.textContent = '';
        } else if (st.mode === 'used') {
            // 已用：变黑
            const mSkillCostUsed = st.blessCost != null ? st.blessCost : origCard.activeSkill.cost;
            mirrorBtn.innerHTML = `<span class="card-cost">${mSkillCostUsed}</span><span class="card-icon">✖</span><br><span class="card-name">已用</span><span class="card-cooldown-overlay"></span>`;
            mirrorBtn.classList.add('card-skill-used', 'mirror-active');
        }
        mirrorBtn.dataset.mirrorSkill = mirrorCardId;
        return;
    }
    mirrorBtn.dataset.mirrorSkill = '';

    if (lastCardId && lastCardId !== 'mirror' && CARDS[lastCardId]) {
        const origCard = CARDS[lastCardId];
        // 🔮 镜像复制屏障：费用跟随屏障动态费用+1（屏障6→镜像7，屏障8→镜像9）
        const mirrorCost = (lastCardId === 'spell_barrier' ? getCardCost(team, 'spell_barrier') : origCard.cost) + 1;
        // 🧭 镜像烟引 pending：镜像卡锁定「0费⬇️+倒计时」（非黑；放烟/超时后恢复普通镜像卡显示）
        if (lastCardId === 'smoke_guide' && getSmokePending(team, true)) {
            const secs = Math.ceil(getSmokePending(team, true).timer);
            if (mirrorBtn.dataset.smokePendingState !== String(secs)) {
                mirrorBtn.dataset.smokePendingState = String(secs);
                mirrorBtn.innerHTML = `<span class="card-cost">0</span>⬇️<br><span class="mirror-copied-name">下烟 ${secs}s</span><span class="card-cooldown-overlay"></span>`;
            }
            mirrorBtn.classList.add('mirror-active');
            mirrorBtn.classList.remove('on-cooldown', 'card-skill-mode', 'card-skill-used', 'card-skill-cd');
            return;
        }
        mirrorBtn.dataset.smokePendingState = '';
        mirrorBtn.innerHTML = `<span class="card-cost">${mirrorCost}</span>🪞<br><span class="mirror-copied-name">${origCard.name}</span><span class="card-cooldown-overlay"></span>`;
        mirrorBtn.classList.add('mirror-active');
        mirrorBtn.classList.remove('card-skill-mode', 'card-skill-used', 'card-skill-cd');
    } else {
        mirrorBtn.dataset.smokePendingState = '';
        mirrorBtn.innerHTML = `<span class="card-cost">1</span>🪞<br>镜像法术<span class="card-cooldown-overlay"></span>`;
        mirrorBtn.classList.remove('mirror-active', 'card-skill-mode', 'card-skill-used', 'card-skill-cd');
    }
}

/** 刷新所有卡牌的冷却显示（每帧由 update.js 调用） */
function refreshCardCooldowns() {
    updateMirrorCardDisplay(); // 先更新镜像法术显示
    refreshEliteSkillCards();  // 🕊️ 精英主动技能：技能卡状态刷新（技能/已用/死亡冷却）
    const cooldowns = game.cardCooldowns.player || {};
    document.querySelectorAll('.card-btn').forEach(btn => {
        const id = btn.dataset.cardId;
        if (!id) return;
        const card = CARDS[id];
        if (card && card.activeSkill) return; // 🕊️ 精英卡冷却由 eliteSkills 管理，不走普通冷却
        if (btn.dataset.mirrorSkill) return;  // 🪞 镜像精英技能卡：冷却由镜像槽管理（技能冷却/已用在 updateSingleMirror 显示）
        // 🧭 烟引：pending 已结束（放烟/超时）但卡面仍被改写过 → 恢复原卡面
        if (id === 'smoke_guide' && btn.dataset.smokePendingState && !getSmokePending('player', false)) {
            btn.dataset.smokePendingState = '';
            btn.innerHTML = `<span class="card-cost">${card.cost}</span>${card.icon}<br>${card.name}<span class="card-cooldown-overlay"></span>`;
        }
        const cd = cooldowns[id] || 0;
        const overlay = btn.querySelector('.card-cooldown-overlay');
        // 🧭 烟引 pending：卡面变「0费⬇️+倒计时」（非黑，无冷却覆盖层；倒计时实时刷新）
        if (id === 'smoke_guide' && getSmokePending('player', false)) {
            const secs = Math.ceil(getSmokePending('player', false).timer);
            if (btn.dataset.smokePendingState !== String(secs)) {
                btn.dataset.smokePendingState = String(secs);
                btn.innerHTML = `<span class="card-cost">0</span>⬇️<br>下烟 ${secs}s<span class="card-cooldown-overlay"></span>`;
            }
            btn.classList.remove('on-cooldown');
            return;
        }
        btn.dataset.smokePendingState = '';
        // 🔮 法术屏障：动态费用显示（场上每多1座己方屏障费用+2）
        if (id === 'spell_barrier') {
            const costEl = btn.querySelector('.card-cost');
            if (costEl) {
                const curCost = getCardCost('player', id);
                const shown = parseInt(costEl.textContent, 10);
                if (!isNaN(shown) && shown !== curCost) costEl.textContent = curCost;
            }
        }
        if (cd > 0) {
            btn.classList.add('on-cooldown');
            if (overlay) overlay.textContent = cd.toFixed(1) + 's';
        } else {
            btn.classList.remove('on-cooldown');
            if (overlay) overlay.textContent = '';
        }
    });
}

/** 更新悬停实体检测（从 render.js 移入，符合"状态改变归 ui"原则） */
function updateHover() {
    game.uiState.hoveredEntity = null;
    for (let e of game.entities) {
        if (e.hp <= 0) continue;
        const range = (e.type === 'tower' || e.type === 'barrack' || e.type === 'collector') ? 18
            : (e.type === 'main_tower' ? 32 : 12); // 主塔体积大（r28），加宽悬停判定
        if (Math.hypot(game.uiState.mouseX - e.x, game.uiState.mouseY - e.y) < range) {
            game.uiState.hoveredEntity = e;
            break;
        }
    }
}

/** 显示堡垒爆破告警 "危険！" */
function showBastionAlert() {
    const el = document.getElementById('bastionAlert');
    if (!el) return;
    el.style.display = 'block';
    el.style.animation = 'none';
    // 双层 rAF 重启动画：让两次样式变更分别落在独立帧周期，浏览器自然完成布局，
    // 替代 void el.offsetWidth 强制同步重排（低端设备避免不必要的 layout 卡顿）
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            el.style.animation = '';
        });
    });
    setTimeout(() => { el.style.display = 'none'; }, 2000);
}
