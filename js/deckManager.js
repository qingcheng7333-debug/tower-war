/* ===== deckManager.js — 卡组管理系统（localStorage 记忆）===== */

const DECK_STORAGE_KEY = 'towerwar_decks';
const DECK_ACTIVE_KEY  = 'towerwar_active_deck_id';

// ---- 默认卡组（前15张卡）----
const DEFAULT_DECK_CARDS = (() => {
    const all = Object.keys(CARDS);
    return all.slice(0, 15);
})();

// ---- 获取所有卡组（优先级：浏览器本地数据 > 個人データ.js 数据文件 > 空）----
function getDecks() {
    try {
        const raw = localStorage.getItem(DECK_STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    // 无本地数据：尝试从「個人データ.js」（私人数据文件，可删除）导入
    const ud = (typeof TOWERWAR_USERDATA !== 'undefined') ? TOWERWAR_USERDATA : null;
    if (ud && Array.isArray(ud.decks) && ud.decks.length > 0) {
        setDecks(ud.decks); // 导入并持久化到浏览器本地，后续保存照常
        if (ud.activeDeckId != null) {
            try { localStorage.setItem(DECK_ACTIVE_KEY, String(ud.activeDeckId)); } catch (e2) { /* ignore */ }
        }
        return [...ud.decks];
    }
    return [];
}

// ---- 保存所有卡组 ----
function setDecks(decks) {
    localStorage.setItem(DECK_STORAGE_KEY, JSON.stringify(decks));
}

// ---- 获取当前激活的卡组 ID ----
function getActiveDeckId() {
    return localStorage.getItem(DECK_ACTIVE_KEY) || null;
}

// ---- 设置激活的卡组 ID ----
function setActiveDeckId(id) {
    localStorage.setItem(DECK_ACTIVE_KEY, String(id));
}

// ---- 获取当前激活的卡组对象 ----
function getActiveDeck() {
    const decks = getDecks();
    const activeId = getActiveDeckId();
    if (activeId) {
        const found = decks.find(d => String(d.id) === activeId);
        if (found) return found;
    }
    // 兜底返回第一个
    return decks[0] || null;
}

// ---- 获取当前激活卡组的卡牌列表（返回 cardId 数组）----
function getActiveDeckCards() {
    const deck = getActiveDeck();
    return deck ? deck.cards : DEFAULT_DECK_CARDS;
}

// ---- 初始化卡组：若无任何卡组则创建默认卡组 ----
function initDecks() {
    const decks = getDecks();
    if (decks.length === 0) {
        const defaultDeck = {
            id: Date.now(),
            name: '默认卡组',
            cards: [...DEFAULT_DECK_CARDS]
        };
        setDecks([defaultDeck]);
        setActiveDeckId(defaultDeck.id);
    } else if (!getActiveDeckId()) {
        // 有卡组但未设置激活 -> 激活第一个
        setActiveDeckId(decks[0].id);
    }
}

// ---- 添加/更新卡组 ----
function saveDeck(deck) {
    const decks = getDecks();
    if (deck.id) {
        const idx = decks.findIndex(d => d.id === deck.id);
        if (idx >= 0) decks[idx] = deck;
        else { deck.id = Date.now(); decks.push(deck); }
    } else {
        deck.id = Date.now();
        decks.push(deck);
    }
    setDecks(decks);
    return deck;
}

// ---- 删除卡组 ----
function deleteDeck(id) {
    let decks = getDecks();
    decks = decks.filter(d => d.id !== id);
    setDecks(decks);
    // 如果删除的是当前激活卡组，切换到第一个
    if (String(id) === getActiveDeckId()) {
        if (decks.length > 0) setActiveDeckId(decks[0].id);
        else setActiveDeckId(null);
    }
}

// ===================================================================
// 渲染函数
// ===================================================================

/** 渲染卡组管理弹窗列表 */
function renderDeckList() {
    const decks = getDecks();
    const activeId = getActiveDeckId();
    const container = document.getElementById('deckList');

    container.innerHTML = '';
    if (decks.length === 0) {
        container.innerHTML = '<div style="color:#666; text-align:center; padding:30px;">暂无卡组，请点击「新建卡组」</div>';
        return;
    }

    decks.forEach((deck, index) => {
        const item = document.createElement('div');
        item.className = 'deck-item' + (String(deck.id) === activeId ? ' selected' : '');

        const cardCount = deck.cards.length;
        const cardNames = deck.cards.map(id => CARDS[id]?.icon || '?').join(' ');

        item.innerHTML = `
            <div class="deck-info">
                <div class="deck-name">${index + 1}. ${deck.name || '未命名'}</div>
                <div class="deck-meta">
                    <span>📦 ${cardCount}/15 张</span>
                    <span class="deck-preview">${cardNames}</span>
                </div>
            </div>
            <div class="deck-actions">
                <button class="deck-btn use" data-id="${deck.id}">✅ 使用</button>
                <button class="deck-btn" data-id="${deck.id}" data-action="edit">✎ 编辑</button>
                <button class="deck-btn danger" data-id="${deck.id}" data-action="delete">✕</button>
            </div>
        `;

        // 点击整行 = 选中
        item.addEventListener('click', (e) => {
            if (e.target.closest('.deck-actions')) return;
            selectDeck(deck.id);
        });

        // ✅ 使用按钮
        item.querySelector('.deck-btn.use').addEventListener('click', (e) => {
            e.stopPropagation();
            selectDeck(deck.id);
        });

        // ✎ 编辑按钮
        item.querySelector('.deck-btn[data-action="edit"]').addEventListener('click', (e) => {
            e.stopPropagation();
            openDeckEditModal(deck);
        });

        // ✕ 删除按钮
        item.querySelector('.deck-btn.danger').addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`确定删除卡组「${deck.name}」吗？`)) {
                deleteDeck(deck.id);
                renderDeckList();
            }
        });

        container.appendChild(item);
    });
}

