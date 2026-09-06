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
 *  - aiBastionTopX: 敌方(AI)堡垒线 x（可选，默认标准 1200；🧪测试双人传入 MODE_TEST_AI_BASTION_TOP.x=1000，随整图缩窄）
 *  - halfMode: 🌊 河道地图（shrink220）半场制扩展开关（可选，默认 false=上述全高扩展老逻辑；仅河道地图传 true）
 *  - aiTopLost / playerTopLost: halfMode 用——敌方/己方上半堡垒(y<H/2)是否已被爆（由调用方从存活实体实时推断传入，本函数保持纯函数不读写 game）
 *    半场制规则：爆掉敌方哪一半堡垒 → 只开放那一半的[己方河界→敌方堡垒线]扩展矩形（=一半河道+一半河→堡垒线区）；两半全爆=整条开放；己方半场恒全高可部署
 */
function isInHalf(x, y, isPlayer, aiBastionsLost = 0, playerBastionsLost = 0, riverL = RIVER_LEFT, riverR = RIVER_RIGHT, aiBastionTopX = AI_BASTION_TOP.x, halfMode = false, aiTopLost = false, playerTopLost = false) {
    if (x < 30 || x > W - 30 || y < 30 || y > H - 30) return false;

    if (isPlayer) {
        // 🌊 河道地图半场制扩展（shrink220 专属 gate；halfMode=false 走下方全高老逻辑，其他模式零变化）
        if (halfMode) {
            if (x < riverL) return true;                // 己方半场恒全高可部署
            if (x >= aiBastionTopX) return false;       // 不越过敌方堡垒线
            const openTop = aiBastionsLost >= 2 || (aiBastionsLost >= 1 && aiTopLost);
            const openBottom = aiBastionsLost >= 2 || (aiBastionsLost >= 1 && !aiTopLost);
            return y < HALF ? openTop : openBottom;     // 爆哪半堡垒开哪半
        }
        let rightBoundary = riverL;
        if (aiBastionsLost >= 2) rightBoundary = aiBastionTopX;
        else if (aiBastionsLost >= 1) rightBoundary = riverR;

        // 河道仅在边界未扩展过河时保持不可部署
        if (rightBoundary <= riverL && x > riverL && x < riverR) return false;
        return x < rightBoundary;
    } else {
        // 🌊 河道地图半场制扩展（红方对称：己方半场=河右界以右；扩展区=[玩家堡垒线→河右界] 对应半场）
        if (halfMode) {
            if (x > riverR) return true;                 // 己方半场恒全高可部署
            if (x <= PLAYER_BASTION_TOP.x) return false; // 不越过玩家堡垒线
            const openTop = playerBastionsLost >= 2 || (playerBastionsLost >= 1 && playerTopLost);
            const openBottom = playerBastionsLost >= 2 || (playerBastionsLost >= 1 && !playerTopLost);
            return y < HALF ? openTop : openBottom;      // 爆哪半堡垒开哪半
        }
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
 *  - halfMode/aiTopLost/playerTopLost：🌊 河道地图（shrink220）半场制扩展尾参，透传给 isInHalf（默认 false=全高老逻辑）
 *  - 建筑类部署时额外检查：不能与其他已有建筑/堡垒/主塔重叠
 */
function canDeployHere(cardId, team, x, y, entities, aiBastionsLost = 0, playerBastionsLost = 0, riverL = RIVER_LEFT, riverR = RIVER_RIGHT, aiBastionTopX = AI_BASTION_TOP.x, halfMode = false, aiTopLost = false, playerTopLost = false) {
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
    if (!isInHalf(x, y, team === 'player', aiBastionsLost, playerBastionsLost, riverL, riverR, aiBastionTopX, halfMode, aiTopLost, playerTopLost)) return false;

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

/* ---- 🧭 全局导航层纯函数（update.js navFollowPath 专用；utils 纯函数，不碰 game）----
 * 障碍对象统一形状：{key, shape:'circle', x, y, r} 或 {key, shape:'rect', x1, y1, x2, y2}；
 * solid=实体障碍（挡路）、deadly=致命区（同样标阻挡——A* 自动绕河/上桥）。
 * 新增障碍形状（多边形/胶囊等）→ 在 navObstacleHit / navObstacleContains 两个分发处扩展即可 */

/** 点到线段最短距离 */
function pointSegDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let k = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    k = Math.max(0, Math.min(1, k));
    return Math.hypot(px - (ax + dx * k), py - (ay + dy * k));
}

/** 线段与矩形（可外扩 pad）是否相交（slab 法闭式判定；零随机） */
function segIntersectsRect(ax, ay, bx, by, x1, y1, x2, y2) {
    const dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1;
    if (dx === 0) {
        if (ax < x1 || ax > x2) return false;
    } else {
        let ta = (x1 - ax) / dx, tb = (x2 - ax) / dx;
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) return false;
    }
    if (dy === 0) {
        if (ay < y1 || ay > y2) return false;
    } else {
        let ta = (y1 - ay) / dy, tb = (y2 - ay) / dy;
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) return false;
    }
    return true;
}

