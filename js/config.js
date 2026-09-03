// ---- 地图尺寸 ----
const W_STAND = 1600;            // 标准地图总宽
let W = W_STAND;                 // 当前逻辑地图宽：resetGame 开局按 detect220 切换（仅🧪测试双人变体=1400，其余恒=W_STAND；画布尺寸由 main.js syncCanvasSize 同步）
const H = 700;
const HALF = H / 2;
const BUFFER_HEIGHT = 40;        // 顶部底部不可部署区域高度
const BUFFER_WIDTH = 300;        // 左右不可部署区域宽度
const RIVER_LEFT = 650;          // 河道区域(650~950)河宽300
const RIVER_RIGHT = 950;
// 🧪 测试双人（本机）专属：整图缩窄——河道收窄省出的 200px 直接从地图总宽去掉（1600→1400），不再留在两岸：
// 左岸0~650 / 河650~750（河宽100） / 右岸750~1400；其余模式仍用 RIVER_LEFT/RIVER_RIGHT 与 W_STAND
const MODE_TEST_W = 1400;                            // 🧪 测试双人：地图总宽（resetGame 切给 W）
const MODE_TEST_RIVER_LEFT = RIVER_LEFT;             // =650 左岸不缩
const MODE_TEST_RIVER_RIGHT = RIVER_RIGHT - 200;     // =750 右岸整体左移200（河宽300→100）

// ---- 逻辑帧（Fixed Timestep）：逻辑固定 30Hz tick；渲染 rAF + 插值（见 main.js gameLoop）----
const TICK_RATE = 30;              // 逻辑帧率（次/秒）
const FIXED_DELTA = 1 / TICK_RATE; // 固定逻辑步长（秒）≈ 0.0333
const TICK_INTERVAL_MS = 1000 / TICK_RATE; // 逻辑帧间隔（毫秒，联机同步锚点参考）
const MAX_STEPS_PER_FRAME = 5;     // 单渲染帧最多推进的逻辑步数（防螺旋死亡）
// ---- 联机 INPUT 帧窗口（协议常量统一放在 config.js）----
const NET_INPUT_PAST_TICKS = 2;     // 允许少量网络乱序/处理延迟
const NET_INPUT_FUTURE_TICKS = 600; // 拒绝异常远期帧，避免缓存膨胀
const NET_INPUT_KEEP_TICKS = 120;   // 已确认帧的保留窗口

// ---- 模式专属常量 ----
const MODE_TEST_DETECT_R = 220;    // 🧪 测试双人（本机220）模式：发现锁敌半径——覆盖全图索敌，圈外敌人视而不见（无目标=原地待机，移动保持纯锁敌驱动）
const MODE_TEST_DETECT_R_FLY = 440;  // 🧪 飞行单位（flying 搜索者）索敌半径：空中视野翻倍；地面单位仍用 MODE_TEST_DETECT_R（三处 gate 经 update.js detectR220Of() 统一取值）

// ---- 🧪 测试双人（本机）：行军路线（waypoint 折线，detect220 下索敌圈内无敌时沿路走向敌方主塔）----
// 蓝方(player)视角，红方(ai)反向复用同一条路；路径离堡垒/主塔中心 ≥70px（建筑碰撞半宽28+单位半径15=43），不会被卡住
// 🧪 整图缩窄版：x>800 的 waypoint 全部左移200（过河中点700=窄河中心，右段1065，终点1300=MODE_TEST_AI_TOWER）
const MODE_TEST_ROUTES = {
    up:   [ { x: 100,  y: 350 }, { x: 335, y: 115 }, { x: 700, y: 115 }, { x: 1065, y: 115 }, { x: 1300, y: 350 } ],
    down: [ { x: 100,  y: 350 }, { x: 335, y: 585 }, { x: 700, y: 585 }, { x: 1065, y: 585 }, { x: 1300, y: 350 } ],
};

// ---- 🧪 测试双人（本机）：河道通行（detect220 专属）——地面单位不可泅渡，只能走两座行军桥；空中单位（flying）与无移速单位豁免 ----
const MODE_TEST_BRIDGE_YS = [MODE_TEST_ROUTES.up[2].y, MODE_TEST_ROUTES.down[2].y]; // 两座桥中心线 y（=走廊 waypoint 115/585）
const MODE_TEST_BRIDGE_HALF = 40;   // 桥走廊半宽（比行军走廊 ±30 宽10：桥开口更好走；岸边排斥框在桥开口处豁免、落水豁免、桥面渲染宽度均跟随此值）
const MODE_TEST_RIVER_GUARD = 22;   // 岸边排斥框厚度：河道两侧各 [岸线-22, 岸线+22]，地面单位进框被推回；穿过整条框带=落水
const MODE_TEST_RIVER_PUSH = 150;   // 排斥推力 px/s（向岸；约为普通移速 2.5~5 倍，正常走位推不穿——落水只来自钩拉/击退/挤压等位移）
const MODE_TEST_SPLASH_T = 0.55;    // 水花特效时长（秒）

// 地图布局：左界(0~100) + 主塔x=100 + 堡垒x=400 + 河道(650~950) + 堡垒x=1200 + 主塔x=1500 + 右界(1500~1600)
// 🧪 测试双人布局：左界不变 + 主塔x=100 + 堡垒x=400 + 河(650~750) + 堡垒x=1000 + 主塔x=1300 + 右界(1300~1400)，总宽1400

// ---- 阵营坐标 ----
const PLAYER_TOWER = { x: 100, y: H / 2 };
const AI_TOWER     = { x: 1500, y: H / 2 };
const PLAYER_BASTIONS = [
    { x: 400, y: 185 },
    { x: 400, y: 515 }
];
const AI_BASTIONS = [
    { x: 1200, y: 185 },
    { x: 1200, y: 515 }
];
// 🧪 测试双人（本机）：AI 侧建筑随整图缩窄左移200（玩家侧不缩不动；resetGame 创建 AI 主塔/堡垒时按 detect220 选用）
const MODE_TEST_AI_TOWER = { x: 1300, y: H / 2 };
const MODE_TEST_AI_BASTIONS = [
    { x: 1000, y: 185 },
    { x: 1000, y: 515 }
];
const HALF_CENTER = { x: 800, y: 350 };

// ---- 阵营标识（联机前置：对称阵营，按索引访问；单机时 'ai' 键交给本地 AI 托管）----
const TEAMS = ['player', 'ai'];

// ---- 单位属性模板 ----
const BAT_TEMPLATE = {
    type: 'troop', flying: true, hp: 24, atk: 22, atkSpeed: 1.2,
    moveSpeed: 40, range: 20, targetMode: 'all', icon: '🦇',
    canHitAir: true, // 蝙蝠可对空（近战也可攻击飞行目标，update.js canTargetFlying判定）
    _isSpawned: true, lifetime: 20
};
const WORM_TEMPLATE = {
    type: 'troop', flying: false, hp: 280, atk: 22, atkSpeed: 1.2,
    moveSpeed: 40, range: 20, targetMode: 'buildings', icon: '🐛',
    _isSpawned: true, lifetime: 15
};
const GOBLIN_TEMPLATE = {
    type: 'troop', flying: false, hp: 25, atk: 25, atkSpeed: 1.1,
    moveSpeed: 40, range: 22, targetMode: 'all', name: '骷髅', icon: '☠️',
    _isSpawned: true
};
const STRONG_GOBLIN_TEMPLATE = {
    type: 'troop', flying: false, hp: 460, atk: 68, atkSpeed: 1.1,
    moveSpeed: 34, range: 25, targetMode: 'all', name: '强壮哥布林', icon: '💪',
    _isSpawned: true
};
const GOBLIN_THROWER_TEMPLATE = {
    type: 'troop', flying: false, hp: 60, atk: 18, atkSpeed: 1.6,
    moveSpeed: 40, range: 105, targetMode: 'all', name: '哥布林投矛手', icon: '🔱',
    _isSpawned: true
};
const GOBLIN_MELEE_TEMPLATE = {
    type: 'troop', flying: false, hp: 100, atk: 26, atkSpeed: 1.1,
    moveSpeed: 40, range: 25, targetMode: 'all', name: '哥布林', icon: '🔪',
    _isSpawned: true
};
const BARREL_GUARD_TEMPLATE = {
    type: 'troop', flying: false, hp: 280, shield: 120, atk: 32, atkSpeed: 1.3,
    moveSpeed: 28, range: 25, targetMode: 'all', name: '木桶护卫', icon: '🛡️',
    _isSpawned: true
};
const BARBARIAN_TEMPLATE = {
    type: 'troop', flying: false, hp: 340, atk: 32, atkSpeed: 1.4,
    moveSpeed: 28, range: 25, targetMode: 'all', name: '蛮人', icon: '🪓',
    _isSpawned: true
};
const CRAFTED_WATER_CARRIER_TEMPLATE = {
    type: 'troop', flying: false, hp: 460, atk: 25, atkSpeed: 1.2,
    moveSpeed: 28, range: 25, targetMode: 'buildings', icon: '💧',
    _isSpawned: true
};
const SMALL_WATER_CARRIER_TEMPLATE = {
    type: 'troop', flying: false, hp: 180, atk: 15, atkSpeed: 1.0,
    moveSpeed: 34, range: 25, targetMode: 'buildings', icon: '💧',
    _isSpawned: true
};
const LAVA_PUP_TEMPLATE = {
    type: 'troop', flying: true, hp: 50, atk: 24, atkSpeed: 1.7,
    moveSpeed: 28, range: 75, targetMode: 'all', name: '猎犬幼崽', icon: '🐕',
    canHitAir: true, // 可对空，无攻击偏好
    _isSpawned: true
};
const MAIN_TOWER_GUARD_TEMPLATE = {
    type: 'troop', flying: false, hp: 3000, atk: 45, atkSpeed: 1,
    moveSpeed: 22, range: 135, targetMode: 'all', name: '主塔守卫', icon: '❌',
    canHitAir: true, // 可对空（射程135远程）
    _isSpawned: true   // 召唤物（非卡牌）
};
const PRINCE_REINFORCEMENT_TEMPLATE = {
    type: 'troop', category: 'elite', flying: false, hp: 800, atk: 42, atkSpeed: 1.2,
    moveSpeed: 22, range: 25, targetMode: 'all', name: '王子增援', icon: '⚔️',
    _isSpawned: true   // 召唤物（非卡牌）
};

