/* ===== apiAI.js — LLM AI 对战通道 ===== */

/**
 * 职责：让大模型（OpenAI 兼容接口）实时操控 AI 方
 * 
 * 数据流：
 *   update.js 检查 timer + aiThinking（每2.5秒固定调度，无拦截逻辑）
 *   llmAiMakeDecision() ↓
 *     1. 构建战场状态 + system prompt
 *     2. 调用 /v1/chat/completions（纯文本格式）
 *     3. 解析文本 【部署】cardId x y
 *     4. 失败 → 重试1次，再不成功则跳过，等待下次调度
 *     5. finally: aiThinking = false, 重置 timer
 */

// ===================================================================
//  1. LLM 配置
// ===================================================================

let LLM_CONFIG = {
    apiKey:      '',
    baseUrl:     'https://api.openai.com/v1',
    proxyUrl:    '',
    model:       'gpt-4o-mini',
    maxTokens:   512,
    temperature: 0.3,
    timeout:     8000,
};

// ---- 预设管理 ----

const PRESET_STORAGE_KEY = 'towerwar_ai_presets';
const DEFAULT_PRESETS = [
    { id: 1, name: 'OpenAI',       apiKey: '', baseUrl: 'https://api.openai.com/v1',              proxyUrl: '', model: 'gpt-4o-mini' },
    { id: 2, name: '硅基流动',     apiKey: '', baseUrl: 'https://api.siliconflow.cn/v1',           proxyUrl: '', model: 'Qwen/Qwen2.5-7B-Instruct' },
    { id: 3, name: 'DeepSeek',     apiKey: '', baseUrl: 'https://api.deepseek.com/v1',             proxyUrl: '', model: 'deepseek-chat' },
];