/** 前瞻命中判定：障碍（外扩 pad）与线段 [a→b] 相交？circle=圆心点线距离；rect=膨胀矩形相交 */
function navObstacleHit(obs, ax, ay, bx, by, pad) {
    if (obs.shape === 'rect') {
        return segIntersectsRect(ax, ay, bx, by, obs.x1 - pad, obs.y1 - pad, obs.x2 + pad, obs.y2 + pad);
    }
    return pointSegDist(obs.x, obs.y, ax, ay, bx, by) < obs.r + pad;  // circle（默认）
}

/** 点包含判定：点（外扩 pad）是否在障碍内？rect 用严格开区间（与 checkRiverDrown 谓词逐点一致，边界不判入） */
function navObstacleContains(obs, px, py, pad) {
    if (obs.shape === 'rect') {
        return px > obs.x1 - pad && px < obs.x2 + pad && py > obs.y1 - pad && py < obs.y2 + pad;
    }
    return Math.hypot(px - obs.x, py - obs.y) < obs.r + pad;  // circle（默认）
}

/* ---- 🧭 寻路纯函数：网格构建 + A* + 视线剪枝（全确定性：遍历序/平局打破固定，Lockstep 安全）---- */

/** 🧭 障碍集→阻挡网格（Uint8Array，1=阻挡）：逐障碍光栅化其包围盒±NAV_GRID_PAD 范围内格子，
 *  格中心落入障碍（navObstacleContains 外扩 NAV_GRID_PAD）即标记——建筑/水域同标，桥段格子自然可走 */
function navBuildGrid(obstacles, gw, gh) {
    const grid = new Uint8Array(gw * gh);
    for (const obs of obstacles) {
        const pad = NAV_GRID_PAD;
        let x1, y1, x2, y2;
        if (obs.shape === 'rect') {
            x1 = obs.x1 - pad; y1 = obs.y1 - pad; x2 = obs.x2 + pad; y2 = obs.y2 + pad;
        } else {
            x1 = obs.x - obs.r - pad; y1 = obs.y - obs.r - pad; x2 = obs.x + obs.r + pad; y2 = obs.y + obs.r + pad;
        }
        const cx1 = Math.max(0, Math.floor(x1 / NAV_GRID_CELL)), cx2 = Math.min(gw - 1, Math.floor(x2 / NAV_GRID_CELL));
        const cy1 = Math.max(0, Math.floor(y1 / NAV_GRID_CELL)), cy2 = Math.min(gh - 1, Math.floor(y2 / NAV_GRID_CELL));
        for (let cy = cy1; cy <= cy2; cy++) {
            for (let cx = cx1; cx <= cx2; cx++) {
                if (grid[cy * gw + cx]) continue;
                const wx = (cx + 0.5) * NAV_GRID_CELL, wy = (cy + 0.5) * NAV_GRID_CELL;   // 格中心判定
                if (navObstacleContains(obs, wx, wy, pad)) grid[cy * gw + cx] = 1;
            }
        }
    }
    return grid;
}