const WOOD_STAKE_TEMPLATE = {
    type: 'tower', flying: false, hp: 220, atk: 0, atkSpeed: 0,
    range: 0, name: '木桩', icon: '🪵',
    _isSpawned: true   // 召唤物（非卡牌）：建筑型纯站桩阻挡（220血），不攻击不移动
};

// ---- 建筑属性模板 ----
const BASTION_STATS = { hp: 4000, atk: 45, atkSpeed: 0.8, range: 163 };

// ---- 巨龙（巨龙蛋满血孵化后）属性 ----
const DRAGON_STATS = { atk: 135, atkSpeed: 1.2, moveSpeed: 22, range: 75, targetMode: 'all' };

// ---- 卡牌模板 ----
const CARDS = {
    // ==================== 军队 ====================
    swordman: {
        type: 'troop', name: '剑士', cost: 3, hp: 880, atk: 40,
        atkSpeed: 1.2, moveSpeed: 28, range: 25, targetMode: 'all', icon: '⚔️',
        deployDelay: 1.5, cooldown: 6
    },
    strong_barbarian: {
        //  强壮蛮人：6费近战肉盾，一次部署2只、竖着排（纵向一列间距50）
        type: 'troop', name: '强壮蛮人', cost: 6, hp: 620, atk: 82,
        atkSpeed: 1.4, moveSpeed: 28, range: 25, targetMode: 'all', icon: '🪓',
        count: 2, deployDelay: 1.5, cooldown: 10,
        desc: '🪓 6费双蛮人：一次部署2只、竖着排（纵向一列间距50）。近战肉盾：生命580、攻击80、攻速1.4s、移速28'
    },
    archer: {
        type: 'troop', name: '弓箭手', cost: 2, hp: 70, atk: 24,
        atkSpeed: 0.9, moveSpeed: 28, range: 135, targetMode: 'all', icon: '🏹',
        count: 2, deployDelay: 1.0, cooldown: 4.5
    },
    tram_squad: {
        type: 'troop', name: '电车小队', cost: 4, hp: 240, atk: 22,
        atkSpeed: 2.2, moveSpeed: 28, range: 105, targetMode: 'all', icon: '🚃',
        count: 3, deployDelay: 1.0, cooldown: 8,
        desc: '🚃 3辆小电车。远程单体攻击（射程108），命中眩晕0.5秒💫'
    },
    fly_swarm: {
        type: 'troop', name: '苍蝇海', cost: 5, hp: 85, atk: 40,
        atkSpeed: 1.2, moveSpeed: 34, range: 22, targetMode: 'all', icon: '🪰',
        count: 6, deployDelay: 1.0, cooldown: 10,
        flying: true, canHitAir: true, // 空中单位、近战可对空（canTargetFlying 豁免近战限制）
        desc: '🪰 5费群蝇：一次部署6只、部署点周围随机散开。空中单位、近战单体、可对空；生命60、攻击22、攻速1.2s、移速34'
    },
    large_fly: {
        type: 'troop', name: '大苍蝇', cost: 3, hp: 400, atk: 75,
        atkSpeed: 1.5, moveSpeed: 28, range: 22, targetMode: 'all', icon: '🪰',
        flying: true, canHitAir: true, deployDelay: 1.0, cooldown: 7.5,
        desc: '🪰 大苍蝇：单体飞行近战单位，可攻击空中目标。生命400、攻击75、攻速1.5秒、移速28。'
    },
    skeleton_guard: {
        type: 'troop', name: '守卫骷髅', cost: 3, hp: 25, atk: 60,
        atkSpeed: 1.1, moveSpeed: 40, range: 22, targetMode: 'all', icon: '☠️',
        count: 3, deployDelay: 0.5, cooldown: 7.5,
        shield: 120,
        desc: '☠️ 3个骷髅守卫（骷髅+黑色小盔甲）。🛡️蓝色护盾条120：护盾未破前伤害全被吸收（哪怕只剩1点护盾也能完整挡下一次攻击），护盾扣完才扣生命。攻击30，部署快(0.5s)'
    },
    balloon: {
        type: 'troop', name: '气球兵', cost: 5, hp: 760, atk: 260,
        atkSpeed: 2.0, moveSpeed: 28, range: 22, targetMode: 'buildings', icon: '🎈',
        flying: true, deployDelay: 1.5, cooldown: 8,
        desc: '🎈 空中单位：只攻击建筑（锁建筑），近战贴脸轰炸。生命760、攻击111、攻速2s、移速28，可被对空单位攻击；死亡时留下💣，2秒后爆炸（范围同法师塔群攻45px）对周围所有敌方单位造成111伤害'
    },
    firework_gunner: {
        type: 'troop', name: '烟花炮手', cost: 3, hp: 130, atk: 65,
        atkSpeed: 3, moveSpeed: 16, range: 135, targetMode: 'all', icon: '🎆',
        deployDelay: 1.5, cooldown: 6,
        desc: '🎆 发射慢速火箭🚀（直线飞行不追踪，发射时后坐力后退）：碰到敌人即伤害并分裂5个橙色小球扇形向前射出；未命中则飞满射程后在最远点分裂'
    },
    hunter: {
        type: 'troop', name: '猎人', cost: 4, hp: 340, atk: 45,
        atkSpeed: 2.2, moveSpeed: 22, range: 105, targetMode: 'all', icon: '🏹',
        shotCount: 10, spreadAngle: 120, deployDelay: 1.5, cooldown: 7.5,
        desc: '🏹 散射猎手：每次攻击向120°扇形随机散射10发弹药（45×10），直线飞行命中即消散，距离越近命中弹数越多伤害越高，可对空'
    },
    ninja: {
        type: 'troop', name: '忍者', cost: 5, hp: 300, atk: 18,
        atkSpeed: 0.7, moveSpeed: 34, range: 135, targetMode: 'all', icon: '🥷',
        deployDelay: 1.5, cooldown: 8, canHitAir: true,
        desc: '🥷单体追踪飞镖，可对空。敌人进入100px内时主动后退，保持100~110px距离；每两次攻击后立即随机翻滚30px，翻滚期间可受伤。'
    },
    goblin_gang: {
        type: 'troop', name: '骷髅海', cost: 3, spawnUnit: 'goblin',
        count: 15, icon: '☠️', deployDelay: 1.5, cooldown: 7.5
    },
    barbarian: {
        type: 'troop', name: '蛮人', cost: 5, spawnUnit: 'barbarian',
        count: 5, icon: '🪓', deployDelay: 1.5, cooldown: 10,
        desc: '🪓 5费召唤5只蛮人：生命350、攻击32、攻速1.4s、移速28。部署点周围随机分散。'
    },
    goblin_crew: {
        type: 'troop', name: '哥布林团伙', cost: 3, goblin: true,
        count: 6, icon: '👹', deployDelay: 1.0, cooldown: 7,
        desc: '👹 3只哥布林(近战小刀) + 3只哥布林投矛手(远程)：蓝方投矛手在左/哥布林在右，红方镜像'
    },
    goblin_pack: {
        type: 'troop', name: '哥布林', cost: 2, goblin: true,
        count: 4, icon: '👺', deployDelay: 1.0, cooldown: 7,
        desc: '👺 召唤4只近战哥布林（小刀）：低费人海，近战单体'
    },
    barrel_guard: {
        type: 'troop', name: '木桶卫队', cost: 7, count: 6,
        hp: 280, shield: 120, atk: 32, atkSpeed: 1.3,
        moveSpeed: 28, range: 25, targetMode: 'all', icon: '🪵',
        deployDelay: 1.5, cooldown: 14,
        desc: '🪵7费召唤一排6名木桶护卫：生命280、护盾120、移速28、伤害32、攻速1.3秒，近战单体攻击。护卫以骑士为基础，头部为木桶并手持长矛。'
    },

    goblin_blowgun: {
        type: 'troop', name: '哥布林吹箭手', cost: 3, hp: 100, atk: 48,
        atkSpeed: 0.8, moveSpeed: 40, range: 135, targetMode: 'all', goblin: true,
        icon: '🎯', deployDelay: 1.5, cooldown: 6,
        desc: '🎯 哥布林吹箭手：远程吹箭（直线弹道不追踪、命中即结算，可对空）。生命90、攻击48、攻速0.8s、移速40、射程135'
    },
    goblin_bomber: {
        type: 'troop', name: '哥布林爆破手', cost: 4, hp: 600, atk: 35,
        atkSpeed: 1.1, moveSpeed: 28, range: 105, splash: 35, groundOnly: true, goblin: true,
        icon: '🧨', deployDelay: 1.5, cooldown: 8,
        desc: '🧨 迫击炮同款抛物线：锁定落点发射炸药包（不追踪），落地35px群攻（同迫击炮中档，只对地）。生命600、攻击35、攻速1.1s、移速28、射程105。🩸半血狂暴（参考攻城人）：血量≤1/2时移速提升至40、不再攻击、锁定建筑冲过去自爆并留下💣（0.5秒后爆炸，45px范围120伤害）'
    },
    goblin_giant: {
        type: 'troop', name: '哥布林巨人', cost: 6, hp: 1500, atk: 32,
        atkSpeed: 1.5, moveSpeed: 28, range: 25, targetMode: 'buildings', goblin: true,
        icon: '🦍', deployDelay: 1.5, cooldown: 10,
        desc: '🦍 哥布林巨人：只攻击建筑（锁定建筑），近战单体。腰间袋中2名投矛手会攻击周围敌人（16伤/1.6s/105射程/可对空），巨人死亡时2名投矛手蹦出作战。生命1500、攻击32、攻速1.5s、移速28'
    },
    healer: {
        type: 'healer', name: '治疗兵', cost: 3, hp: 220,
        healAmount: 24, healSpeed: 1.2, moveSpeed: 28, range: 75, icon: '💚',
        deployDelay: 1.5, cooldown: 7.5
    },
    giant: {
        type: 'troop', name: '巨人', cost: 8, hp: 3800, atk: 70,
        atkSpeed: 2.0, moveSpeed: 16, range: 25, targetMode: 'buildings', icon: '🛡️',
        deployDelay: 2.5, cooldown: 12,
        deathBoomRadius: 75, deathBoomDmg: 50,
        desc: '🛡️ 肉盾：HP极高、攻击力高，只攻击建筑（同野猪/熔岩猎犬），攻速慢(2.0s)；死亡时爆炸（周围75px内所有敌方单位50伤害）'
    },
    hannibal: {
        type: 'troop', name: '汉尼拔', cost: 7, hp: 2400, atk: 24,
        atkSpeed: 1.2, moveSpeed: 34, range: 25, targetMode: 'all', icon: '🐘',
        deployDelay: 1.5, cooldown: 15,
        gutRadius: 75,        // 吞噬触发范围
        gulpTime: 0.5,        // 拉取停止时间
        gulpPullSpeed: 260,   // 拉取拖拽速度（同渔夫收线）
        digestTick: 0.4,      // 消化间隔
        digestEnemyDmg: 16,   // 每次消化对被吞敌人造成的伤害
        digestSelfDmg: 20,    // 每次消化汉拔尼自身受到的伤害
        digestSpeed: 16,      // 消化中移速
        desc: '🐘 7费重型近战单位：生命2400、攻击24、攻速1.2s。75px内有非建筑敌军→停0.5s拉过来吞掉！消化中：身体×1.2、移速16、只锁建筑、每0.4s敌人-16血且自身-20血（头上蓄力条=敌人血量）；消化完恢复原状；死亡时未消化完的敌人被放出'
    },
    anti_armor_giant: {
        type: 'troop', name: '反甲巨人', cost: 7, hp: 2000, atk: 65,
        atkSpeed: 1.8, moveSpeed: 16, range: 25, targetMode: 'buildings', icon: '🦔',
        deployDelay: 2.0, cooldown: 12,
        thornsRadius: 75, thornsDamage: 35, thornsStun: 0.5,
        desc: '🦔 反甲巨人：生命2000、伤害85、攻速1.8秒、移速22，只攻击建筑。75px反甲范围内，攻击它的单位受到35伤害并眩晕0.5秒。'
    },
    dragon: {
        type: 'troop', name: '飞龙', cost: 4, hp: 580, atk: 36,
        atkSpeed: 1.5, moveSpeed: 34, range: 75, splash: 36, // 范围伤害36，溅射全额不衰减
        flying: true, targetMode: 'all', icon: '🐉', deployDelay: 1.5, cooldown: 7.5
    },
    phoenix: {
        // 🦅 凤凰：4费飞行近战火鸟（可对空）。死亡时烈焰爆发：45px范围80伤害并击退15px（击退仅兵种生效，参考超骑落地击退）
        type: 'troop', name: '凤凰', cost: 4, hp: 520, atk: 44,
        atkSpeed: 1.0, moveSpeed: 28, range: 25, targetMode: 'all', icon: '🔥',
        flying: true, canHitAir: true, // 飞行单位、近战可对空（同大苍蝇）
        deployDelay: 1.5, cooldown: 7.5,
        deathBoomRadius: 45, deathBoomDmg: 80, deathBoomKnockback: 15,
        eggHp: 160, // 🥚 凤凰蛋基础生命：下蛋时随凤凰衰减链同步递减（每次重复下蛋血量 -20%）
        desc: '🔥 4费飞行近战凤凰：生命520、攻击44、攻速1s、移速28，可对空。死亡时烈焰爆发：45px范围内80伤害并击退15px'
    },
    lightning_dragon: {
        type: 'troop', name: '雷龙', cost: 5, hp: 500, atk: 40,
        atkSpeed: 2.0, moveSpeed: 28, range: 75, moveTargetRange: 65, splash: 0,
        flying: true, canHitAir: true, targetMode: 'all', icon: '🐲',
        deployDelay: 1.5, cooldown: 9.0,
        chainRange: 75, chainCount: 2, chainDmgMul: 1.0,
        desc: '🐲 雷龙：蓝色飞行单位，攻击造成40点雷电伤害；以目标为起点向75范围内最多2个额外目标连锁（单次最多命中3个目标），连锁伤害不衰减，可攻击空中单位。'
    },
    inferno_dragon: {
        type: 'troop', name: '地狱飞龙', cost: 4, hp: 640, atk: 5,
        atkSpeed: 0.4, moveSpeed: 28, range: 75, moveTargetRange: 65, splash: 0,
        flying: true, canHitAir: true, targetMode: 'all', icon: '🐲',
        deployDelay: 1.5, cooldown: 7.5,
        infernoRamp: [7, 15, 23, 31, 39],
        desc: '🐲 地狱光束：可索敌空中与地面单位；锁定目标后持续灼烧，基础伤害5，每阶段递增7/15/23/31/39，最高120；目标死亡、脱离射程或隐身后解除锁定，1秒后重新索敌。'
    },
    lava_hound: {
        type: 'troop', name: '熔岩猎犬', cost: 7, hp: 3000, atk: 10,
        atkSpeed: 1.3, moveSpeed: 16, range: 75, targetMode: 'buildings', icon: '🐕',
        flying: true, deployDelay: 1.5, cooldown: 12,
        deathSpawnCount: 6, deathBoomRadius: 75, deathBoomDmg: 50,
        desc: '🐕 飞行坦克：HP极高、攻击力低，只攻击建筑（同巨人/野猪），射程同暗夜女巫(75)；死亡时爆炸（75px内所有敌方单位50伤害）并召唤6只猎犬幼崽'
    },
    night_witch: {
        type: 'troop', name: '暗夜女巫', cost: 4, hp: 440, atk: 43,
        atkSpeed: 1.3, moveSpeed: 22, range: 75, targetMode: 'all', icon: '🧛',
        deployDelay: 1.5, cooldown: 7.5,
        spawnInterval: 5.0, spawnCount: 2, spawnUnit: 'bat', deathSpawnCount: 1
    },
    witch: {
        type: 'troop', name: '女巫', cost: 5, hp: 420, atk: 25,
        atkSpeed: 1.1, moveSpeed: 22, range: 135, splash: 25, // 范围伤害32
        targetMode: 'all', canHitAir: true, icon: '🧙‍♀️',
        deployDelay: 1.5, cooldown: 7.5,
        spawnInterval: 7.0, spawnCount: 4, spawnUnit: 'skeleton', // 召唤物：骷髅（SUMMON_CREATORS 映射，spread 圆散）
        desc: '🧙‍♀️ 群伤远程：溅射25px、范围伤害32、可对空，射程同弓箭手(135)；每7秒召唤4只骷髅'
    },
    ice_mage: {
        type: 'troop', name: '寒冰法师', cost: 3, hp: 340, atk: 18,
        atkSpeed: 1.7, moveSpeed: 28, range: 105, targetMode: 'all', icon: '❄️',
        canHitAir: true, splash: 25,
        deployDelay: 1.5, cooldown: 7.5,
        deploySpell: { radius: 40, damage: 20 },
        desc: '❄️ 蓝灰寒冰法师：部署落地时对40px范围造成20伤害并产生冰雪冲击；发射带寒气的冰锥直线弹道，碰到敌人后爆裂；主目标18伤害，25px范围内其他目标受到60%溅射伤害，可对空；命中后减速与降低攻击力60%，持续2.5秒'
    },
    fire_mage: {
        type: 'troop', name: '火法师', cost: 5, hp: 375, atk: 60,
        atkSpeed: 1.4, moveSpeed: 28, range: 135, moveTargetRange: 105, targetMode: 'all', icon: '🔥',
        canHitAir: true, splash: 35,
        deployDelay: 1.5, cooldown: 7.5,
        desc: '🔥 红灰火法师：攻击索敌135、移动索敌105（飞斧胖虎同款索敌分离，边走边打）；发射火球直线弹道，命中爆裂或飞到135终点爆裂；35px范围内所有目标受到全额60伤害（无衰减、不分主次），可对空'
    },
    lightning_wizard: {
        type: 'troop', name: '雷电法师', cost: 4, hp: 320, atk: 55,
        atkSpeed: 1.6, moveSpeed: 28, range: 105, targetMode: 'all', icon: '⚡',
        deployDelay: 0.5, cooldown: 7.5,
        chainRange: 90, chainCount: 2, chainDmgMul: 0.8,
        deploySpell: { radius: 38, damage: 50, length: 150, stunDuration: 1.0 }
    },
    immunity_disciple: {
        type: 'troop', name: '免伤法徒', cost: 4, hp: 400, atk: 15,
        atkSpeed: 2.5, moveSpeed: 22, range: 105, targetMode: 'all', icon: '✨',
        flying: true, deployDelay: 1.5, cooldown: 12,
        desc: '✨飞行单位，白色柔和光环每1秒给射程内友军🛡️减伤30%持续1秒（与巨人半血减伤独立共存）'
    },
    battle_angel: {
        type: 'troop', name: '战斗天使', cost: 4, hp: 900, atk: 20,
        atkSpeed: 2.0, moveSpeed: 28, range: 25, targetMode: 'all', icon: '👼',
        flying: true, deployDelay: 1.0, cooldown: 12,
        healRadius: 75, healTicks: 4, healInterval: 0.3, healDuration: 1.2, // 治疗范围同暗夜女巫射程(75px)
        attackHeal: 10, deployHeal: 20, // 攻击/登场触发持续治疗：1.2秒内每0.3秒一次共4次
        desc: '👼飞行近战(不对空)，治疗范围同暗夜女巫射程(75px)，仅治疗持续时显示绿色光环。每次攻击触发1.2s持续治疗(每0.3s治疗10)；登场触发1.2s持续治疗(每0.3s治疗20)'
    },
    barbarian_battering_ram: {
        type: 'troop', name: '蛮人攻城槌', cost: 4, hp: 480, atk: 140,
        atkSpeed: 1.0, moveSpeed: 28, range: 25, targetMode: 'buildings',
        count: 1, icon: '🪵',
        chargeTime: 4.0, chargeSpeedMul: 2.0, chargeAtkMul: 3.0,
        deployDelay: 1.5, cooldown: 10,
        desc: '单个兵种实体，由两名蛮人共同扛着铁尖木槌；只攻击建筑，部署4秒后进入冲锋，移速200%、攻击力300%；攻击建筑后死亡，并原地召唤两名蛮人继续作战'
    },
    siege_man: {
        type: 'troop', name: '攻城人', cost: 2, hp: 140, atk: 60,
        atkSpeed: 1.0, moveSpeed: 40, range: 10, targetMode: 'buildings',
        count: 2, icon: '💣',
        deployDelay: 1.0, cooldown: 12.5,
        desc: '一次部署2只，移速极快，冲向最近建筑。触碰建筑或死亡时留下💣，0.5秒后爆炸对周围所有敌方单位造成60伤害（对建筑3倍180，含主塔/堡垒），爆炸范围45px'
    },
    hog: {
        type: 'troop', name: '野猪', cost: 4, hp: 800, atk: 135,
        atkSpeed: 1.6, moveSpeed: 40, range: 25, targetMode: 'buildings', icon: '🐗',
        deployDelay: 1.5, cooldown: 10,
        desc: '🐗 快速突击，只攻击建筑'
    },
    ranger: {
        type: 'troop', name: '游侠', cost: 4, hp: 260, atk: 38,
        atkSpeed: 1.2, moveSpeed: 28, range: 135, targetMode: 'all', icon: '🏹',
        deployDelay: 1.5, cooldown: 12,
        pierce: true, arrowRange: 220,
        desc: '发射穿透箭，对路径上所有敌人造成伤害，箭矢飞行距离220px'
    },
    ice_bean: {
        type: 'troop', name: '冰豆', cost: 1, hp: 1, atk: 0,
        atkSpeed: 0, moveSpeed: 0, range: 0, targetMode: 'all', icon: '🧊',
        deployDelay: 0.5, cooldown: 0.5,
        desc: '放置后不能移动，被攻击后会让攻击者减速80%持续1.5秒。被触碰或死亡时自爆，45px范围造成25伤害并减速敌人80%持续1.5秒'
    },
    fire_bean: {
        type: 'troop', name: '火豆', cost: 1, hp: 50, atk: 0,
        atkSpeed: 0, moveSpeed: 34, range: 35, targetMode: 'all', icon: '🔥',
        deployDelay: 0.5, cooldown: 6,
        desc: '🔥跳跃自爆单位。敌人进入90px范围时抛物线跳过去（真实弧线飞行）以敌人为中心自爆，35px范围造成10伤害+🔥灼烧3秒(20/秒)，总伤害70。HP50移速34'
    },
    ghost: {
        type: 'troop', name: '幽灵', cost: 3, hp: 580, atk: 40,
        atkSpeed: 1.0, moveSpeed: 34, range: 25, splash: 25, targetMode: 'all', icon: '👻', // 群攻范围25同超骑
        deployDelay: 1.0, cooldown: 6,
        desc: '隐身状态不会被敌方锁定。攻击后现身，3秒未攻击自动恢复隐身'
    },
    miner: {
        type: 'troop', name: '矿工', cost: 3, hp: 650, atk: 36,
        atkSpeed: 1.3, moveSpeed: 28, range: 25, targetMode: 'all', icon: '⛏️',
        deployDelay: 0.5, cooldown: 6, digTime: 0.6, tunnelTime: 2, towerDmgMul: 1 / 3, anywhere: true,
        desc: '⛏️可部署于任意位置（不受半场限制，直达敌后）。部署延迟0.5秒，土堆从己方主塔挖地道潜行2秒抵达部署点，再潜伏钻出0.6秒（不被锁定，AOE仍可波及）后破土而出。单体近战，对主塔/堡垒（防御工事）伤害1/3'
    },
    shadow_assassin: {
        type: 'troop', name: '暗影刺客', cost: 3, hp: 350, atk: 60,
        atkSpeed: 1.0, moveSpeed: 28, range: 25, targetMode: 'all', icon: '🥷',
        deployDelay: 1.0, cooldown: 6,
        desc: '🥷距离锁定敌人115~135px时进入突袭：短暂隐身+蓄力1秒冲刺，造成双倍伤害(120)，只对地'
    },
    knight: {
        type: 'troop', name: '骑士', cost: 5, hp: 1200, atk: 78,
        atkSpeed: 1.4, moveSpeed: 28, range: 30, targetMode: 'all', icon: '🐴',
        deployDelay: 1.5, cooldown: 10,
        desc: '🐴冲锋移速300%+🗡️伤害400%+单体攻击'
    },
    ronin: {
        type: 'troop', name: '浪人', cost: 5, hp: 820, atk: 60,
        atkSpeed: 1.4, moveSpeed: 28, range: 25, targetMode: 'all', icon: '🚫',
        deployDelay: 1.5, cooldown: 8,
        reflectCooldown: 3.5,   // 反弹冷却（秒）
        reflectMultiplier: 2,   // 反弹倍率 200%
        desc: '🚫流浪武士，单体近战；被近战攻击完全格挡并200%反弹伤害（3.5秒冷却，远程弹道不触发）'
    },
    super_knight: {
        type: 'troop', name: '超级骑士', cost: 7, hp: 2000, atk: 50,
        atkSpeed: 1.2, moveSpeed: 22, range: 30, splash: 25, targetMode: 'all', icon: '\u{1F978}', // 普攻溅射低档25（跃击40特殊不动）
        deployDelay: 1.5, cooldown: 20,
        desc: '近战群攻，部署落地与跃击落地均造成140范围伤害并击退敌人；可蓄力1.5秒抛物线跳跃至中距离敌人（真实弧线飞行）',
        deploySpell: { radius: 40, damage: 140, knockback: 15 },
        leapRange: 105
    },
    wizard: {
        type: 'troop', name: '巫师', cost: 4, hp: 280, atk: 30,
        atkSpeed: 1.0, moveSpeed: 22, range: 105, targetMode: 'all', icon: '🧙',
        deployDelay: 1.5, cooldown: 12,
        desc: '远程单体魔法攻击，🫧气泡给敌人上🐛标记，死亡后召唤小虫'
    },
    dragon_egg: {
        type: 'troop', name: '巨龙蛋', cost: 7, hp: 2600, atk: 0,
        atkSpeed: 0, moveSpeed: 0, range: 0, targetMode: 'all', icon: '🥚',
        deployDelay: 2.0, cooldown: 25,
        healRate: 20,
        desc: '出场只有1/4血量(650)，❤️‍🩹每秒自动回复20血，可被治疗兵加速治疗，满血后孵化成🐉巨龙（飞行单位，单体伤害）'
    },
    electro_cannon: {
        type: 'troop', name: '电磁炮', cost: 6, hp: 630, atk: 570,
        atkSpeed: 0, moveSpeed: 16, range: 135, targetMode: 'all', icon: '🔫',
        groundOnly: true, deployDelay: 1.5, cooldown: 10,
        chargeTime: 5.0,
        desc: '蓄能5秒后发射一发超高伤害电磁炮，单体'
    },
    cannon_cart: {
        type: 'troop', name: '炮车', cost: 5, hp: 450, atk: 85,
        atkSpeed: 1.7, moveSpeed: 22, range: 135, targetMode: 'all', icon: '🚛',
        groundOnly: true, deployDelay: 1.5, cooldown: 8,
        desc: '🚛 只对地远程炮车（射程同电磁炮135）。被打爆后原地变形成🛡️炮台建筑：底座变正方形、回满血=第二条命、射程保持135不变、每秒自流血12'
    },
    mini_pekka: {
        type: 'troop', name: '小皮卡', cost: 4, hp: 600, atk: 240,
        atkSpeed: 2.2, moveSpeed: 22, range: 25, targetMode: 'all', icon: '⚔️',
        deployDelay: 1.0, cooldown: 6,
        desc: '近战单体，超高攻击力，低攻速，一击致命'
    },
    big_pekka: {
        type: 'troop', name: '大皮卡', cost: 7, hp: 1800, atk: 225,
        atkSpeed: 2.0, moveSpeed: 16, range: 25, targetMode: 'all', icon: '🗡️',
        deployDelay: 1.5, cooldown: 12,
        desc: '近战单体，超高攻击力一击致命，皮糙肉厚，只对地（近战天然不对空）'
    },
    water_carrier: {
        type: 'troop', name: '大送水人', cost: 3, hp: 1000, atk: 35,
        atkSpeed: 1.5, moveSpeed: 22, range: 25, targetMode: 'buildings', icon: '💧',
        deployDelay: 1.5, cooldown: 6, deathSpawnCount: 2,
        desc: '💧粉粉送水工，只攻击建筑。大圆身体+两个小圆水桶，大小同巨人。死亡分裂出2个送水人'
    },
    small_ice_man: {
        type: 'troop', name: '小冰人', cost: 2, hp: 650, atk: 18,
        atkSpeed: 2.5, moveSpeed: 16, range: 25, targetMode: 'buildings', icon: '🧊',
        deployDelay: 1.0, cooldown: 8,
        desc: '🧊 雪白小冰人，只攻击建筑。送水人同款圆身建模（雪白配色、无角），皮糙肉厚攻速慢；死亡时冰爆：45px范围18伤害+减速80%持续1.5秒'
    },
    fisherman: {
        type: 'troop', name: '渔夫', cost: 3, hp: 440, atk: 42,
        atkSpeed: 1.3, moveSpeed: 16, range: 25, targetMode: 'all', icon: '🎣',
        groundOnly: true, deployDelay: 1.0, cooldown: 6,
        hookMin: 90, hookMax: 200, hookCharge: 1.2, hookLineSpeed: 700, hookPullSpeed: 260,
        desc: '🎣戴斗笠的渔夫，对地单体近战。距离90~200px锁定目标蓄力1.2秒甩出棕色鱼线：兵种被勾到面前，建筑则把自己拉过去'
    },
    princess: {
        type: 'troop', name: '公主', cost: 3, hp: 110, atk: 60,
        atkSpeed: 3, moveSpeed: 16, range: 165, cooldown: 10,
        splash: 45, // 群箭落地范围伤害45px（公主自身档位）
        icon: '👸',
        desc: '👸 3费远程群攻：生命70、攻击30、攻速3s、移速16、射程165、冷却10s。巡敌迫击炮模式：锁定目标当前位置发射5支群箭（不追踪），落地范围伤害45px（可波及空中），落地效果同剑雨'
    },

    fat_tiger: {
        type: 'troop', name: '飞斧胖虎', cost: 5, hp: 640, atk: 38,
        atkSpeed: 2.4, moveSpeed: 28, range: 135, moveTargetRange: 105, targetMode: 'all', icon: '🪓',
        deployDelay: 1.5, cooldown: 10,
        desc: '🪓 5费远程单体：生命640、攻击35、攻速2.4s、移速28、攻击索敌135、移动索敌105（可对空）。黑蓝配色胖虎，抡起飞斧远程砍人'
    },

    unicorn: {
        type: 'troop', name: '独角兽', cost: 5, hp: 1600, atk: 44,
        atkSpeed: 1.0, moveSpeed: 34, range: 105, targetMode: 'all', icon: '🦄',
        deployDelay: 1.0, cooldown: 10,
        groundOnly: true,  // 🐎 不攻击飞行单位（索敌排除空中，冲刺沿途也不结算飞行）
        healRate: 20,   // ❤️‍🩹 每秒自回20（仅沉睡期生效，苏醒即移除；走 _hasRegen 通用buff模块）
        // ⚡ 蓄力冲刺（参考超骑蓄力+护驾冲锋）：105内出现敌人→蓄力0.8s（开始瞬间锁定方向，之后敌人死活/隐身/跑出射程均不影响）→朝锁定方向直线冲刺135px（不转弯）
        dashCharge: 0.8,      // 蓄力时长（秒）
        dashDistance: 135,    // 冲刺距离（px，直线不转弯；可超出105索敌范围）
        dashSpeedMul: 8,      // 冲刺速度=移速×8（参考护驾冲锋）
        dashHitRadius: 40,    // 沿途碰撞判定半径（参考护驾冲锋）
        dashKnockback: 20,    // 沿途敌人击退（px）
        dashRecoil: 30,       // 撞建筑反作用：独角兽自身被弹回（px）
        dashBuildingMul: 4,   // 撞建筑伤害倍率（44×4=176）；自身眩晕1s+击退，冲锋终止
        desc: '🦄 5费对地单体：生命1600、冲锋伤害44、移速34、触程105。出场沉睡（半血800）：头顶飘💤、每秒自动回复20血（可被治疗兵加速），满血后苏醒（参考巨龙蛋机制），苏醒后移除自回。苏醒后105内出现敌人→蓄力0.8s（开始瞬间锁定方向，敌人死活/隐身/跑出射程均不影响）→直线冲刺135px（不转弯）：沿途敌人受44伤害+击退20px；撞到建筑造成4倍伤害(176)，独角兽自己被眩晕1秒并沿冲刺反方向弹回30px，冲锋终止'
    },

    // ==================== 精锐 ====================
    hades: {
        type: 'troop', category: 'elite', name: '冥王', cost: 6, hp: 350, atk: 25,
        atkSpeed: 1.2, moveSpeed: 16, range: 30, targetMode: 'all', icon: '💀',
        deployDelay: 1.5, cooldown: 30,
        // ☠️ 精英主动技能：部署后卡牌变为「召唤」（1费，释放后进入40秒冷却，冷却结束可再次释放）；冥王死亡后卡牌才恢复可部署并开始死亡冷却
        activeSkill: {
            id: 'hades_summon', name: '召唤', icon: '☠️', cost: 1, cooldown: 40,
            desc: '召唤：根据冥王当前等级，在周围召唤对应数量+2的骷髅（最少3个、最多12个），释放后进入40秒冷却，冷却结束可再次释放'
        },
        desc: '💀群体攻击——攻击范围内所有敌人全额伤害，每7个灵魂升1级(共10级)。☠️主动技能·召唤（1费）：根据当前等级在周围召唤对应数量+2的骷髅（最少3个、最多12个），冷却40秒'
    },
    sword_immortal: {
        type: 'troop', category: 'elite', name: '剑仙', cost: 6, hp: 780, atk: 75,
        atkSpeed: 1.1, moveSpeed: 22, range: 35, targetMode: 'all', icon: '🗡️',
        deployDelay: 1.5, cooldown: 35,  // 死亡冷却：15→35秒
        // 🕊️ 精英主动技能：部署后卡牌变为「御剑」（2费，释放后进入35秒冷却，冷却结束可再次释放）；剑仙死亡后卡牌才恢复可部署并开始死亡冷却
        activeSkill: {
            id: 'sword_ride', name: '御剑', icon: '✨', cost: 2, duration: 10, cooldown: 35,
            desc: '御剑升空：剑飞到脚下、脚下新增阴影，变为空中单位（地面单位无法攻击它），移速提升至40，持续10秒后自动落回地面；御剑期间飞剑变金色：命中敌人后自动朝最近的敌人改向飞去（最多转弯4次、伤害逐次衰减），结束后恢复普通。释放后进入35秒冷却'
        },
        desc: '🗡️ 6费精锐近战单体：生命850、攻击75、攻速1.1s、移速22。🗡️飞剑：每9.5秒生成1把（最多3把）绕身旋转，200内有敌直线射出，命中150伤，未命中飞出场外。🕊️御剑期间飞剑变金色：命中敌人后朝最近的敌人改向飞去（最多转弯4次；伤害逐次衰减40%、最低伤害2后不再衰减），御剑结束恢复普通。🕊️主动技能·御剑（2费）：部署后卡牌变为「御剑」，变为空中单位，御剑期间大剑变金色、普攻提升至80、移速提升至40（持续10秒后自动落回地面并还原）；御剑释放后进入35秒冷却，冷却结束可再次释放；剑仙死亡后卡牌恢复可部署并开始35秒死亡冷却'
    },
    yomi: {
        type: 'troop', category: 'elite', name: '黄泉', cost: 7, hp: 900, atk: 48,
        atkSpeed: 1.1, moveSpeed: 28, range: 35, moveTargetRange: 30, targetMode: 'all', icon: '🌑',
        // 🎯 索敌分离（参考火法师）：移动索敌30 = 攻击索敌35 - 5（靠近到30px站桩，35px内边走边打不贴脸）
        deployDelay: 1.5, cooldown: 35,  // 死亡冷却（暂定35秒同剑仙，可调）
        hpPctDmg: 0.22,  // 🌑 普攻附加目标当前生命值14%伤害（随目标血量动态变化）
        // 🌀 精英主动技能（占位）：部署后卡牌变为「界域」（3费）；效果待定，暂无实际作用
        activeSkill: {
            id: 'yomi_realm', name: '界域', icon: '🌀', cost: 3, cooldown: 30,
            desc: '界域（3费·30s冷却）：施法0.6s后展开105范围界域、持续7s；界域内除黄泉外所有单位（敌我）冰冻+隐身（所有索敌不可见，AOE/溅射仍可波及），黄泉无视隐身、索敌仅限界域内、伤害=5+敌人最大生命值33%、刀变纯红；黄泉阵亡则界域消散'
        },
        desc: '🌑 7费精锐近战单体：生命900、攻击48+目标当前生命值22%、攻速1.1s、移速28、近战范围35（同剑仙）。🌀主动技能·界域（3费·占位待定）'
    },
    little_prince: {
        type: 'troop', category: 'elite', name: '小王子', cost: 3, hp: 340, atk: 22,
        atkSpeed: 1.2, moveSpeed: 22, range: 135, targetMode: 'all', icon: '🤴',
        deployDelay: 1.5, cooldown: 28,  // 死亡冷却（暂定28秒，可调）
        // 👑 精英主动技能：部署后卡牌变为「护驾」（3费·单次技能）；释放后卡牌变黑（singleUse → used），小王子死亡后卡牌才恢复可部署并开始死亡冷却
        activeSkill: {
            id: 'prince_guard', name: '护驾', icon: '🛡️', cost: 3, singleUse: true,
            desc: '护驾：单次技能，释放1秒后在小王子前方召唤王子增援，增援快速冲锋105距离，对沿途敌人造成50伤害并击退；释放后卡牌变黑，小王子阵亡后卡牌恢复可部署并开始15秒死亡冷却'
        },
        desc: '👑 3费精锐远程单体：生命340、攻击20、攻速1.2s、移速22、射程135、单体攻击。🛡️主动技能·护驾（3费·单次）：部署后卡牌变为「护驾」，释放1秒后在小王子前方召唤王子增援，增援快速冲锋105距离，沿途敌人受50伤害并击退；释放后卡牌变黑（单次技能），小王子死亡后卡牌恢复可部署并开始15秒死亡冷却'
    },
    berserker: {
        type: 'troop', category: 'elite', name: '狂战士', cost: 2, hp: 380, atk: 25,
        atkSpeed: 0.6, moveSpeed: 34, range: 25, targetMode: 'all', icon: '🔪',
        deployDelay: 1.5, cooldown: 20,  // 死亡冷却（暂定20秒，可调）
        // 🗡️ 精英主动技能：部署后卡牌变为「爆发」（3费，释放后进入40秒冷却，冷却结束可再次释放）；狂战士死亡后卡牌才恢复可部署并开始死亡冷却
        activeSkill: {
            id: 'berserk_burst', name: '爆发', icon: '💥', cost: 3, cooldown: 20,
            desc: '爆发：释放后进入20秒冷却。持续6秒：攻速0.2s、伤害30、移速40，且锁血最低1（不会死亡）'
        },
        desc: '🗡️ 2费精锐近战单体：生命380、攻击25、攻速0.6s、移速34。💥主动技能·爆发（3费）：释放后进入20秒冷却，冷却结束可再次释放'
    },
    jessie: {
        type: 'troop', category: 'elite', name: '杰西', cost: 4, hp: 300, atk: 36,
        atkSpeed: 1.4, moveSpeed: 22, range: 135, targetMode: 'all', icon: '🔫',
        deployDelay: 1.5, cooldown: 25,  // 死亡冷却（暂定25秒，可调）
        // 🔫 精英主动技能：部署后卡牌变为「后撤」（2费，暂占位；效果待定，冷却暂定30秒）
        activeSkill: {
            id: 'jessie_retreat', name: '后撤', icon: '↩️', cost: 2, cooldown: 30,
            desc: '后撤：杰西立即向后方冲刺105px，并延迟0.3s在原地部署一根木桩（建筑·220血，每秒自流血10）阻挡敌人；后撤后4秒内电磁弹变为亮金色：飞行距离提升至500、命中附带眩晕1秒💫'
        },
        desc: '🔫 4费精锐远程单体：生命300、攻击36、攻速1.4s、移速22、射程135（可对空）。电磁枪发射连锁电磁团：命中后拐向下一个敌人（可回弹），伤害逐次-4（36→32→28→24→20→16→12→8→4），保底4，总射程250。↩️主动技能·后撤（2费）：立即后撤105px并延迟0.3s在原地部署木桩（建筑·220血，每秒自流血10）阻挡敌人，冷却30秒；后撤后4秒内电磁弹变亮金色（飞行距离500、命中眩晕1秒💫）'
    },
    monk: {
        type: 'troop', category: 'elite', name: '武僧', cost: 5, hp: 1100, atk: 30,
        atkSpeed: 0.8, moveSpeed: 28, range: 25, targetMode: 'all', icon: '🥋',
        deployDelay: 1.5, cooldown: 30,  // 死亡冷却（暂定30秒，可调）
        // 🧘 精英主动技能：部署后卡牌变为「超脱」（1费）：止步诵念0.6s（手移到嘴边）→ 全身冒青色光晕5s，减伤70%且不移动不攻击
        activeSkill: {
            id: 'monk_transcend', name: '超脱', icon: '🧘', cost: 1, cooldown: 30,
            desc: '超脱：释放后武僧止步诵念0.6秒（手移到嘴边），随后全身冒起青色光晕持续5秒，期间减伤70%，且一直不移动不攻击'
        },
        desc: '🥋 5费精锐近战单体：生命1100、攻击30、攻速0.8s、移速28。💪三连击：每第3次强化普攻造成90伤害并击退敌人25px。🧘主动技能·超脱（1费）：止步诵念0.6秒后全身冒青色光晕5秒，期间减伤70%且不移动不攻击'
    },
    bow_queen: {
        type: 'troop', category: 'elite', name: '弓箭女皇', cost: 5, hp: 500, atk: 50,
        atkSpeed: 1.2, moveSpeed: 28, range: 135, targetMode: 'all', icon: '🏹',
        deployDelay: 1.5, cooldown: 25,  // 卡牌死亡冷却25s
        // 🌫️ 精英主动技能：部署后卡牌变为「隐身」（1费，释放后进入40秒冷却，冷却结束可再次释放）；弓箭女皇死亡后卡牌才恢复可部署并开始死亡冷却
        activeSkill: {
            id: 'stealth', name: '隐身', icon: '🌫️', cost: 1, cooldown: 40,
            desc: '隐身：释放后0.5秒进入隐身（不可被锁定），攻击力提升200%，持续3.6秒；释放后进入40秒冷却，冷却结束可再次释放'
        },
        desc: '🏹 5费精英远程单体：生命500、攻击50、攻速1.2s、移速28、射程135。🌫️主动技能·隐身（1费）：释放后0.5秒进入隐身（不可被锁定），攻击力提升200%，持续3.6秒；40秒冷却'
    },

    // 🛕 哥布林神庙：精英·建筑（石底木碑+叶耳造型），1费低费圣所；
    //   主动技能「神赐」（11费）：神庙在场时每用1张哥布林卡费用-1（最低1费），释放后恢复11费；
    //   释放哥布林卡时部署位置浮现👺虚影0.5秒提示「已被神庙接收」（与部署延迟时间环同时出现）
    goblin_temple: {
        type: 'tower', category: 'elite', name: '哥布林神庙', cost: 1, hp: 150, atk: 0,
        atkSpeed: 0, range: 0, splash: 0, icon: '🛕',
        deployDelay: 2.5, cooldown: 5,
        activeSkill: {
            id: 'goblin_bless', name: '神赐', icon: '🌟', cost: 11, cooldown: 5,
            desc: '神赐（基础11费）：神庙在场时每使用1张哥布林卡牌费用-1（最低1费），释放后恢复11费，并在神庙附近召唤哥布林援军——1/3概率召唤3只哥布林投矛手，2/3概率召唤哥布林巨人；技能冷却5秒｜神庙死亡后5秒冷却，每方最多同时存在1座'
        },
        desc: '🛕 1费精英·建筑：🌟主动技能·神赐（基础11费）：神庙在场时每使用1张哥布林卡牌费用-1（最低1费），释放后恢复11费，并在神庙附近召唤哥布林援军——1/3概率召唤3只哥布林投矛手，2/3概率召唤哥布林巨人；释放哥布林卡时部署位置浮现👺虚影0.5秒提示已被神庙接收；技能冷却5秒；神庙死亡后卡牌恢复可部署并开始5秒死亡冷却'
    },

    // ==================== 建筑 ====================
    cannon_tower: {
        type: 'tower', name: '炮塔', cost: 4, hp: 450, atk: 100,
        atkSpeed: 2.6, range: 155, splash: 0, onlyGround: true, icon: '🏰',
        deployDelay: 2.5, cooldown: 9
    },
    mortar: {
        type: 'tower', name: '迫击炮', cost: 5, hp: 580, atk: 66,
        atkSpeed: 5, range: 185, minRange: 75, splash: 35, onlyGround: true, icon: '🪨', // 范围伤害中档35
        deployDelay: 2.5, cooldown: 20,
        desc: '🪨 抛物线投石锁定落点轰炸：66范围伤害+击退18px；75px内近身打不到'
    },
    crossbow: {
        type: 'tower', name: '十字弩', cost: 7, hp: 1200, atk: 10,
        atkSpeed: 0.3, range: 185, splash: 0, onlyGround: true, icon: '►',
        deployDelay: 3.5, cooldown: 9,
        desc: '► 重型连弩塔：攻速极快(0.3s/箭)、射程远、只对地；每秒自流血24'
    },
    mage_tower: {
        type: 'tower', name: '法师塔', cost: 5, hp: 700, atk: 55,
        atkSpeed: 2.2, range: 85, splash: 45, icon: '🔮',
        deployDelay: 2.5, cooldown: 20
    },
    inferno_tower: {
        type: 'tower', name: '地狱塔', cost: 7, hp: 1100, atk: 6,
        atkSpeed: 0.2, range: 120, splash: 0, icon: '🔥',
        deployDelay: 2.5, cooldown: 30,
        infernoRamp: [4, 7, 10, 13, 16, 19],
        desc: '🔥 光束连线随持续锁定分段增伤：第一秒内6点伤害（DPS30），之后每秒依次增加4、7、10、13、16、19，最高75点伤害（DPS375）；切换目标冷却1.0秒'
    },
    tesla_tower: {
        type: 'tower', name: '电磁塔', cost: 4, hp: 500, atk: 40,
        atkSpeed: 1.1, range: 120, splash: 0, icon: '⚡',
        deployDelay: 2.5, cooldown: 12,
        desc: '⚡ 闪电单点攻击（不连锁），每次命中眩晕0.2秒'
    },
    goblin_cage: {
        type: 'tower', name: '哥布林牢笼', cost: 4, hp: 360, atk: 0, goblin: true,
        atkSpeed: 0, range: 0, splash: 0, icon: '🏚️',
        deployDelay: 2.5, cooldown: 12,
        desc: '🏚️ 无攻击力，建筑破损后出现1只强壮哥布林'
    },
    goblin_hut: {
        type: 'tower', name: '哥布林小屋', cost: 4, hp: 420, atk: 0, goblin: true,
        atkSpeed: 0, range: 0, splash: 0, icon: '🛖',
        deployDelay: 2.5, cooldown: 12,
        burnPerSec: 14,      // 每秒自流血
        spawnRange: 125,     // 出兵检测范围
        spawnInterval: 2.2,  // 出兵间隔（秒/只）
        deathSpawnCount: 3,  // 被摧毁时召唤投矛手数量
        desc: '🛖 每秒自流血14，125范围内有敌人时每2.2秒出兵1只哥布林投矛手；被摧毁时召唤3只'
    },
    goblin_drill: {
        type: 'tower', name: '哥布林钻机', cost: 4, hp: 600, atk: 0, goblin: true,
        atkSpeed: 0, range: 0, splash: 0, icon: '🛠️',
        deployDelay: 0.5, cooldown: 12,
        tunnelTime: 2.8,   // 挖掘移动：钻机从己方主塔挖地道潜行至部署点
        digTime: 0.8,      // 出土：抵达后原地潜伏钻出
        anywhere: true,    // 全图可放（不受半场限制）
        burnPerSec: 60,      // 每秒自流血
        spawnInterval: 3,    // 出兵间隔（秒/只，无条件持续钻出）
        deathSpawnCount: 2,  // 被摧毁时钻出的哥布林数量
        desc: '🛠️可部署于任意位置（不受半场限制）。部署延迟0.5秒，钻机从己方主塔挖地道潜行2.8秒抵达部署点，再潜伏钻出0.8秒（不被锁定，AOE仍可波及）后破土而出。每秒自流血60，每3秒无条件钻出1只哥布林；被摧毁时钻出2只'
    },
    goblin_barrack: {
        type: 'barrack', name: '骷髅墓碑', cost: 4, hp: 430,
        spawnInterval: 7.0, spawnCount: 2, spawnUnit: 'goblin', icon: '🏕️',
        deployDelay: 2.5, cooldown: 12
    },
    barbarian_hut: {
        type: 'barrack', name: '蛮人屋', cost: 8, hp: 1000,
        spawnInterval: 15.0, spawnCount: 3, spawnUnit: 'barbarian', spawnBurstInterval: 0.3,
        deathSpawnCount: 1, icon: '🛖',
        deployDelay: 2.5, cooldown: 12,
        desc: '🛖 8费兵营：每15秒出兵一轮，每轮3个蛮人，连续每0.3秒出1个；被摧毁时召唤1个蛮人'
    },
    elixir_collector: {
        type: 'collector', name: '圣水生成器', cost: 7, hp: 740,
        generateInterval: 14.0, icon: '💧', deployDelay: 3.0, cooldown: 30
    },
    camp: {
        type: 'tower', name: '临时营地', cost: 1, hp: 60, atk: 0,
        atkSpeed: 0, range: 0, splash: 0, icon: '⛺',
        deployDelay: 2.5, cooldown: 8,
        campCapacity: 2,      // 营地名额
        campRadius: 60,       // 收编范围
        campPatrolR: [40, 60], // 巡逻轨道（第i个加入的成员沿 campPatrolR[i] 半径巡逻）
        campDetectR: 200,     // 成员索敌范围
        desc: '⛺ 1费低血量占位建筑：2个名额，60px内友军加入并绕营巡逻（40/60双轨道，索敌200）'
    },

    spell_barrier: {
        type: 'tower', name: '法术屏障', cost: 4, hp: 50, atk: 0,
        atkSpeed: 0, range: 0, splash: 0, icon: '🔮',
        deployDelay: 2.5, cooldown: 12,
        flying: true,      // 空中单位：地面兵/炮塔打不到，只能被对空单位与法术伤害
        barrierRange: 185,    // 庇护范围：敌方不能在该区域释放法术（同十字弩攻击范围）
        desc: '🔮 空中庇护单位（50血）：庇护185范围区域，敌方无法在该区域释放任何法术；费用4，场上每多1座己方屏障费用+2；空中单位地面兵打不到，需对空单位/法术处理'
    },

    armor_smith: {
        type: 'tower', name: '盔甲铺', cost: 4, hp: 500, atk: 0,
        atkSpeed: 0, range: 85, splash: 0, icon: '🛡️',
        deployDelay: 0.5, cooldown: 8,
        chargeMax: 6,       // 蓄力6s蓄满
        shieldAmount: 100,  // 蓄满后给范围内1个未持盾友军兵种加100盾
        desc: '🛡️ 4费辅助建筑：蓄力6s蓄满，85px内存在未持盾友军兵种时给1人加100护盾（加完重新蓄力）'
    },

    // ==================== 法术 ====================
    log: {
        type: 'spell', halfOnly: true, name: '滚木', cost: 2, damage: 110,
        towerDmgMul: 0.5, radius: 32.5, icon: '🪵', deployDelay: 0.8, cooldown: 18,
        knockback: 30, rollSpeed: 250,
        rollDistance: 560,   // 法术影响范围长度：滚动560px后消失
        logLength: 65,       // 木头本体长度（竖直方向，=影响范围宽65px）
        logWidth: 7,         // 木头本体宽度（滚动方向厚度）
        desc: '🪵 2费法术：只能在己方半场释放（与军队相同）。一根竖直滚木（长65px厚7px）横向滚出560px，影响范围长560px×宽65px（剑仙攻击范围直径），沿途每个接触的敌人造成110伤害并平滑击退30px（位移式滑动，每个敌人仅结算一次，不影响空中单位，对主塔/堡垒伤害减半）；滚到头消失'
    },
    fireball: {
        type: 'spell', name: '火球术', cost: 4, damage: 320,
        radius: 38, towerDmgMul: 0.5, icon: '🔥', deployDelay: 0.8, cooldown: 12,
        flightTime: 1.4,              // 火球从主塔飞往落点耗时（秒），落地即结算
    },
    rocket: {
        type: 'spell', name: '火箭', cost: 6, damage: 740,
        radius: 38, towerDmgMul: 1 / 3, icon: '🚀', deployDelay: 0.5, cooldown: 30,
        flightTime: 3.5,              // 从开洞到命中总耗时3.5s（开洞0.5 + 升空出屏1.5 + 屏外0.5 + 只有影子0.5 + 火箭下落0.5）
        knockback: 30,                // 火箭击退（比火球15px更强，同滚木）
        desc: '🚀 6费法术：己方主塔从圆心开洞(0.5s)，火箭钻出垂直升空飞出屏幕(1.5s)，屏外等待后落点影子出现、火箭俯冲下落，共3.5秒命中造成740伤害（范围同火球术，对主塔/堡垒伤害1/3）并击退30px，命中处升起1秒小蘑菇云'
    },
    arrows: {
        type: 'spell', name: '箭雨', cost: 3, damage: 44,
        radius: 85, towerDmgMul: 0.5, icon: '🌧️', deployDelay: 0.5, cooldown: 18,
        strikes: 3, strikeInterval: 0.3,  // 三段攻击：每0.3秒一段，共3段，每段44，总伤害132
        flightTime: 1.4,              // 箭束从主塔飞往落点耗时（秒），落地后开始下箭
    },
    earthquake: {
        type: 'spell', name: '地震法术', cost: 3, damage: 15,
        radius: 48, towerDmgMul: 10, icon: '🌍', deployDelay: 0.8, cooldown: 32,
        strikes: 3, strikeInterval: 1.5  // 持续3秒，每1.5秒一段共3段；基础伤害减半，对普通建筑10倍（主塔/堡垒除外）
    },
    thunder_spell: {
        type: 'spell', name: '大雷电', cost: 6, damage: 380,
        radius: 85, towerDmgMul: 0.25, icon: '🌩️', deployDelay: 0.8, cooldown: 30,
        strikes: 3, strikeInterval: 0.5, topHpTargets: 3,
        desc: '🌩️ 释放后锁定范围内生命值最高的3名敌方单位（不锁定隐身单位），0.5秒后劈下第一道雷，此后每0.5秒一道，每道造成380伤害并眩晕0.2秒💫；范围内无单位则不劈'
    },
    small_lightning: {
        type: 'spell', name: '小电', cost: 2, damage: 42,
        radius: 38, towerDmgMul: 0.5, stunDuration: 0.5, icon: '⚡',
        deployDelay: 0.4, cooldown: 13,
        desc: '⚡ 2费法术：范围同火球术(38px)，对范围内所有敌人造成42伤害并眩晕0.5秒💫（对主塔/堡垒伤害减半）'
    },
    bat_spell: {
        type: 'spell', name: '蝙蝠法术', cost: 3,
        radius: 38, icon: '🦇',
        deployDelay: 0.8, cooldown: 15,
        spawnWaves: 3, spawnPerWave: 2,   // 分3波、每波2只，共6只
        spawnStartDelay: 1.0,             // 释放1秒后开始出蝙蝠
        spawnInterval: 0.3,               // 每0.3秒出一波
        desc: '🦇 释放1秒后开始，在范围内每0.3秒出2只蝙蝠（共3波6只），蝙蝠飞行近战、可对空、存活20秒'
    },
    goblin_barrel: {
        type: 'spell', name: '哥布林飞桶', cost: 3, goblin: true,
        radius: 38, icon: '🛢️',
        deployDelay: 0.8, cooldown: 15,
        flightTime: 1.5,              // 木桶从主塔飞往落点耗时（秒）
        goblinCount: 3,
        desc: '🛢️ 释放后从己方主塔飞出木桶，抛物线飞向目标点，落地摔出3只近战哥布林（呈120°均匀分布在法术圈上）'
    },
    goblin_curse: {
        type: 'spell', name: '哥布林魔咒', cost: 2, goblin: true,
        radius: 48, icon: '🧪',
        deployDelay: 0.8, cooldown: 15,
        duration: 6, dps: 10, towerDmgMul: 0.5,   // 持续6秒，每秒1次对圈内敌人造成10伤害（总计60）；对主塔/堡垒伤害减半
        desc: '🧪 2费诅咒法术：48px范围形成暗绿魔咒领域6秒，每秒对圈内所有敌人造成10点伤害（可对空、无视目标类型，对主塔/堡垒伤害减半）'
    },
    hurricane: {
        type: 'spell', name: '飓风法术', cost: 3, damage: 8,
        radius: 105, duration: 1.5, tickInterval: 0.5, icon: '🌪️',
        deployDelay: 0.8, cooldown: 12,
        desc: '🌪️ 3费法术：105px范围持续1.5秒的飓风领域，持续向中心牵引圈内敌人，每0.5秒造成8点伤害（共3跳24伤害，不影响建筑）'
    },
    poison_spell: {
        type: 'spell', name: '毒药', cost: 4,
        radius: 85, icon: '🤢',
        deployDelay: 0.8, cooldown: 15,
        duration: 8, dps: 18, slowFactor: 0.85, slowDuration: 1.0, towerDmgMul: 0.5,
        desc: '🤢 4费法术：85px范围（同极速法术）形成橙红毒雾领域8秒，每0.4秒对圈内所有敌人造成18点伤害并减速15%（对主塔/堡垒伤害减半）'
    },
    speed_spell: {
        type: 'spell', name: '极速法术', cost: 2,
        radius: 85, zoneDuration: 8.0, speedBoost: 2.0, boostDuration: 1.0,
        icon: '⚡', deployDelay: 0.8, cooldown: 7.5,
        desc: '部署后留下一个持续8秒的加速区域(半径85px)，范围内的友方单位每秒获得⚡加速100%，持续1秒'
    },
    rage_spell: {
        type: 'spell', name: '狂暴法术', cost: 2, damage: 30,
        radius: 48, zoneDuration: 4.5, rageBoost: 0.3, boostDuration: 1.5, rageTick: 0.5,
        towerDmgMul: 0.5, // 对主塔/堡垒伤害减半
        icon: '😡', deployDelay: 0.5, cooldown: 35,
        desc: '部署1s后：对范围内敌军造成30伤害(对主塔/堡垒减半)，并留下4.5秒狂暴区域(半径48px，同复制法术)，区域内每0.5秒对友方施加持续1.5秒的狂暴(攻速/移速/蓄力/出兵/伤害+30%)'
    },
    freeze_spell: {
        type: 'spell', name: '冰冻法术', cost: 4, damage: 30,
        radius: 85, freezeDuration: 4, towerDmgMul: 0.5, icon: '❄️',
        deployDelay: 0.8, cooldown: 14,
        desc: '范围30伤害(对主塔/堡垒减半)+冻结4秒：范围内敌方无法移动/攻击/蓄力/召唤，如同按下暂停键；地面留下静态冰蓝色区域'
    },
    copy_spell: {
        type: 'spell', name: '复制法术', cost: 3,
        radius: 48, icon: '🔷',
        deployDelay: 0.8, cooldown: 15,
        desc: '🔷 复制范围内所有友军兵种各1个（建筑/堡垒/主塔不复制）：复制体生命值为1，其余特性与本体完全一样，建模为半透明亮蓝色（外形与本体完全相同，不显示名字与血条）；复制体的衍生单位（分裂/召唤/孵化/变形子代）也均为1滴血'
    },
    smoke_guide: {
        type: 'spell', name: '烟引', cost: 1, icon: '🧭',
        radius: 85, deployDelay: 0.2, cooldown: 15,
        smokeDuration: 17, smokeRadius: 12, pendingDuration: 20,
        desc: '🧭 1费引导法术：点击地图选范围→范围内友军套上🧭闪烁buff（已扣费）；20秒内再点地图选放烟点→友军朝烟点前进至抵达或超时。超时未放烟则buff消失、无冷却直接变回烟引'
    },
    mirror: {
        type: 'spell', name: '镜像法术', cost: 1, icon: '🪞',
        deployDelay: 0.5, cooldown: 7.5,
        desc: '🪞复制上一次部署的卡牌，费用+1'
    }
};