/** 选中某个卡组 */
function selectDeck(id) {
    setActiveDeckId(id);
    renderDeckList();
}

// ---- 卡组编辑弹窗状态 ----
let editingDeckId = null;

/** 打开卡组编辑弹窗 */
function openDeckEditModal(deck) {
    editingDeckId = deck ? deck.id : null;
    document.getElementById('deckEditTitle').textContent = deck
        ? `📝 编辑卡组 - ${deck.name}`
        : '📝 新建卡组';

    document.getElementById('deckEditName').value = deck ? deck.name : '';

    const currentCards = deck ? [...deck.cards] : [];
    renderCardSelection(currentCards);

    document.getElementById('deckEditModal').style.display = 'flex';
}

/** 渲染卡牌选择网格 */
function renderCardSelection(selectedIds) {
    const grid = document.getElementById('cardSelectGrid');
    grid.innerHTML = '';

    CARD_IDS.forEach(id => {
        const card = CARDS[id];
        const isSelected = selectedIds.includes(id);
        const cell = document.createElement('div');
        cell.className = 'card-select-cell' + (isSelected ? ' selected' : '');
        cell.dataset.cardId = id;

        cell.innerHTML = `
            <span class="card-select-icon">${card.icon}</span>
            <span class="card-select-name">${card.name}</span>
            <span class="card-select-cost">${card.cost}⚡</span>
            ${isSelected ? '<span class="card-select-check">✓</span>' : ''}
        `;

        cell.addEventListener('click', () => {
            toggleCardSelection(id);
        });

        grid.appendChild(cell);
    });

    updateSelectedCount(selectedIds);
}

/** 切换卡牌选中状态 */
function toggleCardSelection(cardId) {
    const current = getCurrentEditingCards();

    if (current.includes(cardId)) {
        // 取消选中
        const idx = current.indexOf(cardId);
        current.splice(idx, 1);
    } else {
        // 选中（上限15张）
        if (current.length >= 15) {
            alert('最多选择 15 张卡牌！');
            return;
        }
        current.push(cardId);
    }

    renderCardSelection(current);
}

/** 获取当前编辑中的卡牌列表 */
function getCurrentEditingCards() {
    const cells = document.querySelectorAll('.card-select-cell.selected');
    return Array.from(cells).map(el => el.dataset.cardId);
}

/** 更新已选卡牌数量显示 */
function updateSelectedCount(selectedIds) {
    const el = document.getElementById('deckSelectedCount');
    if (el) {
        el.textContent = `${selectedIds.length} / 15`;
        el.style.color = selectedIds.length === 15 ? '#4ade80' : '#facc15';
    }
}

// ===================================================================
// 初始化
// ===================================================================

function setupDeckManager() {
    initDecks();

    // 主页"卡组管理"按钮
    document.getElementById('deckManageBtn').addEventListener('click', () => {
        renderDeckList();
        document.getElementById('deckModal').style.display = 'flex';
    });

    // 关闭卡组管理弹窗
    document.getElementById('closeDeckModalBtn').addEventListener('click', () => {
        document.getElementById('deckModal').style.display = 'none';
    });
    document.getElementById('deckModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });

    // 新建卡组
    document.getElementById('addDeckBtn').addEventListener('click', () => {
        openDeckEditModal(null);
    });

    // 保存卡组编辑
    document.getElementById('saveDeckBtn').addEventListener('click', () => {
        const name = document.getElementById('deckEditName').value.trim();
        if (!name) { alert('请输入卡组名称！'); return; }

        const cards = getCurrentEditingCards();
        if (cards.length === 0) { alert('请至少选择 1 张卡牌！'); return; }

        saveDeck({
            id: editingDeckId,
            name,
            cards
        });

        document.getElementById('deckEditModal').style.display = 'none';
        renderDeckList();
    });

    // 取消编辑
    document.getElementById('cancelDeckEditBtn').addEventListener('click', () => {
        document.getElementById('deckEditModal').style.display = 'none';
    });
    document.getElementById('deckEditModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });
}

// ===================================================================
// 页面加载时自动初始化
// ===================================================================
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupDeckManager);
} else {
    setupDeckManager();
}
