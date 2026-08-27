/**
 * 🤖 AI 行为组调度器（人机选择）
 *
 * 经典人机（人机全卡 / 人机卡组）的行为由「主页 → 人机选择」指定的组文件指导。
 * 与 LLM「AI对战」(apiAI.js) 完全无关。
 * 选择持久化：localStorage['towerwar_ai_group']，选了不改就一直用。
 *
 * ── 内置组（index.html 静态加载）──
 *   js/ai配置/ai测试组.js   → id: test
 *   js/ai配置/ai哥布林组.js → id: goblin
 *   js/ai配置/aiGEMINI组.js → id: GEMINI
 *
 * ── 自定义组 ──
 *   主页「人机选择」→「➕ 新建组」：下载 aixx.js 模板（内容需自己编写）
 *   → 编写后保存到 js/ai配置/ 目录 → 刷新页面
 *   → 本文件启动时自动动态加载 js/ai配置/aixx.js → 文件内 registerAIGroup() 自注册
 *   → 只要语法没问题即可直接运行，无需改任何其它文件（也不要手动加 script 标签）
 */
const AI_GROUPS = {};

// 内置组（index.html 静态加载的组文件，可能被用户删除 → typeof 防御，缺文件不崩，只是该组不出现在列表）
if (typeof AIGroupTest !== 'undefined') AI_GROUPS.test = { module: AIGroupTest };
if (typeof AIGroupGoblin !== 'undefined') AI_GROUPS.goblin = { module: AIGroupGoblin };
if (typeof AIGroupGEMINI !== 'undefined') AI_GROUPS.GEMINI = { module: AIGroupGEMINI };

// 内置组的文件名映射（「🔄 刷新」按钮据此重新探测：文件被删除 → 识别失败 → 从列表移除）
const AI_BUILTIN_FILES = { test: 'ai测试组.js', goblin: 'ai哥布林组.js', GEMINI: 'aiGEMINI组.js' };
// 内置组全局对象名映射（「🔄 刷新」重新注册时按此查找，避免逐个三元判断）
const AI_BUILTIN_GLOBALS = { test: 'AIGroupTest', goblin: 'AIGroupGoblin', GEMINI: 'AIGroupGEMINI' };

const AI_CUSTOM_GROUPS_KEY = 'towerwar_ai_custom_groups';

/** 注册一个行为组（自定义组文件加载后调用；id 冲突会覆盖，创建时已做查重） */
function registerAIGroup(id, module) {
    AI_GROUPS[id] = { module };
}

/** 读取已创建的自定义组记录 [{id, name, file}] */
function getCustomGroupRecords() {
    try {
        const arr = JSON.parse(localStorage.getItem(AI_CUSTOM_GROUPS_KEY));
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        return [];
    }
}

/** 记录一个新建的自定义组（按 id 去重） */
function addCustomGroupRecord(rec) {
    const list = getCustomGroupRecords();
    if (!list.some(r => r.id === rec.id)) list.push(rec);
    localStorage.setItem(AI_CUSTOM_GROUPS_KEY, JSON.stringify(list));
}

/** 启动时动态加载所有已记录的自定义组文件（js/aixx.js）；加载后由文件内 registerAIGroup 自注册 */
function loadCustomGroupScripts() {
    const seen = {};
    getCustomGroupRecords().forEach(rec => {
        if (seen[rec.file] || AI_GROUPS[rec.id]) return; // 已注册的不重复加载
        seen[rec.file] = true;
        const s = document.createElement('script');
        s.src = 'js/ai配置/' + rec.file + '?v=' + Date.now(); // 带时间戳防缓存
        document.head.appendChild(s);
    });
}
loadCustomGroupScripts();

/** 生成自定义组模板文件内容（aixx.js）——纯字符串，供主页「新建组」下载 */
function buildAiGroupTemplate(name, id, file) {
    return [
        '/**',
        ' * 🤖 AI 行为组：' + name,
        ' * 指导文件：' + file,
        ' *',
        ' * ⚠️ 提示：请自己编写本文件的行为逻辑！',
        ' * 完整范例参考：js/ai配置/ai测试组.js（gatherIntel 侦察 / chooseCard 选牌 / deploy 部署）。',
        ' * 使用步骤：编写 → 保存到 js/ai配置/ 目录 → 刷新页面 → 在「人机选择」中选用。',
        ' * 只要语法没问题即可直接运行，无需修改任何其它文件（也不要手动加 script 标签）。',
        ' */',
        'window.AIGroup' + id + ' = {',
        "    name: '" + name + "',",
        "    file: '" + file + "',",
        '    makeDecision: async function () {',
        '        // TODO: 在这里编写你的 AI 行为逻辑（可参考 js/ai配置/ai测试组.js）',
        '        return;',
        '    },',
        '};',
        '',
        '// 自注册进「人机选择」列表（本文件由 aiSelector.js 动态加载，registerAIGroup 必然存在）',
        "if (typeof registerAIGroup === 'function') registerAIGroup('" + id + "', AIGroup" + id + ');',
        '',
    ].join('\n');
}

/** 当前选中的行为组 id（默认 1测试组） */
function getSelectedAIGroup() {
    return localStorage.getItem('towerwar_ai_group') || 'test';
}

/** 设置当前选中的行为组 id（持久化） */
function setSelectedAIGroup(gid) {
    localStorage.setItem('towerwar_ai_group', gid);
}

/** 经典人机决策入口（update.js 每2秒调用）→ 转发到当前选中的行为组（找不到就回退第一个可用组） */
async function aiMakeDecision() {
    const gid = getSelectedAIGroup();
    const group = AI_GROUPS[gid] || Object.values(AI_GROUPS)[0];
    if (group && group.module && typeof group.module.makeDecision === 'function') {
        return group.module.makeDecision();
    }
}