/** 🧭 螺旋找最近可走格（r=0..4 环序固定→确定性；世界坐标→格坐标）：起点贴墙/终点在墙内时投影用 */
function navFreeCell(grid, gw, gh, wx, wy) {
    const cx = Math.min(gw - 1, Math.max(0, Math.floor(wx / NAV_GRID_CELL)));
    const cy = Math.min(gh - 1, Math.max(0, Math.floor(wy / NAV_GRID_CELL)));
    if (!grid[cy * gw + cx]) return { x: cx, y: cy };
    for (let r = 1; r <= 4; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // 只扫当前环
                const nx = cx + dx, ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
                if (!grid[ny * gw + nx]) return { x: nx, y: ny };
            }
        }
    }
    return null;
}

/** 🧭 A* 八方向寻路（禁止对角穿角；octile 启发式；线性开放集+严格小于取最小=平局取先入，确定性）。
 *  返回格心世界坐标点序列（[起点格, ..., 终点格]）；不可达/起终点无法投影 → null */
function navAStar(grid, gw, gh, sx, sy, gx, gy) {
    const s0 = navFreeCell(grid, gw, gh, sx, sy);
    const g0 = navFreeCell(grid, gw, gh, gx, gy);
    if (!s0 || !g0) return null;
    const N = gw * gh;
    const gScore = new Float32Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const open = [];
    const octile = (x, y) => {
        const dx = Math.abs(x - g0.x), dy = Math.abs(y - g0.y);
        return Math.max(dx, dy) + 0.41421356 * Math.min(dx, dy);
    };
    const si = s0.y * gw + s0.x, gi = g0.y * gw + g0.x;
    gScore[si] = 0;
    open.push({ i: si, f: octile(s0.x, s0.y) });
    // 8 方向 [dx, dy, 代价]（顺序固定→扩展序确定）
    const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
    let found = false;
    while (open.length) {
        let bi = 0;
        for (let k = 1; k < open.length; k++) if (open[k].f < open[bi].f) bi = k;   // 严格小于→平局取先入
        const cur = open.splice(bi, 1)[0];
        if (closed[cur.i]) continue;   // 惰性跳过重复入列的旧条目
        closed[cur.i] = 1;
        if (cur.i === gi) { found = true; break; }
        const cx = cur.i % gw, cy = (cur.i / gw) | 0;
        for (const d of DIRS) {
            const nx = cx + d[0], ny = cy + d[1];
            if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
            const ni = ny * gw + nx;
            if (grid[ni]) continue;
            if (d[0] !== 0 && d[1] !== 0) {   // 对角移动：两正交邻格须均可走（防穿墙角）
                if (grid[cy * gw + (cx + d[0])] || grid[(cy + d[1]) * gw + cx]) continue;
            }
            const ng = gScore[cur.i] + d[2];
            if (ng < gScore[ni]) {
                gScore[ni] = ng;
                came[ni] = cur.i;
                open.push({ i: ni, f: ng + octile(nx, ny) });
            }
        }
    }
    if (!found) return null;
    const pts = [];
    let i = gi;
    while (i !== -1) {
        pts.push({ x: (i % gw + 0.5) * NAV_GRID_CELL, y: (((i / gw) | 0) + 0.5) * NAV_GRID_CELL });
        i = came[i];
    }
    pts.reverse();
    return pts;
}

/** 🧭 视线剪枝（string pulling）：能直线到达就跳过中间路径点 → 最少拐点的自然路径。
 *  可视=线段不与任何障碍（外扩 pad）相交；相邻点强制保留（保证推进） */
function navSmoothPath(pts, obstacles, pad) {
    if (!pts || pts.length <= 2) return pts;
    const out = [pts[0]];
    let a = 0;
    while (a < pts.length - 1) {
        let b = pts.length - 1;
        while (b > a + 1) {
            let vis = true;
            for (const obs of obstacles) {
                if (navObstacleHit(obs, pts[a].x, pts[a].y, pts[b].x, pts[b].y, pad)) { vis = false; break; }
            }
            if (vis) break;
            b--;
        }
        out.push(pts[b]);
        a = b;
    }
    return out;
}
