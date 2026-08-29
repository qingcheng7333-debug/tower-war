/* ===== render.js — 所有 Canvas 绘制函数 ===== */

// 🔷 绘制上下文切换：默认主画布（惰性初始化，main.js 加载后才有 ctx）；复制体染色时切到离屏画布
let DC = null;
// 复制体染色离屏画布尺寸（单位建模包围盒半径须 ≤ 该值一半；当前最大建模约 20px，余量充足）
// 未来若新增超大单位建模，只需改这一个常量（偏移/渐变/贴回坐标均自动同步，防止错位）
const COPY_CANVAS_SIZE = 120;
const copyCanvas = document.createElement('canvas');
copyCanvas.width = COPY_CANVAS_SIZE;
copyCanvas.height = COPY_CANVAS_SIZE;
const copyCtx = copyCanvas.getContext('2d');

/** 主绘制函数：清屏 → 背景 → 主塔 → 实体 → 法术预览 → 结束画面 */
function draw(alpha) {
    if (DC === null) DC = ctx;  // 首次使用时指向主画布
    // ---- 渲染坐标插值投影（Fixed Timestep 配套）----
    // 临时把实体 x/y 投影到 [上一逻辑帧, 当前逻辑帧] 之间，draw 结束后 finally 恢复。
    // 这是 render.js「只读不写」原则的登记特例（与 update.js 圣水 DOM 特例对等），
    // 净副作用为零：绘制期间所有实体读取到的都是插值坐标（兵种/建筑/塔/离屏染色自动生效）。
    const proj = [];
    for (const e of game.entities) {
        if (e.prevX === undefined) continue;   // 无插值基准（理论不发生）直接原样绘制
        proj.push(e);
        e._projX = e.x; e._projY = e.y;
        e.x = e.prevX + (e.x - e.prevX) * (alpha || 0);
        e.y = e.prevY + (e.y - e.prevY) * (alpha || 0);
    }
    try {
        DC.clearRect(0, 0, W, H);

    // ---- 背景 ----
    const gradLeft = DC.createLinearGradient(0, 0, RIVER_LEFT, 0);
    gradLeft.addColorStop(0, '#1b3a5c');
    gradLeft.addColorStop(1, '#2a4a6e');
    DC.fillStyle = gradLeft;
    DC.fillRect(0, 0, RIVER_LEFT, H);

    const gradRight = DC.createLinearGradient(RIVER_RIGHT, 0, W, 0);
    gradRight.addColorStop(0, '#2c4c3b');
    gradRight.addColorStop(1, '#3a5a4a');
    DC.fillStyle = gradRight;
    DC.fillRect(RIVER_RIGHT, 0, W - RIVER_RIGHT, H);

    // ---- 河流（缓冲带）----
    DC.fillStyle = '#1e4a6b';
    DC.fillRect(RIVER_LEFT, 0, BUFFER_WIDTH, H);
    DC.strokeStyle = '#3a7ca5';
    DC.lineWidth = 1.5;
    for (let i = 0; i < H; i += 40) {
        DC.beginPath();
        DC.moveTo(RIVER_LEFT, i);
        DC.lineTo(RIVER_RIGHT, i + 10);
        DC.stroke();
    }
    DC.beginPath();
    DC.setLineDash([8, 8]);
    DC.moveTo(RIVER_LEFT, 0);
    DC.lineTo(RIVER_LEFT, H);
    DC.stroke();
    DC.moveTo(RIVER_RIGHT, 0);
    DC.lineTo(RIVER_RIGHT, H);
    DC.stroke();
    // ---- 堡垒竖虚线（与河界线同款）----
    DC.moveTo(PLAYER_BASTION_TOP.x, 0);
    DC.lineTo(PLAYER_BASTION_TOP.x, H);
    DC.stroke();
    DC.moveTo(AI_BASTION_TOP.x, 0);
    DC.lineTo(AI_BASTION_TOP.x, H);
    DC.stroke();
    DC.setLineDash([]);

    // ---- 绘制部署光环（转圈环）----
    for (let d of game.deploying) {
        drawDeployRing(d);
    }

    // ---- 🧭 烟引·放烟点特效（countdown 计时环 + active 持续烟雾发散）----
    drawSmokeGuideEffects();

    // ---- 绘制所有实体 ----
    for (let e of game.entities) {
        if (e.hp <= 0) continue;
        if (e.isCopy) { drawCopyUnit(e); continue; } // 🔷 复制体：本体建模整体染亮蓝+半透明（克隆法术/冥王召唤骷髅共用）
        drawUnitBody(e);
    }

    // ---- 通用状态图标系统：每个实体头顶绘制动态状态标识 ----
    for (let e of game.entities) {
        if (e.hp <= 0) continue;
        drawStatusIcon(e);
    }

    // ---- 🐾 绘制狂战士爆发·兽爪血痕（全局特效层：在所有实体/状态图标绘制之后，不被建模遮挡）----
    if (game.clawEffects && game.clawEffects.length) {
        for (let s of game.clawEffects) {
            const p = 1 - Math.min(s.timer / s.maxTimer, 1);   // 0→1
            const grow = 1 - (1 - p) * (1 - p);                // easeOut 猛然抓出
            const alpha = Math.sin(p * Math.PI);               // 抓出→消散
            const len = 16 * grow;                             // 爪痕长度
            const a = s.dir + (s.flip ? 0.55 : -0.55);         // 本组爪痕方向（左右交替倾斜）
            const nx = -Math.sin(a), ny = Math.cos(a);         // 垂直方向（三条缝错开）
            DC.save();
            DC.lineCap = 'round';
            DC.shadowColor = 'rgba(255,20,45,0.9)';
            DC.shadowBlur = 12;
            [-3.5, 0, 3.5].forEach(off => {
                const x0 = s.x + nx * off, y0 = s.y + ny * off;
                const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len;
                // 双层绘制：外层宽淡红光晕 + 内层亮血痕
                [[5, 0.35], [2.6, 1]].forEach(([lw, al]) => {
                    DC.strokeStyle = `rgba(255,18,40,${alpha * al})`;
                    DC.lineWidth = lw;
                    DC.beginPath();
                    DC.moveTo(x0, y0);
                    DC.lineTo(x1, y1);
                    DC.stroke();
                });
            });
            DC.restore();
        }
    }

    // ---- 绘制弹道特效（弓箭手 །  /  炮塔 ༓  /  飞龙🔥 / 治疗➕）----
    for (let p of game.projectiles) {
        const alpha = p.timer < 0.08 ? (p.timer / 0.08) : 1;
        DC.globalAlpha = alpha;
        if (p.isNinjaDart) {
            // 🥷 四角弯刃手里剑：中心空心圆环 + 四个弯曲尖刃，飞行中持续自转
            const r = p.size * 0.23;
            const outer = p.size * 0.62;
            const spin = game.time * 16 + (p.spinOffset || 0);
            DC.save();
            DC.translate(p.x, p.y);
            DC.rotate(spin);
            DC.shadowColor = 'rgba(120,210,255,0.75)';
            DC.shadowBlur = 5;
            // 四片弯刃：每片从中心外侧弯向切线方向，再收成尖端
            for (let i = 0; i < 4; i++) {
                DC.save();
                DC.rotate(i * Math.PI / 2);
                DC.beginPath();
                DC.moveTo(r * 0.65, -r * 0.7);
                DC.quadraticCurveTo(outer * 0.45, -outer * 0.9, outer * 0.95, -outer * 0.28);
                DC.quadraticCurveTo(outer * 0.78, -outer * 0.12, outer * 0.55, outer * 0.08);
                DC.quadraticCurveTo(outer * 0.32, outer * 0.32, r * 0.65, r * 0.7);
                DC.quadraticCurveTo(r * 0.9, 0, r * 0.65, -r * 0.7);
                DC.closePath();
                DC.fillStyle = p.color || '#d8f3ff';
                DC.fill();
                DC.strokeStyle = 'rgba(255,255,255,0.9)';
                DC.lineWidth = 0.8;
                DC.stroke();
                DC.restore();
            }
            // 中心空心圆环：只描边，中心保持透明，呈现真正的“○”
            DC.strokeStyle = '#e8f8ff';
            DC.lineWidth = 1.5;
            DC.beginPath();
            DC.arc(0, 0, r, 0, Math.PI * 2);
            DC.stroke();
            DC.fillStyle = 'rgba(255,255,255,0.85)';
            DC.beginPath();
            DC.arc(-r * 0.3, -r * 0.3, r * 0.18, 0, Math.PI * 2);
            DC.fill();
            DC.restore();
        } else if (p.isCannonball) {
            // 炮塔黑色实心炮弹
            DC.fillStyle = '#111';
            DC.beginPath();
            DC.arc(p.x, p.y, p.size / 2, 0, 2 * Math.PI);
            DC.fill();
            DC.strokeStyle = '#555';
            DC.lineWidth = 1.5;
            DC.stroke();
            // 高光
            DC.fillStyle = 'rgba(255,255,255,0.2)';
            DC.beginPath();
            DC.arc(p.x - 1.5, p.y - 1.5, p.size / 4, 0, 2 * Math.PI);
            DC.fill();
        } else if (p.isElectro) {
            // 电磁炮：白色电磁团（带外层光晕）
            const r = p.size / 2;
            // 外光晕
            const grad = DC.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.5);
            grad.addColorStop(0, 'rgba(255,255,255,0.6)');
            grad.addColorStop(0.3, 'rgba(200,230,255,0.3)');
            grad.addColorStop(1, 'rgba(255,255,255,0)');
            DC.fillStyle = grad;
            DC.beginPath();
            DC.arc(p.x, p.y, r * 2.5, 0, 2 * Math.PI);
            DC.fill();
            // 核心白球
            DC.fillStyle = '#ffffff';
            DC.beginPath();
            DC.arc(p.x, p.y, r, 0, 2 * Math.PI);
            DC.fill();
            // 高光亮点
            DC.fillStyle = 'rgba(255,255,255,0.8)';
            DC.beginPath();
            DC.arc(p.x - r * 0.3, p.y - r * 0.3, r * 0.35, 0, 2 * Math.PI);
            DC.fill();
        } else if (p.isMortar || p.isBomber || p.isFireJump) {
            // 迫击炮🪨 / 哥布林爆破手🧨 / 火豆跳跃🔥：抛物线弹体（无轨迹虚线）
            DC.font = `${p.size}px sans-serif`;
            DC.textAlign = 'center';
            DC.textBaseline = 'middle';
            DC.fillText(p.char, p.x, p.y);
        } else if (p.isRocket) {
            // 烟花火箭：🚀 + 沿飞行方向拖出橙色尾焰（直线弹道用vx/vy，追踪弹道用tx/ty）
            const ang = (p.vx !== undefined) ? Math.atan2(p.vy, p.vx) : Math.atan2(p.ty - p.y, p.tx - p.x);
            const f = 5 + 3 * Math.sin(game.time * 30);
            DC.strokeStyle = 'rgba(255,140,0,0.8)';
            DC.lineWidth = 3;
            DC.beginPath();
            DC.moveTo(p.x - Math.cos(ang) * 6, p.y - Math.sin(ang) * 6);
            DC.lineTo(p.x - Math.cos(ang) * (10 + f), p.y - Math.sin(ang) * (10 + f));
            DC.stroke();
            DC.font = `${p.size}px sans-serif`;
            DC.textAlign = 'center';
            DC.textBaseline = 'middle';
            DC.fillText(p.char, p.x, p.y);
        } else if (p.isSpear) {
            // 🔱 投矛：木柄 + 菱形金属矛头（沿飞行方向旋转）
            const ang = Math.atan2(p.vy, p.vx);
            DC.save();
            DC.translate(p.x, p.y);
            DC.rotate(ang);
            // 木柄（向后延伸）
            DC.strokeStyle = '#8d6e63';
            DC.lineWidth = 2.5;
            DC.beginPath();
            DC.moveTo(-14, 0);
            DC.lineTo(6, 0);
            DC.stroke();
            // 菱形矛头（前端，金属灰）
            DC.fillStyle = '#cfd8dc';
            DC.beginPath();
            DC.moveTo(16, 0);   // 尖端
            DC.lineTo(8, -4);   // 左翼
            DC.lineTo(12, 0);   // 尾左
            DC.lineTo(8, 4);    // 右翼
            DC.closePath();
            DC.fill();
            DC.strokeStyle = 'rgba(255,255,255,0.5)';
            DC.lineWidth = 1;
            DC.stroke();
            DC.restore();
        } else if (p.isDart) {
            // 🎯 吹箭：短小箭杆 + 绿色毒箭头 + 红色尾羽（沿飞行方向旋转）
            const ang = Math.atan2(p.vy, p.vx);
            DC.save();
            DC.translate(p.x, p.y);
            DC.rotate(ang);
            // 箭杆（细棕杆）
            DC.strokeStyle = '#a0522d';
            DC.lineWidth = 1.3;
            DC.beginPath();
            DC.moveTo(-6, 0);
            DC.lineTo(3, 0);
            DC.stroke();
            // 毒箭头（前端三角，哥布林暗绿）
            DC.fillStyle = '#1e8449';
            DC.beginPath();
            DC.moveTo(8, 0);   // 尖端
            DC.lineTo(4, -2);   // 左翼
            DC.lineTo(6, 0);    // 尾左
            DC.lineTo(4, 2);    // 右翼
            DC.closePath();
            DC.fill();
            // 尾羽（红）
            DC.strokeStyle = '#e74c3c';
            DC.lineWidth = 1.1;
            DC.beginPath();
            DC.moveTo(-6, 0);
            DC.lineTo(-8, -2);
            DC.moveTo(-6, 0);
            DC.lineTo(-8, 2);
            DC.stroke();
            DC.restore();
        } else if (p.isQueenArrow) {
            // 🏹 弓箭女皇：绿色特别细的追踪箭（沿飞行方向旋转：细绿杆 + 深绿箭头 + 浅绿尾羽微光）
            const ang = Math.atan2(p.ty - p.y, p.tx - p.x);
            DC.save();
            DC.translate(p.x, p.y);
            DC.rotate(ang);
            // 箭杆（极细绿杆）
            DC.strokeStyle = '#2ecc71';
            DC.lineWidth = 0.9;
            DC.beginPath();
            DC.moveTo(-9, 0);
            DC.lineTo(5, 0);
            DC.stroke();
            // 箭头（前端三角，深绿）
            DC.fillStyle = '#27ae60';
            DC.beginPath();
            DC.moveTo(8, 0);    // 尖端
            DC.lineTo(4, -1.6); // 左翼
            DC.lineTo(5.5, 0);  // 尾左
            DC.lineTo(4, 1.6);  // 右翼
            DC.closePath();
            DC.fill();
            // 尾羽（浅绿微光）
            DC.strokeStyle = 'rgba(46,204,113,0.7)';
            DC.lineWidth = 0.8;
            DC.beginPath();
            DC.moveTo(-9, 0);
            DC.lineTo(-11.5, -1.6);
            DC.moveTo(-9, 0);
            DC.lineTo(-11.5, 1.6);
            DC.stroke();
            DC.restore();
        } else if (p.isAxe) {
            // 🪓 飞斧胖虎飞斧：沿飞行方向旋转的斧头（去程正向转、返程反向转，滞空感）
            const ang = Math.atan2(p.vy, p.vx);
            const spin = (p._returning ? -1 : 1);
            DC.save();
            DC.translate(p.x, p.y);
            DC.rotate(ang + game.time * 16 * spin);
            DC.font = `${p.size}px sans-serif`;
            DC.textAlign = 'center';
            DC.textBaseline = 'middle';
            DC.fillText('🪓', 0, 0);
            DC.restore();
        } else if (p.isSword) {
            // 🗡️ 剑仙飞剑：发光小剑沿飞行方向旋转（剑身浅青白/浅金 + 剑尖 + 棕柄 + 微光闪烁）；🕊️御剑金剑：金色剑身+更亮光晕
            const ang = Math.atan2(p.vy, p.vx);
            const swordCol = p.gold ? '#ffd700' : (p.team === 'player' ? '#d5f5ec' : '#f9e79f');
            DC.save();
            DC.translate(p.x, p.y);
            DC.rotate(ang);
            // 剑身（御剑金剑更粗更亮）
            DC.strokeStyle = swordCol;
            DC.lineWidth = p.gold ? 3.5 : 2.5;
            DC.beginPath();
            DC.moveTo(-10, 0);
            DC.lineTo(11, 0);
            DC.stroke();
            // 剑尖（三角）
            DC.fillStyle = swordCol;
            DC.beginPath();
            DC.moveTo(11, 0);
            DC.lineTo(6, -3.5);
            DC.lineTo(8, 0);
            DC.lineTo(6, 3.5);
            DC.closePath();
            DC.fill();
            // 剑柄（棕）
            DC.strokeStyle = '#8b4513';
            DC.lineWidth = 2;
            DC.beginPath();
            DC.moveTo(-10, 0);
            DC.lineTo(-14, 0);
            DC.stroke();
            DC.restore();
            // 微光（🕊️御剑金剑：金色光晕更大更亮）
            DC.globalAlpha = (p.gold ? 0.55 : 0.35) + Math.sin(game.time * 8) * 0.15;
            DC.strokeStyle = swordCol;
            DC.lineWidth = p.gold ? 9 : 4;
            DC.beginPath();
            DC.moveTo(p.x - 3, p.y - 3);
            DC.lineTo(p.x + 3, p.y + 3);
            DC.stroke();
            DC.globalAlpha = 1;
        } else {
            DC.font = `${p.size}px sans-serif`;
            DC.textAlign = 'center';
            DC.textBaseline = 'middle';
            DC.fillStyle = p.color || 'white';
            DC.fillText(p.char, p.x, p.y);
        }
    }
    DC.globalAlpha = 1;
    DC.textBaseline = 'alphabetic';

    // ---- 绘制穿透箭（游侠·黄色线条·90px段+尾端渐隐）----
    for (let a of game.pierceArrows) {
        const arrowLen = 90; // 穿透箭可见长度90px
        const tipX = a.x + a.dx * a.traveled;
        const tipY = a.y + a.dy * a.traveled;
        const tailProgress = Math.max(0, a.traveled - arrowLen);
        const tailX = a.x + a.dx * tailProgress;
        const tailY = a.y + a.dy * tailProgress;
        // 渐变：尾端透明→箭尖全亮
        const grad = DC.createLinearGradient(tailX, tailY, tipX, tipY);
        grad.addColorStop(0, 'rgba(241, 196, 15, 0)');
        grad.addColorStop(0.3, 'rgba(241, 196, 15, 0.15)');
        grad.addColorStop(0.6, 'rgba(241, 196, 15, 0.5)');
        grad.addColorStop(0.9, 'rgba(241, 196, 15, 0.9)');
        grad.addColorStop(1, 'rgba(241, 196, 15, 1)');
        DC.strokeStyle = grad;
        DC.lineWidth = a.width || 2;
        DC.beginPath();
        DC.moveTo(tailX, tailY);
        DC.lineTo(tipX, tipY);
        DC.stroke();
        // 箭尖小光点
        DC.fillStyle = '#f9e547';
        DC.beginPath();
        DC.arc(tipX, tipY, 3, 0, 2 * Math.PI);
        DC.fill();
    }

    // ---- 绘制渔夫鱼线（棕色线条·参照游侠穿透箭渐变渲染）----
    if (game.fishingLines) {
        for (const l of game.fishingLines) {
            let tipX, tipY, tailX, tailY;
            if (l.pulling && l.targetId) {
                // 收线拖拽中：线实时连到目标当前位置
                const ht = game.entities.find(en => en.id === l.targetId);
                if (!ht || ht.hp <= 0) continue;
                tipX = ht.x; tipY = ht.y - 10;
                tailX = l.x; tailY = l.y;
            } else {
                // 甩钩飞行中：钩头随 traveled 前进，尾端渐隐
                tipX = l.x + l.dx * l.traveled;
                tipY = l.y + l.dy * l.traveled;
                const tailProgress = Math.max(0, l.traveled - (l.lineLen || 60));
                tailX = l.x + l.dx * tailProgress;
                tailY = l.y + l.dy * tailProgress;
            }
            // 棕色渐变：尾端透明→钩头全亮
            const grad = DC.createLinearGradient(tailX, tailY, tipX, tipY);
            grad.addColorStop(0, 'rgba(139, 90, 43, 0)');
            grad.addColorStop(0.3, 'rgba(139, 90, 43, 0.25)');
            grad.addColorStop(0.6, 'rgba(139, 90, 43, 0.6)');
            grad.addColorStop(0.9, 'rgba(139, 90, 43, 0.95)');
            grad.addColorStop(1, 'rgba(139, 90, 43, 1)');
            DC.strokeStyle = grad;
            DC.lineWidth = 2;
            DC.beginPath();
            DC.moveTo(tailX, tailY);
            DC.lineTo(tipX, tipY);
            DC.stroke();
            // 钩头：小钩子（半圆 + 钩尖）
            DC.strokeStyle = '#c0c0c0';
            DC.lineWidth = 1.5;
            DC.beginPath();
            DC.arc(tipX, tipY, 3, Math.PI, 2 * Math.PI);
            DC.stroke();
            DC.beginPath();
            DC.moveTo(tipX, tipY + 3);
            DC.lineTo(tipX, tipY + 4.5);
            DC.stroke();
        }
    }

    // ---- 绘制极速法术·加速区域（⚡光环）----
    for (let z of game.speedZones) {
        const progress = 1 - z.timer / z.maxTimer; // 0~1
        const pulse = 0.85 + 0.15 * Math.sin(progress * Math.PI * 6); // 呼吸脉动
        const radius = z.radius * pulse;
        // 外圈光环
        DC.beginPath();
        DC.arc(z.x, z.y, radius, 0, 2 * Math.PI);
        DC.fillStyle = z.team === 'player'
            ? 'rgba(100, 180, 255, 0.12)'
            : 'rgba(255, 150, 150, 0.12)';
        DC.fill();
        DC.strokeStyle = z.team === 'player'
            ? 'rgba(100, 200, 255, 0.35)'
            : 'rgba(255, 180, 180, 0.35)';
        DC.lineWidth = 2;
        DC.stroke();
        // 内圈浅光环
        DC.beginPath();
        DC.arc(z.x, z.y, radius * 0.5, 0, 2 * Math.PI);
        DC.fillStyle = z.team === 'player'
            ? 'rgba(180, 220, 255, 0.08)'
            : 'rgba(255, 200, 200, 0.08)';
        DC.fill();
        // ⚡标识已移除（光环视觉已足够）
    }

    // ---- 绘制冰冻法术·冰封区域（静态冰蓝色，不脉动）----
    for (let z of game.freezeZones) {
        const alpha = Math.min(1, z.timer / 0.5); // 最后0.5秒淡出
        // 静态冰蓝半透明大圆
        DC.beginPath();
        DC.arc(z.x, z.y, z.radius, 0, 2 * Math.PI);
        DC.fillStyle = `rgba(130, 205, 255, ${0.16 * alpha})`;
        DC.fill();
        DC.strokeStyle = `rgba(160, 225, 255, ${0.45 * alpha})`;
        DC.lineWidth = 2;
        DC.stroke();
        // 内圈浅光
        DC.beginPath();
        DC.arc(z.x, z.y, z.radius * 0.6, 0, 2 * Math.PI);
        DC.fillStyle = `rgba(190, 235, 255, ${0.10 * alpha})`;
        DC.fill();
        // 中心静态冰晶❄️（不闪烁）
        DC.font = '16px sans-serif';
        DC.textAlign = 'center';
        DC.textBaseline = 'middle';
        DC.fillStyle = `rgba(220, 245, 255, ${0.9 * alpha})`;
        DC.fillText('❄️', z.x, z.y);
    }

    // ---- 🧪 哥布林魔咒·诅咒领域（较透明的暗绿领域 + 低频率冒出小绿泡）----
    for (let z of game.curseZones) {
        const alpha = Math.min(1, z.timer / 0.5); // 最后0.5秒淡出
        // 暗绿色半透明领域（比冰封/狂暴更淡，体现"较透明"）
        DC.beginPath();
        DC.arc(z.x, z.y, z.radius, 0, 2 * Math.PI);
        DC.fillStyle = `rgba(30, 132, 73, ${0.13 * alpha})`; // 哥布林家族暗绿 #1e8449
        DC.fill();
        DC.strokeStyle = `rgba(70, 200, 120, ${0.4 * alpha})`;
        DC.lineWidth = 2;
        DC.stroke();
        // 内圈浅光（偏亮绿）
        DC.beginPath();
        DC.arc(z.x, z.y, z.radius * 0.6, 0, 2 * Math.PI);
        DC.fillStyle = `rgba(60, 190, 105, ${0.08 * alpha})`;
        DC.fill();
        // 中心魔咒符号🧪（暗绿，不闪烁）
        DC.font = '16px sans-serif';
        DC.textAlign = 'center';
        DC.textBaseline = 'middle';
        DC.fillStyle = `rgba(120, 230, 160, ${0.9 * alpha})`;
        DC.fillText('🧪', z.x, z.y);
        // 低频率冒出的小绿泡（缓慢上浮，随领域一起淡出）
        for (const bubble of z.bubbles || []) {
            const bAlpha = alpha * Math.min(1, bubble.timer / 0.4) * 0.85;
            DC.beginPath();
            DC.arc(bubble.x, bubble.y, 4.5, 0, 2 * Math.PI);
            DC.fillStyle = `rgba(90, 220, 130, ${bAlpha})`;
            DC.fill();
            DC.strokeStyle = `rgba(150, 245, 180, ${bAlpha * 0.8})`;
            DC.lineWidth = 1;
            DC.stroke();
            // 小高光点
            DC.beginPath();
            DC.arc(bubble.x - 1.5, bubble.y - 1.5, 1.3, 0, 2 * Math.PI);
            DC.fillStyle = `rgba(210, 255, 225, ${bAlpha * 0.8})`;
            DC.fill();
        }
    }

    // ---- 绘制狂暴法术·狂暴区域（😡橙红愤怒光环，轻微脉动）----
    for (let z of game.rageZones) {
        const alpha = Math.min(1, z.timer / 0.5); // 最后0.5秒淡出
        const progress = 1 - z.timer / z.maxTimer; // 0~1
        const pulse = 0.9 + 0.1 * Math.sin(progress * Math.PI * 8); // 呼吸脉动
        const radius = z.radius * pulse;
        // 外圈火焰光环（半透明橙红）
        DC.beginPath();
        DC.arc(z.x, z.y, radius, 0, 2 * Math.PI);
        DC.fillStyle = `rgba(255, 120, 40, ${0.16 * alpha})`;
        DC.fill();
        DC.strokeStyle = `rgba(255, 140, 50, ${0.45 * alpha})`;
        DC.lineWidth = 2;
        DC.stroke();
        // 内圈浅光（偏金黄）
        DC.beginPath();
        DC.arc(z.x, z.y, radius * 0.6, 0, 2 * Math.PI);
        DC.fillStyle = `rgba(255, 190, 80, ${0.10 * alpha})`;
        DC.fill();
        // 中心愤怒标识😡（随脉动轻微缩放，凸显"狂暴"）
        DC.font = `${Math.round(15 + 3 * pulse)}px sans-serif`;
        DC.textAlign = 'center';
        DC.textBaseline = 'middle';
        DC.fillStyle = `rgba(255, 220, 150, ${0.95 * alpha})`;
        DC.fillText('😡', z.x, z.y);
    }

    // ---- 绘制法术特效（箭雨 །།། / 火球🔥 / 电磁脉冲 / 矿工潜伏土堆）----
    for (let s of game.spellEffects) {
        if (s.type === 'goblinBless') {
            // 🛕 神赐：金色祈祷文「Maglubiyet grash!」+ 神庙上方一缕金光向下照亮（0.8s：快淡入慢淡出）
            const progress = 1 - s.timer / s.maxTimer;              // 0→1
            const alpha = Math.max(0, Math.min(1, Math.min(progress / 0.15, s.timer / 0.25)));
            // ── 一缕金光：金色透明圆锥（顶点在上，向下散开，圆锥底与神庙底座同平面并罩住底座）──
            const beamTop = s.y - 44, beamBottom = s.y + 9;
            const coneHalf = 13;   // 圆锥底半径（神庙底座半宽9，外扩罩住）
            const breathe = 0.8 + 0.2 * Math.sin(Date.now() / 120); // 微呼吸
            const beamGrad = DC.createLinearGradient(0, beamTop, 0, beamBottom);
            beamGrad.addColorStop(0, `rgba(255, 236, 150, ${0.7 * alpha * breathe})`);
            beamGrad.addColorStop(0.45, `rgba(255, 215, 0, ${0.3 * alpha * breathe})`);
            beamGrad.addColorStop(1, 'rgba(255, 190, 0, 0.05)');
            DC.fillStyle = beamGrad;
            DC.beginPath();
            DC.moveTo(s.x, beamTop);          // 顶点（光源点）
            DC.lineTo(s.x + coneHalf, beamBottom);   // 右下
            DC.lineTo(s.x - coneHalf, beamBottom);   // 左下
            DC.closePath();
            DC.fill();
            // 圆锥底缘光环（罩住神庙底座的椭圆金圈）
            DC.beginPath();
            DC.ellipse(s.x, beamBottom, coneHalf, 3.5, 0, 0, 2 * Math.PI);
            DC.strokeStyle = `rgba(255, 215, 0, ${0.35 * alpha * breathe})`;
            DC.lineWidth = 1.2;
            DC.stroke();
            // 顶点光源光晕
            const haloGrad = DC.createRadialGradient(s.x, beamTop, 0, s.x, beamTop, 18);
            haloGrad.addColorStop(0, `rgba(255, 242, 180, ${0.6 * alpha})`);
            haloGrad.addColorStop(1, 'rgba(255, 215, 0, 0)');
            DC.fillStyle = haloGrad;
            DC.beginPath();
            DC.arc(s.x, beamTop, 18, 0, 2 * Math.PI);
            DC.fill();
            // ── 金色祈祷文（发光金字，整体绘制不逐字拆开）──
            DC.font = `bold ${s.size}px sans-serif`;
            DC.textAlign = 'center';
            DC.textBaseline = 'middle';
            DC.globalAlpha = alpha;
            DC.shadowColor = 'rgba(255, 215, 0, 0.95)';
            DC.shadowBlur = 8;
            DC.fillStyle = '#fff3c4';
            DC.fillText(s.char, s.x, s.y - 28);
            DC.shadowBlur = 0;
            DC.shadowColor = 'transparent';
        } else if (s.type === 'miner_tunnel') {
            // ⛏️ 矿工挖掘前进特效：土堆从己方主塔(x0,y0)一路挖地道移动到部署点(x,y)，最后抵达转为 miner_dig 原地潜伏
            const k = Math.min(1, Math.max(0, 1 - s.timer / s.maxTimer)); // 0→1 挖掘进度
            const tx = s.x0 + (s.x - s.x0) * k;
            const ty = s.y0 + (s.y - s.y0) * k;
            const bob = Math.sin(k * Math.PI * 12) * 1.5; // 掘进起伏（模拟一下一下刨土）
            DC.globalAlpha = 1;
            // 土丘（上半圆弓形，埋入地下感，移动中保持完整尺寸）
            DC.fillStyle = '#8B5A2B';
            DC.beginPath();
            DC.arc(tx, ty + 7 + bob, 12, Math.PI, Math.PI * 2);
            DC.closePath();
            DC.fill();
            DC.strokeStyle = 'rgba(0,0,0,0.25)';
            DC.lineWidth = 1;
            DC.stroke();
            // 土块细节
            DC.fillStyle = '#a07040';
            DC.fillRect(tx - 7, ty + 2 + bob, 5, 4);
            DC.fillRect(tx + 3, ty + 3 + bob, 4, 3);
            DC.fillStyle = '#6e4423';
            DC.fillRect(tx - 2, ty + 6 + bob, 3, 3);
            // 前方翻出的新土
            DC.fillStyle = '#8B5A2B';
            DC.fillRect(tx + 8, ty + 6 + bob, 6, 4);
            // 挖掘扬土：土渣沿移动反方向（土堆身后）持续抛出，带大小/颜色/抖动变化
            const ddx = s.x - s.x0, ddy = s.y - s.y0;
            const dl = Math.hypot(ddx, ddy) || 1;
            const udx = ddx / dl, udy = ddy / dl;   // 移动单位方向（土渣向身后抛）
            for (let di = 0; di < 6; di++) {
                const ph = (k * 5 + di / 6) % 1;                    // 每个土渣的飞行相位（循环抛出）
                const back = 8 + di * 4;                            // 离土丘后方的水平距离
                const rise = Math.sin(ph * Math.PI) * 12;           // 上抛回落高度
                const sx = tx - udx * back + Math.sin((k * 5 + di) * 13.7) * 3; // 横向微抖
                const sy = ty + 2 + bob - rise + Math.cos((k * 5 + di) * 9.3) * 2;
                const size = 2 + (di % 3);                          // 土渣大小 2~4px
                DC.globalAlpha = 0.9 * (1 - ph * 0.6);
                DC.fillStyle = di % 3 === 0 ? '#8B5A2B' : di % 3 === 1 ? '#a07040' : '#6e4423';
                DC.fillRect(sx - size / 2, sy - size / 2, size, size);
            }
            DC.globalAlpha = 1;
        } else if (s.type === 'miner_dig') {
            // 矿工潜伏土堆特效（纯特效：土堆随时间从无到有隆起成型，最后一刻矿工破土时消失）
            const k = Math.min(1, Math.max(0, 1 - s.timer / s.maxTimer)); // 0→1 挖地进度（土堆逐渐隆起）
            const grow = k;
            DC.globalAlpha = grow;
            // 土丘（上半圆弓形，埋入地下感；半径随隆起放大）
            DC.fillStyle = '#8B5A2B';
            DC.beginPath();
            DC.arc(s.x, s.y + 7, 12 * grow, Math.PI, Math.PI * 2);
            DC.closePath();
            DC.fill();
            DC.strokeStyle = 'rgba(0,0,0,0.25)';
            DC.lineWidth = 1;
            DC.stroke();
            // 土块细节（随土丘一起缩放，从中心向外展开）
            DC.fillStyle = '#a07040';
            DC.fillRect(s.x - 7 * grow, s.y + 2, 5 * grow, 4 * grow);
            DC.fillRect(s.x + 3 * grow, s.y + 3, 4 * grow, 3 * grow);
            DC.fillStyle = '#6e4423';
            DC.fillRect(s.x - 2 * grow, s.y + 6, 3 * grow, 3 * grow);
            // 前方翻出的新土
            DC.fillStyle = '#8B5A2B';
            DC.fillRect(s.x + 8 * grow, s.y + 6, 6 * grow, 4 * grow);
            DC.globalAlpha = 1;
        } else if (s.type === 'balloon_bomb') {
            // 🎈 气球兵炸弹下落特效：前60%时间💣从 y0 下落到 y1（脚下阴影处），后40%💥在落点放大淡出
            const t = s.maxTimer - s.timer;          // 已过时间
            const dropT = s.maxTimer * 0.6;          // 下落段时长
            DC.textAlign = 'center';
            DC.textBaseline = 'middle';
            if (t < dropT) {
                const k = t / dropT;
                DC.font = `bold ${s.size}px sans-serif`;
                DC.globalAlpha = 1;
                DC.fillText('💣', s.x, s.y0 + (s.y1 - s.y0) * k);
            } else {
                const k = (t - dropT) / Math.max(0.001, s.maxTimer - dropT);
                DC.font = `bold ${s.size * (1 + k * 1.5)}px sans-serif`;
                DC.globalAlpha = 1 - k;
                DC.fillText('💥', s.x, s.y1);
            }
        } else if (s.isPulse) {
            // 电磁炮白色脉冲光环
            const radius = s.size / 2;
            const alpha = s.timer / s.maxTimer;
            const grad = DC.createRadialGradient(s.x, s.y, 0, s.x, s.y, radius);
            grad.addColorStop(0, `rgba(255,255,255,${0.5 * alpha})`);
            grad.addColorStop(0.4, `rgba(200,230,255,${0.25 * alpha})`);
            grad.addColorStop(1, 'rgba(255,255,255,0)');
            DC.fillStyle = grad;
            DC.beginPath();
            DC.arc(s.x, s.y, radius, 0, 2 * Math.PI);
            DC.fill();
            // 外圈描边
            DC.strokeStyle = `rgba(255,255,255,${0.3 * alpha})`;
            DC.lineWidth = 2;
            DC.beginPath();
            DC.arc(s.x, s.y, radius * 0.85, 0, 2 * Math.PI);
            DC.stroke();
        } else if (s.centerX !== undefined) {
            // 粒子向中心靠拢，逐渐缩小消失
            const progress = 1 - s.timer / s.maxTimer;
            const drawX = s.x + (s.centerX - s.x) * progress;
            const drawY = s.y + (s.centerY - s.y) * progress;
            const alpha = s.timer / s.maxTimer;
            const scale = 0.3 + 0.7 * (s.timer / s.maxTimer);
            DC.font = `bold ${s.size * scale}px sans-serif`;
            DC.textAlign = 'center';
            DC.textBaseline = 'middle';
            DC.globalAlpha = alpha;
            DC.fillStyle = s.color || '#fff';
            DC.fillText(s.char, drawX, drawY);
        } else {
            // 精英技能渲染字：逐字紧凑绘制（字间距收紧到字符宽的85%），避免大号文字松散难看
            DC.font = `bold ${s.size}px sans-serif`;
            DC.textAlign = 'center';
            DC.textBaseline = 'middle';
            const alpha = Math.max(0.2, s.timer / s.maxTimer);
            DC.globalAlpha = alpha;
            DC.fillStyle = s.color || '#fff';
            const text = String(s.char);
            // ⚠️ emoji 是代理对（占2个UTF-16码元），split/Array.from 会拆坏成两个字符；
            //    含 emoji 的特效（💥⚡🔥等）直接整体绘制，仅纯文本多字才逐字紧凑排版
            const hasEmoji = /[\uD800-\uDFFF]/.test(text);
            const chars = hasEmoji ? [text] : Array.from(text);
            if (chars.length > 1) {
                const widths = chars.map(c => DC.measureText(c).width);
                let cx = s.x - widths.reduce((a, b) => a + b, 0) * 0.85 / 2;
                for (let i = 0; i < chars.length; i++) {
                    DC.fillText(chars[i], cx + widths[i] / 2, s.y);
                    cx += widths[i] * 0.85;
                }
            } else {
                DC.fillText(text, s.x, s.y);
            }
        }
    }
    DC.globalAlpha = 1;
    DC.textBaseline = 'alphabetic';

    // ---- 🛢️ 哥布林飞桶：木桶从主塔抛物线飞向落点 ----
    for (let b of game.goblinBarrels) {
        const k = 1 - b.timer / b.maxTimer;            // 0→1 飞行进度
        const bx = b.x0 + (b.x1 - b.x0) * k;
        const by = b.y0 + (b.y1 - b.y0) * k;
        const dist = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
        const arcH = Math.min(70, dist * 0.3 + 24);    // 抛物线弧高（随距离）
        const arcY = by - Math.sin(k * Math.PI) * arcH;
        // 地面阴影（随高度变淡变小）
        const lift = Math.sin(k * Math.PI);
        DC.globalAlpha = Math.max(0.08, 0.3 * (1 - lift));
        DC.fillStyle = '#000';
        DC.beginPath();
        DC.ellipse(bx, by, 7 * (1 - lift * 0.3), 3, 0, 0, Math.PI * 2);
        DC.fill();
        DC.globalAlpha = 1;
        // 木桶本体（最高点略放大，飞行中缓慢旋转1.5圈）
        const rot = k * Math.PI * 3;
        DC.save();
        DC.translate(bx, arcY);
        DC.rotate(rot);
        DC.font = `bold ${Math.round(24 + lift * 4)}px sans-serif`;
        DC.textAlign = 'center';
        DC.textBaseline = 'middle';
        DC.fillText('🛢️', 0, 0);
        DC.restore();
    }
    DC.textBaseline = 'alphabetic';

    // ---- 🌧️ 箭雨：三波箭束依次从主塔抛物线飞向落点（参考公主群箭：弧高更抖 + 越飞越散 + 地面阴影）----
    for (let f of game.arrowRainFlights) {
        if (f.launchDelay > 0) continue;             // 波次未到出发时刻（在主塔待命）不绘制
        const k = Math.min(1, Math.max(0, 1 - f.timer / f.maxTimer)); // 0→1 飞行进度（每波标准独立）
        const d0 = Math.max(1, Math.hypot(f.x1 - f.x0, f.y1 - f.y0));
        const arcH = Math.min(300, Math.max(150, d0 * 1.0)); // 弧高同公主（比迫击炮更抖）
        const lift = Math.sin(k * Math.PI);
        const baseX = f.x0 + (f.x1 - f.x0) * k;        // 地面投影基准点（水平插值）
        const baseY = f.y0 + (f.y1 - f.y0) * k;
        for (let a of f.arrows) {
            // 越飞越散：侧向偏移随飞行距离 t² 渐增（发射时集中、越飞越散，同公主群箭）
            const ax = baseX + a.latX * k * k;
            const ay = baseY + a.latY * k * k;
            const arcY = ay - arcH * lift;
            // 地面阴影（随高度变淡变小）
            DC.globalAlpha = Math.max(0.08, 0.3 * (1 - lift));
            DC.fillStyle = '#000';
            DC.beginPath();
            DC.ellipse(ax, ay, 4 * (1 - lift * 0.3), 2, 0, 0, Math.PI * 2);
            DC.fill();
            DC.globalAlpha = 1;
            // 箭支本体
            DC.font = 'bold 13px sans-serif';
            DC.textAlign = 'center';
            DC.textBaseline = 'middle';
            DC.fillStyle = 'rgba(255,255,255,0.95)';
            DC.fillText('།', ax, arcY);
        }
    }
    DC.textBaseline = 'alphabetic';

    // ---- 🔥 火球术：从主塔抛物线飞向落点（火球本体随高度变大 + 拖尾 + 地面阴影）----
    for (let f of game.fireballFlights) {
        const k = Math.min(1, Math.max(0, 1 - f.timer / f.maxTimer)); // 0→1 飞行进度
        const d0 = Math.max(1, Math.hypot(f.x1 - f.x0, f.y1 - f.y0));
        const arcH = Math.min(220, Math.max(100, d0 * 0.45)); // 火球弧高（比箭雨略低，更平直有力）
        const lift = Math.sin(k * Math.PI);
        const bx = f.x0 + (f.x1 - f.x0) * k;
        const by = f.y0 + (f.y1 - f.y0) * k;
        const arcY = by - arcH * lift;
        // 地面阴影（随高度变淡变小）
        DC.globalAlpha = Math.max(0.08, 0.3 * (1 - lift));
        DC.fillStyle = '#000';
        DC.beginPath();
        DC.ellipse(bx, by, 9 * (1 - lift * 0.3), 4, 0, 0, Math.PI * 2);
        DC.fill();
        DC.globalAlpha = 1;
        // 拖尾小火苗（沿轨迹后方2颗，随飞行渐隐）
        DC.font = 'bold 15px sans-serif';
        DC.textAlign = 'center';
        DC.textBaseline = 'middle';
        for (let t = 1; t <= 2; t++) {
            const kk = Math.max(0, k - t * 0.06);
            const tx = f.x0 + (f.x1 - f.x0) * kk;
            const ty = f.y0 + (f.y1 - f.y0) * kk - arcH * Math.sin(kk * Math.PI);
            DC.globalAlpha = 0.35 * (1 - t * 0.3) * (1 - lift * 0.5);
            DC.fillText('🔥', tx, ty);
        }
        DC.globalAlpha = 1;
        // 火球本体（越飞越高越大，落地前最亮）
        DC.font = `bold ${Math.round(26 + lift * 10)}px sans-serif`;
        DC.fillText('🔥', bx, arcY);
    }
    DC.textBaseline = 'alphabetic';

    // ---- 🚀 火箭法术：开洞(0.5s)→升空出屏(1.5s)→屏外(0.5s)→只有影子(0.5s)→火箭下落+影子变大(0.5s)→命中（共3.5s，蘑菇云1s）----
    for (const r of game.rocketFlights) {
        const elapsed = r.maxTimer - r.timer; // 0→3.5 总进度
        if (r._reflected) {
            // 返回弹道：被武僧超脱反弹，从武僧处直线飞向施法方大本营（尾焰 + 火箭）
            const rk = Math.min(1, Math.max(0, 1 - r.timer / r.maxTimer)); // 0→1
            const rx = r._sx + (r._bx - r._sx) * rk;
            const ry = r._sy + (r._by - r._sy) * rk;
            DC.textAlign = 'center';
            DC.textBaseline = 'middle';
            DC.font = 'bold 14px sans-serif';
            DC.globalAlpha = 0.75;
            DC.fillText('🔥', rx, ry + 10);
            DC.globalAlpha = 1;
            DC.font = 'bold 22px sans-serif';
            DC.fillText('🚀', rx, ry);
            DC.textBaseline = 'alphabetic';
            continue;
        }
        if (r.cloud) {
            // 蘑菇云尾段（1s消散）：灰白烟柱 + 橙灰蘑菇头，先升腾后淡出
            const kc = 1 - r.timer / r.maxTimer; // 0→1 消散进度
            const alpha = Math.max(0, 1 - kc * 1.15);
            const liftH = Math.sin(Math.min(1, kc * 3) * Math.PI); // 先升后落
            const bR = r.radius * 0.5;
            DC.globalAlpha = alpha * 0.6;
            DC.fillStyle = '#9e9e9e';
            DC.beginPath();
            DC.arc(r.x, r.y + 8, bR * 0.35, 0, Math.PI * 2);
            DC.fill();
            DC.globalAlpha = alpha * 0.85;
            DC.fillStyle = '#ffb74d';
            DC.beginPath();
            DC.arc(r.x - bR * 0.45, r.y - liftH * 9, bR * 0.55, 0, Math.PI * 2);
            DC.arc(r.x + bR * 0.45, r.y - liftH * 9, bR * 0.55, 0, Math.PI * 2);
            DC.arc(r.x, r.y - liftH * 11, bR * 0.7, 0, Math.PI * 2);
            DC.fill();
            DC.globalAlpha = 1;
            continue;
        }
        // 出洞前（0-0.5s）：主塔圆心开洞从2px快速扩大到15px
        if (elapsed < 0.5) {
            const k1 = elapsed / 0.5; // 0→1
            const holeR = 2 + 13 * k1;
            DC.fillStyle = 'rgba(15,15,25,0.92)';
            DC.beginPath();
            DC.arc(r.tx, r.ty, holeR, 0, Math.PI * 2);
            DC.fill();
            DC.strokeStyle = `rgba(255,255,255,${0.35 + 0.45 * k1})`;
            DC.lineWidth = 2;
            DC.stroke();
        } else if (elapsed < 2.0) {
            // 升空段（0.5-2.0s，共1.5s）：火箭从洞中钻出垂直升空到刚好飞出屏幕；洞在火箭出洞后立马合拢（前0.5s内合拢完）
            const k1 = (elapsed - 0.5) / 1.5; // 0→1 升空进度
            const holeK = Math.min(1, (elapsed - 0.5) / 0.5); // 洞合拢进度（0.5s内完成）
            const holeR = 15 * (1 - holeK);
            DC.fillStyle = 'rgba(15,15,25,0.92)';
            DC.beginPath();
            DC.arc(r.tx, r.ty, holeR, 0, Math.PI * 2);
            DC.fill();
            DC.strokeStyle = `rgba(255,255,255,${0.8 - 0.45 * holeK})`;
            DC.lineWidth = 2;
            DC.stroke();
            // 火箭：主塔圆心 → 刚好飞出屏幕（y=-25）
            const rocketY = r.ty - (r.ty + 25) * k1;
            DC.font = `bold ${Math.round(18 + 10 * k1)}px sans-serif`;
            DC.textAlign = 'center';
            DC.textBaseline = 'middle';
            DC.fillText('🚀', r.tx, rocketY);
            DC.textBaseline = 'alphabetic';
        } else if (elapsed < 2.5) {
            // 屏外段（2.0-2.5s）：火箭在屏幕外，短暂留白等待
        } else if (elapsed < 3.0) {
            // 只有影子（2.5-3.0s）：落点影子出现并逐渐变大
            const k2 = (elapsed - 2.5) / 0.5; // 0→1
            DC.globalAlpha = 0.15 + 0.3 * k2;
            DC.fillStyle = '#000';
            DC.beginPath();
            DC.ellipse(r.x, r.y, 8 + 12 * k2, 3.5 + 5 * k2, 0, 0, Math.PI * 2);
            DC.fill();
            DC.globalAlpha = 1;
        } else {
            // 落地段（3.0-3.5s）：火箭从屏幕外出现快速下落，影子继续变大，落地即命中
            const k3 = Math.min(1, (elapsed - 3) / 0.5); // 0→1
            const rx = r.x + Math.sin(elapsed * 10) * 3 * k3; // 轻微左右摆动
            const ry = -25 + (r.y + 25) * k3;               // 屏顶外→落点
            // 影子继续变大、变实
            DC.globalAlpha = 0.45 + 0.45 * k3;
            DC.fillStyle = '#000';
            DC.beginPath();
            DC.ellipse(r.x, r.y, 20 + 15 * k3, 8.5 + 7 * k3, 0, 0, Math.PI * 2);
            DC.fill();
            DC.globalAlpha = 1;
            // 火箭本体（越接近落点越大）+ 尾焰
            DC.textAlign = 'center';
            DC.textBaseline = 'middle';
            DC.font = `bold ${Math.round(10 + 8 * k3)}px sans-serif`;
            DC.globalAlpha = 0.75;
            DC.fillText('🔥', rx, ry + (8 + 6 * k3));
            DC.globalAlpha = 1;
            DC.font = `bold ${Math.round(16 + 14 * k3)}px sans-serif`;
            DC.fillText('🚀', rx, ry);
            DC.textBaseline = 'alphabetic';
        }
    }
    DC.textBaseline = 'alphabetic';

    // ---- 🪵 滚木：竖直木头（长65px厚7px，居中于释放点）横向滚动，表面木纹随滚动循环移动 + 滚动颠簸微摆 ----
    for (const lg of game.logRolls) {
        const lw = lg.logWidth / 2;   // 厚度一半 = 3.5
        const ll = lg.logLength;      // 竖直长度 = 65
        const rollPhase = (lg.x - lg.startX) / (ll * 0.9); // 滚动相位（每滚过约一个木头周长循环一圈）
        DC.save();
        DC.translate(lg.x, lg.y);
        DC.rotate(Math.sin(rollPhase * Math.PI * 2) * 0.06); // 滚动颠簸微摆
        // 主体：深棕竖直长条
        DC.fillStyle = '#7a4a21';
        DC.strokeStyle = '#4a2c10';
        DC.lineWidth = 2;
        DC.beginPath();
        DC.rect(-lw, -ll / 2, lw * 2, ll);
        DC.fill();
        DC.stroke();
        // 上下端半圆盖（木截面）
        DC.beginPath();
        DC.arc(0, -ll / 2 + lw, lw, Math.PI, 0);
        DC.closePath();
        DC.fill();
        DC.stroke();
        DC.beginPath();
        DC.arc(0, ll / 2 - lw, lw, 0, Math.PI);
        DC.closePath();
        DC.fill();
        DC.stroke();
        // 木纹：竖直纤维纹理随滚动沿水平方向循环移动（模拟横向滚动）
        DC.strokeStyle = 'rgba(214,172,112,0.45)';
        DC.lineWidth = 1.2;
        const off = ((lg.x - lg.startX) % 4 + 4) % 4;
        for (let k = 0; k < 3; k++) {
            const gx = -lw + 1.5 + ((k * 2 + off) % 4);
            DC.beginPath();
            DC.moveTo(gx, -ll / 2 + 7);
            DC.quadraticCurveTo(gx + 1.5, 0, gx, ll / 2 - 7);
            DC.stroke();
        }
        DC.restore();
    }

    // ---- 绘制炸弹💣（单位死后留下的，如攻城人/气球兵）----
    for (let b of game.bombs) {
        const progress = b.timer / b.maxTimer;
        const size = 22 + 6 * (1 - progress);  // 随时间略微缩小
        DC.font = `${size}px sans-serif`;
        DC.textAlign = 'center';
        DC.textBaseline = 'middle';
        DC.globalAlpha = 0.6 + 0.4 * (1 - progress);
        DC.fillText('💣', b.x, b.y);
        // 白色光圈闪烁提醒
        DC.beginPath();
        DC.arc(b.x, b.y, 18, 0, 2 * Math.PI);
        DC.strokeStyle = `rgba(255,255,255,${0.3 * (1 - progress)})`;
        DC.lineWidth = 2;
        DC.stroke();
    }
    DC.globalAlpha = 1;

    // ---- 绘制闪电链特效（雷电法师）----
    for (let c of game.lightningChains) {
        const alpha = c.timer / c.maxTimer;
        DC.strokeStyle = `rgba(255,255,255,${alpha})`;
        DC.lineWidth = 2.5;
        for (let i = 0; i < c.points.length - 1; i++) {
            const a = c.points[i];
            const b = c.points[i + 1];
            drawLightningBolt(a.x, a.y, b.x, b.y);
        }
    }

    // ---- 绘制落雷特效（雷电法师部署）----
    for (let d of game.deployLightnings) {
        const alpha = d.timer / d.maxTimer;
        const x1 = d.x, y1 = d.y - d.length;  // 从天而降
        const x2 = d.x, y2 = d.y;
        drawDeployThunderbolt(x1, y1, x2, y2, alpha);
    }

    // ---- 绘制范围冲击特效（超级骑士部署）----
    for (let d of game.deployEffects) {
        const progress = 1 - d.timer / d.maxTimer; // 0→1
        // static 静态提示环：固定真实半径、固定透明度（不扩散不淡出，到时直接消失）
        const alpha = d.static ? 0.6 : 1 - progress;
        const r = d.static ? d.radius : d.radius * (1 + progress * 0.5); // 动态环向外扩张
        const ringColor = d.color || '255, 230, 150'; // 可选颜色（默认金色；淡红用于攻击范围提示）
        DC.strokeStyle = `rgba(${ringColor}, ${alpha * 0.6})`;
        DC.lineWidth = 3;
        DC.beginPath();
        DC.arc(d.x, d.y, r, 0, 2 * Math.PI);
        DC.stroke();
        // 内圈淡光
        DC.fillStyle = `rgba(${ringColor}, ${alpha * 0.08})`;
        DC.beginPath();
        DC.arc(d.x, d.y, r, 0, 2 * Math.PI);
        DC.fill();
    }

    // ---- 绘制伤害飘字（受击红字 / 治疗绿字，向上飘并淡出）----
    DC.textAlign = 'center';
    DC.font = 'bold 13px sans-serif';
    for (let n of game.dmgNumbers) {
        const alpha = Math.min(1, n.timer / (n.maxTimer * 0.5));
        DC.globalAlpha = alpha;
        DC.fillStyle = 'rgba(0,0,0,0.85)';
        DC.fillText(n.amount, n.x + 1, n.y + 1);
        DC.fillStyle = n.color;
        DC.fillText(n.amount, n.x, n.y);
    }
    DC.globalAlpha = 1;

    // ---- 通用部署预览：选中卡牌时显示己方半场白色浅光框 + 鼠标位置范围圈/十字准心 ----
    // ---- 根据堡垒摧毁数计算双方的可部署区边界 ----
    let playerRightBoundary = RIVER_LEFT;
    if (game.bastionsLost.ai >= 2) playerRightBoundary = AI_BASTION_TOP.x;
    else if (game.bastionsLost.ai >= 1) playerRightBoundary = RIVER_RIGHT;

    let aiLeftBoundary = RIVER_RIGHT;
    if (game.bastionsLost.player >= 2) aiLeftBoundary = PLAYER_BASTION_TOP.x;
    else if (game.bastionsLost.player >= 1) aiLeftBoundary = RIVER_LEFT;

    // 蓝方（下方玩家）——技能卡（已部署精英）不生成部署预览，选中只作高亮/双击释放用
    if (game.uiState.selectedCardId && CARDS[game.uiState.selectedCardId] && !isSkillCardState('player', game.uiState.selectedCardId)) {
        const card = CARDS[game.uiState.selectedCardId];
        // 🔮 法术预览：同步显示场上【敌方】法术屏障的庇护范围（紫色圈提示禁放区域）
        if (card.type === 'spell') drawBarrierRanges('player');
        // 🔮 屏障卡部署预览：同步显示场上【我方】已有屏障的庇护范围（紫色圈）
        if (game.uiState.selectedCardId === 'spell_barrier') drawOwnBarrierRanges('player');
        // 🧭 烟引：阶段1（pending 放烟中）→ 虚线箭头+友军🧭闪烁虚影；阶段0 → 极速同款大圈(85)
        //    镜像烟引 pending 中选中镜像卡 → 同样走「下烟」虚线预览（镜像卡=下烟载体）
        const playerSmokeIsMirror = game.uiState.selectedCardId === 'mirror';
        const playerSmokePending = getSmokePending('player', playerSmokeIsMirror);
        if (game.uiState.selectedCardId === 'smoke_guide' || (playerSmokeIsMirror && playerSmokePending)) {
            if (playerSmokePending) drawSmokeReleasePreview('player', playerSmokeIsMirror);
            else drawSmokeGuideRangePreview('player');
        } else {
        // ★ 镜像法术：预览跟随被镜像的卡牌（镜像矿工→全屏白框、镜像迫击炮→射程圈+盲区内圈、镜像法术→淡红环等）
        let previewCard = card;
        let previewCardId = game.uiState.selectedCardId;
        if (previewCardId === 'mirror' && getMirrorCopiedCard('player') && CARDS[getMirrorCopiedCard('player')]) {
            previewCard = CARDS[getMirrorCopiedCard('player')];
            previewCardId = getMirrorCopiedCard('player');
        }
        // 整片可部署区域白色浅光框（法术/任意部署卡全屏，非法术动态边界渐隐；halfOnly 法术如滚木按军队规则限己方半场）
        if ((previewCard.type === 'spell' && !previewCard.halfOnly) || previewCard.anywhere) {
            drawDeployZoneFrame(0, W, false);
        } else {
            drawDeployZoneFrame(0, playerRightBoundary, true);
        }
        // 鼠标位置部署指示器（范围圈/十字准心 + 颜色区分；治疗范围预览用绿色；塔类显示射程圈+最小射程内圈；小屋显示出兵范围）
        const hasRadius = previewCard.type === 'spell' || previewCard.deploySpell || previewCard.healRadius
            || (previewCard.type === 'tower' && previewCard.range)
            || (previewCardId === 'goblin_hut' && previewCard.spawnRange);
        const isSpellLike = previewCard.type === 'spell';
        const canPlace = (isSpellLike && !previewCard.halfOnly)
            ? !isSpellBlockedByBarrier('player', game.uiState.mouseX, game.uiState.mouseY) // 🔮 法术预览：鼠标在敌方屏障庇护区内→不可部署（预览变红）
            : canDeployHere(previewCardId, 'player', game.uiState.mouseX, game.uiState.mouseY, game.entities, game.bastionsLost.ai, game.bastionsLost.player)
              && !(isSpellLike && isSpellBlockedByBarrier('player', game.uiState.mouseX, game.uiState.mouseY)); // 半场法术（滚木）仍受屏障庇护限制
        // ⛺ 营地：显示索敌圈+巡逻轨道范围预览（与悬停一致，替代十字准心）
        if (previewCardId === 'camp') {
            // 🪏 拆除模式：鼠标移到己方已部署营地上 → 部署预览变为拆除图标
            const ownCamp = game.entities.find(e => e.cardId === 'camp' && e.team === 'player' && e.hp > 0
                && Math.abs(e.x - game.uiState.mouseX) <= 15 && Math.abs(e.y - game.uiState.mouseY) <= 15);
            if (ownCamp) {
                drawDemolishPreview(game.uiState.mouseX, game.uiState.mouseY, ownCamp);
            } else {
                drawCampDeployPreview(game.uiState.mouseX, game.uiState.mouseY, previewCard, canPlace, false);
            }
        } else if (previewCardId === 'spell_barrier') {
            // 🔮 法术屏障：显示庇护范围圈预览（与悬停一致，替代十字准心）
            const barrierR = previewCard.barrierRange || 200;
            DC.beginPath();
            DC.arc(game.uiState.mouseX, game.uiState.mouseY, barrierR, 0, 2 * Math.PI);
            DC.fillStyle = canPlace ? 'rgba(138,123,255,0.12)' : 'rgba(255,80,80,0.12)';
            DC.fill();
            DC.setLineDash([8, 6]);
            DC.strokeStyle = canPlace ? 'rgba(138,123,255,0.8)' : 'rgba(255,80,80,0.8)';
            DC.lineWidth = 1.5;
            DC.stroke();
            DC.setLineDash([]);
        } else if (previewCardId === 'log') {
            // 🪵 滚木：部署预览 = 大致法术影响范围（长=滚动距离560px × 宽=剑仙攻击范围直径65px），起始处画小木头示意
            const rollDist = previewCard.rollDistance || 560;
            const halfW = previewCard.radius || 32.5;
            const x0 = game.uiState.mouseX; // 蓝方向右滚
            DC.fillStyle = canPlace ? 'rgba(180,130,70,0.15)' : 'rgba(255,80,80,0.15)';
            DC.fillRect(x0, game.uiState.mouseY - halfW, rollDist, halfW * 2);
            DC.setLineDash([6, 4]);
            DC.strokeStyle = canPlace ? 'rgba(180,130,70,0.8)' : 'rgba(255,80,80,0.8)';
            DC.lineWidth = 2;
            DC.strokeRect(x0, game.uiState.mouseY - halfW, rollDist, halfW * 2);
            DC.setLineDash([]);
            // 滚动方向箭头
            DC.fillStyle = canPlace ? 'rgba(180,130,70,0.9)' : 'rgba(255,80,80,0.9)';
            DC.font = '16px sans-serif';
            DC.textAlign = 'center';
            DC.textBaseline = 'middle';
            DC.fillText('→', x0 + rollDist / 2, game.uiState.mouseY);
            // 起始位置小木头示意（竖直长65厚7）
            const ll = previewCard.logLength || 65;
            const lw = (previewCard.logWidth || 7) / 2;
            DC.fillStyle = '#7a4a21';
            DC.strokeStyle = '#4a2c10';
            DC.lineWidth = 1.5;
            DC.fillRect(x0 - lw, game.uiState.mouseY - ll / 2, lw * 2, ll);
            DC.strokeRect(x0 - lw, game.uiState.mouseY - ll / 2, lw * 2, ll);
            DC.textAlign = 'left';
            DC.textBaseline = 'alphabetic';
        } else if (hasRadius) {
            const radius = previewCard.type === 'spell' ? previewCard.radius
                : previewCard.deploySpell ? previewCard.deploySpell.radius
                : (previewCard.healRadius || (previewCardId === 'goblin_hut' ? previewCard.spawnRange : previewCard.range));
            const isHeal = !!previewCard.healRadius && !previewCard.deploySpell; // 战斗天使登场治疗范围
            DC.beginPath();
            DC.arc(game.uiState.mouseX, game.uiState.mouseY, radius, 0, 2 * Math.PI);
            DC.fillStyle = isHeal
                ? (canPlace ? 'rgba(46,204,113,0.18)' : 'rgba(255,0,0,0.15)')
                : (canPlace ? 'rgba(255,255,0,0.2)' : 'rgba(255,0,0,0.15)');
            DC.fill();
            DC.strokeStyle = isHeal ? (canPlace ? '#2ecc71' : '#ef4444') : (canPlace ? '#facc15' : '#ef4444');
            DC.lineWidth = 2;
            DC.setLineDash([]);
            DC.stroke();
            // 塔类最小射程内圈（如迫击炮75px近身盲区）
            if (previewCard.type === 'tower' && previewCard.minRange) {
                DC.beginPath();
                DC.arc(game.uiState.mouseX, game.uiState.mouseY, previewCard.minRange, 0, 2 * Math.PI);
                DC.setLineDash([2, 4]);
                DC.strokeStyle = canPlace ? 'rgba(255,120,80,0.8)' : 'rgba(255,80,80,0.8)';
                DC.lineWidth = 1.5;
                DC.stroke();
                DC.setLineDash([]);
            }
        } else {
            drawCrosshair(game.uiState.mouseX, game.uiState.mouseY, canPlace ? '#facc15' : '#ef4444');
        }
        }
    }
    // 红方（上方玩家）— 双人本地模式（技能卡不生成部署预览）
    if (game.uiState.selectedCardId2 && CARDS[game.uiState.selectedCardId2] && !isSkillCardState('ai', game.uiState.selectedCardId2)) {
        const card = CARDS[game.uiState.selectedCardId2];
        // 🔮 法术预览：同步显示场上【敌方】法术屏障的庇护范围（紫色圈提示禁放区域）
        if (card.type === 'spell') drawBarrierRanges('ai');
        // 🔮 屏障卡部署预览：同步显示场上【我方】已有屏障的庇护范围（紫色圈）
        if (game.uiState.selectedCardId2 === 'spell_barrier') drawOwnBarrierRanges('ai');
        // 🧭 烟引：阶段1（pending 放烟中）→ 虚线箭头+友军🧭闪烁虚影；阶段0 → 极速同款大圈(85)
        //    镜像烟引 pending 中选中镜像卡 → 同样走「下烟」虚线预览（镜像卡=下烟载体）
        const aiSmokeIsMirror = game.uiState.selectedCardId2 === 'mirror';
        const aiSmokePending = getSmokePending('ai', aiSmokeIsMirror);
        if (game.uiState.selectedCardId2 === 'smoke_guide' || (aiSmokeIsMirror && aiSmokePending)) {
            if (aiSmokePending) drawSmokeReleasePreview('ai', aiSmokeIsMirror);
            else drawSmokeGuideRangePreview('ai');
        } else {
        let previewCard = card;
        let previewCardId = game.uiState.selectedCardId2;
        if (previewCardId === 'mirror' && getMirrorCopiedCard('ai') && CARDS[getMirrorCopiedCard('ai')]) {
            previewCard = CARDS[getMirrorCopiedCard('ai')];
            previewCardId = getMirrorCopiedCard('ai');
        }
        // 整片可部署区域白色浅光框（法术/任意部署卡全屏，非法术动态边界渐隐；halfOnly 法术如滚木按军队规则限己方半场）
        if ((previewCard.type === 'spell' && !previewCard.halfOnly) || previewCard.anywhere) {
            drawDeployZoneFrame(0, W, false);
        } else {
            drawDeployZoneFrame(aiLeftBoundary, W, true);
        }
        // 鼠标位置部署指示器（治疗范围预览用绿色；塔类显示射程圈+最小射程内圈；小屋显示出兵范围）
        const hasRadius = previewCard.type === 'spell' || previewCard.deploySpell || previewCard.healRadius
            || (previewCard.type === 'tower' && previewCard.range)
            || (previewCardId === 'goblin_hut' && previewCard.spawnRange);
        const isSpellLike = previewCard.type === 'spell';
        const canPlace = (isSpellLike && !previewCard.halfOnly)
            ? !isSpellBlockedByBarrier('ai', game.uiState.mouseX, game.uiState.mouseY) // 🔮 法术预览：鼠标在敌方屏障庇护区内→不可部署（预览变红）
            : canDeployHere(previewCardId, 'ai', game.uiState.mouseX, game.uiState.mouseY, game.entities, game.bastionsLost.ai, game.bastionsLost.player)
              && !(isSpellLike && isSpellBlockedByBarrier('ai', game.uiState.mouseX, game.uiState.mouseY)); // 半场法术（滚木）仍受屏障庇护限制
        // ⛺ 营地：显示索敌圈+巡逻轨道范围预览（与悬停一致，替代十字准心）
        if (previewCardId === 'camp') {
            // 🪏 拆除模式：鼠标移到己方已部署营地上 → 部署预览变为拆除图标
            const ownCamp = game.entities.find(e => e.cardId === 'camp' && e.team === 'ai' && e.hp > 0
                && Math.abs(e.x - game.uiState.mouseX) <= 15 && Math.abs(e.y - game.uiState.mouseY) <= 15);
            if (ownCamp) {
                drawDemolishPreview(game.uiState.mouseX, game.uiState.mouseY, ownCamp);
            } else {
                drawCampDeployPreview(game.uiState.mouseX, game.uiState.mouseY, previewCard, canPlace, true);
            }
        } else if (previewCardId === 'spell_barrier') {
            // 🔮 法术屏障：显示庇护范围圈预览（红方配色，替代十字准心）
            const barrierR = previewCard.barrierRange || 200;
            DC.beginPath();
            DC.arc(game.uiState.mouseX, game.uiState.mouseY, barrierR, 0, 2 * Math.PI);
            DC.fillStyle = canPlace ? 'rgba(224,106,176,0.12)' : 'rgba(255,107,157,0.2)';
            DC.fill();
            DC.setLineDash([8, 6]);
            DC.strokeStyle = canPlace ? 'rgba(224,106,176,0.8)' : '#ff6b9d';
            DC.lineWidth = 1.5;
            DC.stroke();
            DC.setLineDash([]);
        } else if (previewCardId === 'log') {
            // 🪵 滚木：部署预览 = 大致法术影响范围（长=滚动距离560px × 宽=剑仙攻击范围直径65px），起始处画小木头示意
            const rollDist = previewCard.rollDistance || 560;
            const halfW = previewCard.radius || 32.5;
            const x0 = game.uiState.mouseX; // 红方向左滚
            DC.fillStyle = canPlace ? 'rgba(224,106,176,0.12)' : 'rgba(255,107,157,0.2)';
            DC.fillRect(x0 - rollDist, game.uiState.mouseY - halfW, rollDist, halfW * 2);
            DC.setLineDash([6, 4]);
            DC.strokeStyle = canPlace ? 'rgba(224,106,176,0.8)' : '#ff6b9d';
            DC.lineWidth = 2;
            DC.strokeRect(x0 - rollDist, game.uiState.mouseY - halfW, rollDist, halfW * 2);
            DC.setLineDash([]);
            // 滚动方向箭头
            DC.fillStyle = canPlace ? 'rgba(224,106,176,0.9)' : '#ff6b9d';
            DC.font = '16px sans-serif';
            DC.textAlign = 'center';
            DC.textBaseline = 'middle';
            DC.fillText('←', x0 - rollDist / 2, game.uiState.mouseY);
            // 起始位置小木头示意（竖直长65厚7）
            const ll = previewCard.logLength || 65;
            const lw = (previewCard.logWidth || 7) / 2;
            DC.fillStyle = '#7a4a21';
            DC.strokeStyle = '#4a2c10';
            DC.lineWidth = 1.5;
            DC.fillRect(x0 - lw, game.uiState.mouseY - ll / 2, lw * 2, ll);
            DC.strokeRect(x0 - lw, game.uiState.mouseY - ll / 2, lw * 2, ll);
            DC.textAlign = 'left';
            DC.textBaseline = 'alphabetic';
        } else if (hasRadius) {
            const radius = previewCard.type === 'spell' ? previewCard.radius
                : previewCard.deploySpell ? previewCard.deploySpell.radius
                : (previewCard.healRadius || (previewCardId === 'goblin_hut' ? previewCard.spawnRange : previewCard.range));
            const isHeal = !!previewCard.healRadius && !previewCard.deploySpell;
            DC.beginPath();
            DC.arc(game.uiState.mouseX, game.uiState.mouseY, radius, 0, 2 * Math.PI);
            DC.fillStyle = isHeal
                ? (canPlace ? 'rgba(46,204,113,0.2)' : 'rgba(255,150,200,0.2)')
                : (canPlace ? 'rgba(255,255,255,0.2)' : 'rgba(255,150,200,0.2)');
            DC.fill();
            DC.strokeStyle = isHeal ? (canPlace ? '#2ecc71' : '#ff6b9d') : (canPlace ? '#ffffff' : '#ff6b9d');
            DC.lineWidth = 2;
            DC.setLineDash([]);
            DC.stroke();
            // 塔类最小射程内圈（如迫击炮75px近身盲区）
            if (previewCard.type === 'tower' && previewCard.minRange) {
                DC.beginPath();
                DC.arc(game.uiState.mouseX, game.uiState.mouseY, previewCard.minRange, 0, 2 * Math.PI);
                DC.setLineDash([2, 4]);
                DC.strokeStyle = canPlace ? 'rgba(255,120,80,0.8)' : 'rgba(255,150,200,0.8)';
                DC.lineWidth = 1.5;
                DC.stroke();
                DC.setLineDash([]);
            }
        } else {
            drawCrosshair(game.uiState.mouseX, game.uiState.mouseY, canPlace ? '#ffffff' : '#ff6b9d');
        }
    }
    }

    // ---- 游戏结束画面 ----
    if (game.gameOver) {
        DC.fillStyle = 'rgba(0,0,0,0.7)';
        DC.fillRect(0, 0, W, H);
        DC.fillStyle = 'white';
        DC.font = 'bold 36px sans-serif';
        DC.textAlign = 'center';
        let endText;
        if (game.gameMode === 'local_multi') {
            endText = game.winner === 'player' ? '🔵 蓝方 获胜！' : '🔴 红方 获胜！';
        } else {
            endText = game.winner === 'player' ? '🎉 你赢了！' : '💀 AI 获胜';
        }
        DC.fillText(endText, W / 2, H / 2);
    }

    // ---- 悬停 UI（必须在 draw 内部最后一步调用）----
        drawHoverUI();
    } finally {
        for (const e of proj) { e.x = e._projX; e.y = e._projY; }  // 恢复逻辑坐标
    }
}

/** 绘制主塔（圆形建筑 + 血量光环，与堡垒同款风格） */
function drawMainTower(b) {
    const isPlayer = b.team === 'player';
    const color = isPlayer ? '#3498db' : '#f44336';   // 蓝 / 正红（与主塔守卫、堡垒统一）
    const pct = b.hp / b.maxHp;
    const mix = Math.max(0.3, pct);

    // ── 圆形主体（透明度随血量变化）──
    DC.fillStyle = color;
    DC.globalAlpha = mix;
    DC.beginPath();
    DC.arc(b.x, b.y, 28, 0, 2 * Math.PI);
    DC.fill();
    DC.globalAlpha = 1.0;

    // ── 白色边框 ──
    DC.strokeStyle = 'white';
    DC.lineWidth = 2.5;
    DC.stroke();

    // ── 血量环 ──
    const hasShield = (b.shield || 0) > 0;
    if (hasShield) {
        // 🛡️ 有护盾：外圈蓝色护盾环（按盾比例）+ 内圈生命环（按血量），盾破后还原单环
        const shieldPct = (b.shield || 0) / (b.maxShield || 1);
        DC.beginPath();
        DC.arc(b.x, b.y, 32, 0, 2 * Math.PI * shieldPct);
        DC.strokeStyle = '#4fc3f7';  // 护盾蓝（同通用护盾条颜色）
        DC.lineWidth = 3;
        DC.stroke();
        DC.beginPath();
        DC.arc(b.x, b.y, 27, 0, 2 * Math.PI * pct);
        DC.strokeStyle = pct > 0.5 ? '#2ecc71' : (pct > 0.25 ? '#f1c40f' : '#e74c3c');
        DC.lineWidth = 3;
        DC.stroke();
    } else {
        DC.beginPath();
        DC.arc(b.x, b.y, 32, 0, 2 * Math.PI * pct);
        DC.strokeStyle = pct > 0.5 ? '#2ecc71' : (pct > 0.25 ? '#f1c40f' : '#e74c3c');
        DC.lineWidth = 3;
        DC.stroke();
    }
}

/**
 * 🔷 复制法术的复制体：本体建模整体染亮蓝 + 50%半透明（特性与本体一致，仅HP=1）
 * 通用实现：在离屏画布上调用与本体完全相同的绘制函数 → 整体染成亮蓝色 → 半透明贴回主画布
 * 复制体不显示名字/血条/进度条等标签：离屏绘制时包装 fillText（文字）与 fillRect（扁条）跳过
 */
function drawCopyUnit(e) {
    // 0) 包装离屏 ctx：隐藏名字等文字（fillText→no-op）、隐藏血条/进度条（成对扁矩形→跳过）
    const _ft = copyCtx.fillText.bind(copyCtx);
    const _fr = copyCtx.fillRect.bind(copyCtx);
    let lastFlat = null; // {x,y,w,h} 疑似血条底色（扁矩形），等待配对的条色
    copyCtx.fillText = function () {};
    copyCtx.fillRect = function (x, y, w, h) {
        const isFlat = (h <= 6 && w >= 14); // 血条/进度条特征：扁矩形
        if (lastFlat && isFlat && lastFlat.x === x && lastFlat.y === y && lastFlat.h === h && w <= lastFlat.w) {
            lastFlat = null; // 底色+条色成对出现 → 两者都跳过
            return;
        }
        if (isFlat) { lastFlat = { x, y, w, h }; return; } // 疑似血条底色，暂存等配对
        lastFlat = null;
        _fr(x, y, w, h);
    };
    // 1) 离屏画布上绘制本体建模（世界坐标平移到离屏中心 60,60）
    copyCtx.save();
    copyCtx.clearRect(0, 0, COPY_CANVAS_SIZE, COPY_CANVAS_SIZE);
    copyCtx.translate(COPY_CANVAS_SIZE / 2 - e.x, COPY_CANVAS_SIZE / 2 - e.y);
    DC = copyCtx;
    drawUnitBody(e);
    DC = ctx;
    copyCtx.restore();
    // 还原离屏 ctx 的包装方法
    copyCtx.fillText = _ft;
    copyCtx.fillRect = _fr;
    // 2) 整体染成亮蓝色（source-in 只保留建模形状，垂直渐变增加立体感）
    copyCtx.globalCompositeOperation = 'source-in';
    const g = copyCtx.createLinearGradient(0, 0, 0, COPY_CANVAS_SIZE);
    g.addColorStop(0, '#7ff4ff');
    g.addColorStop(0.5, '#00d9ff');
    g.addColorStop(1, '#00a8d9');
    copyCtx.fillStyle = g;
    copyCtx.fillRect(0, 0, COPY_CANVAS_SIZE, COPY_CANVAS_SIZE);
    copyCtx.globalCompositeOperation = 'source-over';
    // 3) 以 50% 透明度贴回主画布（建模半透明，下方战场可见；无名字/血条）
    DC.save();
    DC.globalAlpha = 0.5;
    DC.drawImage(copyCanvas, e.x - COPY_CANVAS_SIZE / 2, e.y - COPY_CANVAS_SIZE / 2);
    DC.restore();
}

/** 绘制单位本体建模（按类型/卡牌分发；复制体也会走这里，画到离屏再染色） */
function drawUnitBody(e) {
    if (e.cardId === 'cannon_cart') { drawCannonCart(e); return; } // 炮车/炮台：底座圆→方形，自绘
    if (e.type === 'troop') {
        if (e.cardId === 'night_witch') drawNightWitch(e);
        else if (e.cardId === 'witch') drawWitch(e);
        else if (e.cardId === 'bat') drawBat(e);
        else if (e.cardId === 'fly_swarm') drawFlySwarm(e);
        else if (e.cardId === 'lightning_wizard') drawLightningWizard(e);
        else if (e.cardId === 'ice_bean') drawIceBean(e);
        else if (e.cardId === 'fire_bean') drawFireBean(e);
        else if (e.cardId === 'ghost') drawGhost(e);
        else if (e.cardId === 'miner') drawMiner(e);
        else if (e.cardId === 'ranger') drawRanger(e);
        else if (e.cardId === 'archer') drawArcher(e);
        else if (e.cardId === 'hunter') drawHunter(e);
        else if (e.cardId === 'ninja') drawNinja(e);
        else if (e.cardId === 'goblin_thrower') drawGoblinThrower(e);
        else if (e.cardId === 'goblin_melee') drawGoblinMelee(e);
        else if (e.cardId === 'goblin_blowgun') drawGoblinBlowgun(e);
        else if (e.cardId === 'goblin_giant') drawGoblinGiant(e);
        else if (e.cardId === 'goblin_bomber') drawGoblinBomber(e);
        else if (e.cardId === 'siege_man') drawSiegeMan(e);
        else if (e.cardId === 'firework_gunner') drawFireworkGunner(e);
        else if (e.cardId === 'tram_squad') drawTram(e);
        else if (e.cardId === 'knight') drawKnight(e);
        else if (e.cardId === 'barrel_guard') drawBarrelGuard(e);
        else if (e.cardId === 'bow_queen') drawBowQueen(e);
        else if (e.cardId === 'fat_tiger') drawFatTiger(e);
        else if (e.cardId === 'ronin') drawRonin(e);
        else if (e.cardId === 'sword_immortal') drawSwordImmortal(e);
        else if (e.cardId === 'fisherman') drawFisherman(e);
        else if (e.cardId === 'shadow_assassin') drawShadowAssassin(e);
        else if (e.cardId === 'battle_angel') drawBattleAngel(e);
        else if (e.cardId === 'wizard') drawWizard(e);
        else if (e.cardId === 'worm') drawWorm(e);
        else if (e.cardId === 'immunity_disciple') drawImmunityDisciple(e);
        else if (e.cardId === 'dragon_egg' && e._isEgg) drawDragonEgg(e);
        else if (e.cardId === 'dragon_egg' && !e._isEgg) drawHatchedDragon(e);
        else if (e.cardId === 'hades') drawHades(e);
        else if (e.cardId === 'berserker') drawBerserker(e);
        else if (e.cardId === 'monk') drawMonk(e);
        else if (e.cardId === 'mini_pekka') drawMiniPekka(e);
        else if (e.cardId === 'big_pekka') drawBigPekka(e);
        else if (e.cardId === 'hog') drawHog(e);
        else if (e.cardId === 'electro_cannon') drawElectroCannon(e);
        else if (e.cardId === 'super_knight') drawSuperKnight(e);
        else if (e.cardId === 'water_carrier') drawWaterCarrier(e);
        else if (e.cardId === 'crafted_water_carrier') drawCraftedWaterCarrier(e);
        else if (e.cardId === 'small_water_carrier') drawSmallWaterCarrier(e);
        else if (e.cardId === 'small_ice_man') drawSmallIceMan(e);
        else if (e.cardId === 'inferno_dragon') drawInfernoDragon(e);
        else if (e.cardId === 'lava_hound') drawLavaHound(e);
        else if (e.cardId === 'lava_pup') drawLavaPup(e);
        else if (e.cardId === 'balloon') drawBalloon(e);
        else if (e.flying) drawDragon(e);
        else drawTroop(e);
    } else if (e.type === 'healer') {
        drawHealer(e);
    } else if (e.type === 'main_tower') {
        drawMainTower(e);
    } else if (e.type === 'bastion') {
        drawBastion(e);
    } else if (e.type === 'tower') {
        drawBuilding(e, false);
    } else if (e.type === 'barrack' || e.type === 'collector') {
        drawBuilding(e, false);
    }
}

/* ═══════════════════════════════════════════
 * 通用绘制样板（第一层提取：零视觉变化）
 *  drawUnitShadow —— 椭圆阴影
 *  drawNameBar    —— 名称 + 血条
 * ═══════════════════════════════════════════ */

/** 椭圆阴影 —— ⚠️ 飞行单位特有标识！只有 flying 单位才调用（地面单位一律不投影） */
function drawUnitShadow(unit, dy, rx, ry, alpha) {
    DC.fillStyle = `rgba(0,0,0,${alpha !== undefined ? alpha : 0.2})`;
    DC.beginPath();
    DC.ellipse(unit.x, unit.y + dy, rx, ry, 0, 0, 2 * Math.PI);
    DC.fill();
}

/** 名称 + 血条（o: name, nameY, barY, barW=30, barH=4, font, color, baseline, barColor） */
function drawNameBar(unit, o) {
    const barW = o.barW || 28, barH = o.barH || 3.5;
    // 血条：仅受伤后显示（血或盾任一项未满即显示，双满不显示），整体上移10px（累计：4px+6px）
    const barY = o.barY - 10;
    unit._barY = barY; // 记录血条位置，供状态图标（buff栏）挂在其正上方
    const injured = (unit.hp || 0) < (unit.maxHp || unit.hp || 1)
        || (unit.shield || 0) < (unit.maxShield || unit.shield || 0);
    if (!injured) return;
    DC.fillStyle = '#333';
    DC.fillRect(unit.x - barW / 2, barY, barW, barH);
    // ★ 通用护盾（第二层血条）：先画生命段，有盾时亮蓝护盾段按自身比例直接盖在生命条上；
    //   护盾掉完露出生命段，总条长度恒定不变（护盾唯一特殊：能完整挡下最后一次攻击）
    const maxHp = unit.maxHp || unit.hp || 1;
    const maxShield = unit.maxShield || unit.shield || 0;
    const lifeW = barW * Math.min(1, (unit.hp || 0) / maxHp);
    DC.fillStyle = o.barColor || (unit.team === 'player' ? '#2e86de' : '#ee5a24');
    DC.fillRect(unit.x - barW / 2, barY, lifeW, barH);
    const shieldW = maxShield > 0 ? barW * Math.min(1, (unit.shield || 0) / maxShield) : 0;
    if (shieldW > 0) {
        DC.fillStyle = '#4fc3f7';
        DC.fillRect(unit.x - barW / 2, barY, shieldW, barH);
    }
}

/** 浮动版名称+血条（浮动类单位专用通模板）：
 *  与 drawNameBar 完全一致（28×3.5、受伤才显示、护盾叠层），
 *  唯一区别：barY 自动叠加建模浮动量 unit._floatY（由各建模函数在算完 floatOffset 后写入） */
function drawNameBarFloat(unit, o) {
    drawNameBar(unit, Object.assign({}, o, { barY: (o.barY || 0) + (unit._floatY || 0) }));
}

/** 通用蓄力条模板：血条正上方紧贴（无间隙），与血条同宽 28×3.5。
 *  progress 0~1；color 进度颜色；text 可选小字（画在条右端外侧，如冥王"x魂"）。
 *  需在 drawNameBar 之后调用（依赖其记录的 unit._barY）。 */
function drawChargeBar(unit, progress, color, text, textStyle) {
    const barW = 28, barH = 3.5;
    const y = (unit._barY !== undefined ? unit._barY : unit.y - 12) - barH;
    DC.fillStyle = '#333';
    DC.fillRect(unit.x - barW / 2, y, barW, barH);
    const p = Math.max(0, Math.min(1, progress));
    if (p > 0) {
        DC.fillStyle = color || '#e67e22';
        DC.fillRect(unit.x - barW / 2, y, barW * p, barH);
    }
    if (text) {
        const ts = textStyle || {};
        DC.fillStyle = ts.color || '#d2b4de';
        DC.font = ts.font || '7px sans-serif';
        DC.textAlign = 'left';
        DC.textBaseline = 'middle';
        DC.fillText(text, unit.x + barW / 2 + 2, y + barH / 2);
        DC.textAlign = 'center';
        DC.textBaseline = 'alphabetic';
    }
}

function drawDeployRing(item) {
    if (item._dugSpawn || item._tunnelDone) return;  // 矿工土堆挖掘前进/潜伏期：不画部署延迟时间环（计时仅驱动流程）
    const progress = 1 - item.timer / item.totalDelay;  // 0 → 1
    const radius = 24 + (1 - progress) * 6;             // 环逐渐缩小
    const color = item.isPlayer ? '#4caf50' : '#f44336';
    const alpha = 0.3 + progress * 0.5;

    // 外圈光晕
    DC.beginPath();
    DC.arc(item.x, item.y, radius + 4, 0, 2 * Math.PI);
    DC.fillStyle = color;
    DC.globalAlpha = alpha * 0.15;
    DC.fill();
    DC.globalAlpha = 1;

    // 外环轮廓
    DC.beginPath();
    DC.arc(item.x, item.y, radius, 0, 2 * Math.PI);
    DC.strokeStyle = color;
    DC.globalAlpha = alpha;
    DC.lineWidth = 2.5;
    DC.stroke();
    DC.globalAlpha = 1;

    // 进度弧（从12点钟方向顺时针扫过）
    const startAngle = -Math.PI / 2;
    const endAngle = startAngle + 2 * Math.PI * progress;
    DC.beginPath();
    DC.arc(item.x, item.y, radius, startAngle, endAngle);
    DC.strokeStyle = color;
    DC.globalAlpha = Math.min(1, alpha * 1.3);
    DC.lineWidth = 4;
    DC.stroke();
    DC.globalAlpha = 1;

    // 小装饰点（在进度末端画一个小圆点）
    if (progress > 0 && progress < 1) {
        const dotAngle = startAngle + 2 * Math.PI * progress;
        const dx = item.x + Math.cos(dotAngle) * radius;
        const dy = item.y + Math.sin(dotAngle) * radius;
        DC.beginPath();
        DC.arc(dx, dy, 3, 0, 2 * Math.PI);
        DC.fillStyle = color;
        DC.globalAlpha = 0.8;
        DC.fill();
        DC.globalAlpha = 1;
    }

    // 🛕 哥布林神庙·神赐接收提示：神庙在场时释放哥布林卡，部署位置浮现👺虚影0.5秒（与部署延迟时间环同时出现）
    if (item.templeBlessed && item.timer > item.totalDelay - 0.5) {
        const ghostT = (item.totalDelay - item.timer) / 0.5;         // 0→1（前0.5秒内）
        const ghostAlpha = ghostT < 0.5 ? ghostT * 2 : (1 - ghostT) * 2; // 淡入→淡出
        const ghostSize = 20 + ghostT * 8;                            // 逐渐放大
        const ghostY = item.y - 4 - ghostT * 8;                       // 轻微上浮
        DC.save();
        DC.globalAlpha = Math.min(1, ghostAlpha) * 0.9;
        DC.font = `${Math.round(ghostSize)}px "Segoe UI Emoji","Noto Color Emoji",sans-serif`;
        DC.textAlign = 'center';
        DC.textBaseline = 'middle';
        DC.fillText('👺', item.x, ghostY);
        DC.restore();
    }
}

/** 🧭 烟引·放烟点特效：countdown 计时环（参考部署延迟转圈环）+ active 持续烟雾发散（10秒） */
function drawSmokeGuideEffects() {
    // 🧭 多友军同烟点（一条引导=一个友军，全指向同一放烟点）：按 (team,tx,ty) 分组，
    //    每组只画「剩余时间最长」的一条特效 → 烟点只显示一套烟/环（不再叠放多套）
    const sgByPos = new Map();
    for (const sg of game.smokeGuides) {
        const key = sg.team + '|' + sg.tx.toFixed(1) + '|' + sg.ty.toFixed(1);
        const remain = sg.phase === 'countdown' ? sg.countdown : sg.timer;
        const prev = sgByPos.get(key);
        if (!prev || remain > (prev.phase === 'countdown' ? prev.countdown : prev.timer)) sgByPos.set(key, sg);
    }
    for (const sg of sgByPos.values()) {
        if (sg.phase === 'countdown') {
            // —— 计时特效（参考部署延迟：外圈光晕+外环轮廓+进度弧）——
            const progress = 1 - sg.countdown / sg.countdownMax;
            const radius = 24 + (1 - progress) * 6;   // 环逐渐缩小
            const color = sg.isPlayer ? '#4caf50' : '#f44336';
            const alpha = 0.3 + progress * 0.5;

            // 外圈光晕
            DC.beginPath();
            DC.arc(sg.tx, sg.ty, radius + 4, 0, 2 * Math.PI);
            DC.fillStyle = color;
            DC.globalAlpha = alpha * 0.15;
            DC.fill();
            DC.globalAlpha = 1;

            // 外环轮廓
            DC.beginPath();
            DC.arc(sg.tx, sg.ty, radius, 0, 2 * Math.PI);
            DC.strokeStyle = color;
            DC.globalAlpha = alpha;
            DC.lineWidth = 2.5;
            DC.stroke();
            DC.globalAlpha = 1;

            // 进度弧（从12点钟方向顺时针扫过）
            const startAngle = -Math.PI / 2;
            const endAngle = startAngle + 2 * Math.PI * progress;
            DC.beginPath();
            DC.arc(sg.tx, sg.ty, radius, startAngle, endAngle);
            DC.strokeStyle = color;
            DC.globalAlpha = Math.min(1, alpha * 1.3);
            DC.lineWidth = 4;
            DC.stroke();
            DC.globalAlpha = 1;
        } else {
            // —— active：持续烟雾发散特效（粒子向外扩散上升；★不全程淡出：保持完整，仅最后0.5秒快速渐变消失）——
            const remain = Math.max(0, sg.timer / sg.maxTimer); // 0→1
            // ★ 渐变系数：全程≈1（烟雾完整），仅最后0.5秒内从1线性降到0（快速消失，不再一直慢慢变淡）
            const fadeSec = 0.5; // 最后0.5秒渐变消失
            const fade = Math.min(1, remain / (fadeSec / sg.maxTimer));
            const t = performance.now() / 1000;
            const smokeR = CARDS.smoke_guide.smokeRadius || 12;

            // 中心浓烟（脉动，缩小版）
            DC.beginPath();
            DC.arc(sg.tx, sg.ty, 5 + 1.5 * Math.sin(t * 2.5), 0, 2 * Math.PI);
            DC.fillStyle = `rgba(190, 190, 195, ${0.28 * fade})`;
            DC.fill();

            // 烟雾粒子（确定性动画：垂直上升为主 + 轻微横向摆动，烟柱向上拉高，不往四周散）
            for (let i = 0; i < 12; i++) {
                const h = ((t * 26 + i * 11) % 42);                        // 上升高度 0→42（变高）
                const sway = Math.sin(t * 1.6 + i * 1.7) * (3 + h * 0.1);  // 轻微横向摆动，越高摆越大
                const px = sg.tx + sway;
                const py = sg.ty - h;                                      // 向上发散
                const size = 5 + ((t * 3 + i * 2) % 5) * (1 - h / 45);     // 越高越小
                const alpha = 0.3 * fade * (1 - h / 44);                   // 越高越淡（★整体不全程淡出，最后0.5s消失）
                DC.beginPath();
                DC.arc(px, py, size, 0, 2 * Math.PI);
                DC.fillStyle = `rgba(205, 205, 210, ${alpha})`;
                DC.fill();
            }

            // 烟点地面范围圈（淡灰虚线，★同样仅最后0.5s淡出）
            DC.beginPath();
            DC.arc(sg.tx, sg.ty, smokeR, 0, 2 * Math.PI);
            DC.strokeStyle = `rgba(205, 205, 210, ${0.28 * fade})`;
            DC.lineWidth = 1.5;
            DC.setLineDash([4, 4]);
            DC.stroke();
            DC.setLineDash([]);

            // —— 🧭 部署延迟同款时间环（剩余时间倒计时：弧长随剩余时间变短；★整体不全程淡出，最后0.5s消失；缩小+变淡版）——
            const ringColor = sg.isPlayer ? '#4caf50' : '#f44336';
            const ringR = 10 + (1 - remain) * 2;              // 环随时间略微缩小（缩小一大半：10~12）
            const ringAlpha = (0.15 + remain * 0.25) * fade;  // 环内渐变 + ★整体仅最后0.5s淡出（最大约0.4）

            // 外圈光晕
            DC.beginPath();
            DC.arc(sg.tx, sg.ty, ringR + 4, 0, 2 * Math.PI);
            DC.fillStyle = ringColor;
            DC.globalAlpha = ringAlpha * 0.15;
            DC.fill();
            DC.globalAlpha = 1;

            // 外环轮廓
            DC.beginPath();
            DC.arc(sg.tx, sg.ty, ringR, 0, 2 * Math.PI);
            DC.strokeStyle = ringColor;
            DC.globalAlpha = ringAlpha;
            DC.lineWidth = 2.5;
            DC.stroke();
            DC.globalAlpha = 1;

            // 剩余时间进度弧（从12点钟方向顺时针，弧长=剩余比例，随时间变短）
            const startAngle = -Math.PI / 2;
            const endAngle = startAngle + 2 * Math.PI * remain;
            DC.beginPath();
            DC.arc(sg.tx, sg.ty, ringR, startAngle, endAngle);
            DC.strokeStyle = ringColor;
            DC.globalAlpha = Math.min(1, ringAlpha * 1.3);
            DC.lineWidth = 4;
            DC.stroke();
            DC.globalAlpha = 1;

            // 小装饰点（在剩余进度弧末端，同部署延迟）
            if (remain > 0 && remain < 1) {
                const dotAngle = startAngle + 2 * Math.PI * remain;
                const dx = sg.tx + Math.cos(dotAngle) * ringR;
                const dy = sg.ty + Math.sin(dotAngle) * ringR;
                DC.beginPath();
                DC.arc(dx, dy, 3, 0, 2 * Math.PI);
                DC.fillStyle = ringColor;
                DC.globalAlpha = ringAlpha;
                DC.fill();
                DC.globalAlpha = 1;
            }
        }
    }
}

/** 🧭 烟引·阶段0 范围预览（未扣费，与极速法术同款大圈）；屏障内变红 */
function drawSmokeGuideRangePreview(team) {
    const radius = CARDS.smoke_guide.radius || 85;
    const mx = game.uiState.mouseX, my = game.uiState.mouseY;
    const canPlace = !isSpellBlockedByBarrier(team, mx, my); // 🔮 屏障内禁放 → 变红
    // 极速同款大圈：黄色半透明填充 + 黄边
    DC.beginPath();
    DC.arc(mx, my, radius, 0, 2 * Math.PI);
    DC.fillStyle = canPlace ? 'rgba(255,255,0,0.2)' : 'rgba(255,0,0,0.15)';
    DC.fill();
    DC.strokeStyle = canPlace ? '#facc15' : '#ef4444';
    DC.lineWidth = 2;
    DC.setLineDash([]);
    DC.stroke();
}

/** 🧭 烟引·阶段1 放烟预览（pending 中，已扣费）：鼠标⬇️ + 与各待引导友军虚线相连 + 友军🧭闪烁虚影 */
function drawSmokeReleasePreview(team, isMirror) {
    const pend = getSmokePending(team, !!isMirror);
    if (!pend) return;
    const mx = game.uiState.mouseX, my = game.uiState.mouseY;
    const canPlace = !isSpellBlockedByBarrier(team, mx, my); // 🔮 屏障内禁放 → 变红
    // 快照中仍存活的待引导友军
    const units = game.entities.filter(e => pend.unitIds.includes(e.id) && e.hp > 0 && e.team === team);

    // 友军 🧭 闪烁虚影 + 与鼠标虚线相连
    const bob = Math.sin(performance.now() / 300) * 4;
    DC.setLineDash([5, 5]);
    DC.strokeStyle = canPlace ? 'rgba(255,255,255,0.6)' : 'rgba(255,80,80,0.6)';
    DC.lineWidth = 2;
    for (const unit of units) {
        DC.beginPath();
        DC.moveTo(unit.x, unit.y - 26 + bob);
        DC.lineTo(mx, my);
        DC.stroke();
        DC.globalAlpha = 0.45 + 0.35 * Math.sin(performance.now() / 180 + unit.id);
        DC.font = '24px sans-serif';
        DC.textAlign = 'center';
        DC.textBaseline = 'middle';
        DC.fillText('🧭', unit.x, unit.y - 30 + bob);
        DC.globalAlpha = 1;
    }
    DC.setLineDash([]);

    // 鼠标位置 ⬇️（大号指示）+ 放烟合法性
    DC.font = '30px sans-serif';
    DC.fillStyle = canPlace ? 'rgba(255,255,255,0.95)' : 'rgba(255,80,80,0.95)';
    DC.fillText('⬇️', mx, my - 14);
}

/** 绘制地面兵种（圆形 + 名称 + 血条） */
function drawTroop(unit) {
    const isPlayer = unit.team === 'player';
    const isGiant = CARDS[unit.cardId]?.name === '巨人';
    const isMainGuard = unit.cardId === 'main_tower_guard';
    // 注：goblin_melee/goblin_thrower 是「哥布林」本体，走专属绘制函数；isGoblin 分支实际全是骷髅家族
    const isGoblin = unit.cardId === 'goblin_gang' || unit.cardId === 'goblin' || unit.cardId === 'skeleton_guard';
    const radius = isGiant ? 16 : (isMainGuard ? 16 : (isGoblin ? 7 : 10));  // 巨人/主塔守卫圆身同熔岩猎犬(16)；骷髅家族建模再次略微缩小 8→7

    // ---- 🦔 反甲巨人：保持巨人轮廓与尺寸的专属立绘 ----
    if (unit.cardId === 'anti_armor_giant') {
        drawAntiArmorGiant(unit);
        return;
    }

    // ---- 剑士：大圆头 + 小正方体身子 ----
    if (unit.cardId === 'swordman') {
        const headColor = isPlayer ? '#3498db' : '#e67e22';
        const bodyColor = isPlayer ? '#2980b9' : '#c0392b';

        // ── 小正方体身子（在下方）──
        DC.fillStyle = bodyColor;
        DC.fillRect(unit.x - 6, unit.y + 2, 12, 11);
        DC.strokeStyle = 'rgba(255,255,255,0.5)';
        DC.lineWidth = 1;
        DC.strokeRect(unit.x - 6, unit.y + 2, 12, 11);

        // ── 大圆头（在上方）──
        DC.fillStyle = headColor;
        DC.beginPath();
        DC.arc(unit.x, unit.y - 4, 10, 0, 2 * Math.PI);
        DC.fill();
        DC.strokeStyle = 'white';
        DC.lineWidth = 1.5;
        DC.stroke();

        // 名称 + 血条
        drawNameBar(unit, {
            name: CARDS[unit.cardId]?.name || '',
            nameY: unit.y - 22,
            barY: unit.y - 18,
        });

        return; // ← 剑士绘制完毕
    }

    // ---- 👸 公主：专属建模（肤色圆头+金色长发+小皇冠+粉色长裙+小弓）----
    if (unit.cardId === 'princess') {
        drawPrincess(unit);
        return;
    }
    // ---- 王子增援：剑士建模（大圆头+方块身）+ 盔甲纹路 ----
    if (unit.cardId === 'prince_reinforcement') {
        const headColor = isPlayer ? '#3498db' : '#e67e22';
        const bodyColor = isPlayer ? '#2980b9' : '#c0392b';
        const armorColor = 'rgba(255,255,255,0.7)';

        // ── 小正方体身子（在下方）──
        DC.fillStyle = bodyColor;
        DC.fillRect(unit.x - 6, unit.y + 2, 12, 11);
        DC.strokeStyle = 'rgba(255,255,255,0.5)';
        DC.lineWidth = 1;
        DC.strokeRect(unit.x - 6, unit.y + 2, 12, 11);

        // ── 盔甲纹路①：胸甲中缝 + 腰带 ──
        DC.strokeStyle = armorColor;
        DC.lineWidth = 1;
        DC.beginPath();
        DC.moveTo(unit.x, unit.y + 3);    // 胸甲中缝
        DC.lineTo(unit.x, unit.y + 8);
        DC.stroke();
        DC.beginPath();
        DC.moveTo(unit.x - 5, unit.y + 9); // 腰带
        DC.lineTo(unit.x + 5, unit.y + 9);
        DC.stroke();

        // ── 盔甲纹理③：V形胸甲（中缝两侧斜向肩部）+ 腰带金色铆钉 ──
        DC.strokeStyle = armorColor;
        DC.lineWidth = 1;
        DC.beginPath();
        DC.moveTo(unit.x - 4.5, unit.y + 2.5); // 左肩
        DC.lineTo(unit.x, unit.y + 5.5);       // 胸甲中缝
        DC.lineTo(unit.x + 4.5, unit.y + 2.5); // 右肩
        DC.stroke();
        DC.fillStyle = '#f1c40f';
        DC.beginPath();
        DC.arc(unit.x - 4.5, unit.y + 9, 1.1, 0, 2 * Math.PI);
        DC.fill();
        DC.beginPath();
        DC.arc(unit.x + 4.5, unit.y + 9, 1.1, 0, 2 * Math.PI);
        DC.fill();

        // ── 大圆头（在上方）──
        DC.fillStyle = headColor;
        DC.beginPath();
        DC.arc(unit.x, unit.y - 4, 10, 0, 2 * Math.PI);
        DC.fill();
        DC.strokeStyle = 'white';
        DC.lineWidth = 1.5;
        DC.stroke();

        // ── 盔甲纹路②：头盔下沿弧线 ──
        DC.strokeStyle = armorColor;
        DC.lineWidth = 1;
        DC.beginPath();
        DC.arc(unit.x, unit.y - 4, 7, Math.PI * 0.15, Math.PI * 0.85);
        DC.stroke();

        // ── ✨ 头部纹理：高光 + 腮红（与王子家族同款）──
        DC.fillStyle = 'rgba(255,255,255,0.5)';
        DC.beginPath();
        DC.arc(unit.x - 4, unit.y - 7, 3.4, 0, 2 * Math.PI);
        DC.fill();
        DC.fillStyle = 'rgba(255,150,170,0.6)';
        DC.beginPath();
        DC.arc(unit.x - 6.5, unit.y - 1, 2.4, 0, 2 * Math.PI);
        DC.fill();
        DC.beginPath();
        DC.arc(unit.x + 6.5, unit.y - 1, 2.4, 0, 2 * Math.PI);
        DC.fill();

        // ── ✨ 头盔顶部金色盔缨（王子护卫身份）──
        DC.strokeStyle = '#f1c40f';
        DC.lineWidth = 1.6;
        DC.beginPath();
        DC.moveTo(unit.x, unit.y - 14);
        DC.lineTo(unit.x, unit.y - 17);
        DC.stroke();
        DC.fillStyle = '#f1c40f';
        DC.beginPath();
        DC.arc(unit.x, unit.y - 18, 1.8, 0, 2 * Math.PI);
        DC.fill();
        DC.strokeStyle = '#b8860b';
        DC.lineWidth = 0.8;
        DC.stroke();

        // 名称 + 血条
        drawNameBar(unit, {
            name: CARDS[unit.cardId]?.name || BASE_UNITS[unit.cardId]?.name || '',
            nameY: unit.y - 22,
            barY: unit.y - 18,
        });

        return; // ← 王子增援绘制完毕
    }

    // 👑 小王子：圆头 + 金色王冠 + 手持十字弩（专属绘制）
    if (unit.cardId === 'little_prince') {
        drawLittlePrince(unit);
        return;
    }

    let bodyColor = isPlayer ? '#3498db' : '#e67e22';
    if (isGiant) bodyColor = '#bdc3c7';  // 巨人保持灰白
    if (isMainGuard) bodyColor = isPlayer ? '#3498db' : '#f44336';  // 主塔守卫：蓝方蓝 / 红方正红
    if (isGoblin) bodyColor = '#ffffff';  // 骷髅：白色建模
    if (unit.cardId === 'strong_goblin') bodyColor = '#1e8449';  // 强壮哥布林：统一暗绿
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, radius, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = isGoblin ? '#bbbbbb' : 'white';  // 骷髅配浅灰描边，轮廓更清晰
    if (isMainGuard) {
        // ★ 主塔守卫：灰白大圆（同巨人）身上画一把黑色叉 ❌
        DC.stroke();  // 圆轮廓描边（仅主塔守卫，其他兵种保持原样不描边）
        DC.strokeStyle = '#2c3e50';
        DC.lineWidth = 4;
        DC.beginPath();
        DC.moveTo(unit.x - 9, unit.y - 9);
        DC.lineTo(unit.x + 9, unit.y + 9);
        DC.moveTo(unit.x - 9, unit.y + 9);
        DC.lineTo(unit.x + 9, unit.y - 9);
        DC.stroke();
    }
    if (unit.cardId === 'skeleton_guard' && (unit.shield || 0) > 0) {
        // ★ 守卫骷髅：护盾存在时带黑色小盔甲（头顶黑色小圆盔 + 胸前黑色小方块）；护盾破碎后还原为普通骷髅外观
        DC.fillStyle = '#2c3e50';
        DC.beginPath();
        DC.arc(unit.x, unit.y - radius * 0.35, radius * 0.58, Math.PI, 0);
        DC.fill();
        DC.fillRect(unit.x - radius * 0.5, unit.y + radius * 0.04, radius * 1.0, radius * 0.65);
    }

    // ── 强壮哥布林特征：暗蓝斜带（左上→右下），与投矛手/近战哥布林同款 ──
    if (unit.cardId === 'strong_goblin') {
        DC.save();
        DC.beginPath();
        DC.arc(unit.x, unit.y, radius, 0, 2 * Math.PI);
        DC.clip();
        DC.strokeStyle = '#1a5276';
        DC.lineWidth = 5;
        DC.beginPath();
        DC.moveTo(unit.x - radius, unit.y - radius);
        DC.lineTo(unit.x + radius, unit.y + radius);
        DC.stroke();
        DC.restore();
    }

    let name = CARDS[unit.cardId]?.name;
    if (unit.cardId === 'goblin_gang') name = '骷髅';  // 卡牌叫骷髅海，实体叫骷髅
    if (!name && BASE_UNITS[unit.cardId]) name = BASE_UNITS[unit.cardId].name;
    // 🦴 骷髅（骷髅海实体/女巫召唤/墓碑出兵）：血条按"受伤才显示"规矩（与其他单位一致）
    // 名称 + 血条
    drawNameBar(unit, {
        name: name || '',
        nameY: unit.y - radius - 7,
        barY: unit.y - radius - 12,
    });
}

/** 👑 绘制小王子（圆头 + 金色王冠 + 手持十字弩朝向目标，十字弩塔同款弩造型；远程兵种） */
function drawLittlePrince(unit) {
    const isPlayer = unit.team === 'player';
    const headColor = isPlayer ? '#3498db' : '#e67e22';

    // ── 大圆头 ──
    DC.fillStyle = headColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y - 4, 10, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── ✨ 头部纹理：高光 + 腮红 ──
    // 头顶左上高光（半透明白色小圆）
    DC.fillStyle = 'rgba(255,255,255,0.5)';
    DC.beginPath();
    DC.arc(unit.x - 4, unit.y - 7, 3.4, 0, 2 * Math.PI);
    DC.fill();
    // 两侧腮红（粉色小圆）
    DC.fillStyle = 'rgba(255,150,170,0.6)';
    DC.beginPath();
    DC.arc(unit.x - 6.5, unit.y - 1, 2.4, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.arc(unit.x + 6.5, unit.y - 1, 2.4, 0, 2 * Math.PI);
    DC.fill();

    // ── 👑 金色王冠（头顶：三尖皇冠 + 红宝石，加大并下移）──
    DC.fillStyle = '#f1c40f';
    DC.beginPath();
    DC.moveTo(unit.x - 10, unit.y - 13);  // 左下
    DC.lineTo(unit.x - 10, unit.y - 17);  // 左竖
    DC.lineTo(unit.x - 5,  unit.y - 22);  // 左尖
    DC.lineTo(unit.x,      unit.y - 16);  // 中凹
    DC.lineTo(unit.x + 5,  unit.y - 22);  // 右尖
    DC.lineTo(unit.x + 10, unit.y - 17);  // 右竖
    DC.lineTo(unit.x + 10, unit.y - 13);  // 右下
    DC.closePath();
    DC.fill();
    DC.strokeStyle = '#b8860b';
    DC.lineWidth = 1;
    DC.stroke();
    // 皇冠纹理：暗金色竖条纹（底部间隔装饰）
    DC.strokeStyle = '#b8860b';
    DC.lineWidth = 1;
    DC.beginPath();
    DC.moveTo(unit.x - 6, unit.y - 16);
    DC.lineTo(unit.x - 6, unit.y - 13.5);
    DC.moveTo(unit.x - 2, unit.y - 15);
    DC.lineTo(unit.x - 2, unit.y - 13.5);
    DC.moveTo(unit.x + 2, unit.y - 15);
    DC.lineTo(unit.x + 2, unit.y - 13.5);
    DC.moveTo(unit.x + 6, unit.y - 16);
    DC.lineTo(unit.x + 6, unit.y - 13.5);
    DC.stroke();
    // 皇冠两侧金色小圆珠（外凸点缀）
    DC.fillStyle = '#f1c40f';
    DC.strokeStyle = '#b8860b';
    DC.lineWidth = 0.8;
    DC.beginPath();
    DC.arc(unit.x - 10, unit.y - 12.8, 1.6, 0, 2 * Math.PI);
    DC.fill();
    DC.stroke();
    DC.beginPath();
    DC.arc(unit.x + 10, unit.y - 12.8, 1.6, 0, 2 * Math.PI);
    DC.fill();
    DC.stroke();
    // 中央红宝石
    DC.fillStyle = '#e74c3c';
    DC.beginPath();
    DC.arc(unit.x, unit.y - 15.5, 2.5, 0, 2 * Math.PI);
    DC.fill();

    // ── 十字弩（拿在手上，朝向攻击目标，十字弩塔同款造型）──
    let angle = 0;
    if (unit.targetId) {
        const target = game.entities.find(en => en.id === unit.targetId && en.hp > 0 && !en._stealthed);
        if (target) {
            angle = Math.atan2(target.y - unit.y, target.x - unit.x);
        }
    }
    const woodColor = isPlayer ? '#8a6a45' : '#9a4040';
    const bowColor  = isPlayer ? '#3a2e22' : '#4a1f1f';
    DC.save();
    DC.translate(unit.x, unit.y + 2);   // 弩在圆下方（手持位置，更靠上）
    DC.rotate(angle);

    // 弩身：长方形杆（从中心延伸到前端）
    DC.fillStyle = woodColor;
    DC.fillRect(-6, -1.8, 18, 3.6);
    DC.strokeStyle = '#ddd';
    DC.lineWidth = 1;
    DC.strokeRect(-6, -1.8, 18, 3.6);

    // 弧形弩弓：开口朝右的弓臂（弧线），位置偏后（杆前端伸出为弩槽）
    const bowTipAng = 80 * Math.PI / 180; // 弓臂张角 ±80°
    const bowR = 8, bowCX = 1;
    DC.strokeStyle = bowColor;
    DC.lineWidth = 2.5;
    DC.beginPath();
    DC.arc(bowCX, 0, bowR, -bowTipAng, bowTipAng);
    DC.stroke();

    // 弩弦：连接两弓梢的直线
    const tipX = bowCX + bowR * Math.cos(bowTipAng);
    const tipY = bowR * Math.sin(bowTipAng);
    DC.strokeStyle = '#ccc';
    DC.lineWidth = 1.2;
    DC.beginPath();
    DC.moveTo(tipX, -tipY);
    DC.lineTo(tipX, tipY);
    DC.stroke();

    // 弓梢点缀
    DC.fillStyle = bowColor;
    DC.beginPath();
    DC.arc(tipX, -tipY, 1.5, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.arc(tipX, tipY, 1.5, 0, 2 * Math.PI);
    DC.fill();

    DC.restore();

    // 名称 + 血条
    drawNameBar(unit, {
        name: CARDS[unit.cardId]?.name || '',
        nameY: unit.y - 24,
        barY: unit.y - 20,
    });
}

/** 👸 绘制公主（肤色圆头 + 金色长发 + 小皇冠 + 粉色长裙 + 手持小弓朝向目标，远程群攻兵种） */
function drawPrincess(unit) {
    const isPlayer = unit.team === 'player';
    const dressColor = isPlayer ? '#ff9fc2' : '#e67e22'; // 长裙：蓝方粉 / 红方橙红

    // ── 整体建模缩小 0.8（保持原比例；名字/血条不缩放，见函数尾部）──
    DC.save();
    DC.translate(unit.x, unit.y);
    DC.scale(0.8, 0.8);
    DC.translate(-unit.x, -unit.y);

    // ── 金色长发（头两侧垂下的发丝）──
    DC.fillStyle = '#f6c453';
    DC.beginPath();
    DC.arc(unit.x - 7, unit.y + 1, 4.5, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.arc(unit.x + 7, unit.y + 1, 4.5, 0, 2 * Math.PI);
    DC.fill();

    // ── 大圆头（肤色）──
    DC.fillStyle = '#ffe3c9';
    DC.beginPath();
    DC.arc(unit.x, unit.y - 5, 8.5, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── ✨ 头部纹理：高光 + 腮红 ──
    DC.fillStyle = 'rgba(255,255,255,0.5)';
    DC.beginPath();
    DC.arc(unit.x - 3.5, unit.y - 7.5, 3, 0, 2 * Math.PI);
    DC.fill();
    DC.fillStyle = 'rgba(255,150,170,0.6)';
    DC.beginPath();
    DC.arc(unit.x - 5.5, unit.y - 2, 2.2, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.arc(unit.x + 5.5, unit.y - 2, 2.2, 0, 2 * Math.PI);
    DC.fill();

    // ── 👑 金色小皇冠（头顶，三尖 + 中央红宝石）──
    DC.fillStyle = '#f1c40f';
    DC.beginPath();
    DC.moveTo(unit.x - 6.5, unit.y - 12.5);
    DC.lineTo(unit.x - 6.5, unit.y - 16);
    DC.lineTo(unit.x - 3, unit.y - 19);
    DC.lineTo(unit.x, unit.y - 15);
    DC.lineTo(unit.x + 3, unit.y - 19);
    DC.lineTo(unit.x + 6.5, unit.y - 16);
    DC.lineTo(unit.x + 6.5, unit.y - 12.5);
    DC.closePath();
    DC.fill();
    DC.strokeStyle = '#b8860b';
    DC.lineWidth = 0.8;
    DC.stroke();
    DC.fillStyle = '#e74c3c';
    DC.beginPath();
    DC.arc(unit.x, unit.y - 14.5, 1.5, 0, 2 * Math.PI);
    DC.fill();

    // ── 粉色长裙（钟形 + 腰带 + 裙摆装饰线）──
    DC.fillStyle = dressColor;
    DC.beginPath();
    DC.moveTo(unit.x - 5.5, unit.y + 2);
    DC.lineTo(unit.x + 5.5, unit.y + 2);
    DC.lineTo(unit.x + 9, unit.y + 13);
    DC.quadraticCurveTo(unit.x + 10, unit.y + 15, unit.x + 6, unit.y + 15.5);
    DC.lineTo(unit.x - 6, unit.y + 15.5);
    DC.quadraticCurveTo(unit.x - 10, unit.y + 15, unit.x - 9, unit.y + 13);
    DC.closePath();
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.5)';
    DC.lineWidth = 1;
    DC.stroke();
    DC.beginPath();
    DC.moveTo(unit.x - 7.5, unit.y + 9.5);
    DC.quadraticCurveTo(unit.x, unit.y + 11.5, unit.x + 7.5, unit.y + 9.5);
    DC.stroke();
    DC.strokeStyle = 'rgba(255,255,255,0.7)';
    DC.beginPath();
    DC.moveTo(unit.x - 4, unit.y + 3.5);
    DC.lineTo(unit.x + 4, unit.y + 3.5);
    DC.stroke();

    // ── 小弓（拿在手上，朝向攻击目标，金色弓臂 + 弓弦）──
    let angle = 0;
    if (unit.targetId) {
        const target = game.entities.find(en => en.id === unit.targetId && en.hp > 0 && !en._stealthed);
        if (target) angle = Math.atan2(target.y - unit.y, target.x - unit.x);
    }
    DC.save();
    DC.translate(unit.x, unit.y + 1);
    DC.rotate(angle);
    const bowTipAng = 75 * Math.PI / 180;
    const bowR = 7;
    DC.strokeStyle = '#f1c40f';
    DC.lineWidth = 2;
    DC.beginPath();
    DC.arc(0, 0, bowR, -bowTipAng, bowTipAng);
    DC.stroke();
    const tipX = bowR * Math.cos(bowTipAng), tipY = bowR * Math.sin(bowTipAng);
    DC.strokeStyle = '#ccc';
    DC.lineWidth = 1;
    DC.beginPath();
    DC.moveTo(tipX, -tipY);
    DC.lineTo(tipX, tipY);
    DC.stroke();
    DC.restore();
    DC.restore(); // 结束整体缩放

    // 名称 + 血条（保持原大小，不随建模缩小）
    drawNameBar(unit, {
        name: CARDS[unit.cardId]?.name || '',
        nameY: unit.y - 21,
        barY: unit.y - 17,
    });
}

/** 绘制木桶护卫（骑士体型 + 木桶头盔 + 长柄卫矛；盾条由通用 drawNameBar 绘制） */
function drawBarrelGuard(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = isPlayer ? '#286090' : '#a93226';
    const armorColor = isPlayer ? '#5dade2' : '#d98880';
    const wood = '#9a642f';
    const woodLight = '#c38b52';
    const metal = isPlayer ? '#bfe8ff' : '#ffe0d6';

    // 长柄卫矛：自动对准当前目标，攻击时沿目标方向前戳再收回（剑仙同款节奏）
    let spearAngle = unit._spearAngle;
    if (spearAngle === undefined) {
        const target = unit.targetId && game.entities.find(en => en.id === unit.targetId && en.hp > 0);
        spearAngle = target ? Math.atan2(target.y - unit.y, target.x - unit.x) : 0;
    }
    const spearTimer = unit._spearTimer || 0;
    const spearThrust = spearTimer > 0
        ? Math.sin((1 - Math.min(spearTimer / 0.3, 1)) * Math.PI) * 10
        : 0;
    const sx = unit.x + Math.cos(spearAngle) * spearThrust;
    const sy = unit.y + Math.sin(spearAngle) * spearThrust;
    const px = Math.cos(spearAngle), py = Math.sin(spearAngle);
    const nx = -py, ny = px;
    const shaftStartX = sx - px * 20, shaftStartY = sy - py * 20;
    const shaftEndX = sx + px * 20, shaftEndY = sy + py * 20;

    DC.save();
    DC.strokeStyle = spearTimer > 0 ? '#f5d76e' : '#68451f';
    DC.lineWidth = 3.2;
    DC.beginPath();
    DC.moveTo(shaftStartX, shaftStartY);
    DC.lineTo(shaftEndX, shaftEndY);
    DC.stroke();
    DC.strokeStyle = '#d7a35e';
    DC.lineWidth = 1;
    DC.beginPath();
    DC.moveTo(shaftStartX + nx, shaftStartY + ny);
    DC.lineTo(shaftEndX + nx, shaftEndY + ny);
    DC.stroke();
    // 细长菱形矛头，尖端始终指向敌人
    const tipX = sx + px * 27, tipY = sy + py * 27;
    DC.fillStyle = spearTimer > 0 ? '#fff4b0' : metal;
    DC.beginPath();
    DC.moveTo(tipX, tipY);
    DC.lineTo(sx + px * 13 + nx * 3.2, sy + py * 13 + ny * 3.2);
    DC.lineTo(sx + px * 9, sy + py * 9);
    DC.lineTo(sx + px * 13 - nx * 3.2, sy + py * 13 - ny * 3.2);
    DC.closePath();
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.8)';
    DC.lineWidth = 1;
    DC.stroke();
    DC.restore();

    // 收窄身体：保留骑士方形护甲基底，但不画手臂或外扩肩甲
    DC.fillStyle = bodyColor;
    DC.fillRect(unit.x - 6, unit.y, 12, 11);
    DC.strokeStyle = 'rgba(255,255,255,0.65)';
    DC.lineWidth = 1.1;
    DC.strokeRect(unit.x - 6, unit.y, 12, 11);
    // 简洁胸甲纹路与腰带
    DC.strokeStyle = 'rgba(230,245,255,0.75)';
    DC.lineWidth = 1;
    DC.beginPath();
    DC.moveTo(unit.x, unit.y + 1);
    DC.lineTo(unit.x, unit.y + 10);
    DC.moveTo(unit.x - 5, unit.y + 7);
    DC.lineTo(unit.x + 5, unit.y + 7);
    DC.stroke();

    // 木桶头部：圆桶轮廓、两道桶箍、木板纹理
    DC.fillStyle = wood;
    DC.beginPath();
    DC.roundRect(unit.x - 10, unit.y - 18, 20, 16, 3);
    DC.fill();
    DC.strokeStyle = '#553515';
    DC.lineWidth = 1.4;
    DC.stroke();
    DC.strokeStyle = woodLight;
    DC.lineWidth = 1.5;
    for (const yy of [unit.y - 14, unit.y - 5]) {
        DC.beginPath();
        DC.moveTo(unit.x - 9, yy);
        DC.lineTo(unit.x + 9, yy);
        DC.stroke();
    }
    DC.strokeStyle = 'rgba(80,45,20,0.65)';
    DC.lineWidth = 0.8;
    DC.beginPath();
    DC.moveTo(unit.x - 3, unit.y - 17);
    DC.lineTo(unit.x - 3, unit.y - 3);
    DC.moveTo(unit.x + 3, unit.y - 17);
    DC.lineTo(unit.x + 3, unit.y - 3);
    DC.stroke();
    // 桶口/面部观察缝
    DC.fillStyle = '#25170d';
    DC.fillRect(unit.x - 7, unit.y - 11, 14, 3);
    DC.fillStyle = metal;
    DC.fillRect(unit.x - 5, unit.y - 10.2, 2.5, 1.2);
    DC.fillRect(unit.x + 2.5, unit.y - 10.2, 2.5, 1.2);

    // 名称和生命/护盾条使用统一模板
    drawNameBar(unit, {
        name: '木桶护卫', nameY: unit.y - 28, barY: unit.y - 24,
        baseline: 'alphabetic',
    });
}

/** 绘制骑士（圆头 + 方块身 + 长方形马，参照剑士几何风格） */
function drawKnight(unit) {
    const isPlayer = unit.team === 'player';
    const headColor = isPlayer ? '#3498db' : '#e67e22';
    const bodyColor = isPlayer ? '#2980b9' : '#c0392b';
    const horseColor = '#8B4513';

    // ── 长方形马（在下方，加长版）──
    DC.fillStyle = horseColor;
    DC.fillRect(unit.x - 14, unit.y + 6, 28, 10);
    DC.strokeStyle = 'rgba(255,255,255,0.3)';
    DC.lineWidth = 1;
    DC.strokeRect(unit.x - 14, unit.y + 6, 28, 10);

    // ── 小正方体身子（马背上）──
    DC.fillStyle = bodyColor;
    DC.fillRect(unit.x - 6, unit.y - 2, 12, 11);
    DC.strokeStyle = 'rgba(255,255,255,0.5)';
    DC.lineWidth = 1;
    DC.strokeRect(unit.x - 6, unit.y - 2, 12, 11);

    // ── 大圆头（在身子上方）──
    DC.fillStyle = headColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y - 10, 10, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // 名称 + 血条
    drawNameBar(unit, {
        name: CARDS[unit.cardId]?.name || '',
        nameY: unit.y - 28,
        barY: unit.y - 24,
    });
}

/** 绘制弓箭女皇（精英·紫色头 + 剑士体型：去掉马改为站立，小正方体身子+大圆头；头统一紫色/身体保留阵营色；
 *  配饰：金色小皇冠+红宝石、手持金弓朝向目标、斜背箭筒、身后小披风） */
function drawBowQueen(unit) {
    const isPlayer = unit.team === 'player';
    // 配色：头统一紫色，身体/披风保留阵营色（蓝方绿/红方紫）
    const headColor    = '#9b59b6';                        // 大圆头（统一紫色）
    const bodyColor    = isPlayer ? '#1e8449' : '#6c3483'; // 方块身（阵营色）
    const cloakColor   = isPlayer ? '#27ae60' : '#8e44ad'; // 披风（阵营色）
    const featherColor = '#c39bd3';                        // 箭羽（紫色呼应头部）

    // 🌫️ 隐身：暗淡半透明 + 紫色呼吸光晕（参考幽灵/暗影刺客隐身渲染）
    const isStealthed = unit._stealthed;
    if (isStealthed) {
        DC.globalAlpha = 0.35;
        const pulse = 0.9 + 0.1 * Math.sin(game.time * 4);
        DC.fillStyle = isPlayer ? 'rgba(150,200,255,0.15)' : 'rgba(200,150,255,0.15)';
        DC.beginPath();
        DC.arc(unit.x, unit.y, 16 * pulse, 0, 2 * Math.PI);
        DC.fill();
    }

    // ✂️ 建模整体略微缩小（0.9倍，以女皇中心为缩放原点；名称/血条不受影响）
    DC.save();
    DC.translate(unit.x, unit.y);
    DC.scale(0.9, 0.9);
    DC.translate(-unit.x, -unit.y);

    // ── 小披风（身体后方，三角垂落）──
    DC.fillStyle = cloakColor;
    DC.beginPath();
    DC.moveTo(unit.x - 6, unit.y + 2);    // 左肩
    DC.lineTo(unit.x - 13, unit.y + 12);  // 左下摆
    DC.lineTo(unit.x - 4, unit.y + 13);   // 底边
    DC.lineTo(unit.x - 1, unit.y + 3);    // 右肩
    DC.closePath();
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.35)';
    DC.lineWidth = 1;
    DC.stroke();

    // ── 小正方体身子（剑士同款比例，在下方）──
    DC.fillStyle = bodyColor;
    DC.fillRect(unit.x - 6, unit.y + 2, 12, 11);
    DC.strokeStyle = 'rgba(255,255,255,0.5)';
    DC.lineWidth = 1;
    DC.strokeRect(unit.x - 6, unit.y + 2, 12, 11);

    // ── 斜背箭筒（身后左侧，皮革筒 + 紫色箭羽）──
    DC.save();
    DC.translate(unit.x - 11, unit.y + 2);
    DC.rotate(-Math.PI / 4);
    DC.fillStyle = '#6d4c2f';
    DC.fillRect(-2.5, -7, 5, 14);
    DC.strokeStyle = 'rgba(255,255,255,0.4)';
    DC.lineWidth = 0.8;
    DC.strokeRect(-2.5, -7, 5, 14);
    // 箭羽（筒口两根彩色小三角，紫色）
    DC.fillStyle = featherColor;
    DC.beginPath();
    DC.moveTo(-2.5, -7);
    DC.lineTo(-5, -10);
    DC.lineTo(-0.5, -8.5);
    DC.closePath();
    DC.fill();
    DC.beginPath();
    DC.moveTo(2.5, -7);
    DC.lineTo(5, -10);
    DC.lineTo(0.5, -8.5);
    DC.closePath();
    DC.fill();
    DC.restore();

    // ── 大圆头（上方，剑士同款位置）──
    DC.fillStyle = headColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y - 4, 10, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();
    // 头部纹理：高光 + 腮红（参照小王子）
    DC.fillStyle = 'rgba(255,255,255,0.5)';
    DC.beginPath();
    DC.arc(unit.x - 4, unit.y - 7, 3.4, 0, 2 * Math.PI);
    DC.fill();
    DC.fillStyle = 'rgba(255,150,170,0.6)';
    DC.beginPath();
    DC.arc(unit.x - 6.5, unit.y - 1, 2.4, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.arc(unit.x + 6.5, unit.y - 1, 2.4, 0, 2 * Math.PI);
    DC.fill();

    // ── 👑 金色小皇冠（头顶，女皇款：三尖+红宝石，参照小王子但更小巧）──
    DC.fillStyle = '#f1c40f';
    DC.beginPath();
    DC.moveTo(unit.x - 9, unit.y - 13);   // 左下
    DC.lineTo(unit.x - 9, unit.y - 17);   // 左竖
    DC.lineTo(unit.x - 4.5, unit.y - 21); // 左尖
    DC.lineTo(unit.x, unit.y - 16);       // 中凹
    DC.lineTo(unit.x + 4.5, unit.y - 21); // 右尖
    DC.lineTo(unit.x + 9, unit.y - 17);   // 右竖
    DC.lineTo(unit.x + 9, unit.y - 13);   // 右下
    DC.closePath();
    DC.fill();
    DC.strokeStyle = '#b8860b';
    DC.lineWidth = 1;
    DC.stroke();
    // 中央红宝石
    DC.fillStyle = '#e74c3c';
    DC.beginPath();
    DC.arc(unit.x, unit.y - 15, 2.2, 0, 2 * Math.PI);
    DC.fill();

    // ── 🏹 长弓（手持朝向目标，参照小王子十字弩旋转方式：弓弧 + 弓弦）──
    let angle = 0;
    if (unit.targetId) {
        const target = game.entities.find(en => en.id === unit.targetId && en.hp > 0 && !en._stealthed);
        if (target) angle = Math.atan2(target.y - unit.y, target.x - unit.x);
    }
    DC.save();
    DC.translate(unit.x + 2, unit.y + 4);
    DC.rotate(angle);
    // 金弓弓臂（朝右弧线）
    DC.strokeStyle = isPlayer ? '#f1c40f' : '#d4ac0d';
    DC.lineWidth = 2.5;
    DC.beginPath();
    DC.arc(0, 0, 9, -1.15, 1.15);
    DC.stroke();
    // 弓弦 + 拉弓动画：蓄力阶段(0.35→0.18)弦中点向后(-x)撤出6px，放箭阶段(0.18→0)回弹归位
    const t = unit._drawBowTimer || 0;
    let pull = 0;
    if (t > 0.18) pull = Math.min(1, (0.35 - t) / 0.17); // 蓄力：0.35→0.18 拉满 0→1
    else if (t > 0) pull = t / 0.18;                      // 放箭：回弹 1→0
    const cx = 9 * Math.cos(1.15) - pull * 6, cy = 0; // 弦中点：未拉时与弓臂两端(3.68,±8.22)成直线，拉满再向后撤6px
    const ax = 9 * Math.cos(-1.15), ay = 9 * Math.sin(-1.15);
    const bx = 9 * Math.cos(1.15), by = 9 * Math.sin(1.15);
    DC.strokeStyle = 'rgba(255,255,255,0.85)';
    DC.lineWidth = 1;
    DC.beginPath();
    DC.moveTo(ax, ay);
    DC.lineTo(cx, cy);
    DC.lineTo(bx, by);
    DC.stroke();
    // 蓄力中的绿色细箭（搭在弦上，朝目标方向）
    if (pull > 0.1) {
        DC.strokeStyle = '#27ae60';
        DC.lineWidth = 1.1;
        DC.beginPath();
        DC.moveTo(cx, cy);
        DC.lineTo(cx + 13, cy);
        DC.stroke();
        DC.fillStyle = '#2ecc71';
        DC.beginPath();
        DC.moveTo(cx + 14, cy);       // 箭头尖端
        DC.lineTo(cx + 10, cy - 1.8); // 左翼
        DC.lineTo(cx + 12, cy);       // 尾左
        DC.lineTo(cx + 10, cy + 1.8); // 右翼
        DC.closePath();
        DC.fill();
    }
    DC.restore();

    DC.restore(); // ✂️ 还原建模缩放（0.9倍结束）

    DC.globalAlpha = 1; // 🌫️ 隐身半透明结束，名称/血条恢复正常显示

    // 名称 + 血条（皇冠仍略高，比剑士略上移）
    drawNameBar(unit, {
        name: CARDS[unit.cardId]?.name || '',
        nameY: unit.y - 24,
        barY: unit.y - 20,
    });
}

/** 绘制飞斧胖虎（黑蓝配色：圆头 + 长方形身体 + 虎耳 + 🪓飞斧，基底同弓箭女皇） */
function drawFatTiger(unit) {
    const isPlayer = unit.team === 'player';
    // 黑蓝配色（参考暗影刺客的深色系改蓝黑：近黑深蓝身体 + 亮蓝点缀）
    const headColor    = '#1b2631';   // 深蓝黑圆头
    const bodyColor    = '#141a2e';   // 近黑深蓝方块身
    const accentColor  = '#4a69bd';   // 亮蓝（披风/腰带/耳内）
    const outlineColor = 'rgba(130,180,255,0.85)';

    // ── 身后小披风（三角垂落，同女皇比例，亮蓝）──
    DC.fillStyle = accentColor;
    DC.beginPath();
    DC.moveTo(unit.x - 6, unit.y + 2);
    DC.lineTo(unit.x - 13, unit.y + 12);
    DC.lineTo(unit.x - 4, unit.y + 13);
    DC.lineTo(unit.x - 1, unit.y + 3);
    DC.closePath();
    DC.fill();

    // ── 长方形身体（弓箭女皇同款 12x11）──
    DC.fillStyle = bodyColor;
    DC.fillRect(unit.x - 6, unit.y + 2, 12, 11);
    DC.strokeStyle = outlineColor;
    DC.lineWidth = 1;
    DC.strokeRect(unit.x - 6, unit.y + 2, 12, 11);

    // 亮蓝腰带（发挥）
    DC.fillStyle = accentColor;
    DC.fillRect(unit.x - 6, unit.y + 8, 12, 2.5);

    // ── 大圆头（弓箭女皇同款 r10）──
    DC.fillStyle = headColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y - 4, 10, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = outlineColor;
    DC.lineWidth = 1.5;
    DC.stroke();
    // 头部高光
    DC.fillStyle = 'rgba(255,255,255,0.35)';
    DC.beginPath();
    DC.arc(unit.x - 4, unit.y - 7, 3.4, 0, 2 * Math.PI);
    DC.fill();
    // 瞪眼（胖虎式白色双眼）
    DC.fillStyle = '#ffffff';
    DC.fillRect(unit.x - 5.2, unit.y - 5, 2.4, 2.6);
    DC.fillRect(unit.x + 2.8, unit.y - 5, 2.4, 2.6);

    // ── 虎耳（头顶两侧三角，内衬亮蓝）──
    DC.fillStyle = headColor;
    DC.beginPath();
    DC.moveTo(unit.x - 9, unit.y - 10);
    DC.lineTo(unit.x - 12.5, unit.y - 17.5);
    DC.lineTo(unit.x - 4.5, unit.y - 12.5);
    DC.closePath();
    DC.fill();
    DC.beginPath();
    DC.moveTo(unit.x + 9, unit.y - 10);
    DC.lineTo(unit.x + 12.5, unit.y - 17.5);
    DC.lineTo(unit.x + 4.5, unit.y - 12.5);
    DC.closePath();
    DC.fill();
    // 耳内亮蓝
    DC.fillStyle = accentColor;
    DC.beginPath();
    DC.moveTo(unit.x - 8.5, unit.y - 10.8);
    DC.lineTo(unit.x - 10.9, unit.y - 16);
    DC.lineTo(unit.x - 5.8, unit.y - 12.1);
    DC.closePath();
    DC.fill();
    DC.beginPath();
    DC.moveTo(unit.x + 8.5, unit.y - 10.8);
    DC.lineTo(unit.x + 10.9, unit.y - 16);
    DC.lineTo(unit.x + 5.8, unit.y - 12.1);
    DC.closePath();
    DC.fill();

    // ── 🪓 飞斧（手持朝向目标；斧头丢出在外飞行时不画，等飞回来再拿上）──
    const axeFlying = game.projectiles.some(p => p.isAxe && p.ownerId === unit.id);
    if (!axeFlying) {
        let angle = 0;
        if (unit.targetId) {
            const target = game.entities.find(en => en.id === unit.targetId && en.hp > 0 && !en._stealthed);
            if (target) angle = Math.atan2(target.y - unit.y, target.x - unit.x);
        }
        DC.save();
        DC.translate(unit.x + 2, unit.y + 4);
        DC.rotate(angle);
        DC.font = '15px sans-serif';
        DC.textAlign = 'center';
        DC.textBaseline = 'middle';
        DC.fillText('🪓', 13, 0);
        DC.restore();
    }

    // 名称 + 血条（同女皇位置）
    drawNameBar(unit, {
        name: CARDS[unit.cardId]?.name || '',
        nameY: unit.y - 24,
        barY: unit.y - 20,
    });
}

/** 绘制浪人（米色斗笠 + 圆头 + 方块身 + 右上方斜背武士刀，参照剑士/骑士几何风格） */
function drawRonin(unit) {
    const isPlayer = unit.team === 'player';
    const headColor = isPlayer ? '#3498db' : '#e67e22';
    const bodyColor = isPlayer ? '#2980b9' : '#c0392b';

    // ── 武士刀（右上方斜背）──
    DC.strokeStyle = '#dcdde1';   // 刀身（浅灰）
    DC.lineWidth = 2;
    DC.beginPath();
    DC.moveTo(unit.x + 11, unit.y - 14);
    DC.lineTo(unit.x + 16, unit.y - 20);
    DC.stroke();
    DC.strokeStyle = '#8b4513';   // 刀柄（深棕）
    DC.lineWidth = 3;
    DC.beginPath();
    DC.moveTo(unit.x + 11, unit.y - 14);
    DC.lineTo(unit.x + 9, unit.y - 11);
    DC.stroke();

    // ── 小正方体身子（下方）──
    DC.fillStyle = bodyColor;
    DC.fillRect(unit.x - 6, unit.y + 2, 12, 11);
    DC.strokeStyle = 'rgba(255,255,255,0.5)';
    DC.lineWidth = 1;
    DC.strokeRect(unit.x - 6, unit.y + 2, 12, 11);

    // ── 大圆头（中间）──
    DC.fillStyle = headColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y - 4, 9, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 斗笠（钝角三角形、宽扁压低；用 path 绘制避免被复制体血条过滤误判）──
    //    底边宽24、顶点低矮 → 顶角约112°（钝角），整体比原半圆帽压低约6px贴合头部
    DC.fillStyle = '#e8c97a';
    DC.beginPath();
    DC.moveTo(unit.x - 12, unit.y - 8);   // 左下
    DC.lineTo(unit.x + 12, unit.y - 8);   // 右下
    DC.lineTo(unit.x, unit.y - 16);       // 顶点（低矮 → 钝角）
    DC.closePath();
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.5)';
    DC.lineWidth = 1;
    DC.stroke();

    // 名称 + 血条
    drawNameBar(unit, {
        name: CARDS[unit.cardId]?.name || '',
        nameY: unit.y - 29,
        barY: unit.y - 29,
    });

    // ── 反弹状态条（通用蓄力条：血条正上方；冷却中橘色进度上涨，就绪时绿色满条） ──
    const rcd = CARDS.ronin.reflectCooldown || 3.5;
    const rTimer = unit._reflectTimer || 0;
    const rProg = rTimer <= 0 ? 1 : Math.max(0, 1 - rTimer / rcd);
    drawChargeBar(unit, rProg, rTimer <= 0 ? '#2ecc71' : '#f39c12');
}

/** 绘制剑仙（御剑仙人：青白道袍圆身 + 肤色头+束发金簪 + 仙剑竖立身侧左侧偏上、剑光流光旋转90°竖着包住剑身（旧形象脚下横置飞剑保留备用，开关 SWORD_IMMORTAL_LEGACY 切换） + 飘带；无斗笠，区别于浪人。战斗姿态：50px内遇敌→剑横指敌（剑柄于身体圆左下角、剑尖指向敌人），剑与流光平滑过渡慢慢飞过去，攻击时一起刺出再缩回（仅特效）；统一绘制：剑柄位置+指向角度由 update.js 平滑插值） */
function drawSwordImmortal(unit) {
    const isPlayer = unit.team === 'player';
    const floatOffset = Math.sin(game.time * 3) * 2;          // 御剑微微上下浮动
    const robeColor = isPlayer ? '#7fd8d0' : '#e8a08a';       // 道袍主色（蓝方青白 / 红方绯红）
    const trimColor = isPlayer ? '#e8f8f5' : '#fdebd0';       // 衣领/飘带镶边
    const swordColor = isPlayer ? '#d5f5ec' : '#f9e79f';      // 剑身（发光浅色）

    // 🕊️ 御剑形态：脚下新增阴影（空中单位贴地投影，不随浮动）+ 身体微微升浮
    if (unit._rideSword) drawUnitShadow(unit, 22, 17, 7, 0.32);
    const bodyY = unit.y + (unit._rideSword ? floatOffset : 0);

    // 🗡️ 刺击特效进度（攻击时剑向前刺出再缩回，仅特效）：0.3s内 0→1→0，幅度9px（与 update.js _stabTimer=0.3 对应）
    const stabTimer = unit._stabTimer || 0;
    const stab = stabTimer > 0 ? Math.sin((1 - Math.min(stabTimer / 0.3, 1)) * Math.PI) * 9 : 0;
    // 🕊️ 御剑形态攻击中：脚下剑闪白 + 剑光脉冲（刺击反馈，纯特效）
    const rideAtk = (unit._rideSword && stabTimer > 0);

    // ── 仙剑：日常=竖立身侧；御剑形态=剑由 update 控制（脚下横置 ⇄ 手中横指刺击，与地面同款特效）；旧形象备用=脚下横置（开关 SWORD_IMMORTAL_LEGACY）──
    if (SWORD_IMMORTAL_LEGACY) {
        // ---- 旧形象（备用保留）：脚下飞剑（横置，微微浮动）----
        //    剑身（御剑形态攻击时闪白，模拟御剑冲击）
        DC.strokeStyle = rideAtk ? '#ffffff' : swordColor;
        DC.lineWidth = rideAtk ? 4 : 3;
        DC.beginPath();
        DC.moveTo(unit.x - 16, unit.y + 12 + floatOffset);
        DC.lineTo(unit.x + 16, unit.y + 12 + floatOffset);
        DC.stroke();
        //    剑尖（左侧小三角）
        DC.fillStyle = rideAtk ? '#ffffff' : swordColor;
        DC.beginPath();
        DC.moveTo(unit.x - 16, unit.y + 12 + floatOffset);
        DC.lineTo(unit.x - 21, unit.y + 12 + floatOffset);
        DC.lineTo(unit.x - 16, unit.y + 9.5 + floatOffset);
        DC.closePath();
        DC.fill();
        //    剑柄（右侧）
        DC.strokeStyle = '#8b4513';
        DC.lineWidth = 2.5;
        DC.beginPath();
        DC.moveTo(unit.x + 16, unit.y + 12 + floatOffset);
        DC.lineTo(unit.x + 21, unit.y + 12 + floatOffset);
        DC.stroke();
        //    剑格护手
        DC.lineWidth = 2;
        DC.beginPath();
        DC.moveTo(unit.x + 16, unit.y + 9.5 + floatOffset);
        DC.lineTo(unit.x + 16, unit.y + 14.5 + floatOffset);
        DC.stroke();
    } else {
        // ---- 日常/战斗统一绘制：剑柄位置+指向角度由 update.js 平滑过渡（剑和流光慢慢飞过去）----
        //     日常目标：剑柄(x-14, y+11)、角度-π/2（剑尖朝上）；战斗目标：剑柄(x-6, y+6)、角度指向敌人
        const gx = unit._swordGX !== undefined ? unit._swordGX : unit.x - 14;
        const gy = unit._swordGY !== undefined ? unit._swordGY : unit.y + 11;
        const ang = unit._swordAngle !== undefined ? unit._swordAngle : -Math.PI / 2;
        const px2 = Math.cos(ang), py2 = Math.sin(ang);
        const nx = -py2, ny = px2;                                      // 垂直方向（剑格/剑尖底宽）
        const hx = gx + px2 * stab, hy = gy + py2 * stab;               // 剑柄（剑格，随刺击前移）
        const len = 26;
        const tipX = hx + px2 * len, tipY = hy + py2 * len;             // 剑尖（指向方向）
        //    剑身（剑柄→剑尖；🕊️ 御剑攻击时闪白加粗，模拟御剑冲击；🕊️ 御剑期间剑身变金色）
        DC.strokeStyle = rideAtk ? '#ffffff' : (unit._rideSword ? '#ffd700' : swordColor);
        DC.lineWidth = rideAtk ? 4 : 3;
        DC.beginPath();
        DC.moveTo(hx, hy);
        DC.lineTo(tipX, tipY);
        DC.stroke();
        //    剑尖（指向敌人的小三角；御剑攻击闪白；🕊️ 御剑期间金色）
        DC.fillStyle = rideAtk ? '#ffffff' : (unit._rideSword ? '#ffd700' : swordColor);
        DC.beginPath();
        DC.moveTo(tipX + px2 * 5, tipY + py2 * 5);
        DC.lineTo(tipX - px2 * 2 + nx * 2.5, tipY - py2 * 2 + ny * 2.5);
        DC.lineTo(tipX - px2 * 2 - nx * 2.5, tipY - py2 * 2 - ny * 2.5);
        DC.closePath();
        DC.fill();
        //    剑格（剑柄处垂直于剑身的小横线）
        DC.lineWidth = 2;
        DC.beginPath();
        DC.moveTo(hx + nx * 2.5, hy + ny * 2.5);
        DC.lineTo(hx - nx * 2.5, hy - ny * 2.5);
        DC.stroke();
        //    剑柄（剑格向反方向短柄）
        DC.strokeStyle = '#8b4513';
        DC.lineWidth = 2.5;
        DC.beginPath();
        DC.moveTo(hx - px2 * 5, hy - py2 * 5);
        DC.lineTo(hx, hy);
        DC.stroke();
    }

    // ── 仙人身（道袍圆身，站在剑上）──
    DC.fillStyle = robeColor;
    DC.beginPath();
    DC.arc(unit.x, bodyY, 9, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.55)';
    DC.lineWidth = 1;
    DC.stroke();
    //    衣领 V 形（白色镶边）
    DC.strokeStyle = trimColor;
    DC.lineWidth = 1.5;
    DC.beginPath();
    DC.moveTo(unit.x - 4, bodyY + 3);
    DC.lineTo(unit.x, bodyY - 2);
    DC.lineTo(unit.x + 4, bodyY + 3);
    DC.stroke();

    // ── 头（肤色圆 + 束发髻 + 金簪）──
    DC.fillStyle = '#f5cba7';
    DC.beginPath();
    DC.arc(unit.x, bodyY - 9, 6, 0, 2 * Math.PI);
    DC.fill();
    DC.fillStyle = isPlayer ? '#2c3e50' : '#5a2d0c';
    DC.beginPath();
    DC.arc(unit.x, bodyY - 15, 3, 0, 2 * Math.PI);
    DC.fill();
    DC.fillStyle = '#f1c40f';
    DC.beginPath();
    DC.arc(unit.x + 2.5, bodyY - 15.5, 1.2, 0, 2 * Math.PI);
    DC.fill();

    // ── 飘带（身侧一缕，随风摆动）──
    const wave = Math.sin(game.time * 4) * 2;
    DC.strokeStyle = trimColor;
    DC.lineWidth = 2;
    DC.beginPath();
    DC.moveTo(unit.x + 6, bodyY + 2);
    DC.quadraticCurveTo(unit.x + 13, bodyY + 4 + wave, unit.x + 12, bodyY + 10 + wave);
    DC.stroke();

    // ── 剑光流光（跟随仙剑位置/姿态，微微呼吸；御剑攻击时脉冲放大；🕊️ 御剑期间金色）──
    DC.globalAlpha = 0.3 + Math.sin(game.time * 5) * 0.12 + (rideAtk ? 0.3 : 0);
    DC.fillStyle = rideAtk ? '#ffffff' : (unit._rideSword ? '#ffd700' : swordColor);
    DC.beginPath();
    if (SWORD_IMMORTAL_LEGACY) {
        // 旧形象备用：脚下横剑 → 光晕在脚下（横），攻击时沿剑方向拉长
        const glowK = rideAtk ? 1 + stab / 9 * 0.8 : 1;
        DC.ellipse(unit.x, unit.y + 12 + floatOffset, 19 * glowK, 2.5 * glowK, 0, 0, 2 * Math.PI);
    } else {
        // 日常/战斗/御剑统一：流光跟随剑（中心=剑身中段，长轴沿剑方向；与剑一起飞/刺）
        const gx = unit._swordGX !== undefined ? unit._swordGX : unit.x - 14;
        const gy = unit._swordGY !== undefined ? unit._swordGY : unit.y + 11;
        const ang = unit._swordAngle !== undefined ? unit._swordAngle : -Math.PI / 2;
        const cxm = gx + Math.cos(ang) * (13 + stab);
        const cym = gy + Math.sin(ang) * (13 + stab);
        DC.ellipse(cxm, cym, 19, 2.5, ang, 0, 2 * Math.PI);
    }
    DC.fill();
    DC.globalAlpha = 1;

    // ── 🗡️ 环绕飞剑（50轨道旋转；小发光剑沿切线方向，随轨道角转动；🕊️御剑时剑身变金色）──
    if (unit._swords) {
        const orbitR = 50;
        const orbCol = unit._rideSword ? '#ffd700' : (isPlayer ? '#d5f5ec' : '#f9e79f'); // 🕊️ 御剑：环绕飞剑金色
        for (const s of unit._swords) {
            const sx = unit.x + Math.cos(s.angle) * orbitR;
            const sy = unit.y + Math.sin(s.angle) * orbitR;
            const tang = s.angle + Math.PI / 2; // 切线方向
            DC.save();
            DC.translate(sx, sy);
            DC.rotate(tang);
            // 剑身（御剑金剑更粗）
            DC.strokeStyle = orbCol;
            DC.lineWidth = unit._rideSword ? 2.5 : 2;
            DC.beginPath();
            DC.moveTo(-8, 0);
            DC.lineTo(9, 0);
            DC.stroke();
            // 剑尖
            DC.fillStyle = orbCol;
            DC.beginPath();
            DC.moveTo(9, 0);
            DC.lineTo(5, -3);
            DC.lineTo(7, 0);
            DC.lineTo(5, 3);
            DC.closePath();
            DC.fill();
            // 剑柄
            DC.strokeStyle = '#8b4513';
            DC.lineWidth = 1.5;
            DC.beginPath();
            DC.moveTo(-8, 0);
            DC.lineTo(-12, 0);
            DC.stroke();
            DC.restore();
            // 微光（🕊️御剑金剑：金色光晕更大）
            DC.globalAlpha = 0.3 + Math.sin(game.time * 6 + s.angle) * 0.15;
            DC.fillStyle = unit._rideSword ? 'rgba(255,215,0,0.85)' : (isPlayer ? 'rgba(213,245,236,0.8)' : 'rgba(249,231,159,0.8)');
            DC.beginPath();
            DC.arc(sx, sy, unit._rideSword ? 4 : 3, 0, 2 * Math.PI);
            DC.fill();
            DC.globalAlpha = 1;
        }
    }

    // 名称 + 血条
    drawNameBar(unit, {
        name: CARDS[unit.cardId]?.name || '',
        nameY: unit.y - 26,
        barY: unit.y - 22,
    });
}

/** 绘制渔夫（黄色宽檐斗笠 + 蓝绿渔夫装 + 斜背鱼竿挂小鱼；对地单体近战） */
function drawFisherman(unit) {
    const isPlayer = unit.team === 'player';
    const headColor = isPlayer ? '#3498db' : '#e67e22';
    const bodyColor = isPlayer ? '#1abc9c' : '#c0392b';

    // ── 鱼竿（左上方斜背：棕色竿 + 白色鱼线 + 线上挂小鱼）──
    DC.strokeStyle = '#8b4513';   // 竿（深棕）
    DC.lineWidth = 2;
    DC.beginPath();
    DC.moveTo(unit.x - 13, unit.y - 15);
    DC.lineTo(unit.x + 9, unit.y - 26);
    DC.stroke();
    DC.strokeStyle = 'rgba(255,255,255,0.7)';  // 鱼线
    DC.lineWidth = 1;
    DC.beginPath();
    DC.moveTo(unit.x + 9, unit.y - 26);
    DC.lineTo(unit.x + 14, unit.y - 13);
    DC.stroke();
    DC.fillStyle = '#f1c40f';     // 小鱼（黄色小圆挂在线尾）
    DC.beginPath();
    DC.arc(unit.x + 14, unit.y - 12, 2.5, 0, 2 * Math.PI);
    DC.fill();

    // ── 身子（渔夫装小方块）──
    DC.fillStyle = bodyColor;
    DC.fillRect(unit.x - 6, unit.y + 2, 12, 11);
    DC.strokeStyle = 'rgba(255,255,255,0.5)';
    DC.lineWidth = 1;
    DC.strokeRect(unit.x - 6, unit.y + 2, 12, 11);

    // ── 大圆头（中间）──
    DC.fillStyle = headColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y - 4, 9, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 宽檐斗笠（黄色：椭圆帽檐 + 半圆顶；与浪人钝角三角帽区分）──
    DC.fillStyle = '#f4d03f';
    DC.beginPath();
    DC.ellipse(unit.x, unit.y - 9, 13, 3.5, 0, 0, 2 * Math.PI);  // 帽檐
    DC.fill();
    DC.beginPath();
    DC.arc(unit.x, unit.y - 11, 7, Math.PI, 0);                   // 圆顶
    DC.closePath();
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.5)';
    DC.lineWidth = 1;
    DC.stroke();

    // 名称 + 血条
    drawNameBar(unit, {
        name: CARDS[unit.cardId]?.name || '',
        nameY: unit.y - 29,
        barY: unit.y - 25,
    });
}

/** 绘制矿工（黄色安全帽 + 矿工服 + 镐；潜伏阶段为纯土堆特效，实体出现即破土造型） */
function drawMiner(unit) {
    const isPlayer = unit.team === 'player';

    // ---- 破土后的矿工造型 ----
    // 身子（矿工服，橙色方块）
    DC.fillStyle = '#e67e22';
    DC.fillRect(unit.x - 6, unit.y - 1, 12, 10);
    DC.strokeStyle = 'rgba(255,255,255,0.5)';
    DC.lineWidth = 1;
    DC.strokeRect(unit.x - 6, unit.y - 1, 12, 10);
    // 头（肤色圆，与身体紧凑贴合）
    DC.fillStyle = '#f7d794';
    DC.beginPath();
    DC.arc(unit.x, unit.y - 9, 8, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();
    // 安全帽（黄色半圆帽顶 + 帽檐）
    DC.fillStyle = '#f1c40f';
    DC.beginPath();
    DC.arc(unit.x, unit.y - 10, 8, Math.PI, Math.PI * 2);
    DC.fill();
    DC.fillRect(unit.x - 10, unit.y - 9, 20, 3);
    // 镐（斜扛在右肩）
    DC.strokeStyle = '#8B4513';
    DC.lineWidth = 2;
    DC.beginPath();
    DC.moveTo(unit.x + 7, unit.y + 11);
    DC.lineTo(unit.x + 13, unit.y + 3);
    DC.stroke();
    DC.strokeStyle = '#95a5a6';
    DC.lineWidth = 2;
    DC.beginPath();
    DC.arc(unit.x + 12, unit.y + 2, 3.5, Math.PI, Math.PI * 2);
    DC.stroke();

    // 名称 + 血条
    drawNameBar(unit, {
        name: CARDS[unit.cardId]?.name || '',
        nameY: unit.y - 28,
        barY: unit.y - 24,
    });
}

/** 绘制超级骑士（黄金铠甲 + 大王冠 + 高头大马，比骑士大一圈） */
function drawSuperKnight(unit) {
    const isPlayer = unit.team === 'player';
    const armorColor = isPlayer ? '#f1c40f' : '#c0392b';
    const accentColor = isPlayer ? '#e67e22' : '#922b21';
    const crownColor = '#ffd700';

    // ── 黄金铠甲（大号，比骑士大一圈，直接站在地上）──
    DC.fillStyle = armorColor;
    DC.fillRect(unit.x - 8, unit.y - 3, 16, 14);
    DC.strokeStyle = 'rgba(255,255,255,0.5)';
    DC.lineWidth = 1.5;
    DC.strokeRect(unit.x - 8, unit.y - 3, 16, 14);

    // 铠甲十字纹饰
    DC.strokeStyle = accentColor;
    DC.lineWidth = 1.5;
    DC.beginPath();
    DC.moveTo(unit.x, unit.y - 2);
    DC.lineTo(unit.x, unit.y + 10);
    DC.moveTo(unit.x - 6, unit.y + 4);
    DC.lineTo(unit.x + 6, unit.y + 4);
    DC.stroke();

    // ── 大圆头（带王冠）──
    DC.fillStyle = '#f5d6b8';
    DC.beginPath();
    DC.arc(unit.x, unit.y - 12, 12, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // 王冠（在头顶）
    DC.fillStyle = crownColor;
    DC.beginPath();
    DC.moveTo(unit.x - 8, unit.y - 13);
    DC.lineTo(unit.x - 6, unit.y - 22);
    DC.lineTo(unit.x - 3, unit.y - 17);
    DC.lineTo(unit.x, unit.y - 24);
    DC.lineTo(unit.x + 3, unit.y - 17);
    DC.lineTo(unit.x + 6, unit.y - 22);
    DC.lineTo(unit.x + 8, unit.y - 13);
    DC.closePath();
    DC.fill();
    DC.strokeStyle = '#b8860b';
    DC.lineWidth = 1;
    DC.stroke();

    // 王冠宝石
    DC.fillStyle = '#e74c3c';
    DC.beginPath();
    DC.arc(unit.x, unit.y - 18, 2, 0, 2 * Math.PI);
    DC.fill();

    // 名称 + 血条
    drawNameBar(unit, {
        name: CARDS[unit.cardId]?.name || '',
        nameY: unit.y - 33,
        barY: unit.y - 29,
        barW: 28,
    });

    // ---- 蓄力跳跃指示器（蓄力条走通用模板：血条正上方；金色"蓄力"字样在条右端；
    //      平时隐藏——仅蓄力中才绘制，脚下金色光圈特效保留）----
    if (unit._leapCharging && unit._leapTimer > 0) {
        const prog = unit._leapTimer / 1.5; // 1→0
        const pulse = 1 + (1 - prog) * 0.3; // 脉冲放大
        // 脚下光圈（脉动扩大）
        DC.strokeStyle = `rgba(255, 200, 80, ${(1 - prog) * 0.7})`;
        DC.lineWidth = 2 + (1 - prog) * 2;
        DC.beginPath();
        DC.arc(unit.x, unit.y, 14 * pulse, 0, 2 * Math.PI);
        DC.stroke();
        // 蓄力条（通用模板，涨满即跳）+ 特殊金色加粗"蓄力"字样
        drawChargeBar(unit, 1 - prog, '#ffd700', '蓄力', { color: '#ffd700', font: 'bold 8px sans-serif' });
    }
}

/** 绘制巫师（大扁三角巫师帽 + 小圆身体，哥布林大小） */
function drawWizard(unit) {
    const isPlayer = unit.team === 'player';
    const hatColor = isPlayer ? '#6b21a8' : '#3b0764';
    const skinColor = '#f5d6b8';
    const r = 8; // 同哥布林大小

    // ── 大扁三角形巫师帽（压低的帽尖 + 宽帽檐）──
    DC.fillStyle = hatColor;
    DC.beginPath();
    DC.moveTo(unit.x, unit.y - r - 12);          // 帽尖（压低了6px）
    DC.lineTo(unit.x + r + 6, unit.y - r - 2);   // 右下帽檐
    DC.lineTo(unit.x - r - 6, unit.y - r - 2);   // 左下帽檐
    DC.closePath();
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.4)';
    DC.lineWidth = 1.5;
    DC.stroke();

    // 帽檐横带装饰
    DC.fillStyle = 'rgba(255,255,255,0.15)';
    DC.fillRect(unit.x - r - 4, unit.y - r - 4, (r + 4) * 2, 3);

    // ── 小圆身体（无表情，干净圆脸）──
    DC.fillStyle = skinColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, r, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // 名称 + 血条
    drawNameBar(unit, {
        name: CARDS[unit.cardId]?.name || '',
        nameY: unit.y - r - 24,
        barY: unit.y - r - 20,
        barW: 28,
    });
}

/** 绘制小虫（深棕色椭圆身体，比骑士的马小一点） */
function drawWorm(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = isPlayer ? '#5D3A1A' : '#3E2410';
    const segColor = isPlayer ? '#4A2E14' : '#2E1B0C';

    // ── 椭圆身体（比骑士的马 28×10 小一点）──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.ellipse(unit.x, unit.y + 2, 11, 6, 0, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.2)';
    DC.lineWidth = 1;
    DC.stroke();

    // ── 节肢纹路（体现虫感）──
    DC.strokeStyle = segColor;
    DC.lineWidth = 1;
    for (let i = -6; i <= 6; i += 4) {
        DC.beginPath();
        DC.moveTo(unit.x + i, unit.y - 2);
        DC.lineTo(unit.x + i, unit.y + 6);
        DC.stroke();
    }

    // ── 小触角 ──
    DC.strokeStyle = segColor;
    DC.lineWidth = 1.2;
    DC.beginPath();
    DC.moveTo(unit.x - 8, unit.y - 1);
    DC.lineTo(unit.x - 12, unit.y - 6);
    DC.moveTo(unit.x + 8, unit.y - 1);
    DC.lineTo(unit.x + 12, unit.y - 6);
    DC.stroke();

    // 名称 + 血条
    drawNameBar(unit, {
        name: CARDS[unit.cardId]?.name || '',
        nameY: unit.y - 14,
        barY: unit.y - 10,
        barW: 28,
        barH: 3.5,
        font: 'bold 9px sans-serif',
    });
}

/** ═══════════════════════════════════════════
 *  绘制巨龙蛋（蛋🥚形 + 呼吸脉动 + 周期性跳动）
 *  ═══════════════════════════════════════════ */
function drawDragonEgg(unit) {
    const isPlayer = unit.team === 'player';
    const pct = unit.hp / unit.maxHp;           // 血量百分比
    const eggTimer = unit._eggPulseTimer || 0;
    const jumpCycle = 2.5;                      // 跳动周期（秒）
    const phase = eggTimer % jumpCycle;

    // ── 跳动动画：每1.8秒一次小跳跃 ──
    let jumpOffset = 0;
    if (phase < 0.25) {
        jumpOffset = -Math.sin(phase / 0.25 * Math.PI) * 6;  // 跳起
    } else if (phase < 0.5) {
        jumpOffset = -Math.sin((0.5 - phase) / 0.25 * Math.PI) * 6; // 回落
    }

    // ── 呼吸脉动（蛋壳轻微缩放）──
    const breathe = 1 + 0.04 * Math.sin(eggTimer * 2.0);

    const eggW = 18 * breathe;
    const eggH = 24 * breathe;
    const drawY = unit.y + jumpOffset;  // 跳动时整体上移

    // ── 蛋壳主体（椭圆形）──
    const shellColor = isPlayer ? '#f0e6d3' : '#d4c5a9';
    DC.fillStyle = shellColor;
    DC.beginPath();
    DC.ellipse(unit.x, drawY, eggW / 2, eggH / 2, 0, 0, 2 * Math.PI);
    DC.fill();

    // ── 蛋壳边框 ──
    DC.strokeStyle = isPlayer ? '#c4a97d' : '#a0845a';
    DC.lineWidth = 2;
    DC.stroke();

    // ── 蛋壳高光（左上角）──
    DC.fillStyle = 'rgba(255,255,255,0.35)';
    DC.beginPath();
    DC.ellipse(unit.x - eggW * 0.18, drawY - eggH * 0.2, eggW * 0.15, eggH * 0.12, -0.3, 0, 2 * Math.PI);
    DC.fill();

    // ── 蛋壳裂纹（未满血时有裂纹，快满时愈合）──
    const crackAlpha = Math.max(0, 1 - pct * 1.1);
    if (crackAlpha > 0) {
        DC.strokeStyle = `rgba(100,80,60,${crackAlpha * 0.5})`;
        DC.lineWidth = 1.2;
        const crackCount = Math.floor(3 + crackAlpha * 4);
        for (let i = 0; i < crackCount; i++) {
            const cx = unit.x + (Math.sin(i * 2.7 + eggTimer) * eggW * 0.3);
            const cy = drawY + (Math.cos(i * 1.3 + eggTimer * 0.5) * eggH * 0.35);
            DC.beginPath();
            DC.moveTo(cx, cy);
            DC.lineTo(cx + Math.sin(i * 1.7 + eggTimer) * 6, cy + Math.cos(i * 2.3) * 5);
            DC.stroke();
        }
    }

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '巨龙蛋',
        nameY: drawY - eggH / 2 - 12,
        barY: drawY - eggH / 2 - 8,
        barW: 28,
    });
}

/** ═══════════════════════════════════════════
 *  绘制孵化后的巨龙（倒三角▽身体+翅膀+尾巴，飞行单位）
 *  ═══════════════════════════════════════════ */
function drawHatchedDragon(unit) {
    const isPlayer = unit.team === 'player';
    const size = 18;   // 比飞龙(size=14)大一圈
    const floatOffset = Math.sin(game.time * 2.5) * 4;  unit._floatY = floatOffset; // 上下浮动
    const wingFlap = Math.sin(game.time * 4) * 3;       // 翅膀拍动

    // ── 影子（随地面，不浮动）──
    drawUnitShadow(unit, 24, 18, 8, 0.3);

    // ── 龙身（倒三角▽：宽肩尖尾）──
    const bodyColor = isPlayer ? '#e67e22' : '#c0392b';
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.moveTo(unit.x - size * 0.9, unit.y - size * 0.4 + floatOffset);  // 左上
    DC.lineTo(unit.x + size * 0.9, unit.y - size * 0.4 + floatOffset);  // 右上
    DC.lineTo(unit.x, unit.y + size + floatOffset);                      // 下尖
    DC.closePath();
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.6)';
    DC.lineWidth = 2;
    DC.stroke();

    // ── 翅膀（两侧三角形）──
    const wingColor = isPlayer ? '#d35400' : '#922b21';
    DC.fillStyle = wingColor;
    // 左翅膀
    DC.beginPath();
    DC.moveTo(unit.x - size * 0.5, unit.y - size * 0.1 + floatOffset);
    DC.lineTo(unit.x - size * 1.3, unit.y - size * 0.3 + wingFlap + floatOffset);
    DC.lineTo(unit.x - size * 0.4, unit.y + size * 0.3 + floatOffset);
    DC.closePath();
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.3)';
    DC.lineWidth = 1;
    DC.stroke();
    // 右翅膀
    DC.beginPath();
    DC.moveTo(unit.x + size * 0.5, unit.y - size * 0.1 + floatOffset);
    DC.lineTo(unit.x + size * 1.3, unit.y - size * 0.3 + wingFlap + floatOffset);
    DC.lineTo(unit.x + size * 0.4, unit.y + size * 0.3 + floatOffset);
    DC.closePath();
    DC.fill();
    DC.stroke();

    // ── 尾巴（小三角在身体下方）──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.moveTo(unit.x, unit.y + size * 0.7 + floatOffset);
    DC.lineTo(unit.x - 5, unit.y + size * 1.1 + floatOffset);
    DC.lineTo(unit.x + 5, unit.y + size * 1.1 + floatOffset);
    DC.closePath();
    DC.fill();

    // ── 名称 + 血条 ──
    drawNameBarFloat(unit, {
        name: '巨龙',
        nameY: unit.y - size - 14,
        barY: unit.y - size - 10,
        barW: 28,
    });
}

/** 绘制游侠（圆形身体 + 三角形兜帽 + 小弓形，简约几何风） */
function drawRanger(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = isPlayer ? '#2ecc71' : '#c0392b';   // 草绿 / 暗红
    const hatColor = isPlayer ? '#1abc9c' : '#922b21';    // 深绿 / 深红

    // ── ① 圆形身体 ──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, 10, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.5)';
    DC.lineWidth = 1;
    DC.stroke();

    // ── ② 三角形兜帽（头顶朝上）──
    DC.fillStyle = hatColor;
    DC.beginPath();
    DC.moveTo(unit.x, unit.y - 16);       // 尖顶
    DC.lineTo(unit.x - 6, unit.y - 9);    // 左下
    DC.lineTo(unit.x + 6, unit.y - 9);    // 右下
    DC.closePath();
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.3)';
    DC.lineWidth = 1;
    DC.stroke();

    // ── ③ 小弓形（身体右侧，白色弧线）──
    DC.strokeStyle = 'rgba(255,255,255,0.8)';
    DC.lineWidth = 2;
    DC.beginPath();
    DC.arc(unit.x + 7, unit.y, 5, -1.2, 1.2);
    DC.stroke();

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: CARDS[unit.cardId]?.name || '',
        nameY: unit.y - 22,
        barY: unit.y - 27,
    });
}

/** 绘制猎人（绿色圆身体 + 猎人帽 + 小弓 + 背箭袋，弓箭手放大版） */
function drawHunter(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = isPlayer ? '#27ae60' : '#7d3c98';   // 草绿 / 紫
    const hatColor = isPlayer ? '#1e8449' : '#5b2c6f';    // 深绿 / 深紫
    const size = 9; // 比弓箭手稍大

    // ── 身体 ──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, size, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.5)';
    DC.lineWidth = 1;
    DC.stroke();

    // ── 猎人帽（圆顶宽檐帽）──
    DC.fillStyle = hatColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y - 6, size * 0.75, Math.PI, 0); // 帽顶圆
    DC.fill();
    DC.fillRect(unit.x - size * 0.95, unit.y - 6, size * 1.9, 2.5); // 帽檐

    // ── 小弓（身体右侧，游侠同款）──
    DC.strokeStyle = 'rgba(255,255,255,0.8)';
    DC.lineWidth = 2;
    DC.beginPath();
    DC.arc(unit.x + 7, unit.y, 4.5, -1.2, 1.2);
    DC.stroke();
    // 弓弦
    DC.strokeStyle = 'rgba(255,255,255,0.4)';
    DC.lineWidth = 1;
    DC.beginPath();
    DC.moveTo(unit.x + 3.1, unit.y + 4);
    DC.lineTo(unit.x + 8, unit.y);
    DC.lineTo(unit.x + 3.1, unit.y - 4);
    DC.stroke();

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: CARDS[unit.cardId]?.name || '猎人',
        nameY: unit.y - size - 8,
        barY: unit.y - size - 12,
        barW: 28,
        barH: 3.5,
    });
}

/** 绘制弓箭手（哥布林大小的身体 + 游侠同款小弓） */
function drawArcher(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = isPlayer ? '#3498db' : '#e67e22';
    const size = 8; // 哥布林大小

    // ── 身体（哥布林大小）──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, size, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 小弓形（身体右侧，游侠同款）──
    DC.strokeStyle = 'rgba(255,255,255,0.8)';
    DC.lineWidth = 2;
    DC.beginPath();
    DC.arc(unit.x + 6, unit.y, 4, -1.2, 1.2);
    DC.stroke();

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '弓箭手',
        nameY: unit.y - size - 6,
        barY: unit.y - size - 10,
        barW: 28,
        barH: 3.5,
        font: 'bold 9px sans-serif',
    });
}

/** 绘制狂战士（弓箭手大小圆 + 棕色头发 + 棕色双丸子 + 双手两把mini小菜刀🔪朝向敌人） */
function drawBerserker(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = isPlayer ? '#3498db' : '#e67e22';
    const hairColor = '#8b5a2b'; // 🟤 棕色头发/丸子
    const size = 8; // 弓箭手（哥布林）大小

    // 💥 爆发状态变量（虚影/身体变暗/血红眼睛共用）：淡入淡出进度 + 浮动高度
    const berserkT = unit._berserkTimer > 0 ? Math.min(unit._berserkTimer, 6.0) : 0;
    const berserkAlpha = berserkT > 0 ? Math.min(1, (6 - berserkT) / 0.3, berserkT / 0.3) : 0;
    const ghostY = unit.y + Math.sin(game.time * 2.5) * 2.5;   // 虚影微微上下浮动

    // 💥 爆发·施法蓄力（0.6s）：脚下红色蓄力圈收缩，蓄满瞬间爆发
    if (unit._berserkCast > 0) {
        const p = 1 - Math.min(unit._berserkCast / 0.6, 1);   // 0→1
        DC.strokeStyle = `rgba(255,40,60,${0.35 + 0.55 * p})`;
        DC.lineWidth = 2;
        DC.beginPath();
        DC.arc(unit.x, unit.y, 15 - 8 * p, 0, 2 * Math.PI);
        DC.stroke();
    }

    // 💥 爆发·暗色虚影：狂战士背后浮现大号幽灵形灵体（持续 _berserkTimer 期间，6s）
    //    纯特效，画在身体最底层；前0.3s浮现、后0.3s消散，微微上下浮动
    if (berserkAlpha > 0) {
        DC.save();
        DC.globalAlpha = Math.max(0, Math.min(1, berserkAlpha * 0.65));
        DC.fillStyle = '#150a26';
        DC.strokeStyle = 'rgba(130,70,200,0.55)';
        DC.lineWidth = 1.5;
        DC.beginPath();
        DC.arc(unit.x, ghostY - 3, 17, Math.PI, 0);              // 大圆头（左→右过顶）
        DC.quadraticCurveTo(unit.x + 16, ghostY + 9, unit.x + 10, ghostY + 15);
        DC.quadraticCurveTo(unit.x + 6, ghostY + 12, unit.x + 3, ghostY + 18);
        DC.quadraticCurveTo(unit.x - 3, ghostY + 12, unit.x - 8, ghostY + 15);
        DC.quadraticCurveTo(unit.x - 13, ghostY + 10, unit.x - 17, ghostY + 2);
        DC.closePath();
        DC.fill();
        DC.stroke();
        DC.restore();
    }

    // ── 身体（弓箭手同款大小圆）──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, size, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 头发：身体圆上半部分涂棕（弧线刘海，不额外凸出发帽）──
    DC.save();
    DC.beginPath();
    DC.arc(unit.x, unit.y, size, 0, 2 * Math.PI);
    DC.clip();   // 头发与纹路只画在身体圆内部
    DC.fillStyle = hairColor;
    DC.beginPath();
    DC.moveTo(unit.x - size - 2, unit.y - size - 4);
    DC.lineTo(unit.x + size + 2, unit.y - size - 4);
    DC.lineTo(unit.x + size + 2, unit.y + 1.5);
    DC.quadraticCurveTo(unit.x, unit.y + 4.5, unit.x - size - 2, unit.y + 1.5);
    DC.closePath();
    DC.fill();
    // 发丝分层（两道深棕弧线，精细感）
    DC.strokeStyle = '#6d4c41';
    DC.lineWidth = 1;
    DC.beginPath();
    DC.arc(unit.x, unit.y - 4.5, 5, Math.PI + 0.75, 2 * Math.PI - 0.75);
    DC.stroke();
    DC.beginPath();
    DC.arc(unit.x, unit.y - 3.5, 2.8, Math.PI + 0.8, 2 * Math.PI - 0.8);
    DC.stroke();
    // 腰带（中下部弧线 + 中央方扣）
    DC.strokeStyle = 'rgba(0,0,0,0.25)';
    DC.beginPath();
    DC.moveTo(unit.x - 7, unit.y + 2.5);
    DC.quadraticCurveTo(unit.x, unit.y + 5.8, unit.x + 7, unit.y + 2.5);
    DC.stroke();
    DC.fillStyle = 'rgba(0,0,0,0.25)';
    DC.fillRect(unit.x - 1.25, unit.y + 4.2, 2.5, 2.5);
    // 🎀 腮红（少女感，左右脸颊粉色小椭圆）
    DC.fillStyle = 'rgba(255,105,150,0.40)';
    DC.beginPath();
    DC.ellipse(unit.x - 4.6, unit.y + 3.6, 2.2, 1.4, 0, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.ellipse(unit.x + 4.6, unit.y + 3.6, 2.2, 1.4, 0, 0, 2 * Math.PI);
    DC.fill();
    DC.restore();

    // ── 呆毛（头顶中央一撮翘起的卷毛，可爱）──
    DC.fillStyle = hairColor;
    DC.beginPath();
    DC.moveTo(unit.x - 1, unit.y - 8);
    DC.quadraticCurveTo(unit.x + 0.5, unit.y - 12.3, unit.x + 2.6, unit.y - 12.4);
    DC.quadraticCurveTo(unit.x + 1.8, unit.y - 10.8, unit.x + 1.6, unit.y - 8.8);
    DC.closePath();
    DC.fill();

    // ── 丸子：棕色双丸子 + 红色发绳 + 高光（精细可爱）──
    [ -6, 6 ].forEach(ox => {
        const cx = unit.x + ox, cy = unit.y - size - 1;
        // 丸子本体
        DC.fillStyle = hairColor;
        DC.strokeStyle = 'white';
        DC.lineWidth = 1;
        DC.beginPath();
        DC.arc(cx, cy, 3.5, 0, 2 * Math.PI);
        DC.fill();
        DC.stroke();
        // 红色发绳（丸子底部一圈）
        DC.strokeStyle = '#e74c3c';
        DC.lineWidth = 1.4;
        DC.beginPath();
        DC.arc(cx, cy, 3.2, Math.PI * 0.2, Math.PI * 0.8);
        DC.stroke();
        // 高光（左上小亮点）
        DC.fillStyle = 'rgba(255,255,255,0.85)';
        DC.beginPath();
        DC.arc(cx - 1.2, cy - 1.5, 0.9, 0, 2 * Math.PI);
        DC.fill();
    });

    // ── 两把mini小菜刀 🔪（左右手各一，朝向攻击目标；攻击时轮流挥砍，参考小王子弩的转向）──
    let angle = 0;
    if (unit.targetId) {
        const target = game.entities.find(en => en.id === unit.targetId && en.hp > 0 && !en._stealthed);
        if (target) {
            angle = Math.atan2(target.y - unit.y, target.x - unit.x);
        }
    }
    // 🗡️ 刺击特效进度（攻击时双刀同时向前刺出再缩回，仅特效）：0.3s内 0→1→0，幅度9px（与 update.js _swingTimer=0.3 对应，剑仙同款）
    const stabTimer = unit._swingTimer || 0;
    const stab = stabTimer > 0 ? Math.sin((1 - Math.min(stabTimer / 0.3, 1)) * Math.PI) * 9 : 0;
    DC.font = '13px sans-serif';                         // 🔪 大一点
    DC.textAlign = 'center';
    DC.textBaseline = 'middle';
    // 左手刀（身体左侧，刀尖朝目标；攻击时向前刺出）
    DC.save();
    DC.translate(unit.x - 7, unit.y + 1);
    DC.rotate(angle);
    DC.fillText('🔪', 2.5 + stab, 0);
    DC.restore();
    // 右手刀（身体右侧，刀尖朝目标；攻击时向前刺出）
    DC.save();
    DC.translate(unit.x + 7, unit.y + 1);
    DC.rotate(angle);
    DC.fillText('🔪', 2.5 + stab, 0);
    DC.restore();

    // 🐾 爆发·兽爪抓痕已迁移至全局特效层 game.clawEffects（渲染在所有实体之上，不被建模遮挡）
    //    相关代码见 render() 主循环「绘制狂战士爆发·兽爪血痕」块

    // 💥 爆发期间：整个身体变暗（暗色罩盖住身体圆+丸子；刀与血红眼睛保持最上层醒目）
    if (berserkAlpha > 0) {
        DC.fillStyle = `rgba(12,6,25,${0.5 * berserkAlpha})`;
        DC.beginPath();
        DC.arc(unit.x, unit.y, size + 0.5, 0, 2 * Math.PI);
        DC.fill();
        [-6, 6].forEach(ox => {
            DC.beginPath();
            DC.arc(unit.x + ox, unit.y - size - 1, 4, 0, 2 * Math.PI);
            DC.fill();
        });
    }

    // 💥 爆发·血红月牙眼（最顶层，悬浮头顶两侧，凶悍吊梢：内眼角低垂、外眼角上挑，红色发光弧线）
    if (berserkAlpha > 0) {
        // 每只眼睛：粗红弧线勾出上挑月牙，线帽圆润；内端靠眉心低垂、外端高高吊起（凶狠）
        [-6, 6].forEach(ox => {
            const ex = unit.x + ox, ey = ghostY - 7;
            const dir = ox < 0 ? -1 : 1;                       // 外眼角方向（左眼朝左、右眼朝右）
            DC.save();
            DC.shadowColor = 'rgba(255,0,40,0.95)';
            DC.shadowBlur = 14;
            DC.strokeStyle = `rgba(255,25,55,${berserkAlpha})`;
            DC.lineWidth = 2.8;
            DC.lineCap = 'round';
            DC.beginPath();
            DC.moveTo(ex - dir * 2.5, ey + 1.8);               // 内眼角（靠眉心，低垂）
            DC.quadraticCurveTo(ex, ey + 3.2, ex + dir * 2.5, ey - 1.8); // 下弯月牙，外眼角上挑
            DC.stroke();
            DC.restore();
            // 内眼角红点（愤怒皱眉感，点睛）
            DC.fillStyle = `rgba(255,40,70,${berserkAlpha})`;
            DC.beginPath();
            DC.arc(ex - dir * 2.6, ey + 2.1, 1, 0, 2 * Math.PI);
            DC.fill();
        });
    }

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '狂战士',
        nameY: unit.y - size - 9,
        barY: unit.y - size - 13,
        barW: 28,
        barH: 3.5,
        font: 'bold 9px sans-serif',
    });
}

/** 🥋 绘制武僧（精英可爱版：队伍色圆身圆头 + 棕色发髻 + 推掌朝向目标；攻击时手掌向前推出再缩回） */
function drawMonk(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = isPlayer ? '#3498db' : '#e67e22';     // 身体/发髻带（队伍色）
    const skinColor = '#f2c49b';                             // 肤色（头/手掌）
    const hairColor = '#5d4037';                             // 发髻棕
    const size = 9;
    const bodyRY = size * 0.84;                              // 身体球压扁（宽9 高7.6）

    // 🧘 超脱状态：全身冒起青色光晕（仅 _transcendTimer>0 的5秒期间；0.6s前摇无光晕），呼吸脉动包裹全身
    const transcendTimer = unit._transcendTimer || 0;
    if (transcendTimer > 0) {
        const auraR = 20 + Math.sin(game.time * 4) * 1.5;
        DC.beginPath();
        DC.arc(unit.x, unit.y - 4, auraR, 0, 2 * Math.PI);
        DC.fillStyle = 'rgba(0, 229, 255, 0.16)';
        DC.fill();
        DC.strokeStyle = 'rgba(0, 229, 255, 0.4)';
        DC.lineWidth = 1.8;
        DC.stroke();
        DC.beginPath();
        DC.arc(unit.x, unit.y - 4, auraR * 0.55, 0, 2 * Math.PI);
        DC.fillStyle = 'rgba(0, 229, 255, 0.10)';
        DC.fill();
    }

    // ── 身体（队伍色扁圆身）──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.ellipse(unit.x, unit.y, size, bodyRY, 0, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 衣服纹理：腰带弧线 + 中央方扣（裁剪在身体扁圆内）──
    DC.save();
    DC.beginPath();
    DC.ellipse(unit.x, unit.y, size, bodyRY, 0, 0, 2 * Math.PI);
    DC.clip();
    DC.strokeStyle = 'rgba(0,0,0,0.22)';
    DC.lineWidth = 1.2;
    DC.beginPath();
    DC.moveTo(unit.x - size + 0.5, unit.y + 4.6);
    DC.quadraticCurveTo(unit.x, unit.y + 7.4, unit.x + size - 0.5, unit.y + 4.6);
    DC.stroke();
    DC.fillStyle = 'rgba(0,0,0,0.22)';
    DC.fillRect(unit.x - 1.3, unit.y + 5.9, 2.6, 2.6);
    DC.restore();

    // ── 头（肤色圆头，叠在身体上方，两球靠近）──
    const headX = unit.x, headY = unit.y - 12.5;
    DC.fillStyle = skinColor;
    DC.beginPath();
    DC.arc(headX, headY, 6.8, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.2;
    DC.stroke();
    // 高光（左上小亮点）
    DC.fillStyle = 'rgba(255,255,255,0.5)';
    DC.beginPath();
    DC.arc(headX - 2.8, headY - 2.6, 2.1, 0, 2 * Math.PI);
    DC.fill();
    // 腮红（左右粉色小圆）
    DC.fillStyle = 'rgba(255,140,150,0.45)';
    DC.beginPath();
    DC.arc(headX - 4.4, headY + 1.8, 1.6, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.arc(headX + 4.4, headY + 1.8, 1.6, 0, 2 * Math.PI);
    DC.fill();

    // ── 发髻（头顶棕色小髻 + 红色发绳 + 高光）──
    DC.fillStyle = hairColor;
    DC.strokeStyle = 'white';
    DC.lineWidth = 1;
    DC.beginPath();
    DC.arc(headX, headY - 6.8, 3.2, 0, 2 * Math.PI);
    DC.fill();
    DC.stroke();
    // 红色发绳（髻底一圈）
    DC.strokeStyle = '#e74c3c';
    DC.lineWidth = 1.4;
    DC.beginPath();
    DC.arc(headX, headY - 6.8, 2.9, Math.PI * 0.15, Math.PI * 0.85);
    DC.stroke();
    // 髻高光（左上小亮点）
    DC.fillStyle = 'rgba(255,255,255,0.7)';
    DC.beginPath();
    DC.arc(headX - 1.2, headY - 7.8, 0.9, 0, 2 * Math.PI);
    DC.fill();

    // 🧘 超脱：手移到嘴的位置（诵经手势，前摇+光晕全程保持，不推掌）
    const transcendChant = unit._transcendChant || 0;
    const inTranscend = transcendChant > 0 || transcendTimer > 0;
    if (inTranscend) {
        // 嘴的位置（头下缘略偏）：手掌贴近嘴边，指尖朝上
        // 0.6s前摇内手掌从身侧推掌位逐渐移到嘴边（读 _transcendChant 进度）；光晕期间固定嘴边
        const chantT = unit._transcendChant || 0;
        const prog = chantT > 0 ? Math.max(0, Math.min(1, 1 - chantT / 0.6)) : 1;
        const mouthX = headX + 1.2, mouthY = headY + 4.2;
        const hx = unit.x + 8 + (mouthX - (unit.x + 8)) * prog;
        const hy = unit.y + 1 + (mouthY - (unit.y + 1)) * prog;
        DC.save();
        DC.translate(hx, hy);
        DC.rotate(-prog * Math.PI / 2); // 手掌随移动渐转：水平推掌 → 指尖朝上诵经
        // 掌根圆
        DC.fillStyle = skinColor;
        DC.beginPath();
        DC.arc(2.4, 0, 3.4, 0, 2 * Math.PI);
        DC.fill();
        DC.strokeStyle = 'rgba(0,0,0,0.15)';
        DC.lineWidth = 0.8;
        DC.stroke();
        // 四指（指尖朝上）
        [[1.6, -3.6], [2.8, -2.8], [3.3, -1.6], [3.3, -0.4]].forEach(([ox, oy]) => {
            DC.beginPath();
            DC.arc(ox, oy, 1.25, 0, 2 * Math.PI);
            DC.fill();
            DC.stroke();
        });
        DC.restore();
    } else {
    // ── 推掌（手掌伸向攻击目标；攻击时向前推出再缩回，狂战士刺击同款节奏）──
    let angle = 0;
    if (unit.targetId) {
        const target = game.entities.find(en => en.id === unit.targetId && en.hp > 0 && !en._stealthed);
        if (target) {
            angle = Math.atan2(target.y - unit.y, target.x - unit.x);
        }
    }
    const stabTimer = unit._swingTimer || 0;
    const stab = stabTimer > 0 ? Math.sin((1 - Math.min(stabTimer / 0.3, 1)) * Math.PI) * 9 : 0;
    DC.save();
    DC.translate(unit.x + 8, unit.y + 1);
    DC.rotate(angle);
    // 🫸 强化普攻虚影：手掌浮现大一些的半透明推手，随推出淡出（三连击第3下，_strongPunchTimer>0）
    const strongT = unit._strongPunchTimer || 0;
    if (strongT > 0) {
        const sAlpha = Math.min(strongT / 0.3, 1);
        DC.save();
        DC.globalAlpha = sAlpha * 0.85;
        DC.translate(stab * 1.5, 0);
        DC.font = '28px sans-serif';
        DC.textAlign = 'center';
        DC.textBaseline = 'middle';
        DC.fillText('🫸', 7, 0);
        DC.restore();
    }
    DC.translate(stab, 0);   // 沿目标方向推出
    // 掌心（肤色圆）
    DC.fillStyle = skinColor;
    DC.beginPath();
    DC.arc(0, 0, 3.6, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(0,0,0,0.15)';
    DC.lineWidth = 0.8;
    DC.stroke();
    // 四指（朝目标方向伸出的小圆头）
    DC.fillStyle = skinColor;
    [[2.6, -1.7], [3.4, -0.6], [3.4, 0.6], [2.6, 1.7]].forEach(([ox, oy]) => {
        DC.beginPath();
        DC.arc(ox, oy, 1.25, 0, 2 * Math.PI);
        DC.fill();
        DC.stroke();
    });
    // 拇指（掌心后侧斜出）
    DC.beginPath();
    DC.arc(0.4, -3.1, 1.15, 0, 2 * Math.PI);
    DC.fill();
    DC.stroke();
    // 掌纹（一道弧线）
    DC.strokeStyle = 'rgba(0,0,0,0.12)';
    DC.lineWidth = 0.7;
    DC.beginPath();
    DC.moveTo(-1.6, 1.2);
    DC.quadraticCurveTo(-0.2, 2.2, 1.6, 1.2);
    DC.stroke();
    DC.restore();
    }

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '武僧',
        nameY: unit.y - size - 15,
        barY: unit.y - size - 19,
        barW: 28,
        barH: 3.5,
        font: 'bold 9px sans-serif',
    });
}

/** 绘制哥布林投矛手（哥布林大小的身体 + 斜举长矛，弓箭手同体型） */
function drawGoblinThrower(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = '#1e8449';   // 哥布林系列统一暗绿（敌我靠血条色/名字区分）
    const size = 8; // 同弓箭手（哥布林大小）

    // ── 身体（哥布林大小）──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, size, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 哥布林特征：暗蓝斜带（左上→右下）──
    DC.save();
    DC.beginPath();
    DC.arc(unit.x, unit.y, size, 0, 2 * Math.PI);
    DC.clip();
    DC.strokeStyle = '#1a5276';
    DC.lineWidth = 4;
    DC.beginPath();
    DC.moveTo(unit.x - size, unit.y - size);
    DC.lineTo(unit.x + size, unit.y + size);
    DC.stroke();
    DC.restore();

    // ── 手持长矛（身体右侧斜举：木柄 + 菱形矛头）──
    DC.save();
    DC.translate(unit.x + 7, unit.y - 2);
    DC.rotate(-0.7);
    DC.strokeStyle = '#8d6e63';
    DC.lineWidth = 2.5;
    DC.beginPath();
    DC.moveTo(-11, 0);
    DC.lineTo(8, 0);
    DC.stroke();
    DC.fillStyle = '#cfd8dc';
    DC.beginPath();
    DC.moveTo(15, 0);   // 尖端
    DC.lineTo(7, -4);   // 左翼
    DC.lineTo(11, 0);   // 尾左
    DC.lineTo(7, 4);    // 右翼
    DC.closePath();
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.5)';
    DC.lineWidth = 1;
    DC.stroke();
    DC.restore();

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '哥布林投矛手',
        nameY: unit.y - size - 6,
        barY: unit.y - size - 10,
        barW: 28,
        barH: 3.5,
        font: 'bold 9px sans-serif',
    });
}

/** 绘制哥布林吹箭手（哥布林同款身体 + 手持吹箭筒，与投矛手同体型） */
function drawGoblinBlowgun(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = '#1e8449';   // 哥布林系列统一暗绿（敌我靠血条色/名字区分）
    const size = 8; // 同投矛手/弓箭手（哥布林大小）

    // ── 身体（哥布林同款底座）──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, size, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 哥布林特征：暗蓝斜带（左上→右下）──
    DC.save();
    DC.beginPath();
    DC.arc(unit.x, unit.y, size, 0, 2 * Math.PI);
    DC.clip();
    DC.strokeStyle = '#1a5276';
    DC.lineWidth = 4;
    DC.beginPath();
    DC.moveTo(unit.x - size, unit.y - size);
    DC.lineTo(unit.x + size, unit.y + size);
    DC.stroke();
    DC.restore();

    // ── 手持吹箭筒（身体右侧斜举：短竹筒 + 前端小吹口 + 尾部斜切）──
    DC.save();
    DC.translate(unit.x + 6, unit.y - 2);
    DC.rotate(-0.15);
    // 吹箭筒身（短棕色竹管）
    DC.strokeStyle = '#8d6e63';
    DC.lineWidth = 4;
    DC.beginPath();
    DC.moveTo(-8, 0);
    DC.lineTo(8, 0);
    DC.stroke();
    // 筒身高光（细亮线）
    DC.strokeStyle = 'rgba(255,255,255,0.45)';
    DC.lineWidth = 1.2;
    DC.beginPath();
    DC.moveTo(-6, -1.4);
    DC.lineTo(6, -1.4);
    DC.stroke();
    // 前端吹口（深色金属圈）
    DC.strokeStyle = '#5d4037';
    DC.lineWidth = 2.5;
    DC.beginPath();
    DC.moveTo(9, 0);
    DC.lineTo(11, 0);
    DC.stroke();
    // 尾部斜切面（浅色小椭圆）
    DC.fillStyle = '#a1887f';
    DC.beginPath();
    DC.ellipse(-8, 0, 2, 3.2, 0, 0, 2 * Math.PI);
    DC.fill();
    DC.restore();

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '哥布林吹箭手',
        nameY: unit.y - size - 6,
        barY: unit.y - size - 10,
        barW: 28,
        barH: 3.5,
        font: 'bold 9px sans-serif',
    });
}

/** 绘制反甲巨人（以巨人为基底：保持轮廓紧凑，加入薄背甲与少量短刺） */
function drawAntiArmorGiant(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = '#7f8c8d';
    const armorColor = isPlayer ? '#2874a6' : '#922b21';
    const plateColor = isPlayer ? '#5dade2' : '#e67e22';
    const r = 16;
    const thornRadius = CARDS[unit.cardId]?.thornsRadius || 75;

    // 🦔 反甲范围：淡色小环，低频呼吸式渐变闪烁（不使用高频闪烁）
    const pulse = 0.5 + 0.5 * Math.sin(game.time * 1.6);
    DC.save();
    // 最暗时完全消失，最亮时提高透明度和线宽，保持低频呼吸感
    DC.globalAlpha = pulse * 0.38;
    DC.strokeStyle = '#d7edf2';
    DC.lineWidth = 1.5 + pulse * 1.0;
    DC.setLineDash([4, 5]);
    DC.beginPath();
    DC.arc(unit.x, unit.y, thornRadius, 0, 2 * Math.PI);
    DC.stroke();
    DC.setLineDash([]);
    DC.restore();

    // 背后短刺：只沿轮廓分布，不扩大主体体积
    DC.save();
    DC.fillStyle = plateColor;
    DC.strokeStyle = '#34495e';
    DC.lineWidth = 1;
    const spikes = [
        [-13, -9, -20, -13], [-16, -2, -24, -3], [-15, 6, -22, 10],
        [13, -9, 20, -13], [16, -2, 24, -3], [15, 6, 22, 10],
    ];
    for (const [bx, by, tx, ty] of spikes) {
        DC.beginPath();
        DC.moveTo(unit.x + bx - 3, unit.y + by + 2);
        DC.lineTo(unit.x + tx, unit.y + ty);
        DC.lineTo(unit.x + bx + 3, unit.y + by - 2);
        DC.closePath();
        DC.fill();
        DC.stroke();
    }
    DC.restore();

    // 保持普通巨人的紧凑圆形身体
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, r, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = '#ecf0f1';
    DC.lineWidth = 1.5;
    DC.stroke();

    // 薄型背甲/胸甲，只覆盖局部，不让身体显得更胖
    DC.fillStyle = armorColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y + 1, 11, Math.PI * 0.15, Math.PI * 0.85);
    DC.lineTo(unit.x + 7, unit.y + 8);
    DC.lineTo(unit.x - 7, unit.y + 8);
    DC.closePath();
    DC.globalAlpha = 0.82;
    DC.fill();
    DC.globalAlpha = 1;
    DC.strokeStyle = 'rgba(230,240,245,0.75)';
    DC.lineWidth = 1;
    DC.beginPath();
    DC.moveTo(unit.x, unit.y - 8);
    DC.lineTo(unit.x, unit.y + 8);
    DC.moveTo(unit.x - 8, unit.y + 5);
    DC.lineTo(unit.x + 8, unit.y + 5);
    DC.stroke();

    // 头部保留巨人简洁识别度，增加小型刺冠
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y - 3, 10, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = '#ecf0f1';
    DC.lineWidth = 1.2;
    DC.stroke();
    DC.fillStyle = plateColor;
    DC.beginPath();
    DC.moveTo(unit.x - 7, unit.y - 10);
    DC.lineTo(unit.x - 4, unit.y - 16);
    DC.lineTo(unit.x, unit.y - 11);
    DC.lineTo(unit.x + 4, unit.y - 16);
    DC.lineTo(unit.x + 7, unit.y - 10);
    DC.closePath();
    DC.fill();
    DC.strokeStyle = '#34495e';
    DC.stroke();

    // 少量铆钉，强化反甲材质
    DC.fillStyle = '#f1c40f';
    for (const [dx, dy] of [[-7, 3], [7, 3], [-6, 8], [6, 8]]) {
        DC.beginPath();
        DC.arc(unit.x + dx, unit.y + dy, 1.2, 0, 2 * Math.PI);
        DC.fill();
    }

    drawNameBar(unit, {
        name: CARDS[unit.cardId]?.name || '反甲巨人',
        nameY: unit.y - 25,
        barY: unit.y - 21,
    });
}

/** 绘制哥布林巨人（大号哥布林底座 + 腰间两个鼓包袋子，锁定建筑） */
function drawGoblinGiant(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = '#1e8449';   // 哥布林系列统一暗绿（敌我靠血条色/名字区分）
    const size = 15; // 大号：普通哥布林(8)近2倍，比巨人(16)略小

    // ── 身体（大号哥布林圆身）──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, size, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 2;
    DC.stroke();

    // ── 哥布林特征：暗蓝斜带（左上→右下，加粗）──
    DC.save();
    DC.beginPath();
    DC.arc(unit.x, unit.y, size, 0, 2 * Math.PI);
    DC.clip();
    DC.strokeStyle = '#1a5276';
    DC.lineWidth = 7;
    DC.beginPath();
    DC.moveTo(unit.x - size, unit.y - size);
    DC.lineTo(unit.x + size, unit.y + size);
    DC.stroke();
    DC.restore();

    // ── 腰间两个鼓包袋子（挂在圆身左下角/右下角，大鼓包略向圆心内收）──
    const bagColor = '#6d4c41';   // 深棕皮袋
    for (const sx of [-1, 1]) {
        const bx = unit.x + sx * 7.5, by = unit.y + 8;
        DC.fillStyle = bagColor;
        DC.beginPath();
        DC.arc(bx, by, 7, 0, 2 * Math.PI);
        DC.fill();
        DC.strokeStyle = 'rgba(255,255,255,0.35)';
        DC.lineWidth = 1;
        DC.stroke();
        // 袋子高光点
        DC.fillStyle = 'rgba(255,255,255,0.35)';
        DC.beginPath();
        DC.arc(bx - 2, by - 2, 2, 0, 2 * Math.PI);
        DC.fill();
    }

    // ── 袋口露出两个小投矛手（小绿头 + 斜举小矛，直观体现"袋里装着投矛手"）──
    for (const sx of [-1, 1]) {
        const bx = unit.x + sx * 7.5, by = unit.y + 8;
        // 小头（半露出袋口）
        DC.fillStyle = bodyColor;
        DC.beginPath();
        DC.arc(bx, by - 6, 4, 0, 2 * Math.PI);
        DC.fill();
        DC.strokeStyle = 'white';
        DC.lineWidth = 1;
        DC.stroke();
        // 眼睛
        DC.fillStyle = '#fff';
        DC.beginPath();
        DC.arc(bx + sx * 1.2, by - 6.5, 1.2, 0, 2 * Math.PI);
        DC.fill();
        DC.fillStyle = '#111';
        DC.beginPath();
        DC.arc(bx + sx * 1.2, by - 6.5, 0.6, 0, 2 * Math.PI);
        DC.fill();
        // 小暗蓝斜带（家族特征）
        DC.save();
        DC.beginPath();
        DC.arc(bx, by - 6, 4, 0, 2 * Math.PI);
        DC.clip();
        DC.strokeStyle = '#1a5276';
        DC.lineWidth = 2;
        DC.beginPath();
        DC.moveTo(bx - 4, by - 10);
        DC.lineTo(bx + 4, by - 2);
        DC.stroke();
        DC.restore();
        // 斜举小矛（朝外侧上方）
        DC.save();
        DC.translate(bx + sx * 4, by - 7.5);
        DC.rotate(-0.7 * sx);
        DC.strokeStyle = '#8d6e63';
        DC.lineWidth = 1.5;
        DC.beginPath();
        DC.moveTo(-5, 0);
        DC.lineTo(5, 0);
        DC.stroke();
        DC.fillStyle = '#cfd8dc';
        DC.beginPath();
        DC.moveTo(8, 0);
        DC.lineTo(3, -2);
        DC.lineTo(5, 0);
        DC.lineTo(3, 2);
        DC.closePath();
        DC.fill();
        DC.restore();
    }

    // ── 名称 + 血条（通用模板 28×3.5）──
    drawNameBar(unit, {
        name: '哥布林巨人',
        nameY: unit.y - size - 8,
        barY: unit.y - size - 12,
    });
}

/** 绘制哥布林（哥布林大小的身体 + 斜握小刀，与投矛手同体型；近战） */
function drawGoblinMelee(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = '#1e8449';   // 哥布林系列统一暗绿（敌我靠血条色/名字区分）
    const size = 8; // 同投矛手/弓箭手（哥布林大小）

    // ── 身体（哥布林大小）──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, size, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 哥布林特征：暗蓝斜带（左上→右下）──
    DC.save();
    DC.beginPath();
    DC.arc(unit.x, unit.y, size, 0, 2 * Math.PI);
    DC.clip();
    DC.strokeStyle = '#1a5276';
    DC.lineWidth = 4;
    DC.beginPath();
    DC.moveTo(unit.x - size, unit.y - size);
    DC.lineTo(unit.x + size, unit.y + size);
    DC.stroke();
    DC.restore();

    // ── 手持小刀（身体右侧斜握：短柄 + 银色刀片）──
    DC.save();
    DC.translate(unit.x + 6, unit.y - 1);
    DC.rotate(-0.5);
    DC.strokeStyle = '#8d6e63';
    DC.lineWidth = 2;
    DC.beginPath();
    DC.moveTo(-3, 0);
    DC.lineTo(3, 0);
    DC.stroke();
    DC.fillStyle = '#e0e0e0';
    DC.beginPath();
    DC.moveTo(9, 0);    // 刀尖
    DC.lineTo(2, -2.5); // 刀背
    DC.lineTo(4.5, 0);  // 刀根
    DC.lineTo(2, 2.5);  // 刀刃
    DC.closePath();
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.5)';
    DC.lineWidth = 0.8;
    DC.stroke();
    DC.restore();

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '哥布林',
        nameY: unit.y - size - 6,
        barY: unit.y - size - 10,
        barW: 28,
        barH: 3.5,
        font: 'bold 9px sans-serif',
    });
}

/** 绘制哥布林爆破手（哥布林同款底座·和强壮哥布林同大小 + 右下角🧨 左下角💣 挂身上、都在底座圆内） */
function drawGoblinBomber(unit) {
    const size = 10; // 和强壮哥布林同大小（普通哥布林为8）
    const bodyColor = '#1e8449'; // 哥布林系列统一暗绿（敌我靠血条色/名字区分）

    // ── 身体（哥布林同款底座，强壮哥布林大小）──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, size, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 哥布林特征：暗蓝斜带（左上→右下）──
    DC.save();
    DC.beginPath();
    DC.arc(unit.x, unit.y, size, 0, 2 * Math.PI);
    DC.clip();
    DC.strokeStyle = '#1a5276';
    DC.lineWidth = 4;
    DC.beginPath();
    DC.moveTo(unit.x - size, unit.y - size);
    DC.lineTo(unit.x + size, unit.y + size);
    DC.stroke();
    DC.restore();

    // ── 挂身上的弹药：右下角🧨 + 左下角💣（都在底座圆内）──
    DC.font = '9px sans-serif';
    DC.textAlign = 'center';
    DC.textBaseline = 'middle';
    if (unit.isSiege) {
        // 🩸 半血狂暴提示：🧨消失、💣变大并移到原🧨和💣正中央（准备自爆）
        DC.font = 'bold 13px sans-serif';
        DC.fillText('💣', unit.x - size * 0.015, unit.y + size * 0.325);
    } else {
        DC.fillText('🧨', unit.x + size * 0.42, unit.y + size * 0.35);
        DC.fillText('💣', unit.x - size * 0.45, unit.y + size * 0.3);
    }

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '哥布林爆破手',
        nameY: unit.y - size - 6,
        barY: unit.y - size - 10,
        barW: 28,
        barH: 3.5,
        font: 'bold 9px sans-serif',
    });
}

/** 绘制攻城人（白色身体·哥布林大小 + 头举💣：💣圆心在身体圆心正上方、略微超过圆上边界） */
function drawSiegeMan(unit) {
    const size = 8; // 哥布林大小
    const bodyColor = '#ffffff'; // 白色身体

    // ── 身体（哥布林大小白色圆）──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, size, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = '#bbbbbb'; // 浅灰描边，轮廓清晰（同骷髅）
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 头举💣（圆心在正上方、略微超过圆上边界）──
    DC.font = 'bold 12px sans-serif';
    DC.textAlign = 'center';
    DC.textBaseline = 'middle';
    DC.fillText('💣', unit.x, unit.y - size - 1);

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '攻城人',
        nameY: unit.y - size - 10,
        barY: unit.y - size - 14,
        barW: 28,
        barH: 3.5,
        font: 'bold 9px sans-serif',
    });
}

/** 绘制免伤法徒（小圆头+倒三角身体+影子+浮动，比飞龙略小） */
function drawImmunityDisciple(unit) {
    const isPlayer = unit.team === 'player';
    const size = 11;  // 比飞龙(size=14)小一圈
    const floatOffset = Math.sin(game.time * 3) * 3; unit._floatY = floatOffset;

    // ── ✨ 白色柔和光环（以攻击范围为界，平缓脉动）──
    const auraRadius = 108;
    const pulse = 0.95 + 0.05 * Math.sin(game.time * 2.0); // 更慢更柔的呼吸
    const r = auraRadius * pulse;

    // 外圈光环（极淡填充+柔和描边）
    DC.beginPath();
    DC.arc(unit.x, unit.y, r, 0, 2 * Math.PI);
    DC.fillStyle = 'rgba(255, 255, 255, 0.035)';
    DC.fill();
    DC.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    DC.lineWidth = 1.5;
    DC.stroke();

    // 内圈更淡淡光晕
    DC.beginPath();
    DC.arc(unit.x, unit.y, r * 0.5, 0, 2 * Math.PI);
    DC.fillStyle = 'rgba(255, 255, 255, 0.018)';
    DC.fill();

    // 影子（随地面，不浮动）
    drawUnitShadow(unit, 18, 12, 6, 0.3);

    // ── 倒三角身体 ──
    const bodyColor = isPlayer ? '#2ecc71' : '#27ae60';
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.moveTo(unit.x - size, unit.y - size + floatOffset);
    DC.lineTo(unit.x + size, unit.y - size + floatOffset);
    DC.lineTo(unit.x, unit.y + size + floatOffset);
    DC.closePath();
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.6)';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 小圆头 ──
    DC.fillStyle = '#f5d6b8';
    DC.beginPath();
    DC.arc(unit.x, unit.y - size - 5 + floatOffset, 5, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.4)';
    DC.lineWidth = 1;
    DC.stroke();

    // 名称 + 血条
    drawNameBarFloat(unit, {
        name: '免伤法徒',
        nameY: unit.y - size - 14,
        barY: unit.y - size - 20,
        barW: 28,
    });
}

/** 绘制战斗天使（白色圆身+金色双翼+头顶光环，飞行浮动，体型比免伤法徒略大） */
function drawBattleAngel(unit) {
    const isPlayer = unit.team === 'player';
    const size = 12;  // 圆身半径
    const floatOffset = Math.sin(game.time * 3) * 3; unit._floatY = floatOffset;

    // ── 💚 治疗光环（仅治疗持续期间显示：登场/攻击触发后亮起，1.2秒后消失）──
    if (unit._healActive > 0) {
        const auraRadius = CARDS.battle_angel.healRadius || 75;
        const pulse = 0.95 + 0.05 * Math.sin(game.time * 2.0); // 更慢更柔的呼吸
        const r = auraRadius * pulse;

        // 外圈光环（极淡填充+柔和描边）
        DC.beginPath();
        DC.arc(unit.x, unit.y, r, 0, 2 * Math.PI);
        DC.fillStyle = 'rgba(46, 204, 113, 0.05)';
        DC.fill();
        DC.strokeStyle = 'rgba(46, 204, 113, 0.22)';
        DC.lineWidth = 1.5;
        DC.stroke();

        // 内圈更淡淡光晕（贴近自身）
        DC.beginPath();
        DC.arc(unit.x, unit.y, r * 0.5, 0, 2 * Math.PI);
        DC.fillStyle = 'rgba(46, 204, 113, 0.035)';
        DC.fill();
    }

    // 影子（贴地，不随浮动）
    drawUnitShadow(unit, 18, 12, 6, 0.3);

    const bodyColor = isPlayer ? '#ffffff' : '#e8e8e8';
    const wingColor = isPlayer ? '#f9e79f' : '#f0c27f';
    const ringColor = isPlayer ? '#f1c40f' : '#e67e22';

    // ── 金色双翼（左右对称，向上展开的弧翼）──
    DC.fillStyle = wingColor;
    DC.beginPath();
    DC.moveTo(unit.x - size * 0.35, unit.y - 1 + floatOffset);
    DC.quadraticCurveTo(unit.x - size * 1.7, unit.y - size * 1.1 + floatOffset, unit.x - size * 0.85, unit.y - size * 0.35 + floatOffset);
    DC.closePath();
    DC.fill();
    DC.beginPath();
    DC.moveTo(unit.x + size * 0.35, unit.y - 1 + floatOffset);
    DC.quadraticCurveTo(unit.x + size * 1.7, unit.y - size * 1.1 + floatOffset, unit.x + size * 0.85, unit.y - size * 0.35 + floatOffset);
    DC.closePath();
    DC.fill();

    // ── 白色圆身（金色描边）──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y + floatOffset, size, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(241,196,15,0.7)';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 头顶金色光环（小椭圆环，随浮动）──
    DC.strokeStyle = ringColor;
    DC.lineWidth = 2.5;
    DC.beginPath();
    DC.ellipse(unit.x, unit.y - size - 4 + floatOffset, 6, 2.5, 0, 0, 2 * Math.PI);
    DC.stroke();

    // 名称 + 血条
    drawNameBarFloat(unit, {
        name: '战斗天使',
        nameY: unit.y - size - 14,
        barY: unit.y - size - 20,
    });
}

/** 绘制冥王（竖直长方形+圆+竖直长方形 + 灵魂进度条，矮胖压扁版） */
function drawHades(unit) {
    const isPlayer = unit.team === 'player';
    const soulProg = (unit._souls % unit._soulsPerLevel) / unit._soulsPerLevel;

    // ── 主体色（满级10级 → 暗金色风格：不同部位明暗有别，整体暗金）──
    const isMax = unit._level >= unit._maxLevel;
    const mainColor = isMax ? '#b8860b' : (isPlayer ? '#8e44ad' : '#6c3483');
    const darkColor = isMax ? '#8b6508' : (isPlayer ? '#6c3483' : '#4a235a');
    const accentColor = isMax ? '#d4af37' : (isPlayer ? '#a569bd' : '#8e44ad');
    const edgeColor = isMax ? 'rgba(255,215,0,0.35)' : 'rgba(255,255,255,0.2)';

    // ── 下段竖直长方形（底座/裙摆）─ 宽22高6 ──
    DC.fillStyle = darkColor;
    DC.fillRect(unit.x - 11, unit.y + 2, 22, 6);
    DC.strokeStyle = edgeColor;
    DC.lineWidth = 1;
    DC.strokeRect(unit.x - 11, unit.y + 2, 22, 6);

    // ── 中段竖直长方形（身体/长袍）─ 宽16高14 ──
    DC.fillStyle = mainColor;
    DC.fillRect(unit.x - 8, unit.y - 12, 16, 14);
    DC.strokeStyle = edgeColor;
    DC.lineWidth = 1;
    DC.strokeRect(unit.x - 8, unit.y - 12, 16, 14);

    // ── 上段圆（头部，满级暗金浅金头，无表情）─ 半径7 ──
    DC.fillStyle = isMax ? '#e6c34a' : '#d5b895';
    DC.beginPath();
    DC.arc(unit.x, unit.y - 16, 7, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = accentColor;
    DC.lineWidth = 2;
    DC.stroke();

    // ── 头顶小皇冠/装饰 ──
    DC.fillStyle = accentColor;
    DC.fillRect(unit.x - 4, unit.y - 22, 8, 3);
    DC.fillRect(unit.x - 2, unit.y - 25, 4, 3);

    // ── 名称 + 血条（第一层样板收口）──
    drawNameBar(unit, {
        name: `冥王 Lv${unit._level}`,
        nameY: unit.y - 30,
        barY: unit.y - 22,
        barW: 28,
        barH: 3.5,
        color: unit._level >= unit._maxLevel ? '#ffd700' : 'white',
    });

    // ── 灵魂进度条（通用蓄力条；未满级才显示，计数小字在条右侧）──
    if (unit._level < unit._maxLevel) {
        drawChargeBar(unit, soulProg, accentColor, `Lv${unit._level}`);
    }
}

/** 绘制飞行单位（倒三角建模，通用飞行单位模板） */
function drawDragon(unit) {
    const isPlayer = unit.team === 'player';
    const size = 14;
    const floatOffset = Math.sin(game.time * 3) * 3;   unit._floatY = floatOffset; // 上下浮动

    // 影子（椭圆投影，不随浮动，保持在地面）
    drawUnitShadow(unit, 20, 16, 8, 0.3);

    // 倒三角身体（▽，跟随浮动）
    DC.fillStyle = isPlayer ? '#e67e22' : '#c0392b';
    DC.beginPath();
    DC.moveTo(unit.x - size, unit.y - size + floatOffset);       // 左上
    DC.lineTo(unit.x + size, unit.y - size + floatOffset);       // 右上
    DC.lineTo(unit.x, unit.y + size + floatOffset);              // 下尖
    DC.closePath();
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // 名称 + 血条（跟随浮动）
    drawNameBarFloat(unit, {
        name: '飞龙',
        nameY: unit.y - size - 12,
        barY: unit.y - size - 18,
    });
}

/** 绘制地狱飞龙：严格参考普通飞龙的倒三角身体，加入熔岩纹、外展扇动小翅膀与上置吐息口 */
function drawInfernoDragon(unit) {
    const isPlayer = unit.team === 'player';
    const size = 14;
    const floatOffset = Math.sin(game.time * 3) * 3;
    unit._floatY = floatOffset;
    drawUnitShadow(unit, 20, 16, 8, 0.3);
    const y = unit.y + floatOffset;

    // 少量装饰置于身体后方：小翅膀略微向外斜、放大，并做扇动效果
    const wingFlap = Math.sin(game.time * 9) * 2.5;
    DC.fillStyle = isPlayer ? '#7d1f16' : '#4a1010';
    DC.beginPath();
    DC.moveTo(unit.x - 6, y - 5);
    DC.lineTo(unit.x - 24, y - 18 - wingFlap);
    DC.lineTo(unit.x - 15, y + 6 + wingFlap * 0.35);
    DC.closePath();
    DC.fill();
    DC.beginPath();
    DC.moveTo(unit.x + 6, y - 5);
    DC.lineTo(unit.x + 24, y - 18 - wingFlap);
    DC.lineTo(unit.x + 15, y + 6 + wingFlap * 0.35);
    DC.closePath();
    DC.fill();

    // 背部熔岩尖刺装饰
    DC.fillStyle = isPlayer ? '#b83220' : '#7b1e1e';
    DC.beginPath();
    DC.moveTo(unit.x - 8, y - size + 3);
    DC.lineTo(unit.x - 4, y - size - 7);
    DC.lineTo(unit.x, y - size + 2);
    DC.lineTo(unit.x + 5, y - size - 8);
    DC.lineTo(unit.x + 9, y - size + 4);
    DC.closePath();
    DC.fill();

    // 普通飞龙同款：倒三角身体（▽）
    DC.fillStyle = isPlayer ? '#9e2b20' : '#681515';
    DC.beginPath();
    DC.moveTo(unit.x - size, y - size);
    DC.lineTo(unit.x + size, y - size);
    DC.lineTo(unit.x, y + size);
    DC.closePath();
    DC.fill();
    DC.strokeStyle = '#ffb347';
    DC.lineWidth = 1.5;
    DC.stroke();

    // 熔岩纹路：保留装饰感，但不绘制眼睛
    DC.strokeStyle = '#ff6b22';
    DC.lineWidth = 1.5;
    DC.beginPath();
    DC.moveTo(unit.x - 6, y + 4);
    DC.lineTo(unit.x, y - 1);
    DC.lineTo(unit.x + 6, y + 4);
    DC.moveTo(unit.x - 4, y - 7);
    DC.lineTo(unit.x, y - 3);
    DC.lineTo(unit.x + 4, y - 7);
    DC.stroke();

    // 吐息口位于身体上部
    const mouthX = unit.x;
    const mouthY = y - 9;
    DC.fillStyle = '#fff3b0';
    DC.beginPath();
    DC.arc(mouthX, mouthY, 3.5, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = '#ff7a18';
    DC.lineWidth = 1;
    DC.stroke();

    // 光束从偏上方的吐息口发出
    if (unit._beamTargetId) {
        const target = game.entities.find(en => en.id === unit._beamTargetId && en.hp > 0);
        if (target) {
            DC.beginPath();
            DC.moveTo(mouthX, mouthY);
            DC.lineTo(target.x, target.y);
            DC.strokeStyle = 'rgba(255,120,20,0.35)';
            DC.lineWidth = 8;
            DC.stroke();
            DC.beginPath();
            DC.moveTo(mouthX, mouthY);
            DC.lineTo(target.x, target.y);
            DC.strokeStyle = '#ffd54a';
            DC.lineWidth = 2 + Math.min(unit._beamTimer || 0, 5) * 2;
            DC.stroke();
        }
    }

    drawNameBarFloat(unit, {
        name: '地狱飞龙',
        nameY: unit.y - size - 12,
        barY: unit.y - size - 18,
    });
}

/** 绘制熔岩猎犬（暗红熔岩大圆身+熔岩裂纹+左右小翅膀+金色火焰眼，比飞龙大一圈） */
function drawLavaHound(unit) {
    const isPlayer = unit.team === 'player';
    const size = 16;   // 比飞龙(size=14)大，同巨人圆身
    const floatOffset = Math.sin(game.time * 3) * 3;   unit._floatY = floatOffset; // 上下浮动

    // 影子（椭圆投影，不随浮动，保持在地面）
    drawUnitShadow(unit, 22, 20, 9, 0.3);

    // ── 左右小翅膀 ──
    DC.fillStyle = isPlayer ? '#c97b1f' : '#8e2f0f';
    // 左翅
    DC.beginPath();
    DC.moveTo(unit.x - size * 0.35, unit.y - size * 0.35 + floatOffset);
    DC.lineTo(unit.x - size * 1.5, unit.y - size * 0.9 + floatOffset);
    DC.lineTo(unit.x - size * 0.45, unit.y + size * 0.35 + floatOffset);
    DC.closePath();
    DC.fill();
    // 右翅
    DC.beginPath();
    DC.moveTo(unit.x + size * 0.35, unit.y - size * 0.35 + floatOffset);
    DC.lineTo(unit.x + size * 1.5, unit.y - size * 0.9 + floatOffset);
    DC.lineTo(unit.x + size * 0.45, unit.y + size * 0.35 + floatOffset);
    DC.closePath();
    DC.fill();

    // ── 熔岩圆身 ──
    DC.fillStyle = isPlayer ? '#e67e22' : '#c0392b';
    DC.beginPath();
    DC.arc(unit.x, unit.y + floatOffset, size, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 熔岩裂纹斑纹（暗色碎块）──
    DC.fillStyle = isPlayer ? '#d35400' : '#922b21';
    DC.beginPath();
    DC.arc(unit.x - size * 0.45, unit.y + size * 0.2 + floatOffset, 4.5, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.arc(unit.x + size * 0.5, unit.y - size * 0.15 + floatOffset, 3.5, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.arc(unit.x, unit.y + size * 0.55 + floatOffset, 3, 0, 2 * Math.PI);
    DC.fill();

    // ── 金色火焰眼 ──
    DC.fillStyle = '#ffd700';
    DC.beginPath();
    DC.arc(unit.x - 6, unit.y - 5 + floatOffset, 2.6, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.arc(unit.x + 6, unit.y - 5 + floatOffset, 2.6, 0, 2 * Math.PI);
    DC.fill();

    // 名称 + 血条（跟随浮动）
    drawNameBarFloat(unit, {
        name: '熔岩猎犬',
        nameY: unit.y - size - 12,
        barY: unit.y - size - 18,
        barW: 28,
    });
}

/** 绘制猎犬幼崽（熔岩猎犬等比缩小到骷髅大小：圆身8，裂纹+小翅膀+金眼） */
function drawLavaPup(unit) {
    const isPlayer = unit.team === 'player';
    const size = 8;    // 骷髅大小（熔岩猎犬16等比缩小）
    const floatOffset = Math.sin(game.time * 3) * 2;   unit._floatY = floatOffset; // 上下浮动（小单位浮动略小）

    // 影子（椭圆投影，不随浮动）
    drawUnitShadow(unit, 11, 10, 4.5, 0.25);

    // ── 左右小翅膀 ──
    DC.fillStyle = isPlayer ? '#c97b1f' : '#8e2f0f';
    DC.beginPath();
    DC.moveTo(unit.x - size * 0.35, unit.y - size * 0.35 + floatOffset);
    DC.lineTo(unit.x - size * 1.5, unit.y - size * 0.9 + floatOffset);
    DC.lineTo(unit.x - size * 0.45, unit.y + size * 0.35 + floatOffset);
    DC.closePath();
    DC.fill();
    DC.beginPath();
    DC.moveTo(unit.x + size * 0.35, unit.y - size * 0.35 + floatOffset);
    DC.lineTo(unit.x + size * 1.5, unit.y - size * 0.9 + floatOffset);
    DC.lineTo(unit.x + size * 0.45, unit.y + size * 0.35 + floatOffset);
    DC.closePath();
    DC.fill();

    // ── 熔岩圆身 ──
    DC.fillStyle = isPlayer ? '#e67e22' : '#c0392b';
    DC.beginPath();
    DC.arc(unit.x, unit.y + floatOffset, size, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.2;
    DC.stroke();

    // ── 熔岩裂纹斑纹（暗色碎块，等比缩小）──
    DC.fillStyle = isPlayer ? '#d35400' : '#922b21';
    DC.beginPath();
    DC.arc(unit.x - size * 0.45, unit.y + size * 0.2 + floatOffset, 2.2, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.arc(unit.x + size * 0.5, unit.y - size * 0.15 + floatOffset, 1.8, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.arc(unit.x, unit.y + size * 0.55 + floatOffset, 1.5, 0, 2 * Math.PI);
    DC.fill();

    // ── 金色火焰眼 ──
    DC.fillStyle = '#ffd700';
    DC.beginPath();
    DC.arc(unit.x - 3, unit.y - 2.5 + floatOffset, 1.3, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.arc(unit.x + 3, unit.y - 2.5 + floatOffset, 1.3, 0, 2 * Math.PI);
    DC.fill();

    // 名称 + 血条（跟随浮动）
    drawNameBarFloat(unit, {
        name: '猎犬幼崽',
        nameY: unit.y - size - 8,
        barY: unit.y - size - 12,
        barW: 28,
        barH: 3.5,
        font: 'bold 8px sans-serif',
    });
}

/** 绘制气球兵（大椭圆气囊 + 绳索吊篮 + 吊篮里的小骷髅头，空中浮动，比飞龙略小一档） */
function drawBalloon(unit) {
    const isPlayer = unit.team === 'player';
    const size = 15;   // 气囊半径（比飞龙14再大一点点）
    const floatOffset = Math.sin(game.time * 3) * 3;   unit._floatY = floatOffset; // 上下浮动

    // 影子（椭圆投影，不随浮动，保持在地面）
    drawUnitShadow(unit, 24, 20, 8, 0.3);

    const bx = unit.x;
    const by = unit.y + floatOffset;   // 气囊中心（跟随浮动）

    // ── 气囊（大椭圆）──
    DC.fillStyle = isPlayer ? '#5dade2' : '#e74c3c';
    DC.beginPath();
    DC.ellipse(bx, by - size * 0.55, size, size * 0.95, 0, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 气囊高光 ──
    DC.fillStyle = 'rgba(255,255,255,0.45)';
    DC.beginPath();
    DC.ellipse(bx - size * 0.35, by - size * 0.95, size * 0.26, size * 0.36, 0, 0, 2 * Math.PI);
    DC.fill();

    // ── 绳索（连接气囊与吊篮）──
    DC.strokeStyle = '#7f5539';
    DC.lineWidth = 1.2;
    DC.beginPath();
    DC.moveTo(bx - size * 0.5, by - size * 0.12);
    DC.lineTo(bx - size * 0.25, by + size * 0.42);
    DC.moveTo(bx + size * 0.5, by - size * 0.12);
    DC.lineTo(bx + size * 0.25, by + size * 0.42);
    DC.stroke();

    // ── 吊篮（小方块）──
    DC.fillStyle = '#8b5a2b';
    DC.fillRect(bx - size * 0.28, by + size * 0.4, size * 0.56, size * 0.42);
    DC.strokeStyle = 'rgba(255,255,255,0.5)';
    DC.lineWidth = 1;
    DC.strokeRect(bx - size * 0.28, by + size * 0.4, size * 0.56, size * 0.42);

    // ── 吊篮里的小骷髅头（白圆 + 黑眼洞）──
    DC.fillStyle = '#ffffff';
    DC.beginPath();
    DC.arc(bx, by + size * 0.56, 3.8, 0, 2 * Math.PI);
    DC.fill();
    DC.fillStyle = '#222';
    DC.fillRect(bx - 2.0, by + size * 0.5, 1.4, 1.4);
    DC.fillRect(bx + 0.6, by + size * 0.5, 1.4, 1.4);

    // 名称 + 血条（跟随浮动）
    drawNameBarFloat(unit, {
        name: '气球兵',
        nameY: unit.y - size * 1.6 - 8,
        barY: unit.y - size * 1.6 - 13,
        barW: 28,
    });
}

/** 绘制雷电法师（圆形头部 + 三角形身体 + 方形底座，简约几何风） */
function drawLightningWizard(unit) {
    const isPlayer = unit.team === 'player';
    const baseColor = isPlayer ? '#7c3aed' : '#4c1d95';
    const skinColor = '#f5d6b8';

    // ── 正方体底座 ──
    DC.fillStyle = isPlayer ? '#5b21b6' : '#3b0764';
    DC.fillRect(unit.x - 7, unit.y + 5, 14, 10);
    DC.strokeStyle = 'rgba(255,255,255,0.6)';
    DC.lineWidth = 1;
    DC.strokeRect(unit.x - 7, unit.y + 5, 14, 10);

    // ── 倒三角身体 ──
    DC.fillStyle = baseColor;
    DC.beginPath();
    DC.moveTo(unit.x, unit.y - 8);        // 上顶点
    DC.lineTo(unit.x + 9, unit.y + 6);    // 右下
    DC.lineTo(unit.x - 9, unit.y + 6);    // 左下
    DC.closePath();
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.5)';
    DC.lineWidth = 1;
    DC.stroke();

    // ── 圆形头部 ──
    DC.fillStyle = skinColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y - 12, 5, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1;
    DC.stroke();

    // 眼睛（两点）
    DC.fillStyle = '#333';
    DC.fillRect(unit.x - 2.5, unit.y - 13, 1.5, 1.5);
    DC.fillRect(unit.x + 1, unit.y - 13, 1.5, 1.5);

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '雷电法师',
        nameY: unit.y - 28,
        barY: unit.y - 12,
    });
}

/** 绘制曲折闪电线条 */
function drawLightningBolt(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const segments = Math.max(5, Math.floor(len / 6));
    const nx = -dy / len;
    const ny = dx / len;

    // 外层主闪电
    DC.beginPath();
    DC.moveTo(x1, y1);
    for (let i = 1; i < segments; i++) {
        const t = i / segments;
        const px = x1 + dx * t;
        const py = y1 + dy * t;
        const offset = (Math.random() - 0.5) * 10;
        DC.lineTo(px + nx * offset, py + ny * offset);
    }
    DC.lineTo(x2, y2);
    DC.stroke();

    // 内层亮光（更亮更细）
    DC.strokeStyle = 'rgba(255,255,255,0.6)';
    DC.lineWidth = 1.2;
    DC.beginPath();
    DC.moveTo(x1, y1);
    for (let i = 1; i < segments; i++) {
        const t = i / segments;
        const px = x1 + dx * t;
        const py = y1 + dy * t;
        const offset = (Math.random() - 0.5) * 7;
        DC.lineTo(px + nx * offset, py + ny * offset);
    }
    DC.lineTo(x2, y2);
    DC.stroke();
}

/** 绘制部署落雷（雷电法师部署时的从天而降闪电） */
function drawDeployThunderbolt(x1, y1, x2, y2, alpha) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const segments = Math.max(8, Math.floor(len / 5));
    const nx = -dy / len, ny = dx / len;

    // 外层主闪电（更粗）
    DC.strokeStyle = `rgba(180, 220, 255, ${alpha})`;
    DC.lineWidth = 5;
    DC.beginPath();
    DC.moveTo(x1, y1);
    for (let i = 1; i < segments; i++) {
        const t = i / segments;
        const px = x1 + dx * t;
        const py = y1 + dy * t;
        const offset = (Math.random() - 0.5) * 12;
        DC.lineTo(px + nx * offset, py + ny * offset);
    }
    DC.lineTo(x2, y2);
    DC.stroke();

    // 内层亮白光芒
    DC.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.8})`;
    DC.lineWidth = 2.5;
    DC.beginPath();
    DC.moveTo(x1, y1);
    for (let i = 1; i < segments; i++) {
        const t = i / segments;
        const px = x1 + dx * t;
        const py = y1 + dy * t;
        const offset = (Math.random() - 0.5) * 8;
        DC.lineTo(px + nx * offset, py + ny * offset);
    }
    DC.lineTo(x2, y2);
    DC.stroke();
}

/** 绘制暗夜女巫（暗紫色 + 蝙蝠翅膀感） */
function drawNightWitch(unit) {
    const isPlayer = unit.team === 'player';
    const pulse = 0.8 + 0.2 * Math.sin(game.time * 3);

    // 暗紫色光晕
    DC.fillStyle = isPlayer ? '#6a0dad' : '#4a0072';
    DC.globalAlpha = 0.3 * pulse;
    DC.beginPath();
    DC.arc(unit.x, unit.y, 16, 0, 2 * Math.PI);
    DC.fill();
    DC.globalAlpha = 1;

    // 身体（菱形 + 翅膀展开）
    DC.fillStyle = isPlayer ? '#8e44ad' : '#6c3483';
    DC.beginPath();
    DC.moveTo(unit.x, unit.y - 14);
    DC.lineTo(unit.x + 10, unit.y);
    DC.lineTo(unit.x, unit.y + 14);
    DC.lineTo(unit.x - 10, unit.y);
    DC.closePath();
    DC.fill();
    DC.strokeStyle = '#d2b4de';
    DC.lineWidth = 1.5;
    DC.stroke();

    // 两侧"翅膀"小三角
    DC.fillStyle = isPlayer ? '#9b59b6' : '#7d3c98';
    DC.beginPath();
    DC.moveTo(unit.x - 10, unit.y - 4);
    DC.lineTo(unit.x - 18, unit.y - 8);
    DC.lineTo(unit.x - 14, unit.y + 2);
    DC.closePath();
    DC.fill();
    DC.beginPath();
    DC.moveTo(unit.x + 10, unit.y - 4);
    DC.lineTo(unit.x + 18, unit.y - 8);
    DC.lineTo(unit.x + 14, unit.y + 2);
    DC.closePath();
    DC.fill();

    // 眼睛（发红光）
    DC.fillStyle = '#e74c3c';
    DC.beginPath();
    DC.arc(unit.x - 3, unit.y - 2, 2, 0, 2 * Math.PI);
    DC.arc(unit.x + 3, unit.y - 2, 2, 0, 2 * Math.PI);
    DC.fill();

    // 名称 + 血条（第一层样板收口）
    drawNameBar(unit, {
        name: '暗夜女巫',
        nameY: unit.y - 22,
        barY: unit.y - 16,
        barW: 28,
        barH: 3.5,
    });

    // 召唤进度条（通用蓄力条）
    const card = CARDS[unit.cardId];
    if (card && card.spawnInterval) {
        drawChargeBar(unit, (unit.spawnTimer || 0) / card.spawnInterval, '#a569bd');
    }
}

/** 绘制女巫（紫罗兰圆身 + 深紫尖顶宽檐帽 + 金色眼睛 + 右斜扫帚，区别于暗夜女巫的菱形蝙蝠造型） */
function drawWitch(unit) {
    const isPlayer = unit.team === 'player';
    const pulse = 0.8 + 0.2 * Math.sin(game.time * 3);

    // 紫罗兰光晕
    DC.fillStyle = isPlayer ? '#5b2c6f' : '#3d1a52';
    DC.globalAlpha = 0.3 * pulse;
    DC.beginPath();
    DC.arc(unit.x, unit.y, 15, 0, 2 * Math.PI);
    DC.fill();
    DC.globalAlpha = 1;

    // 身体（圆身）
    DC.fillStyle = isPlayer ? '#a569bd' : '#7d3c98';
    DC.beginPath();
    DC.arc(unit.x, unit.y + 3, 10, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = '#d2b4de';
    DC.lineWidth = 1.5;
    DC.stroke();

    // 扫帚（右下斜柄 + 刷毛）
    DC.strokeStyle = '#8d6e63';
    DC.lineWidth = 2;
    DC.beginPath();
    DC.moveTo(unit.x + 4, unit.y + 6);
    DC.lineTo(unit.x + 14, unit.y + 13);
    DC.stroke();
    DC.fillStyle = '#a1887f';
    DC.beginPath();
    DC.moveTo(unit.x + 12, unit.y + 11);
    DC.lineTo(unit.x + 18, unit.y + 14);
    DC.lineTo(unit.x + 12, unit.y + 18);
    DC.closePath();
    DC.fill();

    // 尖顶帽（深紫帽檐 + 帽身 + 金色帽尖）
    DC.fillStyle = isPlayer ? '#4a235a' : '#2c0e37';
    DC.beginPath();
    DC.ellipse(unit.x, unit.y - 8, 12, 3.5, 0, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.moveTo(unit.x - 8, unit.y - 8);
    DC.lineTo(unit.x + 8, unit.y - 8);
    DC.lineTo(unit.x + 1, unit.y - 20);
    DC.closePath();
    DC.fill();
    DC.fillStyle = '#f1c40f';
    DC.beginPath();
    DC.arc(unit.x + 1, unit.y - 20, 1.6, 0, 2 * Math.PI);
    DC.fill();

    // 眼睛（金色发光）
    DC.fillStyle = '#f1c40f';
    DC.beginPath();
    DC.arc(unit.x - 3.5, unit.y - 1, 1.8, 0, 2 * Math.PI);
    DC.arc(unit.x + 3.5, unit.y - 1, 1.8, 0, 2 * Math.PI);
    DC.fill();

    // 名称 + 血条（第一层样板收口）
    drawNameBar(unit, {
        name: '女巫',
        nameY: unit.y - 22,
        barY: unit.y - 16,
        barW: 28,
        barH: 3.5,
    });

    // 召唤进度条（通用蓄力条）
    const card = CARDS[unit.cardId];
    if (card && card.spawnInterval) {
        drawChargeBar(unit, (unit.spawnTimer || 0) / card.spawnInterval, '#a569bd');
    }
}

/** 绘制蝙蝠（小巧飞行单位） */
function drawBat(unit) {
    const isPlayer = unit.team === 'player';
    const flap = Math.sin(game.time * 12) * 3; // 翅膀拍动

    // 影子（很小）
    drawUnitShadow(unit, 8, 8, 4, 0.2);

    // 蝙蝠身体（小圆）
    DC.fillStyle = isPlayer ? '#2c3e50' : '#1a1a2e';
    DC.beginPath();
    DC.arc(unit.x, unit.y, 5, 0, 2 * Math.PI);
    DC.fill();

    // 翅膀（V形）
    DC.fillStyle = isPlayer ? '#34495e' : '#16213e';
    DC.beginPath();
    DC.moveTo(unit.x - 1, unit.y - 2);
    DC.lineTo(unit.x - 10, unit.y - 5 + flap);
    DC.lineTo(unit.x - 6, unit.y + 1);
    DC.closePath();
    DC.fill();
    DC.beginPath();
    DC.moveTo(unit.x + 1, unit.y - 2);
    DC.lineTo(unit.x + 10, unit.y - 5 + flap);
    DC.lineTo(unit.x + 6, unit.y + 1);
    DC.closePath();
    DC.fill();

    // 眼睛（两点小红色）
    DC.fillStyle = '#e74c3c';
    DC.fillRect(unit.x - 2, unit.y - 1, 1.5, 1.5);
    DC.fillRect(unit.x + 1, unit.y - 1, 1.5, 1.5);

    // 名称 + 血条（受伤才显示）
    drawNameBar(unit, {
        name: '蝙蝠',
        nameY: unit.y - 12,
        barY: unit.y - 12,
    });
}

/** 绘制苍蝇（苍蝇海：小圆身+快速拍动的半透明双翅+触角+红眼，飞行浮动） */
function drawFlySwarm(unit) {
    const isPlayer = unit.team === 'player';
    const flap = Math.sin(game.time * 16) * 2.5; // 翅膀快速拍动
    const floatOffset = Math.sin(game.time * 4 + unit.id) * 1.5; unit._floatY = floatOffset; // 浮动

    // 影子（很小）
    drawUnitShadow(unit, 8, 8, 4, 0.2);

    // 身体（小圆）
    DC.fillStyle = isPlayer ? '#3d3f2f' : '#1a1a2e';
    DC.beginPath();
    DC.arc(unit.x, unit.y + floatOffset, 5, 0, 2 * Math.PI);
    DC.fill();

    // 触角（两根小须）
    DC.strokeStyle = '#888';
    DC.lineWidth = 1;
    DC.beginPath();
    DC.moveTo(unit.x - 2, unit.y - 4 + floatOffset);
    DC.lineTo(unit.x - 3, unit.y - 7 + floatOffset);
    DC.moveTo(unit.x + 2, unit.y - 4 + floatOffset);
    DC.lineTo(unit.x + 3, unit.y - 7 + floatOffset);
    DC.stroke();

    // 翅膀（两侧半透明椭圆，快速拍动）
    DC.fillStyle = isPlayer ? 'rgba(200,200,255,0.5)' : 'rgba(255,180,180,0.5)';
    DC.beginPath();
    DC.ellipse(unit.x - 6, unit.y - 3 + flap + floatOffset, 5, 2.5, -0.6, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.ellipse(unit.x + 6, unit.y - 3 + flap + floatOffset, 5, 2.5, 0.6, 0, 2 * Math.PI);
    DC.fill();

    // 眼睛（两点小红色）
    DC.fillStyle = '#e74c3c';
    DC.fillRect(unit.x - 2.5, unit.y - 1 + floatOffset, 1.5, 1.5);
    DC.fillRect(unit.x + 1, unit.y - 1 + floatOffset, 1.5, 1.5);

    // 名称 + 血条（受伤才显示，跟随浮动）
    drawNameBarFloat(unit, {
        name: '苍蝇',
        nameY: unit.y - 12,
        barY: unit.y - 12,
    });
}

/** 绘制冰豆（冰蓝色小圆豆 + ❄️ 标记，不能移动） */
function drawIceBean(unit) {
    const isPlayer = unit.team === 'player';
    const pulse = 0.85 + 0.15 * Math.sin(game.time * 2);

    // 寒冰光晕
    DC.fillStyle = 'rgba(100,200,255,0.2)';
    DC.beginPath();
    DC.arc(unit.x, unit.y, 13 * pulse, 0, 2 * Math.PI);
    DC.fill();

    // 冰蓝色豆子身体
    DC.fillStyle = isPlayer ? '#74b9ff' : '#a29bfe';
    DC.beginPath();
    DC.arc(unit.x, unit.y, 6, 0, 2 * Math.PI);
    DC.fill();

    // 白色高光
    DC.fillStyle = 'rgba(255,255,255,0.5)';
    DC.beginPath();
    DC.arc(unit.x - 1.5, unit.y - 1.5, 1.5, 0, 2 * Math.PI);
    DC.fill();

    // 白色边框
    DC.strokeStyle = 'rgba(255,255,255,0.8)';
    DC.lineWidth = 1.5;
    DC.beginPath();
    DC.arc(unit.x, unit.y, 6, 0, 2 * Math.PI);
    DC.stroke();

    // 名称 + 血条（受伤才显示；❄️ 身份标记已移入状态栏常驻显示，血条用通用位置）
    drawNameBar(unit, {
        name: '冰豆',
        nameY: unit.y - 12,
        barY: unit.y - 12,
        baseline: 'alphabetic',
    });
}

/** 绘制火豆（橙红色小圆豆 + 🔥 标记，快速移动自爆） */
function drawFireBean(unit) {
    const isPlayer = unit.team === 'player';
    const pulse = 0.85 + 0.15 * Math.sin(game.time * 2);

    // 火焰光晕
    DC.fillStyle = 'rgba(255,150,50,0.2)';
    DC.beginPath();
    DC.arc(unit.x, unit.y, 13 * pulse, 0, 2 * Math.PI);
    DC.fill();

    // 橙红色豆子身体
    DC.fillStyle = isPlayer ? '#ff6b35' : '#e74c3c';
    DC.beginPath();
    DC.arc(unit.x, unit.y, 6, 0, 2 * Math.PI);
    DC.fill();

    // 黄色高光
    DC.fillStyle = 'rgba(255,255,100,0.5)';
    DC.beginPath();
    DC.arc(unit.x - 1.5, unit.y - 1.5, 1.5, 0, 2 * Math.PI);
    DC.fill();

    // 橙色边框
    DC.strokeStyle = 'rgba(255,200,50,0.8)';
    DC.lineWidth = 1.5;
    DC.beginPath();
    DC.arc(unit.x, unit.y, 6, 0, 2 * Math.PI);
    DC.stroke();

    // 名称 + 血条（受伤才显示；🔥 身份标记已移入状态栏常驻显示，血条用通用位置）
    drawNameBar(unit, {
        name: '火豆',
        nameY: unit.y - 12,
        barY: unit.y - 12,
        baseline: 'alphabetic',
    });
}

/** ═══════════════════════════════════════════
 *  通用状态图标系统
 *  收集实体所有动态状态 icon，从左到右一字排开
 *
 *  内置状态：
 *    - _stealthed        → 🌫️（隐身）
 *    - 冰豆/火豆         → ❄️/🔥（身份标记，常驻显示）
 *    - slowTimer > 0     → ❄️（减速，冰豆自身常驻❄️不重复画）
 *  扩展：未来只需在 icons 数组中 push 新 icon 即可
 *  ═══════════════════════════════════════════ */
function drawStatusIcon(entity) {
    const icons = [];

    // 隐身状态（矿工挖地潜行不显示🌫️）
    if (entity._stealthed) {
        icons.push('🌫️');
    }

    // 身份标记：冰豆 ❄️ / 火豆 🔥（常驻显示，替代原建模头顶 emoji）
    if (entity.cardId === 'ice_bean') {
        icons.push('❄️');
    }
    if (entity.cardId === 'fire_bean') {
        icons.push('🔥');
    }

    // 减速状态（冰豆自身常驻❄️，不重复画）
    if (entity.slowTimer > 0 && entity.cardId !== 'ice_bean') {
        icons.push('❄️');
    }

    // 🧊 冰冻状态（暂停一切行动）
    if (entity.freezeTimer > 0) {
        icons.push('🧊');
    }

    // 眩晕状态
    if (entity._stunTimer > 0) {
        icons.push('💫');
    }

    // ⚡ 加速状态（极速法术）
    if (entity._speedBoosted) {
        icons.push('⚡');
    }

    // 😡 狂暴状态（狂暴法术：攻速/移速/蓄力/出兵+30%）
    if (entity._rageTimer > 0) {
        icons.push('😡');
    }

    // 🐴 骑士冲锋状态
    if (entity._charging) {
        icons.push('🐴');
    }

    // 🚩 巡逻状态（营地成员 / 主塔守卫常驻：绕圈巡逻，索敌/移动受限；复制体不显示）
    if ((entity._campFlag || entity.cardId === 'main_tower_guard') && !entity.isCopy) {
        icons.push('🚩');
    }

    // 🛡️ 减伤状态（如免伤法术/免伤法徒给的盾）
    if (entity._damageReduction > 0) {
        icons.push('🛡️');
    }

    // ❤️‍🩹 常驻自回状态（巨龙蛋/巨龙）
    if (entity._hasRegen) {
        icons.push('❤️‍🩹');
    }

    // 🐛 巫师标记（死亡后召唤小虫）
    if (entity._wormMarkTimer > 0) {
        icons.push('🐛');
    }

    // 🔥 灼烧状态（火豆自爆引发；火豆自身常驻🔥不重复画）
    if (entity._burnTimer > 0 && entity.cardId !== 'fire_bean') {
        icons.push('🔥');
    }

    // 🤢 中毒状态（忍者飞镖命中；不叠加，只刷新持续时间）
    if (entity._poisonTimer > 0) {
        icons.push('🤢');
    }

    // 🧭 烟引·pending 闪烁 buff（原烟引/镜像烟引分别记账）
    if (entity._smokePendingBuff || entity._smokePendingBuffMirror) {
        if (Math.sin(performance.now() / 180) > 0) icons.push('🧭');
    }
    // 🧭 烟引引导状态（朝烟点前进中，稳显）
    if (entity._smokeGuide) {
        icons.push('🧭');
    }

    if (icons.length === 0) return;

    // —— 一字排开居中绘制，挂在血条正上方（跟随 _barY，血条上移自动跟随；无血条记录时回退固定高度）——
    const iconSpacing = 12;         // 每个 icon 占据宽度
    const totalW = icons.length * iconSpacing;
    const startX = entity.x - totalW / 2 + iconSpacing / 2;
    const iconY = entity._barY !== undefined ? entity._barY - 9 : entity.y - 29;

    DC.font = '10px sans-serif';
    DC.textAlign = 'center';
    DC.textBaseline = 'middle';

    for (let i = 0; i < icons.length; i++) {
        DC.fillText(icons[i], startX + i * iconSpacing, iconY);
    }

    DC.textBaseline = 'alphabetic';
}

/** 绘制小电车（幽灵同体型大圆 r=10 打底 + 中间电磁小圆发光，同电磁塔顶部小球特效） */
function drawTram(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = isPlayer ? '#00838f' : '#4a148c';
    const ballColor = isPlayer ? '#b2ebf2' : '#e1bee7';
    const glowColor = isPlayer ? 'rgba(0, 229, 255, 0.25)' : 'rgba(255, 64, 255, 0.25)';
    // 电磁脉冲浮动（参考电磁塔小圆球发光）
    const pulse = 0.9 + 0.1 * Math.sin(game.time * 6);

    // ── 大圆（幽灵同体型 r=10）──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, 10, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'white';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 中间电磁小圆（更小，电磁特效集中在小圆上：紧贴外发光光晕 + 实心小球）──
    DC.fillStyle = glowColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, 8 * pulse, 0, 2 * Math.PI);
    DC.fill();
    DC.fillStyle = ballColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, 4, 0, 2 * Math.PI);
    DC.fill();

    // 名称 + 血条
    drawNameBar(unit, {
        name: '小电车',
        nameY: unit.y - 17,
        barY: unit.y - 12,
        baseline: 'alphabetic',
    });
}

/** 绘制忍者（分层忍者造型；翻滚时旋转、淡化并隐身，但仍可受伤） */
function drawNinja(unit) {
    const isPlayer = unit.team === 'player';
    const rolling = (unit._ninjaRollRemain || 0) > 0;
    const body = isPlayer ? '#34495e' : '#8e3328';
    const dark = isPlayer ? '#17202a' : '#4a1510';
    const cloth = isPlayer ? '#566573' : '#b04a3a';
    const metal = isPlayer ? '#b9c6d0' : '#f0b8a8';

    DC.save();
    if (rolling) {
        // 翻滚参考暗影刺客：整体变淡，不做无敌处理
        DC.globalAlpha = 0.42;
        DC.translate(unit.x, unit.y);
        DC.rotate(unit._ninjaRollAngle || 0);
        DC.translate(-unit.x, -unit.y);
        DC.shadowColor = isPlayer ? 'rgba(100,190,255,0.8)' : 'rgba(255,100,80,0.8)';
        DC.shadowBlur = 8;
    }

    // 身体与肩部轮廓
    DC.fillStyle = body;
    DC.beginPath();
    DC.ellipse(unit.x, unit.y + 2, 8.5, 9.5, 0, 0, Math.PI * 2);
    DC.fill();
    DC.strokeStyle = dark;
    DC.lineWidth = 1.4;
    DC.stroke();
    DC.fillStyle = cloth;
    DC.beginPath();
    DC.moveTo(unit.x - 8, unit.y + 1);
    DC.lineTo(unit.x - 12, unit.y + 5);
    DC.lineTo(unit.x - 7, unit.y + 7);
    DC.closePath();
    DC.fill();
    DC.beginPath();
    DC.moveTo(unit.x + 8, unit.y + 1);
    DC.lineTo(unit.x + 12, unit.y + 5);
    DC.lineTo(unit.x + 7, unit.y + 7);
    DC.closePath();
    DC.fill();

    // 头巾/兜帽：尖顶与两侧布带
    DC.fillStyle = dark;
    DC.beginPath();
    DC.moveTo(unit.x, unit.y - 17);
    DC.lineTo(unit.x - 9, unit.y - 8);
    DC.lineTo(unit.x - 7, unit.y + 1);
    DC.lineTo(unit.x + 7, unit.y + 1);
    DC.lineTo(unit.x + 9, unit.y - 8);
    DC.closePath();
    DC.fill();
    DC.fillStyle = cloth;
    DC.beginPath();
    DC.moveTo(unit.x - 7, unit.y - 5);
    DC.lineTo(unit.x - 14, unit.y - 1);
    DC.lineTo(unit.x - 9, unit.y + 1);
    DC.lineTo(unit.x - 3, unit.y - 4);
    DC.closePath();
    DC.fill();
    DC.beginPath();
    DC.moveTo(unit.x + 7, unit.y - 5);
    DC.lineTo(unit.x + 14, unit.y - 1);
    DC.lineTo(unit.x + 9, unit.y + 1);
    DC.lineTo(unit.x + 3, unit.y - 4);
    DC.closePath();
    DC.fill();

    // 眼部面罩与高亮眼睛
    DC.fillStyle = '#101820';
    DC.fillRect(unit.x - 7, unit.y - 6, 14, 5);
    DC.fillStyle = metal;
    DC.fillRect(unit.x - 5, unit.y - 4.5, 3.5, 1.6);
    DC.fillRect(unit.x + 1.5, unit.y - 4.5, 3.5, 1.6);

    // 胸前护甲线
    DC.strokeStyle = 'rgba(220,235,245,0.65)';
    DC.lineWidth = 1;
    DC.beginPath();
    DC.moveTo(unit.x - 5, unit.y + 5);
    DC.lineTo(unit.x, unit.y + 7);
    DC.lineTo(unit.x + 5, unit.y + 5);
    DC.stroke();

    // 背后苦无与飘带
    DC.strokeStyle = metal;
    DC.lineWidth = 2;
    DC.beginPath();
    DC.moveTo(unit.x - 6, unit.y + 4);
    DC.lineTo(unit.x - 14, unit.y + 11);
    DC.stroke();
    DC.fillStyle = cloth;
    DC.beginPath();
    DC.moveTo(unit.x - 7, unit.y + 7);
    DC.lineTo(unit.x - 16, unit.y + 10);
    DC.lineTo(unit.x - 11, unit.y + 14);
    DC.lineTo(unit.x - 5, unit.y + 10);
    DC.closePath();
    DC.fill();

    // 手中短苦无
    DC.strokeStyle = metal;
    DC.lineWidth = 1.8;
    DC.beginPath();
    DC.moveTo(unit.x + 5, unit.y + 6);
    DC.lineTo(unit.x + 14, unit.y - 4);
    DC.stroke();
    DC.fillStyle = metal;
    DC.beginPath();
    DC.moveTo(unit.x + 14, unit.y - 4);
    DC.lineTo(unit.x + 9, unit.y - 3);
    DC.lineTo(unit.x + 12, unit.y + 1);
    DC.closePath();
    DC.fill();

    DC.restore();
    drawNameBar(unit, {
        name: '忍者', nameY: unit.y - 20, barY: unit.y - 15,
        baseline: 'alphabetic', color: rolling ? 'rgba(255,255,255,0.48)' : 'white',
    });
}

/** 绘制暗影刺客（忍者造型：深紫圆身+蒙面头巾+匕首；突袭隐身时半透明+蓄力光圈） */
function drawShadowAssassin(unit) {
    const isPlayer = unit.team === 'player';
    const isStealthed = unit._stealthed;

    if (isStealthed) {
        // ---- 突袭隐身：暗淡半透明 + 紫色光晕（参考幽灵隐身）----
        DC.globalAlpha = 0.35;
        const pulse = 0.9 + 0.1 * Math.sin(game.time * 6);
        DC.fillStyle = isPlayer ? 'rgba(160,120,255,0.18)' : 'rgba(255,120,160,0.18)';
        DC.beginPath();
        DC.arc(unit.x, unit.y, 14 * pulse, 0, 2 * Math.PI);
        DC.fill();
        // 半透明身体
        DC.fillStyle = isPlayer ? '#8e5fd0' : '#d05f8e';
        DC.beginPath();
        DC.arc(unit.x, unit.y, 9, 0, 2 * Math.PI);
        DC.fill();
        DC.globalAlpha = 1;
    } else {
        // ---- 正常状态 ----
        // 身体（深紫圆）
        DC.fillStyle = isPlayer ? '#7d4fc0' : '#c04f7d';
        DC.beginPath();
        DC.arc(unit.x, unit.y, 9, 0, 2 * Math.PI);
        DC.fill();
        DC.strokeStyle = '#2c2c54';
        DC.lineWidth = 1.5;
        DC.stroke();
        // 蒙面头巾（上半弧）
        DC.fillStyle = '#2c2c54';
        DC.beginPath();
        DC.arc(unit.x, unit.y, 9, Math.PI, 0);
        DC.fill();
        // 眼部白色细缝
        DC.fillStyle = '#ffffff';
        DC.fillRect(unit.x - 5, unit.y - 4, 3, 2);
        DC.fillRect(unit.x + 2, unit.y - 4, 3, 2);
        // 匕首（右上方斜放）
        DC.strokeStyle = '#dcdde1';
        DC.lineWidth = 2;
        DC.beginPath();
        DC.moveTo(unit.x + 6, unit.y - 5);
        DC.lineTo(unit.x + 13, unit.y - 11);
        DC.stroke();
        DC.strokeStyle = '#8b4513';
        DC.lineWidth = 3;
        DC.beginPath();
        DC.moveTo(unit.x + 11, unit.y - 9);
        DC.lineTo(unit.x + 14, unit.y - 13);
        DC.stroke();
    }

    // 突袭蓄力脚下光圈（脉动扩大，参考超骑蓄力指示器）
    if (unit._assaultCharging && unit._assaultTimer > 0) {
        const prog = unit._assaultTimer / 1.0; // 1→0
        DC.strokeStyle = `rgba(160, 80, 255, ${(1 - prog) * 0.7 + 0.2})`;
        DC.lineWidth = 2 + (1 - prog) * 2;
        DC.beginPath();
        DC.arc(unit.x, unit.y, 12 + (1 - prog) * 8, 0, 2 * Math.PI);
        DC.stroke();
    }

    // 名称 + 血条
    drawNameBar(unit, {
        name: '暗影刺客',
        nameY: unit.y - 17,
        barY: unit.y - 12,
        baseline: 'alphabetic',
        color: isStealthed ? 'rgba(255,255,255,0.5)' : 'white',
    });
}

/** 绘制幽灵（隐身时暗淡 + 🌫️标识由通用状态系统接管，现身时正常；建模：白色羽毛球=半圆球头+梯形裙摆） */
function drawGhost(unit) {
    const isPlayer = unit.team === 'player';
    const isStealthed = unit._stealthed;

    // 上下浮动偏移（幽灵本体浮动）
    const floatOffset = Math.sin(game.time * 3) * 3; unit._floatY = floatOffset;

    if (isStealthed) {
        // ---- 隐身状态：暗淡半透明 + 飘忽光晕 + 浮动 ----
        DC.globalAlpha = 0.3;

        // 幽灵光晕（跟随浮动）
        const pulse = 0.9 + 0.1 * Math.sin(game.time * 3);
        DC.fillStyle = isPlayer ? 'rgba(150,200,255,0.15)' : 'rgba(200,150,255,0.15)';
        DC.beginPath();
        DC.arc(unit.x, unit.y + floatOffset, 14 * pulse, 0, 2 * Math.PI);
        DC.fill();

        // 半透明白色羽毛球（跟随浮动）
        DC.fillStyle = 'rgba(255,255,255,0.85)';
        DC.strokeStyle = 'rgba(255,255,255,0.45)';
        DC.lineWidth = 1.5;
        drawShuttlecock(unit.x, unit.y + floatOffset);

        DC.globalAlpha = 1;

        // 🌫️ 标识已由通用 drawStatusIcon 接管，此处不再绘制
    } else {
        // ---- 现身状态：白色羽毛球（半圆球头+梯形裙摆）+ 轻微浮动，阵营色描边 ----
        DC.fillStyle = '#ffffff';
        DC.strokeStyle = isPlayer ? '#3498db' : '#e67e22';
        DC.lineWidth = 1.5;
        drawShuttlecock(unit.x, unit.y + floatOffset);
    }

    // 名称 + 血条（羽毛球比原圆高约3px，血条上移保持间距）
    drawNameBarFloat(unit, {
        name: '幽灵',
        nameY: unit.y - 17,
        barY: unit.y - 17,
        baseline: 'alphabetic',
        color: isStealthed ? 'rgba(255,255,255,0.5)' : 'white',
    });
}

/** 白色羽毛球形状（半圆球头直径14 + 梯形裙摆上底14→下底18，底部波浪线）：轮廓约 18宽×23高，与原 r=10 圆大小基本一致 */
function drawShuttlecock(cx, cy) {
    // 填充：半圆球头 + 张开裙摆（波浪下底）
    DC.beginPath();
    DC.arc(cx, cy - 8, 7, Math.PI, 0);      // 半圆球头（顶部，直径14）
    DC.lineTo(cx + 9, cy + 8);              // 裙摆右下（张开，下底18）
    // 下底波浪线（右→左，2个波，振幅±2）
    DC.quadraticCurveTo(cx + 6.75, cy + 6, cx + 4.5, cy + 8);
    DC.quadraticCurveTo(cx + 2.25, cy + 10, cx, cy + 8);
    DC.quadraticCurveTo(cx - 2.25, cy + 6, cx - 4.5, cy + 8);
    DC.quadraticCurveTo(cx - 6.75, cy + 10, cx - 9, cy + 8);
    DC.lineTo(cx - 7, cy - 8);              // 裙摆左下（回球头左端）
    DC.closePath();
    DC.fill();
    // 描边：半圆 + 两条斜边 + 波浪下底
    DC.beginPath();
    DC.arc(cx, cy - 8, 7, Math.PI, 0);
    DC.lineTo(cx + 9, cy + 8);
    DC.quadraticCurveTo(cx + 6.75, cy + 6, cx + 4.5, cy + 8);
    DC.quadraticCurveTo(cx + 2.25, cy + 10, cx, cy + 8);
    DC.quadraticCurveTo(cx - 2.25, cy + 6, cx - 4.5, cy + 8);
    DC.quadraticCurveTo(cx - 6.75, cy + 10, cx - 9, cy + 8);
    DC.lineTo(cx - 7, cy - 8);
    DC.closePath();
    DC.stroke();
}

/** 绘制烟花炮手（幽灵同体型圆打底 + 火箭筒 + 护目镜 + 头带 + 推进火苗） */
function drawFireworkGunner(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = isPlayer ? '#c0392b' : '#8e44ad';
    const darkColor = isPlayer ? '#7b241c' : '#5b2c6f';
    const accent = '#f39c12';
    // 开火后坐力小抖动
    const shake = (unit._recoilTimer > 0) ? Math.sin(game.time * 45) * 1.5 : 0;
    const x = unit.x + shake;

    // ── 主体圆（幽灵同体型 r=10 打底）──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(x, unit.y, 10, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = accent;
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 火箭筒（身体右侧斜筒 + 金色炮口）──
    DC.strokeStyle = darkColor;
    DC.lineWidth = 4;
    DC.beginPath();
    DC.moveTo(x + 4, unit.y - 1);
    DC.lineTo(x + 12, unit.y - 5);
    DC.stroke();
    DC.fillStyle = accent;
    DC.beginPath();
    DC.arc(x + 13, unit.y - 6, 2.5, 0, 2 * Math.PI);
    DC.fill();

    // ── 护目镜（两只白眼 + 黑瞳）──
    DC.fillStyle = 'white';
    DC.beginPath();
    DC.arc(x - 3, unit.y - 2, 2.6, 0, 2 * Math.PI);
    DC.arc(x + 2, unit.y - 2, 2.6, 0, 2 * Math.PI);
    DC.fill();
    DC.fillStyle = '#222';
    DC.beginPath();
    DC.arc(x - 2.2, unit.y - 2, 1.2, 0, 2 * Math.PI);
    DC.arc(x + 2.8, unit.y - 2, 1.2, 0, 2 * Math.PI);
    DC.fill();

    // ── 头顶头带（帽檐）──
    DC.fillStyle = darkColor;
    DC.fillRect(x - 8, unit.y - 9, 16, 3);

    // ── 脚下推进小火苗（橙色闪烁）──
    const flame = 0.6 + 0.4 * Math.sin(game.time * 12);
    DC.fillStyle = `rgba(243,156,18,${0.5 + 0.5 * flame})`;
    DC.beginPath();
    DC.arc(x, unit.y + 10, 3.5 * flame + 1, 0, 2 * Math.PI);
    DC.fill();

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '烟花炮手',
        nameY: unit.y - 17, // 名称不随后坐力抖动，保持居中
        barY: unit.y - 12,
        baseline: 'alphabetic',
        barColor: isPlayer ? '#e74c3c' : '#8e44ad',
    });
}

/** 绘制小皮卡（参照治疗兵圆主体 + 几何装饰，无脸无影） */
function drawMiniPekka(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = isPlayer ? '#4a235a' : '#3d1a3d';
    const helmetColor = isPlayer ? '#6c3483' : '#5a2a5a';
    const armorColor = isPlayer ? '#8e44ad' : '#7b3d9a';

    // ── 主体圆（身体）──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, 10, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = helmetColor;
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 头盔（上半圆弧顶）──
    DC.beginPath();
    DC.arc(unit.x, unit.y - 2, 9, Math.PI, 2 * Math.PI);
    DC.fillStyle = helmetColor;
    DC.fill();

    // ── 铠甲装饰（胸前小菱形）──
    DC.beginPath();
    DC.moveTo(unit.x, unit.y - 4);
    DC.lineTo(unit.x + 3, unit.y);
    DC.lineTo(unit.x, unit.y + 4);
    DC.lineTo(unit.x - 3, unit.y);
    DC.closePath();
    DC.fillStyle = armorColor;
    DC.fill();

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '小皮卡',
        nameY: unit.y - 17,
        barY: unit.y - 12,
        barW: 28,
    });
}

/** 绘制大皮卡（小皮卡放大版：大圆身体+长方形铠甲，参考超级骑士体型） */
function drawBigPekka(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = isPlayer ? '#4a235a' : '#3d1a3d';
    const helmetColor = isPlayer ? '#6c3483' : '#5a2a5a';
    const armorColor = isPlayer ? '#8e44ad' : '#7b3d9a';

    // ── 长方形铠甲（下半身，参考超骑矩形身段 18x12）──
    DC.fillStyle = bodyColor;
    DC.fillRect(unit.x - 9, unit.y + 8, 18, 12);
    DC.strokeStyle = helmetColor;
    DC.lineWidth = 1.5;
    DC.strokeRect(unit.x - 9, unit.y + 8, 18, 12);

    // ── 大圆身体（r14，比小皮卡r10大一圈，参考超骑体型）──
    DC.beginPath();
    DC.arc(unit.x, unit.y, 14, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = helmetColor;
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 头盔（上半圆弧顶）──
    DC.beginPath();
    DC.arc(unit.x, unit.y - 2, 13, Math.PI, 2 * Math.PI);
    DC.fillStyle = helmetColor;
    DC.fill();

    // ── 铠甲装饰（胸前大菱形）──
    DC.beginPath();
    DC.moveTo(unit.x, unit.y - 5);
    DC.lineTo(unit.x + 4, unit.y);
    DC.lineTo(unit.x, unit.y + 5);
    DC.lineTo(unit.x - 4, unit.y);
    DC.closePath();
    DC.fillStyle = armorColor;
    DC.fill();

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '大皮卡',
        nameY: unit.y - 22,
        barY: unit.y - 14,
    });
}

/** 🐗 绘制野猪（椭圆身体 + 猪头 + 粉色猪鼻 + 四腿） */
function drawHog(unit) {
    const isPlayer = unit.team === 'player';
    const bodyColor = isPlayer ? '#8B4513' : '#6B2020';
    const legColor = isPlayer ? '#6B3410' : '#4A1515';
    const noseColor = '#FFB6C1';
    const tuskColor = '#FFF8DC';

    const x = unit.x, y = unit.y;

    // ── 身体（椭圆） ──
    DC.fillStyle = bodyColor;
    DC.beginPath();
    DC.ellipse(x, y, 11, 7, 0, 0, 2 * Math.PI);
    DC.fill();

    // ── 粉色圆鼻子（简化，去掉耳朵/眼睛/肚子/尾巴） ──
    DC.fillStyle = noseColor;
    DC.beginPath();
    DC.arc(x + 9, y + 1, 4, 0, 2 * Math.PI);
    DC.fill();

    // ── 獠牙（两个小白尖，保留特色） ──
    DC.fillStyle = tuskColor;
    DC.beginPath();
    DC.moveTo(x + 7, y + 5);
    DC.lineTo(x + 5, y + 11);
    DC.lineTo(x + 8, y + 6);
    DC.closePath();
    DC.fill();
    DC.beginPath();
    DC.moveTo(x + 11, y + 5);
    DC.lineTo(x + 13, y + 11);
    DC.lineTo(x + 10, y + 6);
    DC.closePath();
    DC.fill();

    // ── 腿（4条短矩形） ──
    DC.fillStyle = legColor;
    const legW = 3.5, legH = 7;
    const legOffsets = [[-7, 6], [-2, 6], [3, 6], [8, 6]];
    for (const [lx, ly] of legOffsets) {
        DC.fillRect(x + lx - legW / 2, y + ly, legW, legH);
    }

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '野猪',
        nameY: unit.y - 20,
        barY: unit.y - 15,
        barW: 28,
    });
}

/** 💧 绘制大送水人（大圆身体+左下右下两个小圆水桶，粉色，大小同巨人） */
function drawWaterCarrier(unit) {
    const isPlayer = unit.team === 'player';
    const mainColor = isPlayer ? '#FF9EB5' : '#E06080';
    const smallColor = isPlayer ? '#FFB0C3' : '#CC5070';

    const x = unit.x, y = unit.y;
    const bigR = 14;       // 大圆半径（比巨人16略小）
    const smallR = 6;      // 小圆半径（水桶）
    const offsetY = 8;     // 小圆垂直偏移（在大圆下方）

    // ── 大圆身体 ──
    DC.fillStyle = mainColor;
    DC.beginPath();
    DC.arc(x, y - 2, bigR, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.3)';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 右下小圆（水桶） ──
    DC.fillStyle = smallColor;
    DC.beginPath();
    DC.arc(x + 10, y + offsetY, smallR, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.3)';
    DC.lineWidth = 1;
    DC.stroke();

    // ── 左下小圆（水桶） ──
    DC.fillStyle = smallColor;
    DC.beginPath();
    DC.arc(x - 10, y + offsetY, smallR, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.3)';
    DC.lineWidth = 1;
    DC.stroke();

    // ── 小水滴点缀（送水人特色） ──
    DC.fillStyle = '#87CEEB';
    DC.beginPath();
    DC.ellipse(x + 14, y - 8, 2.5, 3.5, 0.3, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.ellipse(x - 14, y - 8, 2.5, 3.5, -0.3, 0, 2 * Math.PI);
    DC.fill();

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '大送水人',
        nameY: unit.y - 22,
        barY: unit.y - 18,
        barW: 28,
    });
}

/** 绘制送水人（大送水人等比缩放版，中心大圆≈骑士大小） */
function drawCraftedWaterCarrier(unit) {
    const isPlayer = unit.team === 'player';
    const mainColor = isPlayer ? '#FF9EB5' : '#E06080';
    const smallColor = isPlayer ? '#FFB0C3' : '#CC5070';

    const x = unit.x, y = unit.y;
    // 等比缩放：大送水人 bigR=13 → 骑士大小 bigR=10，缩放比≈0.77
    const bigR = 10;       // 大圆半径（参考骑士大小）
    const smallR = 5;      // 小圆半径（水桶，等比6→5）
    const offsetY = 6;     // 小圆垂直偏移（等比8→6）

    // ── 大圆身体 ──
    DC.fillStyle = mainColor;
    DC.beginPath();
    DC.arc(x, y - 1, bigR, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.3)';
    DC.lineWidth = 1.2;
    DC.stroke();

    // ── 右下小圆（水桶） ──
    DC.fillStyle = smallColor;
    DC.beginPath();
    DC.arc(x + 8, y + offsetY, smallR, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.3)';
    DC.lineWidth = 1;
    DC.stroke();

    // ── 左下小圆（水桶） ──
    DC.fillStyle = smallColor;
    DC.beginPath();
    DC.arc(x - 8, y + offsetY, smallR, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.3)';
    DC.lineWidth = 1;
    DC.stroke();

    // ── 小水滴点缀（送水人特色） ──
    DC.fillStyle = '#87CEEB';
    DC.beginPath();
    DC.ellipse(x + 11, y - 6, 2, 3, 0.3, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.ellipse(x - 11, y - 6, 2, 3, -0.3, 0, 2 * Math.PI);
    DC.fill();

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '送水人',
        nameY: unit.y - 18,
        barY: unit.y - 14,
        barW: 28,
        barH: 3.5,
        font: 'bold 9px sans-serif',
    });
}

/** 💧 绘制小送水人（送水人等比缩放版，大圆等同哥布林大小） */
function drawSmallWaterCarrier(unit) {
    const isPlayer = unit.team === 'player';
    const mainColor = isPlayer ? '#FF9EB5' : '#E06080';
    const smallColor = isPlayer ? '#FFB0C3' : '#CC5070';

    const x = unit.x, y = unit.y;
    // 等比缩放：送水人 bigR=10 → 哥布林大小 bigR=8，缩放比=0.8
    const bigR = 8;        // 大圆半径（等同哥布林大小）
    const smallR = 4;      // 小圆半径（水桶，等比5→4）
    const offsetY = 4;     // 小圆垂直偏移（等比6→4）

    // ── 大圆身体 ──
    DC.fillStyle = mainColor;
    DC.beginPath();
    DC.arc(x, y - 1, bigR, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.3)';
    DC.lineWidth = 1;
    DC.stroke();

    // ── 右下小圆（水桶） ──
    DC.fillStyle = smallColor;
    DC.beginPath();
    DC.arc(x + 6, y + offsetY, smallR, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.3)';
    DC.lineWidth = 0.8;
    DC.stroke();

    // ── 左下小圆（水桶） ──
    DC.fillStyle = smallColor;
    DC.beginPath();
    DC.arc(x - 6, y + offsetY, smallR, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.3)';
    DC.lineWidth = 0.8;
    DC.stroke();

    // ── 小水滴点缀（送水人特色） ──
    DC.fillStyle = '#87CEEB';
    DC.beginPath();
    DC.ellipse(x + 9, y - 5, 1.5, 2.5, 0.3, 0, 2 * Math.PI);
    DC.fill();
    DC.beginPath();
    DC.ellipse(x - 9, y - 5, 1.5, 2.5, -0.3, 0, 2 * Math.PI);
    DC.fill();

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '小送水人',
        nameY: unit.y - 15,
        barY: unit.y - 12,
        barW: 28,
        barH: 3.5,
        font: 'bold 8px sans-serif',
    });
}

/** 🧊 绘制小冰人（雪白配色：大圆身体+左右两个小圆，参考送水人建模、去掉水滴点缀"角"；骑士大小） */
function drawSmallIceMan(unit) {
    const isPlayer = unit.team === 'player';
    const mainColor = isPlayer ? '#F4F9FF' : '#B8C6D4';   // 雪白（敌稍暗）
    const smallColor = isPlayer ? '#DCE9F5' : '#93A6B8';  // 浅冰蓝

    const x = unit.x, y = unit.y;
    const bigR = 10;       // 大圆半径（同送水人，骑士大小）
    const smallR = 5;      // 小圆半径
    const offsetY = 6;     // 小圆垂直偏移

    // ── 大圆身体 ──
    DC.fillStyle = mainColor;
    DC.beginPath();
    DC.arc(x, y - 1, bigR, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(160,210,255,0.5)';   // 淡冰蓝描边
    DC.lineWidth = 1.2;
    DC.stroke();

    // ── 右下小圆 ──
    DC.fillStyle = smallColor;
    DC.beginPath();
    DC.arc(x + 8, y + offsetY, smallR, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(160,210,255,0.5)';
    DC.lineWidth = 1;
    DC.stroke();

    // ── 左下小圆 ──
    DC.fillStyle = smallColor;
    DC.beginPath();
    DC.arc(x - 8, y + offsetY, smallR, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(160,210,255,0.5)';
    DC.lineWidth = 1;
    DC.stroke();

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '小冰人',
        nameY: unit.y - 18,
        barY: unit.y - 14,
        barW: 28,
        barH: 3.5,
        font: 'bold 9px sans-serif',
    });
}

/** 绘制治疗兵（白底绿纹医疗风：白圆身+绿描边+浅绿同心环+绿色医疗十字 + 血条） */
function drawHealer(unit) {
    // ── 本体圆（白色底）──
    DC.fillStyle = '#f4fbf4';
    DC.beginPath();
    DC.arc(unit.x, unit.y, 10, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = '#27ae60';
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 浅绿同心环（内圈纹路装饰）──
    DC.strokeStyle = 'rgba(46, 204, 113, 0.45)';
    DC.lineWidth = 1;
    DC.beginPath();
    DC.arc(unit.x, unit.y, 7, 0, 2 * Math.PI);
    DC.stroke();

    // ── 中央医疗十字（绿色，治疗身份标识）──
    DC.fillStyle = '#2ecc71';
    DC.fillRect(unit.x - 1.5, unit.y - 4.5, 3, 9);   // 竖
    DC.fillRect(unit.x - 4.5, unit.y - 1.5, 9, 3);   // 横

    // 名称 + 血条（第一层样板收口）
    drawNameBar(unit, {
        name: '治疗兵',
        nameY: unit.y - 17,
        barY: unit.y - 12,
        barW: 28,
        barH: 3.5,
    });
}

/** 绘制电磁炮（圆形底座 + 同心小圆 + 细长枪管 + 炮口小圆，蓄能指示） */
function drawElectroCannon(unit) {
    const isPlayer = unit.team === 'player';
    const baseColor = isPlayer ? '#1a5276' : '#4a1a1a';
    const innerColor = isPlayer ? '#2e86c1' : '#6b2a2a';
    const barrelColor = isPlayer ? '#2e86c1' : '#922b21';
    const chargeColor = '#f39c12';

    // ── 炮管角度（指向目标） ──
    let angle = 0;
    if (unit.targetId) {
        const target = game.entities.find(en => en.id === unit.targetId && en.hp > 0 && !en._stealthed);
        if (target) {
            angle = Math.atan2(target.y - unit.y, target.x - unit.x);
        }
    }

    // ── 圆形底座（半径14，比巨人15略小） ──
    DC.fillStyle = baseColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, 14, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = barrelColor;
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 同心小圆（底座内部装饰） ──
    DC.fillStyle = innerColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, 6, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.3)';
    DC.lineWidth = 1;
    DC.stroke();

    // ── 绘制炮管（更细长：宽*0.5） ──
    DC.save();
    DC.translate(unit.x, unit.y);
    DC.rotate(angle);
    DC.fillStyle = barrelColor;
    DC.fillRect(4, -2.5, 22, 5);   // 宽从10→5，长度不变
    DC.strokeStyle = '#1a1a2e';
    DC.lineWidth = 1;
    DC.strokeRect(4, -2.5, 22, 5);
    // 炮口小圆（缩小：半径5→3.5）
    DC.beginPath();
    DC.arc(26, 0, 3.5, 0, 2 * Math.PI);
    DC.fillStyle = '#2c3e50';
    DC.fill();
    DC.strokeStyle = barrelColor;
    DC.lineWidth = 1.5;
    DC.stroke();

    // ── 满蓄时炮口脉动白光 ──
    if (unit._chargeTimer >= unit._chargeMax) {
        const pulse = 0.7 + 0.3 * Math.sin(Date.now() / 200);
        const glowR = 7 + 3 * pulse;
        const grad = DC.createRadialGradient(26, 0, 1, 26, 0, glowR);
        grad.addColorStop(0, `rgba(255,255,255,${0.95 * pulse})`);
        grad.addColorStop(0.5, `rgba(200,230,255,${0.4 * pulse})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        DC.fillStyle = grad;
        DC.beginPath();
        DC.arc(26, 0, glowR, 0, 2 * Math.PI);
        DC.fill();
    }

    DC.restore();

    // ── 蓄能进度条（通用蓄力条：血条正下方紧贴，需在 drawNameBar 之后）──
    const progress = unit._chargeTimer / (unit._chargeMax || 5.0);

    // ── 名称 + 血条 ──
    drawNameBar(unit, {
        name: '电磁炮',
        nameY: unit.y - 20,
        barY: unit.y - 19,
        barW: 28,
    });

    // ── 蓄能进度条（通用蓄力条）──
    drawChargeBar(unit, Math.min(progress, 1), progress >= 1 ? '#e74c3c' : chargeColor);
}

/** 绘制炮车（电磁炮同款圆形底座+炮塔；被打爆后变形成同大小方形底座炮台） */
function drawCannonCart(unit) {
    const isPlayer = unit.team === 'player';
    const baseColor = isPlayer ? '#1a5276' : '#4a1a1a';
    const innerColor = isPlayer ? '#2e86c1' : '#6b2a2a';
    const barrelColor = isPlayer ? '#2e86c1' : '#922b21';

    // ── 炮管角度（指向目标） ──
    let angle = 0;
    if (unit.targetId) {
        const target = game.entities.find(en => en.id === unit.targetId && en.hp > 0 && !en._stealthed);
        if (target) {
            angle = Math.atan2(target.y - unit.y, target.x - unit.x);
        }
    }

    // ── 底座：炮车=圆形（电磁炮同款r14），变形成炮台=同大小正方形(28x28) ──
    DC.fillStyle = baseColor;
    DC.strokeStyle = barrelColor;
    DC.lineWidth = 1.5;
    if (unit._turretMode) {
        DC.fillRect(unit.x - 14, unit.y - 14, 28, 28);
        DC.strokeRect(unit.x - 14, unit.y - 14, 28, 28);
    } else {
        DC.beginPath();
        DC.arc(unit.x, unit.y, 14, 0, 2 * Math.PI);
        DC.fill();
        DC.stroke();
    }

    // ── 同心小圆（底座内部装饰） ──
    DC.fillStyle = innerColor;
    DC.beginPath();
    DC.arc(unit.x, unit.y, 6, 0, 2 * Math.PI);
    DC.fill();
    DC.strokeStyle = 'rgba(255,255,255,0.3)';
    DC.lineWidth = 1;
    DC.stroke();

    // ── 炮塔（炮管 + 炮口小圆，指向目标） ──
    DC.save();
    DC.translate(unit.x, unit.y);
    DC.rotate(angle);
    DC.fillStyle = barrelColor;
    DC.fillRect(4, -2.5, 22, 5);
    DC.strokeStyle = '#1a1a2e';
    DC.lineWidth = 1;
    DC.strokeRect(4, -2.5, 22, 5);
    DC.beginPath();
    DC.arc(26, 0, 3.5, 0, 2 * Math.PI);
    DC.fillStyle = '#2c3e50';
    DC.fill();
    DC.strokeStyle = barrelColor;
    DC.lineWidth = 1.5;
    DC.stroke();
    DC.restore();

    // ── 名称 + 血条（第一层样板收口）──
    drawNameBar(unit, {
        name: unit._turretMode ? '炮台' : '炮车',
        nameY: unit.y - 20,
        barY: unit.y - 15,
        barW: 28,
        barH: 3.5,
    });
}

/** 绘制建筑（正方形 + 名称 + 血条 + 可选攻击范围） */
function drawBuilding(b, showRange) {
    const isPlayer = b.team === 'player';

    // ---- 炮塔：正方形底座 + 长方形炮管 + 指向目标 ----
    if (b.type === 'tower' && b.cardId === 'cannon_tower') {
        const baseColor = isPlayer ? '#4a6fa5' : '#7a3030';
        const barrelColor = isPlayer ? '#5c7fb8' : '#9a4040';

        // ── 正方形底座 ──
        DC.fillStyle = baseColor;
        DC.fillRect(b.x - 15, b.y - 15, 30, 30);
        DC.strokeStyle = 'white';
        DC.lineWidth = 2;
        DC.strokeRect(b.x - 15, b.y - 15, 30, 30);

        // ── 计算炮管角度（指向目标）──
        let angle = 0;
        if (b.targetId) {
            const target = game.entities.find(en => en.id === b.targetId && en.hp > 0 && !en._stealthed);
            if (target) {
                angle = Math.atan2(target.y - b.y, target.x - b.x);
            }
        }

        // ── 绘制炮管（偏移旋转）──
        DC.save();
        DC.translate(b.x, b.y);
        DC.rotate(angle);

        // 炮管主体（长方形）
        const barrelLen = 24, barrelW = 8;
        DC.fillStyle = barrelColor;
        DC.fillRect(2, -barrelW / 2, barrelLen, barrelW);
        DC.strokeStyle = '#ddd';
        DC.lineWidth = 1.5;
        DC.strokeRect(2, -barrelW / 2, barrelLen, barrelW);

        // 炮口加粗
        DC.fillStyle = '#222';
        DC.fillRect(barrelLen - 2, -barrelW / 2 - 1, 6, barrelW + 2);

        DC.restore();

        // 攻击范围虚线
        if (showRange && b.range) {
            DC.beginPath();
            DC.arc(b.x, b.y, b.range, 0, 2 * Math.PI);
            DC.setLineDash([5, 5]);
            DC.strokeStyle = 'rgba(255,255,255,0.6)';
            DC.lineWidth = 1.5;
            DC.stroke();
            DC.setLineDash([]);
        }

        const name = CARDS[b.cardId]?.name || '';

        drawNameBar(b, { barY: b.y - 18 });

        return; // ← 炮塔绘制完毕
    }

    // ---- 十字弩：正方形底座 + 长方形弩身杆 + 弧形弩弓（可转向，指向目标）----
    if (b.type === 'tower' && b.cardId === 'crossbow') {
        const baseColor = isPlayer ? '#6b4f3a' : '#7a3030';
        const woodColor = isPlayer ? '#8a6a45' : '#9a4040';
        const bowColor  = isPlayer ? '#3a2e22' : '#4a1f1f';

        // ── 建筑通用基底：正方形底座 ──
        DC.fillStyle = baseColor;
        DC.fillRect(b.x - 15, b.y - 15, 30, 30);
        DC.strokeStyle = 'white';
        DC.lineWidth = 2;
        DC.strokeRect(b.x - 15, b.y - 15, 30, 30);

        // ── 计算弩朝向角度（指向目标，同炮塔）──
        let angle = 0;
        if (b.targetId) {
            const target = game.entities.find(en => en.id === b.targetId && en.hp > 0 && !en._stealthed);
            if (target) {
                angle = Math.atan2(target.y - b.y, target.x - b.x);
            }
        }

        // ── 绘制弩（整体随 angle 转向）──
        DC.save();
        DC.translate(b.x, b.y);
        DC.rotate(angle);

        // 弩身：长方形杆（从中心延伸到前端）
        DC.fillStyle = woodColor;
        DC.fillRect(-8, -2.5, 26, 5);
        DC.strokeStyle = '#ddd';
        DC.lineWidth = 1;
        DC.strokeRect(-8, -2.5, 26, 5);

        // 弧形弩弓：开口朝右的弓臂（弧线），位置偏后（杆前端伸出为弩槽）
        const bowTipAng = 80 * Math.PI / 180; // 弓臂张角 ±80°
        const bowR = 12, bowCX = 1;
        DC.strokeStyle = bowColor;
        DC.lineWidth = 3.5;
        DC.beginPath();
        DC.arc(bowCX, 0, bowR, -bowTipAng, bowTipAng);
        DC.stroke();

        // 弩弦：连接两弓梢的直线
        const tipX = bowCX + bowR * Math.cos(bowTipAng);
        const tipY = bowR * Math.sin(bowTipAng);
        DC.strokeStyle = '#ccc';
        DC.lineWidth = 1.2;
        DC.beginPath();
        DC.moveTo(tipX, -tipY);
        DC.lineTo(tipX, tipY);
        DC.stroke();

        // 弓梢点缀
        DC.fillStyle = bowColor;
        DC.beginPath();
        DC.arc(tipX, -tipY, 2, 0, 2 * Math.PI);
        DC.fill();
        DC.beginPath();
        DC.arc(tipX, tipY, 2, 0, 2 * Math.PI);
        DC.fill();

        DC.restore();

        // 攻击范围虚线
        if (showRange && b.range) {
            DC.beginPath();
            DC.arc(b.x, b.y, b.range, 0, 2 * Math.PI);
            DC.setLineDash([5, 5]);
            DC.strokeStyle = 'rgba(255,255,255,0.6)';
            DC.lineWidth = 1.5;
            DC.stroke();
            DC.setLineDash([]);
        }

        const name = CARDS[b.cardId]?.name || '';

        drawNameBar(b, { barY: b.y - 18 });

        return; // ← 十字弩绘制完毕
    }

    // ---- 迫击炮：正方形底座 + 圆形转台 + 粗短炮管（抛物线投石，近身打不到）----
    if (b.type === 'tower' && b.cardId === 'mortar') {
        const baseColor = isPlayer ? '#4a6f4a' : '#7a3030';
        const barrelColor = isPlayer ? '#5c8a5c' : '#9a4040';

        // ── 正方形底座 ──
        DC.fillStyle = baseColor;
        DC.fillRect(b.x - 15, b.y - 15, 30, 30);
        DC.strokeStyle = 'white';
        DC.lineWidth = 2;
        DC.strokeRect(b.x - 15, b.y - 15, 30, 30);

        // ── 圆形转台 ──
        DC.fillStyle = '#555';
        DC.beginPath();
        DC.arc(b.x, b.y, 9, 0, 2 * Math.PI);
        DC.fill();
        DC.strokeStyle = 'rgba(255,255,255,0.7)';
        DC.lineWidth = 1.5;
        DC.stroke();

        // ── 粗短炮管（指向目标，默认朝上）──
        let angle = -Math.PI / 2; // 炮管默认朝上
        if (b.targetId) {
            const target = game.entities.find(en => en.id === b.targetId && en.hp > 0 && !en._stealthed);
            if (target) {
                // 炮管固定朝上，最多偏转 ±20°
                const maxTilt = Math.PI / 9; // 20°
                let diff = Math.atan2(target.y - b.y, target.x - b.x) + Math.PI / 2;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;
                angle = -Math.PI / 2 + Math.max(-maxTilt, Math.min(maxTilt, diff));
            }
        }
        DC.save();
        DC.translate(b.x, b.y);
        DC.rotate(angle);

        const barrelLen = 16, barrelW = 11;
        DC.fillStyle = barrelColor;
        DC.fillRect(2, -barrelW / 2, barrelLen, barrelW);
        DC.strokeStyle = '#ddd';
        DC.lineWidth = 1.5;
        DC.strokeRect(2, -barrelW / 2, barrelLen, barrelW);
        // 炮口
        DC.fillStyle = '#222';
        DC.fillRect(barrelLen - 3, -barrelW / 2 - 1, 7, barrelW + 2);

        DC.restore();

        // 攻击范围虚线：外圈射程 + 内圈最小射程（近身打不到）
        if (showRange && b.range) {
            DC.beginPath();
            DC.arc(b.x, b.y, b.range, 0, 2 * Math.PI);
            DC.setLineDash([5, 5]);
            DC.strokeStyle = 'rgba(255,255,255,0.6)';
            DC.lineWidth = 1.5;
            DC.stroke();
            DC.setLineDash([]);
            if (b.minRange) {
                DC.beginPath();
                DC.arc(b.x, b.y, b.minRange, 0, 2 * Math.PI);
                DC.setLineDash([2, 4]);
                DC.strokeStyle = 'rgba(255,120,80,0.5)';
                DC.lineWidth = 1.2;
                DC.stroke();
                DC.setLineDash([]);
            }
        }

        const name = CARDS[b.cardId]?.name || '';

        drawNameBar(b, { barY: b.y - 18 });

        return; // ← 迫击炮绘制完毕
    }

    // ---- 法师塔：正方形底座 + 中间一个小圆形（浮动）----
    if (b.type === 'tower' && b.cardId === 'mage_tower') {
        const baseColor = isPlayer ? '#7c3aed' : '#4c1d95';
        const circleColor = isPlayer ? '#a78bfa' : '#8b5cf6';

        // ── 正方形底座 ──
        DC.fillStyle = baseColor;
        DC.fillRect(b.x - 15, b.y - 15, 30, 30);
        DC.strokeStyle = 'white';
        DC.lineWidth = 2;
        DC.strokeRect(b.x - 15, b.y - 15, 30, 30);

        // ── 中间小圆形（魔法核心，上下浮动）──
        const floatOff = Math.sin(game.time * 3) * 2;
        DC.fillStyle = circleColor;
        DC.beginPath();
        DC.arc(b.x, b.y + floatOff, 7, 0, 2 * Math.PI);
        DC.fill();
        DC.strokeStyle = 'rgba(255,255,255,0.8)';
        DC.lineWidth = 1.5;
        DC.stroke();

        // 攻击范围虚线
        if (showRange && b.range) {
            DC.beginPath();
            DC.arc(b.x, b.y, b.range, 0, 2 * Math.PI);
            DC.setLineDash([5, 5]);
            DC.strokeStyle = 'rgba(255,255,255,0.6)';
            DC.lineWidth = 1.5;
            DC.stroke();
            DC.setLineDash([]);
        }

        const name = CARDS[b.cardId]?.name || '';

        drawNameBar(b, { barY: b.y - 18 });

        return; // ← 法师塔绘制完毕
    }

    // ---- 电磁塔：正方形底座 + 竖长方形杆 + 顶部小圆球（攻击发射口）----
    //      平时不露头（只留暗淡底座），射程内有敌人/2.5秒内攻击过才露出杆+球
    if (b.type === 'tower' && b.cardId === 'tesla_tower') {
        const baseColor = isPlayer ? '#00838f' : '#4a148c';
        const bodyColor = isPlayer ? '#00bcd4' : '#7b1fa2';
        const ballColor = isPlayer ? '#b2ebf2' : '#e1bee7';

        const headHidden = !(b._headTimer > 0);  // 未露头

        // ── 正方形底座（隐藏时暗淡半透明，参考幽灵隐身效果）──
        if (headHidden) DC.globalAlpha = 0.35;
        DC.fillStyle = baseColor;
        DC.fillRect(b.x - 15, b.y - 15, 30, 30);
        DC.strokeStyle = 'white';
        DC.lineWidth = 2;
        DC.strokeRect(b.x - 15, b.y - 15, 30, 30);
        DC.globalAlpha = 1;

        if (!headHidden) {
            // ── 竖长方形杆（细长柱体，下底对齐底座中央 b.y）──
            DC.fillStyle = bodyColor;
            DC.fillRect(b.x - 3, b.y - 26, 6, 26);
            DC.strokeStyle = '#ddd';
            DC.lineWidth = 1.5;
            DC.strokeRect(b.x - 3, b.y - 26, 6, 26);

            // ── 顶部小圆球（发射口，发光，无浮动）──
            DC.fillStyle = isPlayer ? 'rgba(0, 229, 255, 0.25)' : 'rgba(255, 64, 255, 0.25)';
            DC.beginPath();
            DC.arc(b.x, b.y - 26, 12, 0, 2 * Math.PI);
            DC.fill();
            DC.fillStyle = ballColor;
            DC.beginPath();
            DC.arc(b.x, b.y - 26, 7, 0, 2 * Math.PI);
            DC.fill();
            DC.strokeStyle = 'rgba(255,255,255,0.9)';
            DC.lineWidth = 1.5;
            DC.stroke();
        }

        // 攻击范围虚线
        if (showRange && b.range) {
            DC.beginPath();
            DC.arc(b.x, b.y, b.range, 0, 2 * Math.PI);
            DC.setLineDash([5, 5]);
            DC.strokeStyle = 'rgba(255,255,255,0.6)';
            DC.lineWidth = 1.5;
            DC.stroke();
            DC.setLineDash([]);
        }

        const name = CARDS[b.cardId]?.name || '';

        drawNameBar(b, { barY: b.y - 18 });

        return; // ← 电磁塔绘制完毕
    }

    // ---- 地狱塔：正方形底座 + 竖直长方体 + 倒三角 ----
    if (b.type === 'tower' && b.cardId === 'inferno_tower') {
        const baseColor = isPlayer ? '#d35400' : '#922b21';
        const bodyColor = isPlayer ? '#e67e22' : '#c0392b';
        const triColor = isPlayer ? '#f39c12' : '#e74c3c';

        // ── 正方形底座 ──
        DC.fillStyle = baseColor;
        DC.fillRect(b.x - 15, b.y - 15, 30, 30);
        DC.strokeStyle = 'white';
        DC.lineWidth = 2;
        DC.strokeRect(b.x - 15, b.y - 15, 30, 30);

        // ── 竖直长方体（细长柱体，下底对齐底座中央 b.y）──
        DC.fillStyle = bodyColor;
        DC.fillRect(b.x - 3, b.y - 26, 6, 26);
        DC.strokeStyle = '#ddd';
        DC.lineWidth = 1.5;
        DC.strokeRect(b.x - 3, b.y - 26, 6, 26);

        // ── 倒三角▽（炮口/光束发射口，底边在上，顶点在下）──
        DC.fillStyle = triColor;
        DC.beginPath();
        DC.moveTo(b.x - 10, b.y - 33);  // 左上
        DC.lineTo(b.x + 10, b.y - 33);  // 右上
        DC.lineTo(b.x, b.y - 20);       // 下顶点（对齐长方体顶部）
        DC.closePath();
        DC.fill();
        DC.strokeStyle = '#fff';
        DC.lineWidth = 1;
        DC.stroke();

        // ── 光束连线（指向目标，随持续时间增粗增亮）──
        if (b._beamTargetId) {
            const target = game.entities.find(en => en.id === b._beamTargetId && en.hp > 0);
            if (target) {
                const beamTimer = b._beamTimer || 0;
                const beamWidth = 2 + Math.min(beamTimer, 5) * 4; // 2~22px
                const alpha = 0.5 + Math.min(beamTimer, 5) * 0.1; // 0.5~1.0

                // 外圈发光
                DC.beginPath();
                DC.moveTo(b.x, b.y - 20);
                DC.lineTo(target.x, target.y);
                DC.strokeStyle = 'rgba(255, 100, 0, 0.25)';
                DC.lineWidth = beamWidth + 8;
                DC.globalAlpha = alpha * 0.5;
                DC.stroke();

                // 光束主体（渐变热感）
                const grad = DC.createLinearGradient(b.x, b.y - 20, target.x, target.y);
                grad.addColorStop(0, isPlayer ? '#ff4500' : '#8b0000');
                grad.addColorStop(0.4, '#ff8c00');
                grad.addColorStop(0.7, '#ffd700');
                grad.addColorStop(1, '#fff8dc');
                DC.beginPath();
                DC.moveTo(b.x, b.y - 20);
                DC.lineTo(target.x, target.y);
                DC.strokeStyle = grad;
                DC.lineWidth = beamWidth;
                DC.globalAlpha = alpha;
                DC.stroke();

                // 核心白芯
                DC.beginPath();
                DC.moveTo(b.x, b.y - 20);
                DC.lineTo(target.x, target.y);
                DC.strokeStyle = 'rgba(255,255,255,0.7)';
                DC.lineWidth = Math.max(1, beamWidth * 0.3);
                DC.globalAlpha = alpha * 0.6;
                DC.stroke();

                DC.globalAlpha = 1;
            }
        }

        // 攻击范围虚线
        if (showRange && b.range) {
            DC.beginPath();
            DC.arc(b.x, b.y, b.range, 0, 2 * Math.PI);
            DC.setLineDash([5, 5]);
            DC.strokeStyle = 'rgba(255,255,255,0.6)';
            DC.lineWidth = 1.5;
            DC.stroke();
            DC.setLineDash([]);
        }

        const name = CARDS[b.cardId]?.name || '';

        drawNameBar(b, { barY: b.y - 18 });

        return; // ← 地狱塔绘制完毕
    }

    // ---- 哥布林牢笼：木笼 + 竖条栅栏 + 内部哥布林 ----
    if (b.type === 'tower' && b.cardId === 'goblin_cage') {
        const isPlayer = b.team === 'player';
        const woodColor = isPlayer ? '#8B6914' : '#6B3A2A';
        const barColor = isPlayer ? '#A0822A' : '#8B4513';
        const insideColor = isPlayer ? '#1a1a1a' : '#0d0d0d';
        const goblinEyes = isPlayer ? '#ff4444' : '#ff8844';

        // ── 笼底阴影 ──
        DC.fillStyle = 'rgba(0,0,0,0.3)';
        DC.fillRect(b.x - 16, b.y - 14, 32, 30);

        // ── 内部暗色 ──
        DC.fillStyle = insideColor;
        DC.fillRect(b.x - 14, b.y - 14, 28, 28);

        // ── 哥布林脸（👺表情，在笼子内部） ──
        DC.font = '18px sans-serif';
        DC.textAlign = 'center';
        DC.textBaseline = 'middle';
        DC.fillText('👺', b.x, b.y - 1);

        // ── 竖条栅栏（6根竖条） ──
        DC.strokeStyle = barColor;
        DC.lineWidth = 2.5;
        for (let i = 0; i < 6; i++) {
            const bx = b.x - 13 + i * 5.6;
            DC.beginPath();
            DC.moveTo(bx, b.y - 15);
            DC.lineTo(bx, b.y + 15);
            DC.stroke();
        }

        // ── 上下横梁 ──
        DC.strokeStyle = woodColor;
        DC.lineWidth = 3;
        DC.strokeRect(b.x - 15, b.y - 15, 30, 30);

        // ── 顶部锁扣（小圆环） ──
        DC.strokeStyle = '#aaa';
        DC.lineWidth = 2;
        DC.beginPath();
        DC.arc(b.x, b.y - 15, 4, Math.PI, 2 * Math.PI);
        DC.stroke();

        // ── 破损度指示：血量越低栅栏颜色越红 ──
        const hpRatio = b.hp / b.maxHp;
        if (hpRatio < 0.5) {
            // 半血以下栅栏出现裂缝效果（红色裂纹）
            const crackAlpha = (1 - hpRatio) * 0.8;
            DC.strokeStyle = `rgba(255, 50, 50, ${crackAlpha})`;
            DC.lineWidth = 1.5;
            // 斜向裂纹
            DC.beginPath();
            DC.moveTo(b.x - 8, b.y - 12);
            DC.lineTo(b.x + 5, b.y + 8);
            DC.stroke();
            DC.beginPath();
            DC.moveTo(b.x + 10, b.y - 10);
            DC.lineTo(b.x - 5, b.y + 12);
            DC.stroke();
        }

        // ── 名字 ──
        const name = CARDS[b.cardId]?.name || '';

        drawNameBar(b, { barY: b.y - 18 });

        return; // ← 哥布林牢笼绘制完毕
    }

    // ---- 哥布林小屋：茅草顶小木屋 + 屋内👀 ----
    if (b.type === 'tower' && b.cardId === 'goblin_hut') {
        const woodColor = isPlayer ? '#8B6914' : '#6B3A2A';
        const wallColor = isPlayer ? '#a08050' : '#7a5a30';
        const roofColor = isPlayer ? '#4a7a2a' : '#3d5a20';

        // ── 阴影 ──
        DC.fillStyle = 'rgba(0,0,0,0.3)';
        DC.fillRect(b.x - 16, b.y - 12, 32, 28);

        // ── 木墙（主体） ──
        DC.fillStyle = wallColor;
        DC.fillRect(b.x - 13, b.y - 4, 26, 18);

        // ── 茅草屋顶（三角） ──
        DC.fillStyle = roofColor;
        DC.beginPath();
        DC.moveTo(b.x - 16, b.y - 4);
        DC.lineTo(b.x, b.y - 17);
        DC.lineTo(b.x + 16, b.y - 4);
        DC.closePath();
        DC.fill();
        DC.strokeStyle = woodColor;
        DC.lineWidth = 1.5;
        DC.stroke();

        // ── 小门 ──
        DC.fillStyle = '#3a2a1a';
        DC.fillRect(b.x - 4, b.y + 2, 8, 12);

        // ── 小屋立绘（无屋内眼睛）──

        // ── 动态💤：125px出兵范围内无敌人时，建筑右上角浮动显示（有敌人时消失）──
        const hutRange = CARDS.goblin_hut.spawnRange || 125;
        const hasEnemy = game.entities.some(en => en.team !== b.team && en.hp > 0 && !en._stealthed
            && Math.hypot(en.x - b.x, en.y - b.y) <= hutRange);
        if (!hasEnemy) {
            const sleepX = b.x + 13;
            const sleepY = b.y - 10 + Math.sin(game.time * 2.5) * 2;
            DC.font = '12px sans-serif';
            DC.textAlign = 'center';
            DC.textBaseline = 'middle';
            DC.fillText('💤', sleepX, sleepY);
        }

        // ── 名字 ──
        const name = CARDS[b.cardId]?.name || '';

        drawNameBar(b, { barY: b.y - 18 });

        // ── 出兵进度条（通用蓄力条：血条正上方；仅范围内有敌人正在出兵时显示，
        //    平时隐藏——与💤互补：有敌人出兵时显示进度、💤消失）──
        if (hasEnemy) {
            drawChargeBar(b, (b._spawnTimer || 0) / (CARDS.goblin_hut.spawnInterval || 2.2), '#a569bd');
        }

        return; // ← 哥布林小屋绘制完毕
    }

    // ---- 哥布林钻机：金属机身 + 旋转钻头 + 顶部冒烟 ----
    if (b.type === 'tower' && b.cardId === 'goblin_drill') {
        const bodyColor = isPlayer ? '#7d8a99' : '#8a6a5a';
        const darkColor = isPlayer ? '#4a5560' : '#5a3f30';
        const accentColor = isPlayer ? '#3d7ea6' : '#a63d3d';
        const drillSpin = game.time * 20;              // 钻头旋转角速度

        // ── 阴影 ──
        DC.fillStyle = 'rgba(0,0,0,0.3)';
        DC.fillRect(b.x - 17, b.y - 10, 34, 26);

        // ── 机身（方舱） ──
        DC.fillStyle = bodyColor;
        DC.fillRect(b.x - 13, b.y - 8, 26, 18);

        // ── 中部驾驶窗 + 哥布林眼睛（随钻机高频震动） ──
        DC.fillStyle = darkColor;
        DC.fillRect(b.x - 8, b.y - 4, 16, 10);
        const eyeShake = Math.sin(game.time * 30) * 0.8;   // 震动幅度
        DC.fillStyle = '#fff';
        DC.fillRect(b.x - 5 + eyeShake, b.y - 1, 3.5, 3.5);
        DC.fillRect(b.x + 2 + eyeShake, b.y - 1, 3.5, 3.5);
        DC.fillStyle = '#222';
        DC.fillRect(b.x - 4 + eyeShake + Math.cos(game.time * 5) * 0.5, b.y - 0.5, 1.5, 1.5);
        DC.fillRect(b.x + 3 + eyeShake + Math.cos(game.time * 5) * 0.5, b.y - 0.5, 1.5, 1.5);

        // ── 铆钉（机身四角） ──
        DC.fillStyle = 'rgba(255,255,255,0.5)';
        for (let i = 0; i < 3; i++) {
            DC.fillRect(b.x - 11 + i * 8, b.y - 7, 2, 2);
            DC.fillRect(b.x - 11 + i * 8, b.y + 7, 2, 2);
        }

        // ── 钻头（前方锥形 + 两条旋转纹路） ──
        DC.fillStyle = accentColor;
        DC.beginPath();
        DC.moveTo(b.x + 13, b.y - 5);
        DC.lineTo(b.x + 23, b.y);
        DC.lineTo(b.x + 13, b.y + 5);
        DC.closePath();
        DC.fill();
        DC.strokeStyle = '#e8e8e8';
        DC.lineWidth = 1.5;
        for (let li = 0; li < 2; li++) {
            const off = Math.sin(drillSpin + li * Math.PI) * 4;
            DC.beginPath();
            DC.moveTo(b.x + 14, b.y - 3 + off * 0.6);
            DC.lineTo(b.x + 22, b.y + off);
            DC.stroke();
        }

        // ── 顶部排气管 + 冒烟（烟量随出兵进度变大，出兵瞬间喷出） ──
        DC.fillStyle = darkColor;
        DC.fillRect(b.x - 4, b.y - 14, 8, 6);
        const spawnProg = (b._spawnTimer || 0) / (CARDS.goblin_drill.spawnInterval || 3);
        DC.fillStyle = `rgba(160,160,160,${0.55 * spawnProg})`;
        DC.beginPath();
        DC.arc(b.x, b.y - 17 - spawnProg * 5, 3 + spawnProg * 4, 0, Math.PI * 2);
        DC.fill();

        // ── 名字 ──
        const name = CARDS[b.cardId]?.name || '';

        drawNameBar(b, { barY: b.y - 18 });

        // ── 出兵进度条（无条件持续出兵，常显；紧贴血条正上方） ──
        drawChargeBar(b, (b._spawnTimer || 0) / (CARDS.goblin_drill.spawnInterval || 3), '#a569bd');

        return; // ← 哥布林钻机绘制完毕
    }

    // ---- 临时营地：小号建筑基底 + 上方一团浮动篝火 ----
    if (b.type === 'tower' && b.cardId === 'camp') {
        const baseColor = isPlayer ? '#8a6a45' : '#5a4030';   // 木色基底（按阵营深浅）
        const rimColor  = isPlayer ? '#a98a5f' : '#6b4f38';

        // ── 阴影 ──
        DC.fillStyle = 'rgba(0,0,0,0.3)';
        DC.fillRect(b.x - 11, b.y - 10, 22, 22);

        // ── 小号建筑基底（18×18，比标准30小一号）──
        DC.fillStyle = baseColor;
        DC.fillRect(b.x - 9, b.y - 9, 18, 18);
        DC.strokeStyle = rimColor;
        DC.lineWidth = 1.5;
        DC.strokeRect(b.x - 9, b.y - 9, 18, 18);

        // ── 基底顶面纹理（两条细线，示意营地平台）──
        DC.strokeStyle = 'rgba(255,255,255,0.15)';
        DC.lineWidth = 1;
        DC.beginPath();
        DC.moveTo(b.x - 6, b.y - 9); DC.lineTo(b.x - 6, b.y + 9);
        DC.moveTo(b.x + 6, b.y - 9); DC.lineTo(b.x + 6, b.y + 9);
        DC.stroke();

        // ── 上方篝火（🔥 emoji，贴近基底顶、轻微浮动）──
        const fireY = b.y - 9 + Math.sin(game.time * 3) * 1.5;
        DC.font = '13px sans-serif';
        DC.textAlign = 'center';
        DC.textBaseline = 'middle';
        DC.fillText('🔥', b.x, fireY);

        // ── 名字 ──
        const name = CARDS[b.cardId]?.name || '';

        drawNameBar(b, { barY: b.y - 19 });

        return; // ← 临时营地绘制完毕
    }

    // ---- 🛕 哥布林神庙：石纹正方形底（同临时营地大小18×18）+ 竖直木碑 + 一对叶耳（精英·建筑）----
    if (b.type === 'tower' && b.cardId === 'goblin_temple') {
        // 阵营色：石头底（亮石灰/暗棕灰）+ 木碑（浅木/深木）+ 叶耳（哥布林暗绿）
        const stoneBase = isPlayer ? '#9aa7a4' : '#6e6358';
        const stoneRim  = isPlayer ? '#b9c4c1' : '#85776a';
        const woodColor = isPlayer ? '#a1887f' : '#6d4c41';
        const woodRim   = isPlayer ? '#bcaaa4' : '#8d6e63';
        const leafColor = isPlayer ? '#27ae60' : '#1e8449';
        const leafRim   = '#145a32';

        // ── 阴影 ──
        DC.fillStyle = 'rgba(0,0,0,0.3)';
        DC.fillRect(b.x - 11, b.y - 10, 22, 22);

        // ── 正方形石头底座（18×18，与临时营地同款大小）──
        DC.fillStyle = stoneBase;
        DC.fillRect(b.x - 9, b.y - 9, 18, 18);
        DC.strokeStyle = stoneRim;
        DC.lineWidth = 1.5;
        DC.strokeRect(b.x - 9, b.y - 9, 18, 18);

        // ── 石头纹路（细缝线：横 + 竖 + 斜，模拟石板拼接）──
        DC.strokeStyle = 'rgba(0,0,0,0.25)';
        DC.lineWidth = 1;
        DC.beginPath();
        DC.moveTo(b.x - 9, b.y - 4); DC.lineTo(b.x + 9, b.y - 4);   // 横缝
        DC.moveTo(b.x - 9, b.y + 3); DC.lineTo(b.x + 9, b.y + 3);   // 横缝
        DC.moveTo(b.x - 4, b.y - 9); DC.lineTo(b.x - 4, b.y + 9);   // 竖缝
        DC.moveTo(b.x + 5, b.y - 9); DC.lineTo(b.x + 5, b.y + 9);   // 竖缝
        DC.moveTo(b.x - 9, b.y - 9); DC.lineTo(b.x - 1, b.y + 9);   // 斜缝（左上→右下）
        DC.stroke();

        // ── 竖直长方形木头碑（插在底座正中央，向上延伸；长且细）──
        const steleW = 7, steleH = 18;
        const steleBottom = b.y + 1;              // 碑底：插入底座中心（底座 y∈[b.y-9, b.y+9]）
        const steleTop = steleBottom - steleH;    // 碑顶 y
        DC.fillStyle = woodColor;
        DC.fillRect(b.x - steleW / 2, steleTop, steleW, steleH);
        DC.strokeStyle = woodRim;
        DC.lineWidth = 1.2;
        DC.strokeRect(b.x - steleW / 2, steleTop, steleW, steleH);
        // 碑面木纹（一道竖纹）
        DC.strokeStyle = 'rgba(0,0,0,0.2)';
        DC.lineWidth = 0.8;
        DC.beginPath();
        DC.moveTo(b.x, steleTop + 2); DC.lineTo(b.x, steleTop + steleH - 2);
        DC.stroke();
        // 碑顶小横梁（神庙顶饰）
        DC.fillStyle = woodRim;
        DC.fillRect(b.x - 6, steleTop - 2, 12, 2.5);

        // ── 一对类似叶子的耳朵（碑顶两侧对称露出，哥布林暗绿）──
        DC.fillStyle = leafColor;
        DC.strokeStyle = leafRim;
        DC.lineWidth = 1;
        for (const side of [-1, 1]) {
            DC.save();
            DC.translate(b.x + side * 5.5, steleTop - 1.5);
            DC.rotate(side * 0.55);   // 左右对称外倾
            DC.beginPath();
            DC.ellipse(0, 0, 4.5, 2.2, 0, 0, 2 * Math.PI);   // 横椭叶
            DC.fill();
            DC.stroke();
            DC.restore();
        }

        // ── 🛕 神赐蓄力·木碑金色呼吸灯（参考盔甲铺蓄力光圈：11费无特效，每减1费变强，1费最强）──
        //    强度 = (基础11费 - 当前神赐费) / 10，范围 0（11费无特效）~ 1（1费最强）
        const esT = (game.eliteSkills || {})[b.team] || {};
        const stT = esT[b.isMirrored ? 'mirror_goblin_temple' : 'goblin_temple'] || {};
        const baseCostT = (CARDS.goblin_temple && CARDS.goblin_temple.activeSkill)
            ? CARDS.goblin_temple.activeSkill.cost : 11;
        const curCostT = stT.blessCost != null ? stT.blessCost : baseCostT;
        const glowK = Math.max(0, Math.min(1, (baseCostT - curCostT) / Math.max(1, baseCostT - 1)));
        if (glowK > 0.01) {
            const breathe = 0.75 + 0.25 * Math.sin(Date.now() / 200);   // 呼吸脉动（盔甲铺同款节奏）
            const steleCy = steleTop + steleH / 2;                      // 碑体中心
            // 碑体金色染色（随减费加深、随呼吸明暗）
            DC.fillStyle = `rgba(255, 215, 0, ${(0.15 + 0.25 * breathe) * glowK})`;
            DC.fillRect(b.x - steleW / 2, steleTop, steleW, steleH);
            // 碑体金色发光描边
            DC.strokeStyle = `rgba(255, 220, 90, ${(0.45 + 0.35 * breathe) * glowK})`;
            DC.lineWidth = 1.5;
            DC.strokeRect(b.x - steleW / 2, steleTop, steleW, steleH);
            // 碑体呼吸金晕（径向渐变外扩，强度越高范围越大）
            const glowR = (10 + 6 * breathe) * (0.55 + 0.45 * glowK);
            const gradG = DC.createRadialGradient(b.x, steleCy, 2, b.x, steleCy, glowR);
            gradG.addColorStop(0, `rgba(255, 215, 0, ${0.5 * breathe * glowK})`);
            gradG.addColorStop(1, 'rgba(255, 215, 0, 0)');
            DC.fillStyle = gradG;
            DC.beginPath();
            DC.arc(b.x, steleCy, glowR, 0, 2 * Math.PI);
            DC.fill();
        }

        // ── 血条（碑顶之上）──
        drawNameBar(b, { barY: b.y - 22 });

        return; // ← 哥布林神庙绘制完毕
    }

    // ---- 🔮 法术屏障（空中单位）：上方悬浮菱形宝石本体 + 底下暗淡旋转六芒星阵充当阴影 ----
    if (b.type === 'tower' && b.cardId === 'spell_barrier') {
        const gemColor  = isPlayer ? '#a5c8ff' : '#ffb3d1';      // 宝石色（亮蓝/亮粉，按阵营）
        const glowRGBA  = isPlayer ? 'rgba(138,123,255,' : 'rgba(224,106,176,';
        const R = 14;                                            // 六芒星外接圆半径（与营地同级大小）

        // ── 法阵底盘（半透明光晕 + 外圈，暗淡版本=地面阴影）──
        const grad = DC.createRadialGradient(b.x, b.y, 2, b.x, b.y, R + 6);
        grad.addColorStop(0, glowRGBA + '0.22)');
        grad.addColorStop(1, glowRGBA + '0)');
        DC.fillStyle = grad;
        DC.beginPath();
        DC.arc(b.x, b.y, R + 6, 0, 2 * Math.PI);
        DC.fill();

        DC.beginPath();
        DC.arc(b.x, b.y, R + 2, 0, 2 * Math.PI);
        DC.strokeStyle = glowRGBA + '0.38)';
        DC.lineWidth = 1.5;
        DC.stroke();

        // ── 缓缓旋转的六芒星（正三角 + 倒三角叠加，随 game.time 缓慢旋转；半透明暗淡=地面阴影）──
        const rot = game.time * 0.25;
        DC.save();
        DC.translate(b.x, b.y);
        DC.rotate(rot);
        DC.strokeStyle = glowRGBA + '0.6)';
        DC.lineWidth = 1.5;
        DC.lineJoin = 'round';
        for (let flip = 0; flip < 2; flip++) {
            DC.beginPath();
            for (let i = 0; i < 3; i++) {
                const a = -Math.PI / 2 + (flip ? Math.PI : 0) + i * 2 * Math.PI / 3;
                const px = Math.cos(a) * R, py = Math.sin(a) * R;
                if (i === 0) DC.moveTo(px, py); else DC.lineTo(px, py);
            }
            DC.closePath();
            DC.stroke();
        }
        DC.restore();

        // ── 上方悬浮菱形宝石（空中本体，只上下浮动，不自转）──
        const gemY = b.y - R - 5 + Math.sin(game.time * 2.5) * 2;
        DC.save();
        DC.translate(b.x, gemY);
        DC.beginPath();
        DC.moveTo(0, -5.5);
        DC.lineTo(4.5, 0);
        DC.lineTo(0, 5.5);
        DC.lineTo(-4.5, 0);
        DC.closePath();
        DC.fillStyle = gemColor;
        DC.fill();
        DC.strokeStyle = '#fff';
        DC.lineWidth = 1.2;
        DC.stroke();
        // 高光点
        DC.fillStyle = 'rgba(255,255,255,0.9)';
        DC.beginPath();
        DC.arc(-1.3, -1.8, 1, 0, 2 * Math.PI);
        DC.fill();
        DC.restore();

        // ── 名字 ──
        const name = CARDS[b.cardId]?.name || '';

        // 浮动血条（菱形宝石上下浮动，血条跟随同幅浮动）
        const floatOffset = Math.sin(game.time * 2.5) * 2; b._floatY = floatOffset; // 上下浮动
        drawNameBarFloat(b, { barY: b.y - 28 });

        return; // ← 法术屏障绘制完毕
    }

    // ---- 盔甲铺：铁砧紫灰基底 + 中央🛡️ + 蓄力条（蓄满蓝色脉动光圈）----
    if (b.type === 'tower' && b.cardId === 'armor_smith') {
        const baseColor = isPlayer ? '#5d4a66' : '#3f3345';   // 紫灰铁砧色（按阵营深浅）
        const rimColor  = isPlayer ? '#8a6d99' : '#5f4a6b';

        // ── 阴影 ──
        DC.fillStyle = 'rgba(0,0,0,0.3)';
        DC.fillRect(b.x - 15, b.y - 15, 30, 30);

        // ── 基底（30×30 通用建筑底座）──
        DC.fillStyle = baseColor;
        DC.fillRect(b.x - 15, b.y - 15, 30, 30);
        DC.strokeStyle = rimColor;
        DC.lineWidth = 1.5;
        DC.strokeRect(b.x - 15, b.y - 15, 30, 30);

        // ── 中央盾牌图标 ──
        DC.font = '15px sans-serif';
        DC.textAlign = 'center';
        DC.textBaseline = 'middle';
        DC.fillText('🛡️', b.x, b.y - 1);

        // ── 蓄满：蓝色脉动光圈 ──
        const charge = b._chargeTimer || 0;
        if (charge >= (b._chargeMax || 6)) {
            const pulse = 0.7 + 0.3 * Math.sin(Date.now() / 200);
            const glowR = 17 + 4 * pulse;
            const grad = DC.createRadialGradient(b.x, b.y, 2, b.x, b.y, glowR);
            grad.addColorStop(0, `rgba(120,200,255,${0.5 * pulse})`);
            grad.addColorStop(1, 'rgba(120,200,255,0)');
            DC.fillStyle = grad;
            DC.beginPath();
            DC.arc(b.x, b.y, glowR, 0, 2 * Math.PI);
            DC.fill();
        }

        // ── 名字 ──
        const name = CARDS[b.cardId]?.name || '';

        // ── 血条（通用模板）──
        drawNameBar(b, { barY: b.y - 19 });

        // ── 蓄力条（通用模板：血条正上方紧贴；白蓝→满蓄红）──
        const progress = charge / (b._chargeMax || 6);
        drawChargeBar(b, progress, progress >= 1 ? '#e74c3c' : '#4fc3f7');

        return; // ← 盔甲铺绘制完毕
    }

    // ---- 兵营 / 采集器 ----
    let color = '#d4a373';
    if (b.type === 'collector') color = '#9b59b6';
    else if (b.type === 'barrack') color = '#a98467';

    if (b.type === 'collector') {
        // ── 圣水生成器：玻璃瓶（外面玻璃色，内部透明竖槽 + 紫色圣水进度）──
        // 玻璃瓶身（半透明淡蓝玻璃）
        DC.fillStyle = 'rgba(150,200,240,0.45)';
        DC.fillRect(b.x - 15, b.y - 15, 30, 30);
        DC.strokeStyle = 'rgba(210,235,255,0.95)';
        DC.lineWidth = 2;
        DC.strokeRect(b.x - 15, b.y - 15, 30, 30);

        // 内部透明竖槽（扣除区域，居中，槽内直接露出背景）
        const slotW = 10, slotH = 20;
        const slotX = b.x - slotW / 2, slotY = b.y - 10;
        DC.strokeStyle = 'rgba(255,255,255,0.3)';
        DC.lineWidth = 1;
        DC.strokeRect(slotX, slotY, slotW, slotH);

        // 紫色圣水：从下往上冒（生成进度）
        const genP = Math.max(0, Math.min(1, b.generateTimer / (b.generateInterval || 14)));
        if (genP > 0.01) {
            const liqH = slotH * genP;
            DC.fillStyle = '#9b59b6';
            DC.fillRect(slotX, slotY + slotH - liqH, slotW, liqH);
            // 圣水液面高光
            DC.fillStyle = 'rgba(255,255,255,0.45)';
            DC.fillRect(slotX, slotY + slotH - liqH, slotW, 1.5);
        }
    } else {
        // ── 兵营方块样式（骷髅墓碑）──
        DC.fillStyle = color;
        DC.fillRect(b.x - 15, b.y - 15, 30, 30);
        DC.strokeStyle = 'white';
        DC.lineWidth = 2;
        DC.strokeRect(b.x - 15, b.y - 15, 30, 30);
    }

    // 骷髅墓碑：中央「۩」图标
    if (b.type === 'barrack') {
        DC.font = '18px sans-serif';
        DC.textAlign = 'center';
        DC.textBaseline = 'middle';
        DC.fillStyle = '#fff';
        DC.fillText('۩', b.x, b.y);
        DC.textBaseline = 'alphabetic';
    }

    // 攻击范围虚线
    if (showRange && b.range) {
        DC.beginPath();
        DC.arc(b.x, b.y, b.range, 0, 2 * Math.PI);
        DC.setLineDash([5, 5]);
        DC.strokeStyle = 'rgba(255,255,255,0.6)';
        DC.lineWidth = 1.5;
        DC.stroke();
        DC.setLineDash([]);
    }

    const name = CARDS[b.cardId]?.name || '';

    drawNameBar(b, { barY: b.y - 18 });

    // 骷髅墓碑：出兵进度条（通用蓄力条：血条正上方）
    if (b.type === 'barrack') {
        drawChargeBar(b, (b.spawnTimer || 0) / (CARDS[b.cardId]?.spawnInterval || 7), '#a569bd');
    }
}

/** 绘制堡垒（主塔同款圆形 + 血量环 + 常驻射程） */
function drawBastion(b) {
    const isPlayer = b.team === 'player';
    const color = isPlayer ? '#3498db' : '#f44336';   // 蓝 / 正红（与主塔、主塔守卫统一）
    const pct = b.hp / b.maxHp;
    const mix = Math.max(0.3, pct);

    // ── 圆形主体（透明度随血量变化，与大本营一致）──
    DC.fillStyle = color;
    DC.globalAlpha = mix;
    DC.beginPath();
    DC.arc(b.x, b.y, 28, 0, 2 * Math.PI);
    DC.fill();
    DC.globalAlpha = 1.0;

    // ── 白色边框 ──
    DC.strokeStyle = 'white';
    DC.lineWidth = 2.5;
    DC.stroke();

    // ── 血量环（与大本营同款）：常驻显示 ──
    DC.beginPath();
    DC.arc(b.x, b.y, 32, 0, 2 * Math.PI * pct);
    DC.strokeStyle = pct > 0.5 ? '#2ecc71' : (pct > 0.25 ? '#f1c40f' : '#e74c3c');
    DC.lineWidth = 3;
    DC.stroke();

    // ── 常驻射程虚线（半透明金色）──
    DC.beginPath();
    DC.arc(b.x, b.y, b.range, 0, 2 * Math.PI);
    DC.setLineDash([5, 5]);
    DC.strokeStyle = 'rgba(255,215,0,0.35)';
    DC.lineWidth = 1.5;
    DC.stroke();
    DC.setLineDash([]);
}

/** 绘制可部署区域的白色浅光渐隐边框 */
function drawDeployZoneFrame(left, right, fade) {
    DC.save();
    // 内部极淡白色填充 2%
    DC.fillStyle = 'rgba(255,255,255,0.02)';
    DC.fillRect(left, 0, right - left, H);
    DC.shadowColor = 'rgba(255,255,255,0.7)';
    DC.shadowBlur = 20;
    DC.lineWidth = 3;
    DC.setLineDash([]);
    if (fade) {
        // 渐隐边框：从己方边界（白）→ 河道边界（透明），比之前更明显
        const grad = DC.createLinearGradient(left, 0, right, 0);
        grad.addColorStop(0, 'rgba(255,255,255,0.50)');
        grad.addColorStop(0.5, 'rgba(255,255,255,0.20)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        DC.strokeStyle = grad;
    } else {
        // 全屏均匀边框（法术）
        DC.strokeStyle = 'rgba(255,255,255,0.20)';
    }
    DC.strokeRect(left + 2, 2, right - left - 4, H - 4);
    DC.restore();
}

/** ⛺ 营地部署预览：索敌圈（橙）+ 巡逻轨道圈（蓝外圈60/淡内圈40），与悬停预览一致；不可部署时整体红化 */
function drawCampDeployPreview(mx, my, card, canPlace, isRedSide) {
    const detectR = card.campDetectR || 200;
    const tracks = card.campPatrolR || [40, 60];
    const outerR = tracks[1] !== undefined ? tracks[1] : 60; // 外圈60（原50样式）
    const innerR = tracks[0] !== undefined ? tracks[0] : 40; // 内圈40（淡色）
    // 非法：整体红/粉红化（与通用部署预览的不可部署状态一致）；合法：保留原橙/蓝样式
    const invStroke = isRedSide ? '#ff6b9d' : '#ef4444';
    const invFill = isRedSide ? 'rgba(255,150,200,0.2)' : 'rgba(255,0,0,0.15)';
    // 索敌圈（淡橙填充 + 橙虚线 / 非法红化）
    DC.beginPath();
    DC.arc(mx, my, detectR, 0, 2 * Math.PI);
    DC.fillStyle = canPlace ? 'rgba(255,140,0,0.04)' : invFill;
    DC.fill();
    DC.setLineDash([10, 6]);
    DC.strokeStyle = canPlace ? 'rgba(255,140,0,0.6)' : invStroke;
    DC.lineWidth = 1.5;
    DC.stroke();
    // 外圈60（淡蓝填充 + 蓝虚线 / 非法红化）
    DC.beginPath();
    DC.arc(mx, my, outerR, 0, 2 * Math.PI);
    DC.fillStyle = canPlace ? 'rgba(64,156,255,0.07)' : invFill;
    DC.fill();
    DC.setLineDash([5, 5]);
    DC.strokeStyle = canPlace ? 'rgba(64,156,255,0.75)' : invStroke;
    DC.lineWidth = 1.5;
    DC.stroke();
    // 内圈40（淡蓝细虚线 / 非法红化）
    DC.beginPath();
    DC.arc(mx, my, innerR, 0, 2 * Math.PI);
    DC.setLineDash([3, 6]);
    DC.strokeStyle = canPlace ? 'rgba(64,156,255,0.45)' : invStroke;
    DC.lineWidth = 1;
    DC.stroke();
    DC.setLineDash([]);
}

/** 🪏 营地拆除模式预览：选中临时营地卡且鼠标位于己方已部署营地上时，替代营地三圈预览 */
function drawDemolishPreview(mx, my, camp) {
    // 目标营地红色虚线框高亮
    DC.setLineDash([4, 4]);
    DC.strokeStyle = '#ef4444';
    DC.lineWidth = 2;
    DC.strokeRect(camp.x - 15, camp.y - 15, 30, 30);
    DC.setLineDash([]);
    // 拆除图标 🪏（鼠标位置居中）
    DC.font = '34px "Segoe UI Emoji","Noto Color Emoji","Apple Color Emoji",sans-serif';
    DC.textAlign = 'center';
    DC.textBaseline = 'middle';
    DC.fillText('🪏', mx, my);
}

/** 绘制十字准心部署指示器（用于兵种/建筑等非范围类卡牌） */
/** 🔮 绘制场上敌方法术屏障的庇护范围圈（选中法术预览时同步显示禁放区域；蓝/红方通用） */
function drawBarrierRanges(myTeam) {
    const enemyTeam = myTeam === 'player' ? 'ai' : 'player';
    const barrierR = (CARDS.spell_barrier && CARDS.spell_barrier.barrierRange) || 200;
    for (const e of game.entities) {
        if (e.cardId === 'spell_barrier' && e.team === enemyTeam && e.hp > 0) {
            DC.beginPath();
            DC.arc(e.x, e.y, barrierR, 0, 2 * Math.PI);
            DC.fillStyle = 'rgba(138,123,255,0.06)';
            DC.fill();
            DC.setLineDash([8, 6]);
            DC.strokeStyle = 'rgba(138,123,255,0.7)';
            DC.lineWidth = 1.5;
            DC.stroke();
            DC.setLineDash([]);
        }
    }
}

/** 🔮 绘制场上我方法术屏障的庇护范围圈（选中屏障卡部署预览时显示；蓝/红方通用） */
function drawOwnBarrierRanges(myTeam) {
    const barrierR = (CARDS.spell_barrier && CARDS.spell_barrier.barrierRange) || 200;
    for (const e of game.entities) {
        if (e.cardId === 'spell_barrier' && e.team === myTeam && e.hp > 0) {
            DC.beginPath();
            DC.arc(e.x, e.y, barrierR, 0, 2 * Math.PI);
            DC.fillStyle = 'rgba(138,123,255,0.06)';
            DC.fill();
            DC.setLineDash([8, 6]);
            DC.strokeStyle = 'rgba(138,123,255,0.7)';
            DC.lineWidth = 1.5;
            DC.stroke();
            DC.setLineDash([]);
        }
    }
}

function drawCrosshair(x, y, color) {
    const len = 14;   // 十字臂长
    const gap = 5;    // 中间缺口半宽
    const lineWidth = 2.5;

    DC.strokeStyle = color;
    DC.lineWidth = lineWidth;
    DC.setLineDash([]);
    DC.globalAlpha = 0.85;

    // 横线（左右各一段，中间留缺口）
    DC.beginPath();
    DC.moveTo(x - len, y);
    DC.lineTo(x - gap, y);
    DC.moveTo(x + gap, y);
    DC.lineTo(x + len, y);
    DC.stroke();

    // 竖线（上下各一段，中间留缺口）
    DC.beginPath();
    DC.moveTo(x, y - len);
    DC.lineTo(x, y - gap);
    DC.moveTo(x, y + gap);
    DC.lineTo(x, y + len);
    DC.stroke();

    // 中间空心小圆
    DC.beginPath();
    DC.arc(x, y, 3.5, 0, 2 * Math.PI);
    DC.strokeStyle = color;
    DC.lineWidth = 1.5;
    DC.stroke();

    DC.globalAlpha = 1.0;
}

/** 绘制悬停 UI：血量数值、冷却进度、攻击范围 */
function drawHoverUI() {
    const e = game.uiState.hoveredEntity;
    if (!e) return;

    // 实体名字（替代旧头顶名字，避免被血条预览遮挡；主塔/堡垒固定名，兵种/建筑取卡牌名）
    const hoverName = e.cardId === 'main_tower' ? '主塔'
        : e.cardId === 'bastion' ? '堡垒'
        // 🦴 骷髅系列统一：骷髅海/女巫/骷髅墓碑 召唤的骷髅（cardId 均为 goblin）
        : e.cardId === 'goblin' ? '骷髅'
        // 👺 哥布林系列各保持原名（cardId 不在 CARDS 表里，逐个补名）
        : e.cardId === 'goblin_melee' ? '哥布林'              // 团伙近战/飞桶/2费哥布林卡
        : e.cardId === 'goblin_thrower' ? '哥布林投矛手'      // 团伙投矛手/小屋出兵
        : e.cardId === 'goblin_blowgun' ? '哥布林吹箭手'      // 3费吹箭手卡
        : e.cardId === 'goblin_giant' ? '哥布林巨人'          // 6费巨人卡
        : e.cardId === 'strong_goblin' ? '强壮哥布林'         // 哥布林牢笼破裂
        : e.cardId === 'goblin_bomber' ? '哥布林爆破手'       // 4费爆破手卡
        // 🪰 苍蝇海部署的每只苍蝇
        : e.cardId === 'fly_swarm' ? '苍蝇'
        // 🦇 蝙蝠法术/暗夜女巫召唤的蝙蝠
        : e.cardId === 'bat' ? '蝙蝠'
        // 🪱 食人虫召唤物
        : e.cardId === 'worm' ? '食人虫'
        // 💧 送水人系：大送水人(卡牌 CARDS 已有) → 送水人 → 小送水人
        : e.cardId === 'crafted_water_carrier' ? '送水人'
        : e.cardId === 'small_water_carrier' ? '小送水人'
        // 🧊 小冰人
        : e.cardId === 'small_ice_man' ? '小冰人'
        // 🐕 熔岩猎犬分裂的幼崽
        : e.cardId === 'lava_pup' ? '猎犬幼崽'
        // 🛡️ 主塔守卫 / 👑 王子增援
        : e.cardId === 'main_tower_guard' ? '主塔守卫'
        : e.cardId === 'prince_reinforcement' ? '王子增援'
        : (CARDS[e.cardId]?.name || '');

    // 血量信息：有盾时 🛡️ 贴单位、❤️ 在其上两行叠放；无盾时仅 ❤️（底边基准 e.y-25 不动）
    DC.fillStyle = 'rgba(0,0,0,0.85)';
    const hasShield = (e.shield || 0) > 0;
    let ty = e.y - 41;   // 底框（🛡️/❤️）顶边，底边 e.y-25
    let tw;
    if (hasShield) {
        const shieldText = `🛡️ ${Math.ceil(e.shield)}/${e.maxShield}`;
        DC.font = '12px sans-serif';
        tw = DC.measureText(shieldText).width + 12;
        DC.fillRect(e.x - tw / 2, ty, tw, 16);
        DC.fillStyle = 'white';
        DC.textAlign = 'center';
        DC.fillText(shieldText, e.x, ty + 12);
        ty -= 18;
    }
    const hpText = `❤️ ${Math.ceil(e.hp)}/${e.maxHp}`;
    DC.font = '12px sans-serif';
    tw = DC.measureText(hpText).width + 12;
    DC.fillStyle = 'rgba(0,0,0,0.85)';
    DC.fillRect(e.x - tw / 2, ty, tw, 16);
    DC.fillStyle = 'white';
    DC.textAlign = 'center';
    DC.fillText(hpText, e.x, ty + 12);

    // 名字框：血量框正上方（黑底白字，与预览一体）
    if (hoverName) {
        ty -= 18;
        DC.font = '13px sans-serif';
        tw = DC.measureText(hoverName).width + 14;
        DC.fillStyle = 'rgba(0,0,0,0.85)';
        DC.fillRect(e.x - tw / 2, ty, tw, 16);
        DC.fillStyle = '#fff';
        DC.textAlign = 'center';
        DC.fillText(hoverName, e.x, ty + 12);
    }

    // 生产/生成冷却进度
    if (e.type === 'barrack' || e.type === 'collector') {
        let cdPercent = 0;
        if (e.type === 'barrack') cdPercent = e.spawnTimer / e.spawnInterval;
        else cdPercent = e.generateTimer / e.generateInterval;
        const cdText = `⏳ ${(cdPercent * 100).toFixed(0)}%`;
        tw = DC.measureText(cdText).width + 12;
        ty -= 18;
        DC.fillStyle = 'rgba(0,0,0,0.85)';
        DC.fillRect(e.x - tw / 2, ty, tw, 16);
        DC.fillStyle = '#f1c40f';
        DC.fillText(cdText, e.x, ty + 12);
    }

    // 攻击/治疗范围
    if ((e.type === 'troop' || e.type === 'healer' || e.type === 'tower') && e.range) {
        DC.beginPath();
        DC.arc(e.x, e.y, e.range, 0, 2 * Math.PI);
        DC.setLineDash([5, 5]);
        DC.strokeStyle = e.type === 'healer'
            ? 'rgba(46,204,113,0.8)'
            : 'rgba(255,215,0,0.7)';
        DC.lineWidth = 1.5;
        DC.stroke();
        DC.setLineDash([]);
        // 塔类最小射程内圈（如迫击炮75px近身盲区）
        if (e.type === 'tower' && e.minRange) {
            DC.beginPath();
            DC.arc(e.x, e.y, e.minRange, 0, 2 * Math.PI);
            DC.setLineDash([2, 4]);
            DC.strokeStyle = 'rgba(255,120,80,0.8)';
            DC.lineWidth = 1.2;
            DC.stroke();
            DC.setLineDash([]);
        }
    }

    // 🛖 哥布林小屋：出兵范围（spawnRange=125，无攻击射程，与部署预览一致）
    if (e.type === 'tower' && e.cardId === 'goblin_hut') {
        const hutRange = CARDS.goblin_hut.spawnRange || 125;
        DC.beginPath();
        DC.arc(e.x, e.y, hutRange, 0, 2 * Math.PI);
        DC.setLineDash([5, 5]);
        DC.strokeStyle = 'rgba(255,215,0,0.7)';
        DC.lineWidth = 1.5;
        DC.stroke();
        DC.setLineDash([]);
    }

    // 🦍 哥布林巨人：袋中投矛手索敌范围（105，与投矛手模板联动；自身仍只攻击建筑）
    if (e.type === 'troop' && e.cardId === 'goblin_giant') {
        const tRange = GOBLIN_THROWER_TEMPLATE.range;
        DC.beginPath();
        DC.arc(e.x, e.y, tRange, 0, 2 * Math.PI);
        DC.setLineDash([5, 5]);
        DC.strokeStyle = 'rgba(255,215,0,0.7)';
        DC.lineWidth = 1.5;
        DC.stroke();
        DC.setLineDash([]);
    }

    // 🛡️ 主塔：守卫巡逻圈（蓝）+ 索敌圈（橙）悬停预览
    // 巡逻圈半径=70，索敌范围=250（固定值，与 update.js 行为一致）
    if (e.type === 'main_tower') {
        const patrolR = 70;    // 巡逻半径（固定70）
        const detectR = 250;   // 索敌范围（固定250）
        // 索敌圈（淡橙填充 + 橙虚线）
        DC.beginPath();
        DC.arc(e.x, e.y, detectR, 0, 2 * Math.PI);
        DC.fillStyle = 'rgba(255,140,0,0.04)';
        DC.fill();
        DC.setLineDash([10, 6]);
        DC.strokeStyle = 'rgba(255,140,0,0.6)';
        DC.lineWidth = 1.5;
        DC.stroke();
        // 巡逻圈（淡蓝填充 + 蓝虚线）
        DC.beginPath();
        DC.arc(e.x, e.y, patrolR, 0, 2 * Math.PI);
        DC.fillStyle = 'rgba(64,156,255,0.07)';
        DC.fill();
        DC.setLineDash([5, 5]);
        DC.strokeStyle = 'rgba(64,156,255,0.75)';
        DC.lineWidth = 1.5;
        DC.stroke();
        DC.setLineDash([]);
        // 标注：主塔下方小标签
        const label = `❌ 巡逻 ${patrolR} · 索敌 ${detectR}`;
        DC.font = '11px sans-serif';
        const lw = DC.measureText(label).width + 10;
        const ly = e.y + 33;
        DC.fillStyle = 'rgba(0,0,0,0.85)';
        DC.fillRect(e.x - lw / 2, ly, lw, 15);
        DC.fillStyle = '#9cc9ff';
        DC.textAlign = 'center';
        DC.fillText(label, e.x, ly + 11);
    }

    // ⛺ 临时营地：巡逻轨道圈（蓝60/淡40）+ 索敌圈（橙）悬停预览 + 名额
    // 巡逻轨道40/60，索敌范围=200（与 config.js / update.js 行为一致）
    if (e.cardId === 'camp') {
        const detectR = CARDS.camp.campDetectR || 200;  // 索敌范围（固定200）
        const tracks = CARDS.camp.campPatrolR || [40, 60]; // 巡逻轨道（40/60）
        const outerR = tracks[1] !== undefined ? tracks[1] : 60; // 外圈60
        const innerR = tracks[0] !== undefined ? tracks[0] : 40; // 内圈40
        const cap = CARDS.camp.campCapacity || 2;
        const used = (game.entities || []).filter(en => en._campFlag && en._campId === e.id && en.hp > 0).length;
        // 索敌圈（淡橙填充 + 橙虚线）
        DC.beginPath();
        DC.arc(e.x, e.y, detectR, 0, 2 * Math.PI);
        DC.fillStyle = 'rgba(255,140,0,0.04)';
        DC.fill();
        DC.setLineDash([10, 6]);
        DC.strokeStyle = 'rgba(255,140,0,0.6)';
        DC.lineWidth = 1.5;
        DC.stroke();
        // 外圈60（原50样式：淡蓝填充 + 蓝虚线）
        DC.beginPath();
        DC.arc(e.x, e.y, outerR, 0, 2 * Math.PI);
        DC.fillStyle = 'rgba(64,156,255,0.07)';
        DC.fill();
        DC.setLineDash([5, 5]);
        DC.strokeStyle = 'rgba(64,156,255,0.75)';
        DC.lineWidth = 1.5;
        DC.stroke();
        // 内圈40（淡蓝细虚线，继续沿用淡色）
        DC.beginPath();
        DC.arc(e.x, e.y, innerR, 0, 2 * Math.PI);
        DC.setLineDash([3, 6]);
        DC.strokeStyle = 'rgba(64,156,255,0.45)';
        DC.lineWidth = 1;
        DC.stroke();
        DC.setLineDash([]);
        // 标注：营地下方小标签（名额 x/2）
        const label = `⛺ 名额 ${used}/${cap} · 轨道 ${tracks.join('/')} · 索敌 ${detectR}`;
        DC.font = '11px sans-serif';
        const lw = DC.measureText(label).width + 10;
        const ly = e.y + 33;
        DC.fillStyle = 'rgba(0,0,0,0.85)';
        DC.fillRect(e.x - lw / 2, ly, lw, 15);
        DC.fillStyle = '#9cc9ff';
        DC.textAlign = 'center';
        DC.fillText(label, e.x, ly + 11);
    }

    // 🔮 法术屏障：庇护范围圈（紫）悬停预览 + 标注
    if (e.cardId === 'spell_barrier') {
        const barrierR = CARDS.spell_barrier.barrierRange || 200;
        // 庇护圈（淡紫填充 + 紫虚线）
        DC.beginPath();
        DC.arc(e.x, e.y, barrierR, 0, 2 * Math.PI);
        DC.fillStyle = 'rgba(138,123,255,0.05)';
        DC.fill();
        DC.setLineDash([8, 6]);
        DC.strokeStyle = 'rgba(138,123,255,0.7)';
        DC.lineWidth = 1.5;
        DC.stroke();
        DC.setLineDash([]);
        // 标注：屏障下方小标签
        const label = `🔮 庇护 ${barrierR} · 敌方禁法术`;
        DC.font = '11px sans-serif';
        const lw = DC.measureText(label).width + 10;
        const ly = e.y + 33;
        DC.fillStyle = 'rgba(0,0,0,0.85)';
        DC.fillRect(e.x - lw / 2, ly, lw, 15);
        DC.fillStyle = '#c8a8ff';
        DC.textAlign = 'center';
        DC.fillText(label, e.x, ly + 11);
    }
}