// ---- 卡牌 ID 列表（自动生成）----
const CARD_IDS = Object.keys(CARDS);

// ---- 剑仙形象开关 ----
// false = 日常形象（仙剑竖立身侧）；true = 旧形象备用（脚下横置飞剑，保留待用）
const SWORD_IMMORTAL_LEGACY = false;

// ---- 兼容旧引用（gameState.js / entities.js 仍在用）----
const PLAYER_BASTION_TOP    = PLAYER_BASTIONS[0];
const PLAYER_BASTION_BOTTOM = PLAYER_BASTIONS[1];
const AI_BASTION_TOP        = AI_BASTIONS[0];
const AI_BASTION_BOTTOM     = AI_BASTIONS[1];
const MODE_TEST_AI_BASTION_TOP    = MODE_TEST_AI_BASTIONS[0];   // 🧪 测试双人别名（与标准对称：isInHalf/render 部署边界引用）
const MODE_TEST_AI_BASTION_BOTTOM = MODE_TEST_AI_BASTIONS[1];

const BASE_UNITS = {
    bat: BAT_TEMPLATE,
    worm: WORM_TEMPLATE,
    goblin: GOBLIN_TEMPLATE,
    strong_goblin: STRONG_GOBLIN_TEMPLATE,
    crafted_water_carrier: CRAFTED_WATER_CARRIER_TEMPLATE,
    small_water_carrier: SMALL_WATER_CARRIER_TEMPLATE,
    lava_pup: LAVA_PUP_TEMPLATE,
    main_tower_guard: MAIN_TOWER_GUARD_TEMPLATE,
    prince_reinforcement: PRINCE_REINFORCEMENT_TEMPLATE,
    wood_stake: WOOD_STAKE_TEMPLATE,
    barrel_guard: BARREL_GUARD_TEMPLATE,
    barbarian: BARBARIAN_TEMPLATE
};