/** 获取所有预设（优先级：浏览器本地数据 > 個人データ.js 数据文件 > 内置默认） */
function getPresets() {
    try {
        const raw = localStorage.getItem(PRESET_STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    // 无本地数据：尝试从「個人データ.js」（私人数据文件，可删除）导入
    const ud = (typeof TOWERWAR_USERDATA !== 'undefined') ? TOWERWAR_USERDATA : null;
    if (ud && Array.isArray(ud.presets) && ud.presets.length > 0) {
        setPresets(ud.presets); // 导入并持久化到浏览器本地，后续保存照常
        if (ud.activePresetId != null) {
            try { localStorage.setItem('towerwar_active_preset_id', String(ud.activePresetId)); } catch (e2) { /* ignore */ }
            const active = ud.presets.find(p => String(p.id) === String(ud.activePresetId));
            if (active && !LLM_CONFIG.apiKey) {
                LLM_CONFIG.apiKey   = (active.apiKey || '').trim();
                LLM_CONFIG.baseUrl  = (active.baseUrl || 'https://api.openai.com/v1').trim();
                LLM_CONFIG.model    = (active.model || 'gpt-4o-mini').trim();
                LLM_CONFIG.proxyUrl = (active.proxyUrl || '').trim();
            }
        }
        return [...ud.presets];
    }
    // 首次使用，初始化默认预设
    setPresets(DEFAULT_PRESETS);
    return [...DEFAULT_PRESETS];
}

/** 保存所有预设 */
function setPresets(presets) {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
}

/** 添加/更新一个预设（有 id 则更新，无则新增） */
function savePreset(preset) {
    const presets = getPresets();
    if (preset.id) {
        const idx = presets.findIndex(p => p.id === preset.id);
        if (idx >= 0) presets[idx] = preset;
        else { preset.id = Date.now(); presets.push(preset); }
    } else {
        preset.id = Date.now();
        presets.push(preset);
    }
    setPresets(presets);
    return preset;
}

/** 设置某个预设为激活状态 */
function setActivePreset(id) {
    if (id === undefined || id === null) return;
    localStorage.setItem('towerwar_active_preset_id', String(id));
}

/** 删除一个预设 */
function deletePreset(id) {
    let presets = getPresets();
    presets = presets.filter(p => p.id !== id);
    setPresets(presets);
}

/** 应用某个预设到 LLM_CONFIG，保存为当前激活配置 */
function applyPreset(preset) {
    LLM_CONFIG.apiKey        = (preset.apiKey || '').trim();
    LLM_CONFIG.baseUrl       = (preset.baseUrl || 'https://api.openai.com/v1').trim();
    LLM_CONFIG.model         = (preset.model || 'gpt-4o-mini').trim();
    LLM_CONFIG.proxyUrl      = (preset.proxyUrl || '').trim();
    localStorage.setItem('towerwar_llm_key',   LLM_CONFIG.apiKey);
    localStorage.setItem('towerwar_llm_base',  LLM_CONFIG.baseUrl);
    localStorage.setItem('towerwar_llm_proxy', LLM_CONFIG.proxyUrl);
    localStorage.setItem('towerwar_llm_model', LLM_CONFIG.model);
    localStorage.setItem('towerwar_active_preset_id', String(preset.id));
}

/** 获取当前激活的预设 ID */
function getActivePresetId() {
    return localStorage.getItem('towerwar_active_preset_id') || null;
}

/** 获取当前 LLM 配置（key 脱敏） */
function getLlmConfig() {
    return {
        apiKey:        LLM_CONFIG.apiKey ? LLM_CONFIG.apiKey.slice(0, 8) + '...' : '',
        baseUrl:       LLM_CONFIG.baseUrl,
        proxyUrl:      LLM_CONFIG.proxyUrl,
        model:         LLM_CONFIG.model,
    };
}

// ---- 请求地址构建器（支持 Cloudflare Worker 代理转发）----

/**
 * 根据配置构建最终请求 URL 和额外 headers
 * @param {string} path       - API 路径，如 '/chat/completions'
 * @param {string} [overrideBase]  - 可选覆盖 baseUrl
 * @param {string} [overrideProxy] - 可选覆盖 proxyUrl
 * @returns {{ url: string, extraHeaders: object }}
 */
function buildRequestConfig(path, overrideBase, overrideProxy) {
    const base  = (overrideBase || LLM_CONFIG.baseUrl).replace(/\/+$/, '') || 'https://api.openai.com/v1';
    const proxy = (overrideProxy || LLM_CONFIG.proxyUrl).replace(/\/+$/, '');

    if (proxy) {
        // 通过 Cloudflare Worker 代理：发往代理地址 + 带 Target-Url 头
        return {
            url: proxy + '/v1' + path,
            extraHeaders: { 'Target-Url': base },
        };
    } else {
        // 直连 LLM API
        return {
            url: base + path,
            extraHeaders: {},
        };
    }
}


// ===================================================================
//  2. 卡牌描述生成器（从 CARDS 动态构建，改 config.js 自动生效）
// ===================================================================

/**
 * 从 config.js 的 CARDS 对象自动生成 LLM 可读的卡牌清单文本
 * 以后新增卡牌只需改 config.js，这里自动感知
 */
function buildCardDescriptions(deckOnly = false) {
    const lines = [];
    let ids;
    if (deckOnly) {
        ids = getActiveDeckCards().filter(id => id !== 'bat'); // 只展示卡组中的卡牌
    } else {
        ids = Object.keys(CARDS).filter(id => id !== 'bat'); // 跳过非卡牌单位（蝙蝠）
    }
    ids.forEach((id, idx) => {
        const c = CARDS[id];
        let typeLabel = {
            troop: c.flying ? '飞行兵种' : '地面兵种',
            tower: '防御建筑',
            barrack: '兵营建筑',
            collector: '经济建筑',
            spell: '法术',
            healer: '治疗单位',
        }[c.type] || c.type;
        if (c.category === 'elite') typeLabel = '精锐兵种';

        lines.push(`${idx + 1}. ${id}（${c.name}）${c.icon || ''}`);
        lines.push(`   - 费用：${c.cost}  |  类型：${c.type}（${typeLabel}）`);

        if (c.type === 'spell') {
            if (c.spawnCount || c.spawnWaves) {
                // 召唤型法术（如蝙蝠法术）
                if (c.spawnWaves) {
                    const total = (c.spawnWaves || 1) * (c.spawnPerWave || 1);
                    lines.push(`   - 释放${c.spawnStartDelay || 0}秒后在目标位置分${c.spawnWaves}波召唤（每${c.spawnInterval || 0.3}秒一波、每波${c.spawnPerWave || 2}只，共${total}只，散落半径 ${c.radius || 30}）`);
                } else {
                    lines.push(`   - 在目标位置召唤 ${c.spawnCount} 个单位（散落半径 ${c.radius || 30}）`);
                }
                lines.push(`   - 可全图施放，不限位置`);
            } else {
                lines.push(`   - 伤害：${c.damage !== undefined ? c.damage : '无'}  |  范围半径：${c.radius ?? '?'}`);
                if (id === 'earthquake') {
                    lines.push(`   - 对普通建筑10倍伤害（主塔/堡垒仅基础伤害）`);
                } else if (c.towerDmgMul !== undefined && c.towerDmgMul !== 1) {
                    lines.push(`   - 对主塔/堡垒伤害倍率：${c.towerDmgMul}`);
                }
            }
            if (c.desc) lines.push(`   - ${c.desc}`);
        } else if (c.type === 'healer') {
            lines.push(`   - HP：${c.hp}  |  治疗量：${c.healAmount}  |  治疗速度：${c.healSpeed}s`);
            lines.push(`   - 移速：${c.moveSpeed}  |  射程：${c.range}`);
            lines.push(`   - 不攻击，自动治疗范围内受伤友军`);
        } else if (c.type === 'troop') {
            // ★ 复用基础单位模板的卡牌（如骷髅海→通用哥布林）按模板显示面板；有独立属性的卡牌（女巫/暗夜女巫）显示自身
            const u = (c.hp ? c : ((c.spawnUnit && BASE_UNITS[c.spawnUnit]) || c));
            lines.push(`   - HP：${u.hp}  |  攻击：${u.atk}  |  攻速：${u.atkSpeed}s`);
            lines.push(`   - 移速：${u.moveSpeed}  |  射程：${u.range}  |  目标：${u.flying ? '飞行' : '对空对地'}`);
            if (u.splash) lines.push(`   - 溅射半径：${u.splash}`);
            if (u.targetMode === 'buildings') lines.push(`   - 只攻击建筑`);
            if (c.desc) lines.push(`   - ${c.desc}`);
        } else if (c.type === 'tower') {
            lines.push(`   - HP：${c.hp}  |  攻击：${c.atk}  |  攻速：${c.atkSpeed}s`);
            lines.push(`   - 射程：${c.range}${c.onlyGround ? '  |  只攻击地面单位' : '  |  对空对地'}`);
            if (c.splash) lines.push(`   - 溅射半径：${c.splash}（群体伤害）`);
            if (c.desc) lines.push(`   - ${c.desc}`);
        } else if (c.type === 'barrack') {
            lines.push(`   - HP：${c.hp}  |  每 ${c.spawnInterval} 秒生产 ${c.spawnCount} 只${c.spawnUnit || '小兵'}`);
            if (c.desc) lines.push(`   - ${c.desc}`);
        } else if (c.type === 'collector') {
            lines.push(`   - HP：${c.hp}  |  每 ${c.generateInterval} 秒产出 1 点圣水`);
            if (c.desc) lines.push(`   - ${c.desc}`);
        }
        lines.push('');
    });
    return lines.join('\n');
}

// ===================================================================
//  3. System Prompt（完整游戏规则，让 LLM 真正理解游戏）
//     卡牌部分由 buildCardDescriptions(deckOnly) 动态生成，AI对战只输出卡组卡牌
// ===================================================================

/**
 * 动态构建 System Prompt（包含最新卡牌数据 + 动态地图参数）
 */
function getSystemPrompt() {
return `你是「嘗試ゲーム」AI指挥官，目标是摧毁敌方主塔。

【绝对输出规则】（极其重要！）
你必须严格按照以下两步输出，绝不允许出现其他格式外的废话：
第一步：【战术分析】（50字以内，一句话说明当前最大威胁或战略意图）
第二步：【部署】或【等待】（紧跟在分析之后单独换行）

【战场JSON】
每2.5秒收到，包含：
· gameTime / summary — 游戏时间与战局统计
· ai / player — 双方圣水、主塔HP、丢堡数
· myUnits / enemyUnits — 双方存活单位（id/type/hp/x/y/flying）
· availableCards — 可用卡牌（费用够且非冷却）

【地图】
· 画布 ${W}×${H}，河流 x:${RIVER_LEFT}~${RIVER_RIGHT}
· 己方半场 x>${RIVER_RIGHT}（右），敌方半场 x<${RIVER_LEFT}（左）

【建筑】
· 你方主塔 (${AI_TOWER.x},${AI_TOWER.y}) HP 5000
· 敌方主塔 (${PLAYER_TOWER.x},${PLAYER_TOWER.y}) HP 5000
· 你方堡垒：上路 (${AI_BASTION_TOP.x},${AI_BASTION_TOP.y}) 下路 (${AI_BASTION_BOTTOM.x},${AI_BASTION_BOTTOM.y}) HP${BASTION_STATS.hp} 攻击${BASTION_STATS.atk} 射程${BASTION_STATS.range} 对空对地
· 敌方堡垒：上路 (${PLAYER_BASTION_TOP.x},${PLAYER_BASTION_TOP.y}) 下路 (${PLAYER_BASTION_BOTTOM.x},${PLAYER_BASTION_BOTTOM.y})

【圣水】
· 上限10点，初始5点，每2.8秒回复1点
· 满水(=10)时必须出牌
· 丢堡加速（丢1座×1.2，丢2座×1.4）

【可用卡牌】

${buildCardDescriptions(game.gameMode === 'api')}
【战斗机制】
· 近战（射程≤30）不攻击飞行单位
· 巨人只打建筑，溅射伤害对主目标100%，其余60%
· 防御塔默认对地（法师塔可对空），治疗兵不攻击自动治疗友军

【部署格式】（生成回复时最后参考此规则，必须严格遵守）
· 部署：【部署】cardId x y（每行一张，可多张同时部署）
· 等待：【等待】
· 部署位置必须在己方半场（x>${RIVER_RIGHT}），法术可全图施放

【输出示例】
【战术分析】敌方巨人逼近主塔，部署高伤单位拦截。
【部署】wizard 885 335

【战术分析】圣水已满，巨人+法师推进上路。
【部署】giant 910 278
【部署】wizard 885 335

【战术分析】费用不足暂无威胁，等待圣水回复。
【等待】

胜负：任意主塔血量为0即结束，摧毁敌方主塔获胜。`;
}


// ===================================================================
//  4. 构建战场状态（发给 LLM 的实时数据）
// ===================================================================

function buildLlmBattleState() {
    // ---- 己方（AI）单位（精简字段，节省 token）----
    const myUnits = game.entities
        .filter(e => e.team === 'ai' && e.hp > 0)
        .map(e => ({
            id: e.id,
            type: e.type,
            hp: Math.round(e.hp),
            x: Math.round(e.x),
            y: Math.round(e.y),
            flying: e.flying ? 1 : 0,
        }));

    // ---- 敌方（玩家）单位（精简字段，节省 token）----
    const enemyUnits = game.entities
        .filter(e => e.team === 'player' && e.hp > 0)
        .map(e => ({
            id: e.id,
            type: e.type,
            hp: Math.round(e.hp),
            x: Math.round(e.x),
            y: Math.round(e.y),
            flying: e.flying ? 1 : 0,
        }));

    // ---- 战场统计摘要（让 LLM 快速了解局势，不用数数）----
    const summary = {
        myUnitCount: myUnits.length,
        enemyUnitCount: enemyUnits.length,
        myTroopCount: myUnits.filter(e => e.type === 'troop').length,
        enemyTroopCount: enemyUnits.filter(e => e.type === 'troop').length,
        myBuildingCount: myUnits.filter(e => ['tower','barrack','collector'].includes(e.type)).length,
        enemyBuildingCount: enemyUnits.filter(e => ['tower','barrack','collector'].includes(e.type)).length,
        myFlyingCount: myUnits.filter(e => e.flying).length,
        enemyFlyingCount: enemyUnits.filter(e => e.flying).length,
    };

    // ---- AI 可用卡牌（费用足够且不在冷却）----
    const deckCards = getActiveDeckCards() || CARD_IDS;
    const availableCards = deckCards
        .filter(id => {
            const card = CARDS[id];
            if (!card) return false;
            if (getCardCost('ai', id) > game.elixir.ai) return false;
            const cd = game.cardCooldowns.ai[id];
            if (cd && cd > 0) return false;
            return true;
        })
        .map(id => {
            const card = CARDS[id];
            const cdRemain = game.cardCooldowns.ai[id] || 0;
            return {
                id,
                name: card.name,
                cost: getCardCost('ai', id),
                type: card.type,
                cooldownRemain: Math.round(cdRemain * 10) / 10, // 剩余冷却秒数
            };
        });

    return {
        gameTime: Math.round(game.time * 10) / 10,
        summary, // ← 新增战局摘要
        ai: {
            elixir: Math.round(game.elixir.ai * 10) / 10,
            elixirRate: game.elixirMultiplier.ai || 1.0,
            towerHp: Math.round((game.entities.find(e => e.type === 'main_tower' && e.team === 'ai')?.hp) || 0),
            maxTowerHp: 5000,
            bastionsLost: game.bastionsLost.ai,
        },
        player: {
            elixir: Math.round(game.elixir.player * 10) / 10,
            towerHp: Math.round((game.entities.find(e => e.type === 'main_tower' && e.team === 'player')?.hp) || 0),
            maxTowerHp: 5000,
            bastionsLost: game.bastionsLost.player,
        },
        myUnits,
        enemyUnits,
        availableCards,
    };
}


// ===================================================================
//  5. 文本格式部署解析器（钩子）
// ===================================================================

/**
 * 从 LLM 返回的文字中解析部署指令
 * 格式： 【部署】卡牌ID x坐标 y坐标 [理由]
 * 示例： 【部署】giant 950 200
 *        【部署】wizard 900 350 远程输出
 * 不部署时： 【等待】
 * 增强容错：兼容 **【部署】**、【部署】：、冒号 等 LLM 手滑格式
 */
function parseDeploymentText(content) {
    if (!content || typeof content !== 'string') return null;
    const deployments = [];
    // 增强正则：兼容 **【部署】**、【部署】:：、前后多余空格等情况
    const regex = /(?:\*\*)*【部署】(?:\*\*)*[:：]?\s*([a-zA-Z0-9_]+)\s+(\d+)\s+(\d+)(?:\s+(.*))?/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        deployments.push({
            cardId: String(match[1]),
            x:      parseInt(match[2], 10),
            y:      parseInt(match[3], 10),
            reason: (match[4] || '').trim(),
        });
    }
    return deployments.length > 0 ? deployments : null;
}


// ===================================================================
//  6. 调用 LLM API
// ===================================================================

/**
 * 调用 LLM 获取决策（支持批量部署）
 * @returns {Array<{ cardId: string, x: number, y: number, reason: string }> | null}
 */
async function callLlmDecision(apiKey, model, maxTokens, temperature) {
    const key = (apiKey || LLM_CONFIG.apiKey).trim();
    const mdl = (model || LLM_CONFIG.model || 'gpt-4o-mini').trim();
    const maxT = maxTokens || LLM_CONFIG.maxTokens || 512;
    const temp = temperature ?? LLM_CONFIG.temperature ?? 0.3;
    const timeout = LLM_CONFIG.timeout || 30000;

    if (!key) {
        console.warn('[LLM] API Key 无效');
        return null;
    }

    const state = buildLlmBattleState();
    const { url: endpoint, extraHeaders } = buildRequestConfig('/chat/completions');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
                ...extraHeaders,   // 代理转发时含 Target-Url 头
            },
            body: JSON.stringify({
                model: mdl,
                messages: [
                    { role: 'system', content: getSystemPrompt() },
                    { role: 'user',   content: JSON.stringify(state, null, 2) },
                ],
                max_tokens: maxT,
                temperature: temp,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status} ${response.statusText} — ${errText.slice(0, 200)}`);
        }

        const data = await response.json();
        const choice = data.choices && data.choices[0];
        if (!choice) throw new Error('LLM 返回空 choices');

        // ★【调试】打印实际请求与响应，打开 F12 控制台查看
        console.log('========== LLM 调试 ==========');
        console.log('[请求] 战场JSON(缩略):', JSON.stringify(state).slice(0, 300) + '...');
        console.log('[请求] SystemPrompt长度:', getSystemPrompt().length, '字符');
        console.log('[响应] 完整 choices:', JSON.stringify(choice, null, 2).slice(0, 1000));
        console.log('===============================');

        const content = choice.message.content || '';

        // ★ 解析文本格式 【部署】xxx
        let deployments = parseDeploymentText(content);
        if (deployments && deployments.length > 0) {
            console.log(`[LLM] 文本解析: 部署 ${deployments.length} 张卡牌 — ${deployments.map(d => d.cardId + '@(' + d.x + ',' + d.y + ')').join(', ')}`);
            return deployments.map(d => ({
                cardId: String(d.cardId),
                x:      Number(d.x),
                y:      Number(d.y),
                reason: String(d.reason || ''),
            }));
        }

        // 没有部署指令
        console.log('[LLM] 本次选择不部署, 原始回复:', content.slice(0, 200));
        return null;
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}


// ===================================================================
//  8. 回退策略（LLM 失败时使用）
// ===================================================================

/** 在指定坐标附近随机偏移尝试部署 */
function fallbackDeployNear(cardId, baseX, baseY) {
    const offsets = [
        [0, 0], [30, 0], [-30, 0], [0, 30], [0, -30],
        [50, 0], [-50, 0], [0, 50], [0, -50],
    ];
    for (const [dx, dy] of offsets) {
        const x = Math.min(W - 30, Math.max(30, baseX + dx));
        const y = Math.min(H - 30, Math.max(30, baseY + dy));
        if (canDeployHere(cardId, 'ai', x, y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
            deploy(cardId, 'ai', x, y);
            return true;
        }
    }
    return false;
}

/* ★ fallbackRandomDeploy 已移除：LLM失败只重试不回退本地，完全信任 LLM 决策能力 */


// ===================================================================
//  9. 连接测试（测试 Key + 地址 + 模型是否可用）
// ===================================================================

/**
 * 测试 LLM 连接
 * 发送一个简单对话请求，验证 API Key 和 Endpoint 是否正常
 */
async function testLlmConnection(apiKey, baseUrl, model, proxyUrl) {
    const { url, extraHeaders } = buildRequestConfig('/chat/completions', baseUrl, proxyUrl);
    const key = (apiKey || LLM_CONFIG.apiKey).trim();
    const mdl = (model || LLM_CONFIG.model || 'gpt-4o-mini').trim();

    const displayUrl = proxyUrl ? proxyUrl.replace(/\/+$/, '') + ' → ' + baseUrl.replace(/\/+$/, '') : url.replace(/\/chat\/completions$/, '');
    console.log('[LLM测试] 开始测试连接:', { url: displayUrl, model: mdl });

    if (!key) {
        console.warn('[LLM测试] 未输入 API Key');
        return { success: false, latency: null, error: '未输入 API Key' };
    }

    const startTime = performance.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        console.warn(`[LLM测试] 请求超时，${LLM_CONFIG.timeout/1000}秒无响应`);
        controller.abort();
    }, LLM_CONFIG.timeout);

    try {
        console.log('[LLM测试] 发送请求...');
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
                ...extraHeaders,   // 代理转发时含 Target-Url 头
            },
            body: JSON.stringify({
                model: mdl,
                messages: [
                    { role: 'user', content: '回复"连接成功"四个字即可' },
                ],
                max_tokens: 20,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const latency = Math.round(performance.now() - startTime);
        console.log('[LLM测试] 收到响应:', response.status, response.statusText);

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            console.warn('[LLM测试] HTTP错误:', response.status, errText.slice(0, 200));
            return {
                success: false,
                latency,
                error: `HTTP ${response.status} ${response.statusText}`,
                detail: errText.slice(0, 200),
            };
        }

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || '';
        console.log('[LLM测试] 连接成功，延迟:', latency + 'ms', '回复:', reply.slice(0, 50));
        return { success: true, latency, error: null, reply: reply.slice(0, 50) };
    } catch (err) {
        clearTimeout(timeoutId);
        const latency = Math.round(performance.now() - startTime);
        console.error('[LLM测试] 请求失败:', err.name, err.message);
        if (err.name === 'AbortError') {
            const usedTimeout = LLM_CONFIG.timeout || 30000;
            return { success: false, latency, error: `连接超时（超过${usedTimeout/1000}秒）` };
        }
        // CORS 错误/网络错误时 err.message 通常是 "Failed to fetch"
        let hint = '';
        if (err.message === 'Failed to fetch' || err.message.includes('NetworkError')) {
            hint = ' — 可能是CORS跨域问题，或者API地址不可达。试试在API配置中去掉代理地址（留空）直连。';
        }
        return { success: false, latency, error: (err.message || '连接失败') + hint };
    }
}


// ===================================================================
//  10. 主入口（被 update.js 调用）
// ===================================================================

async function llmAiMakeDecision() {
    if (game.gameOver || game.aiThinking) return;
    if (!LLM_CONFIG.apiKey) return;

    // ★ 每 2.5 秒固定调用，无唤醒拦截逻辑
    game.aiThinking = true;

    try {
        const decisions = await callLlmDecision();
        if (!decisions || !Array.isArray(decisions)) {
            // LLM 选择不部署（攒水等），完全尊重 LLM 的主观判断
            return;
        }

        // 批量部署：循环遍历 LLM 返回的每个动作
        for (const decision of decisions) {
            if (game.gameOver) break;

            // 坐标校验与裁剪
            const x = Math.min(W - 30, Math.max(30, decision.x));
            const y = Math.min(H - 30, Math.max(30, decision.y));

            if (canDeployHere(decision.cardId, 'ai', x, y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                deploy(decision.cardId, 'ai', x, y);
            } else {
                // 坐标不合法 → 就近偏移修正（只修坐标，不改决策）
                fallbackDeployNear(decision.cardId, x, y);
            }
        }
        // ★ 不兜底：LLM选择不出牌/部署失败都尊重，等下次调度
    } catch (err) {
        console.warn('[LLM] 首次调用失败，重试1次:', err.message);
        // 重试1次
        try {
            const retryDecisions = await callLlmDecision();
            if (retryDecisions && Array.isArray(retryDecisions)) {
                for (const decision of retryDecisions) {
                    if (game.gameOver) break;
                    const x = Math.min(W - 30, Math.max(30, decision.x));
                    const y = Math.min(H - 30, Math.max(30, decision.y));
                    if (canDeployHere(decision.cardId, 'ai', x, y, game.entities, game.bastionsLost.ai, game.bastionsLost.player)) {
                        deploy(decision.cardId, 'ai', x, y);
                    } else {
                        fallbackDeployNear(decision.cardId, x, y);
                    }
                }
            }
        } catch (retryErr) {
            console.warn('[LLM] 重试也失败，本轮跳过（不降级本地）:', retryErr.message);
        }
    } finally {
        game.aiDecisionTimer = 0;
        game.aiThinking = false;
    }
}

// ===================================================================
//  初始化：页面加载时恢复上次激活的预设
// ===================================================================
(function initActivePreset() {
    const activeId = localStorage.getItem('towerwar_active_preset_id');
    if (activeId) {
        try {
            const presets = JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) || '[]');
            const active = presets.find(p => String(p.id) === activeId);
            if (active) {
                LLM_CONFIG.apiKey        = (active.apiKey || '').trim();
                LLM_CONFIG.baseUrl       = (active.baseUrl || 'https://api.openai.com/v1').trim();
                LLM_CONFIG.model         = (active.model || 'gpt-4o-mini').trim();
                LLM_CONFIG.proxyUrl      = (active.proxyUrl || '').trim();
                console.log('[LLM] 已恢复预设配置:', active.name);
            }
        } catch (e) { /* ignore */ }
    }
})();
