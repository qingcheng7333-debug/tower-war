/* ===== update.js — 每帧更新逻辑（移动、攻击、生产、治疗） ===== */
/** 群体攻击范围提示环颜色（淡红 RGB，渲染层拼接 rgba） */
const AOE_RING_COLOR = '255, 80, 80';
// 范围伤害三档规范（2026-08-12）：法师塔45为最高档基准；普攻/弹道溅射类统一收口
const AOE_RANGE_LARGE = 45; // 高档：法师塔（飞龙已改34）
const AOE_RANGE_MED   = 35; // 中档：迫击炮 / 电磁炮
const AOE_RANGE_SMALL = 25; // 低档：超级骑士普攻 / 女巫
/* ═══════════════════════════════════════════
 * 弹道处理器表（务实版规范化：行为零变化）
 *  6 类弹道 → 统一接口 update(p, deltaSec)，内部各自组织 移动→碰撞→结算→消散
 *  共享骨架：moveStraight（直线推进）/ scanEnemies（逐实体碰撞）/ straightHit（直线弹结算）/ applyAoe（范围结算）
 * ═══════════════════════════════════════════ */

/** 直线推进：沿 (vx,vy) 匀速飞行并累计 dist（烟花碎片/猎人散弹/烟花火箭共用） */
function moveStraight(p, deltaSec) {
    const step = p.speed * deltaSec;
    p.x += p.vx * step;
    p.y += p.vy * step;
    p.dist += step;
}

/** 直线弹命中结算（原 isShard/isHuntShot/isRocket 三处逐实体碰撞的公共骨架：伤害+飘字+💥） */
function straightHit(p, e2, fxSize, fxTimer) {
    const atkEnt = game.entities.find(en => en.id === p.ownerId) || null;
    const dmg = calcActualDmg(p.damage, atkEnt, e2);
    e2.hp -= dmg;
    spawnDmgNum(e2.x, e2.y - 20, dmg);
    game.spellEffects.push({ x: e2.x, y: e2.y, char: '💥', size: fxSize, timer: fxTimer, maxTimer: fxTimer });
}

/** 逐实体碰撞扫描：opts.breakOnHit=true 命中第一个即返回；否则扫描全部命中（穿透） */
function scanEnemies(p, onHit, opts) {
    let hit = null;
    const pad = (opts && opts.hitPad) || 8; // 命中判定加宽（默认8；大弹道如飞斧可调大）
    for (let e2 of game.entities) {
        if (e2.id === p.shardSource || e2.team === p.team || e2.hp <= 0 || e2._headHidden) continue;
        if (e2.flying && !p.hitsAir) continue;
        if (Math.hypot(e2.x - p.x, e2.y - p.y) <= getHitRadius(e2) + pad) {
            onHit(e2);
            hit = e2;
            if (opts && opts.breakOnHit) return hit;
        }
    }
    return hit;
}

/** 范围/溅射结算（电磁炮/追踪弹共用：aoeDamage 固定值 → fullAoe 全额 → 0.6 倍） */
function applyAoe(p, center, atkEnt) {
    game.entities.forEach(e2 => {
        if (e2.id === center.id || e2.team === p.team || e2.hp <= 0 || e2._headHidden) return;
        if (e2.flying && !p.hitsAir) return; // 地面弹道溅射不波及空中
        if (Math.hypot(center.x - e2.x, center.y - e2.y) <= p.aoeRadius) {
            const aoeDmg = p.aoeDamage !== undefined ? p.aoeDamage : (p.fullAoe ? p.damage : p.damage * 0.6);
            const dmgA = calcActualDmg(aoeDmg, atkEnt, e2); // 溅射也统一收口
            e2.hp -= dmgA;
            spawnDmgNum(e2.x, e2.y - 20, dmgA);
        }
    });
    game.spellEffects.push({ x: center.x, y: center.y, char: '✦', size: 36, timer: 0.3, maxTimer: 0.3 });
    // 攻击范围提示：淡红色小环（电磁炮/法师塔/女巫共用结算点，统一浮现）
    game.deployEffects.push({ x: center.x, y: center.y, radius: p.aoeRadius, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
}

const PROJECTILE_HANDLERS = {
    // ── 🎆 烟花分裂小球：直线穿透飞行（命中不消失，5球共享去重：同一目标整体只结算一次伤害），60px 后消散 ──
    shard: {
        update(p, deltaSec) {
            moveStraight(p, deltaSec);
            scanEnemies(p, (e2) => {
                if (p.hitIds.includes(e2.id)) return; // 该目标已被分裂弹（本球或其他球）伤过 → 不再结算
                straightHit(p, e2, 10, 0.15);
                p.hitIds.push(e2.id); // 穿透：继续飞行不消失
            });
            if (p.dist >= 60) p.timer = 0; // 射程耗尽消散
        }
    },
    // ── 🏹 猎人散射弹药：直线飞行（不追踪），命中第一个目标即消散（非穿透），可对空 ──
    huntShot: {
        update(p, deltaSec) {
            moveStraight(p, deltaSec);
            const hit = scanEnemies(p, (e2) => straightHit(p, e2, 10, 0.15), { breakOnHit: true });
            if (hit) { p.timer = 0; return; } // 非穿透：命中即消散
            if (p.dist >= p.maxDist) p.timer = 0; // 射程耗尽消散
        }
    },
    // ── 🔱 哥布林投矛手投矛：直线飞行（不追踪），命中第一个目标即消散（非穿透），可对空；未命中飞满射程在最远端消失 ──
    spear: {
        update(p, deltaSec) {
            moveStraight(p, deltaSec);
            const hit = scanEnemies(p, (e2) => straightHit(p, e2, 10, 0.15), { breakOnHit: true });
            if (hit) { p.timer = 0; return; } // 命中即消散
            if (p.dist >= p.maxDist) p.timer = 0; // 射程耗尽消散
        }
    },
    // ── 🎯 哥布林吹箭手吹箭：直线飞行（不追踪），命中第一个目标即消散（非穿透），可对空；未命中飞满射程在最远端消失 ──
    dart: {
        update(p, deltaSec) {
            moveStraight(p, deltaSec);
            const hit = scanEnemies(p, (e2) => straightHit(p, e2, 10, 0.15), { breakOnHit: true });
            if (hit) { p.timer = 0; return; } // 命中即消散
            if (p.dist >= p.maxDist) p.timer = 0; // 射程耗尽消散
        }
    },
    // 🪓 飞斧：直线穿透、135px折返；去程/返程独立结算（实体标记防重，出去/回来各至多1次）
    axe: {
        update(p, deltaSec) {
            moveStraight(p, deltaSec);
            const tag = p._returning ? '_axeBackTag' : '_axeGoTag';
            scanEnemies(p, (e2) => {
                if (e2[tag] !== p.id) {
                    e2[tag] = p.id;
                    straightHit(p, e2, 12, 0.15);
                }
            }, { breakOnHit: false, hitPad: 10 }); // 斧头建模加大，命中判定同步加宽
            // 去程到最远点折返；返程回到发射原点消散
            if (p.dist >= p.maxDist) {
                if (p._returning) { p.timer = 0; return; }
                p._returning = true;
                p.vx = -p.vx; p.vy = -p.vy;
                p.dist = 0;
            }
        }
    },
    // ── 🗡️ 剑仙飞剑：直线飞行（不追踪）；🕊️御剑金剑·穿透改向（命中一个后朝最近的「下一个敌人」改向，最多转弯4次），普通飞剑命中第一个目标即消散；可对空；未命中无最大飞行距离，一直飞出场外（出界消散）──
    sword: {
        update(p, deltaSec) {
            moveStraight(p, deltaSec);
            if (p.pierce) {
                // 🕊️ 御剑金剑·穿透改向：命中一个目标（排除刚命中的）结算伤害后，朝最近的「下一个敌人」
                //    重新定向直线飞（只改方向、不追踪）；再命中再改向——最多转弯4次，之后保持方向直线穿透；
                //    没有其他敌人则保持方向一直飞。伤害逐次衰减40%（×0.6），最低钳制2后不再衰减、继续穿透
                let hit = null;
                for (const e2 of game.entities) {
                    if (e2.id === p._lastPierceId || e2.team === p.team || e2.hp <= 0 || e2._headHidden) continue;
                    if (e2.flying && !p.hitsAir) continue;
                    if (Math.hypot(e2.x - p.x, e2.y - p.y) <= getHitRadius(e2) + 8) { hit = e2; break; }
                }
                if (hit) {
                    const atkEnt = game.entities.find(en => en.id === p.ownerId);
                    const dmg = calcActualDmg(p.damage, atkEnt, hit);
                    hit.hp -= dmg;
                    spawnDmgNum(hit.x, hit.y - 20, dmg);
                    p.damage *= 0.6; // 穿透伤害衰减
                    if (p.damage < 2) p.damage = 2; // 🎯 钳制到最低伤害2，继续穿透
                    // 命中金光
                    game.spellEffects.push({ x: hit.x, y: hit.y, char: '✨', size: 18, timer: 0.15, maxTimer: 0.15 });
                    p._lastPierceId = hit.id; // 排除刚命中的目标
                    // 改向：最多转弯4次——朝最近的「下一个敌人」直线飞（只判定距离、不追踪）
                    if (p._turns < 4) {
                        let best = null, bestDist = Infinity;
                        for (const en of game.entities) {
                            if (en.id === hit.id || en.team === p.team || en.hp <= 0 || en._headHidden) continue;
                            if (en.flying && !p.hitsAir) continue;
                            const d = Math.hypot(en.x - p.x, en.y - p.y);
                            if (d < bestDist) { bestDist = d; best = en; }
                        }
                        if (best) {
                            const a = Math.atan2(best.y - p.y, best.x - p.x);
                            p.vx = Math.cos(a);
                            p.vy = Math.sin(a);
                            p._turns++; // 转弯次数+1（最多4次）
                        }
                        // 没有其他敌人 → 保持原方向直线飞（出界消散）
                    }
                    // 转弯次数用尽 → 不再改向，保持当前方向直线穿透飞（出界消散）
                }
            } else {
                const hit = scanEnemies(p, (e2) => straightHit(p, e2, 12, 0.18), { breakOnHit: true });
                if (hit) { p.timer = 0; return; } // 命中即消散
            }
            // 无最大飞行距离：未命中则一直飞出场外（出界即消散）
            if (p.x < -60 || p.x > W + 60 || p.y < -60 || p.y > H + 60) p.timer = 0;
        }
    },
    // ── 🎆 烟花火箭：直线飞行（不追踪），碰到敌人立即伤害+分裂；飞满射程未命中则在最远点分裂 ──
    rocket: {
        update(p, deltaSec) {
            moveStraight(p, deltaSec);
            const hitEntity = scanEnemies(p, (e2) => straightHit(p, e2, 14, 0.2), { breakOnHit: true });
            if (hitEntity || p.dist >= p.maxDist) {
                // 分裂：5个橙色小球，扇形90°向前射出（沿飞行方向），穿透飞行60px，伤害与🚀一致
                const cx = hitEntity ? hitEntity.x : p.x;
                const cy = hitEntity ? hitEntity.y : p.y;
                const baseA = Math.atan2(p.vy, p.vx); // 向前（沿飞行方向）
                const spread = Math.PI * 90 / 180; // 总夹角90°
                const sharedHitIds = []; // 5球共享去重：分裂弹整体对同一目标只结算一次伤害
                for (let i = 0; i < 5; i++) {
                    const a = baseA + (i - 2) * (spread / 4); // -45° ~ +45° 覆盖90°
                    game.projectiles.push({
                        x: cx, y: cy, char: '🟠', size: 7,
                        vx: Math.cos(a), vy: Math.sin(a),
                        speed: 100, timer: 1.2, maxTimer: 1.2,
                        isShard: true, dist: 0, damage: p.damage,
                        team: p.team, hitsAir: true,
                        ownerId: p.ownerId, // 继承火箭的攻击者
                        shardSource: hitEntity ? hitEntity.id : p.ownerId, // 不二次伤害刚炸的主目标（落空则排除发射者）
                        hitIds: sharedHitIds, // 5球共享：分裂弹整体对同一目标只结算一次伤害
                    });
                }
                game.spellEffects.push({ x: cx, y: cy, char: '✨', size: 18, timer: 0.3, maxTimer: 0.3 });
                p.timer = 0;
            }
        }
    },
    // ── ⚡ 电磁炮：直线锁定落点，落点判定（不追踪）；命中需目标仍在落点附近，落点范围伤害 ──
    electro: {
        update(p, deltaSec) {
            const dxE = p.tx - p.x, dyE = p.ty - p.y;
            const dE = Math.hypot(dxE, dyE);
            if (dE < 5) {
                if (p.damage !== undefined && !p.hit) {
                    const tgtE = game.entities.find(en => en.id === p.targetId && en.hp > 0 && !en._headHidden && !en._stealthed);
                    // 目标还活着且仍在落点附近才算命中；目标已死亡/跑远则落空（不扣血）
                    if (tgtE && Math.hypot(tgtE.x - p.tx, tgtE.y - p.ty) < 18) {
                        const atkEnt = game.entities.find(en => en.id === p.ownerId) || null;
                        const dmgE = calcActualDmg(p.damage, atkEnt, tgtE);
                        tgtE.hp -= dmgE;
                        spawnDmgNum(tgtE.x, tgtE.y - 20, dmgE);
                        // 溅射/范围伤害：电磁炮全额，女巫固定25
                        if (p.aoeRadius) applyAoe(p, tgtE, atkEnt);
                        // 命中特效
                        game.spellEffects.push({ x: tgtE.x, y: tgtE.y, char: '💥', size: 14, timer: 0.2, maxTimer: 0.2 });
                    }
                    p.hit = true;
                }
                p.timer -= deltaSec;
            } else {
                const step = p.speed * deltaSec;
                p.x += (dxE / dE) * Math.min(step, dE);
                p.y += (dyE / dE) * Math.min(step, dE);
            }
        }
    },
    // ── 🪨 迫击炮：抛物线投石（锁定落点不追踪，落地范围伤害+轻微击退）──
    mortar: {
        update(p, deltaSec) {
            p.dist += p.speed * deltaSec;
            const t = Math.min(1, p.dist / p.maxDist);
            // 水平匀速 + 垂直抛物线（先升后降）
            p.x = p.sx + (p.tx - p.sx) * t;
            p.y = p.sy + (p.ty - p.sy) * t - p.arcHeight * Math.sin(Math.PI * t);
            if (t >= 1) {
                // 落地：范围伤害（参考火球术范围）+ 轻微击退（仅兵种，同火球）
                game.entities.forEach(e2 => {
                    if (e2.team === p.team || e2.hp <= 0 || e2._headHidden) return;
                    if (e2.flying) return; // 迫击炮只对地，范围不波及空中
                    if (Math.hypot(e2.x - p.tx, e2.y - p.ty) <= p.aoeRadius) {
                        const atkEnt = game.entities.find(en => en.id === p.ownerId) || null;
                        const dmgM = calcActualDmg(p.damage, atkEnt, e2);
                        e2.hp -= dmgM;
                        spawnDmgNum(e2.x, e2.y - 20, dmgM);
                        // 击退仅兵种生效（建筑不被推）：标记剩余位移向量，由帧驱动渐进滑动应用（位移式击退，不瞬移）
                        if (e2.moveSpeed !== undefined && !e2.fortification) {
                            const angle = Math.atan2(e2.y - p.ty, e2.x - p.tx);
                            e2._kbX = Math.cos(angle) * p.knockback;
                            e2._kbY = Math.sin(angle) * p.knockback;
                        }
                    }
                });
                // 落地特效：爆点 + 碎石 + 冲击圈
                game.spellEffects.push({ x: p.tx, y: p.ty, char: '💥', size: 40, timer: 0.35, maxTimer: 0.35 });
                game.spellEffects.push({ x: p.tx, y: p.ty, char: '🪨', size: 22, timer: 0.3, maxTimer: 0.3 });
                game.deployEffects.push({ x: p.tx, y: p.ty, radius: p.aoeRadius, timer: 0.4, maxTimer: 0.4 }); // 原有金色冲击圈（原样保留）
                // 范围提示：淡红色小环（通用提示，不覆盖任何原有特效）
                game.deployEffects.push({ x: p.tx, y: p.ty, radius: p.aoeRadius, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
                p.timer = 0;
            }
        }
    },
    // ── 🧨 哥布林爆破手：抛物线炸药包（锁定落点不追踪，落地范围伤害35px同迫击炮中档，只对地，无击退）──
    bomber: {
        update(p, deltaSec) {
            p.dist += p.speed * deltaSec;
            const t = Math.min(1, p.dist / p.maxDist);
            // 水平匀速 + 垂直抛物线（先升后降，同迫击炮）
            p.x = p.sx + (p.tx - p.sx) * t;
            p.y = p.sy + (p.ty - p.sy) * t - p.arcHeight * Math.sin(Math.PI * t);
            if (t >= 1) {
                // 落地：范围伤害35px（同迫击炮中档，只对地不波及空中）
                game.entities.forEach(e2 => {
                    if (e2.team === p.team || e2.hp <= 0 || e2._headHidden) return;
                    if (e2.flying) return; // 只对地
                    if (Math.hypot(e2.x - p.tx, e2.y - p.ty) <= p.aoeRadius) {
                        const atkEnt = game.entities.find(en => en.id === p.ownerId) || null;
                        const dmgM = calcActualDmg(p.damage, atkEnt, e2);
                        e2.hp -= dmgM;
                        spawnDmgNum(e2.x, e2.y - 20, dmgM);
                    }
                });
                // 落地特效：爆点 + 炸药 + 淡红范围环
                game.spellEffects.push({ x: p.tx, y: p.ty, char: '💥', size: 40, timer: 0.35, maxTimer: 0.35 });
                game.spellEffects.push({ x: p.tx, y: p.ty, char: '🧨', size: 20, timer: 0.3, maxTimer: 0.3 });
                game.deployEffects.push({ x: p.tx, y: p.ty, radius: p.aoeRadius, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
                p.timer = 0;
            }
        }
    },
    // ── 🔥 火豆跳跃：抛物线自爆（锁定落点不追踪，落地以落点为中心自爆：35px 10伤害+灼烧3秒20/秒）──
    fireJump: {
        update(p, deltaSec) {
            p.dist += p.speed * deltaSec;
            const t = Math.min(1, p.dist / p.maxDist);
            // 水平匀速 + 垂直抛物线（先升后降，同迫击炮）
            p.x = p.sx + (p.tx - p.sx) * t;
            p.y = p.sy + (p.ty - p.sy) * t - p.arcHeight * Math.sin(Math.PI * t);
            if (t >= 1) {
                // 落地：以落点为中心自爆（35px 10伤害+灼烧3秒20/秒，同原火豆跳炸）
                game.entities.forEach(e2 => {
                    if (e2.team === p.team || e2.hp <= 0 || e2._headHidden) return;
                    if (Math.hypot(e2.x - p.tx, e2.y - p.ty) <= p.aoeRadius) {
                        const atkEnt = game.entities.find(en => en.id === p.ownerId) || null;
                        const dmgM = calcActualDmg(p.damage, atkEnt, e2);
                        e2.hp -= dmgM;
                        spawnDmgNum(e2.x, e2.y - 20, dmgM);
                        e2._burnDamage = p.burnDamage;
                        e2._burnTimer = p.burnTimer;
                    }
                });
                // 落地特效：爆点 + 火焰（同原跳炸特效）
                game.spellEffects.push({ x: p.tx, y: p.ty, char: '💥', size: 24, timer: 0.3, maxTimer: 0.3 });
                game.spellEffects.push({ x: p.tx, y: p.ty, char: '🔥', size: 35, timer: 0.5, maxTimer: 0.5 });
                // 范围提示：淡红色小环（同群攻，静态真实范围）
                game.deployEffects.push({ x: p.tx, y: p.ty, radius: p.aoeRadius, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
                p.timer = 0;
            }
        }
    },
    // ── 👸 公主群箭：抛物线抛射（弧高比迫击炮更抖）+ 飞行中越分越散，到达落点范围伤害（splash45 全额，可波及空中）+ 落地效果同剑雨 + 落点红圈提示 ──
    princessSalvo: {
        update(p, deltaSec) {
            p.dist += p.speed * deltaSec;
            const t = Math.min(1, p.dist / p.maxDist);
            // 水平匀速 + 垂直抛物线（先升后降，比迫击炮更抖）
            p.x = p.sx + (p.tx - p.sx) * t;
            p.y = p.sy + (p.ty - p.sy) * t - p.arcHeight * Math.sin(Math.PI * t);
            // 越分越散：侧向偏移随飞行距离 t² 渐增（发射时集中、越飞越散）
            p.x += p.latX * t * t;
            p.y += p.latY * t * t;
            if (t >= 1) {
                if (p.isLandSettler && !p.landed) {
                    p.landed = true;
                    // 落点范围伤害：splash45（全额伤害，同剑雨结算、可波及空中）
                    game.entities.forEach(e2 => {
                        if (e2.team === p.team || e2.hp <= 0 || e2._headHidden) return;
                        if (Math.hypot(e2.x - p.tx, e2.y - p.ty) <= p.aoeRadius) {
                            const atkEnt = game.entities.find(en => en.id === p.ownerId) || null;
                            const dmgP = calcActualDmg(p.damage, atkEnt, e2);
                            e2.hp -= dmgP;
                            spawnDmgNum(e2.x, e2.y - 20, dmgP);
                        }
                    });
                    // 落地效果同剑雨：8支箭落地特效 + 冲击圈
                    for (let j = 0; j < 8; j++) {
                        const angle = rand() * 2 * Math.PI;
                        const r = rand() * p.aoeRadius * 0.7;
                        game.spellEffects.push({
                            x: p.tx + Math.cos(angle) * r,
                            y: p.ty + Math.sin(angle) * r,
                            char: '།', size: 16,
                            timer: 0.5 + rand() * 0.3,
                            maxTimer: 0.8,
                        });
                    }
                    game.deployEffects.push({ x: p.tx, y: p.ty, radius: p.aoeRadius * 0.3, timer: 0.3, maxTimer: 0.3 });
                    // 范围提示：淡红色小环（同迫击炮落点提示同款）
                    game.deployEffects.push({ x: p.tx, y: p.ty, radius: p.aoeRadius, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
                }
                p.timer = 0;
            }
        }
    },
    // ── 🎯 通用追踪弹：目标存活则每帧追踪其当前位置，贴近受击半径即命中（有目标必中）──
    tracking: {
        update(p, deltaSec) {
            // 查找目标（存活且未隐身/未露头）
            const tgt = game.entities.find(en => en.id === p.targetId && en.hp > 0 && !en._headHidden && !en._stealthed);
            if (tgt) {
                // 追踪：持续刷新落点为目标当前位置（子弹拐弯追目标）
                p.tx = tgt.x;
                p.ty = tgt.y;
            }
            const dx = p.tx - p.x, dy = p.ty - p.y;
            const d = Math.hypot(dx, dy);
            if (tgt) {
                // 有目标：追踪中（timer不衰减保证必中），贴近受击半径即结算命中
                const hitR = getHitRadius(tgt) + (p.size || 10) * 0.5 + 6;
                if (d <= hitR) {
                    if (p.damage !== undefined && !p.hit) {
                        const atkEnt = game.entities.find(en => en.id === p.ownerId) || null;
                        const dmgT = calcActualDmg(p.damage, atkEnt, tgt);
                        tgt.hp -= dmgT;
                        spawnDmgNum(tgt.x, tgt.y - 20, dmgT);
                        if (p.isNinjaDart) applyPoison(tgt); // 🥷 忍者飞镖命中：施加/刷新4秒中毒
                        // 溅射/范围伤害：法师塔0.6倍，电磁炮全额，女巫固定25
                        if (p.aoeRadius) applyAoe(p, tgt, atkEnt);
                        // 命中特效
                        game.spellEffects.push({ x: tgt.x, y: tgt.y, char: '💥', size: 14, timer: 0.2, maxTimer: 0.2 });
                    }
                    p.hit = true;
                    p.timer = 0; // 命中即消散
                } else {
                    // 追踪移动（子弹拐弯追目标）
                    const step = p.speed * deltaSec;
                    p.x += (dx / d) * Math.min(step, d);
                    p.y += (dy / d) * Math.min(step, d);
                }
            } else {
                // 目标已消失/死亡：沿最后方向飞完并消散（不结算伤害）
                if (d < 5) {
                    p.timer -= deltaSec;
                } else {
                    const step = p.speed * deltaSec;
                    p.x += (dx / d) * Math.min(step, d);
                    p.y += (dy / d) * Math.min(step, d);
                    p.timer -= deltaSec;
                }
            }
        }
    }
};

/* ═══════════════════════════════════════════
 * 🧘 武僧超脱·弹道反弹（2026-08-15，通用化：按弹道字段特征分类，不依赖卡牌名单）
 *  超脱光晕期间（_transcendTimer>0）：碰到武僧的敌方飞行物一律反弹回发起者
 *  · 追踪类（默认 tracking：弓箭/炮弹/能量球/弩箭等）→ 目标直接改为发起者
 *    （凡有 targetId、无 vx/vy、无 sx/sy/arcHeight 的弹道都归此类，自动覆盖）
 *  · 直线类（凡有 vx/vy：投矛/飞剑/火箭/猎弹/分裂球/电磁炮/游侠穿透箭）
 *    → 从武僧位置朝发起者重新发射
 *  · 抛物线类（凡有 sx/sy/arcHeight：迫击炮/公主群箭及未来同类）
 *    → 以武僧为起点、发起者为落点重新抛射（弧高按距离比例缩放）
 *  已反弹（_reflected）不再二次反弹；及时伤害（雷电法师/巫师/电磁塔等）与近战无弹道，天然不反弹
 *  ➕ 后续新增兵种弹道无需改动本函数：标准追踪弹/直线弹/抛物线弹自动被反弹
 *     （新弹道类型只需在 PROJECTILE_HANDLERS 分发表注册，与反弹无关）
 * ═══════════════════════════════════════════ */
function tryReflectProjectile(p, deltaSec) {
    if (p._reflected) return false; // 已反弹过：不再二次反弹（防无限循环）
    // 找超脱中的敌方武僧（光晕期间才反弹，0.6s前摇 _transcendChant 不反弹）
    // 判定半径 = 命中判定半径 + 本帧步长前瞻 + 拦截余量8px：
    //   命中半径取 scanEnemies(+8) 与 tracking(+size/2+6) 的较大者；
    //   +step 保证「弹道本帧移动后就会命中武僧」时，移动前检查已命中反弹（防慢半拍漏判）；
    //   +8 扩大拦截范围：弹道在光晕(20px)边缘外即被反弹，拦截更宽
    const step = (p.speed || 200) * (deltaSec || 1 / 60);
    const hitPad = Math.max(8, (p.size || 10) * 0.5 + 6) + 8;
    let monk = null;
    for (const e of game.entities) {
        if (e.cardId === 'monk' && e.hp > 0 && e.team !== p.team && (e._transcendTimer || 0) > 0) {
            if (Math.hypot(e.x - p.x, e.y - p.y) <= getHitRadius(e) + hitPad + step) { monk = e; break; }
        }
    }
    if (!monk) return false;
    // 发起者（反弹目标）：已阵亡则无法反弹（弹道正常命中武僧，武僧有70%减伤兜底）
    const origin = game.entities.find(en => en.id === p.ownerId && en.hp > 0);
    if (!origin) return false;
    const dR = Math.hypot(origin.x - monk.x, origin.y - monk.y);
    if (dR < 1) return false;
    p.team = monk.team;      // 归属武僧阵营
    p.ownerId = monk.id;     // 伤害归属武僧（吃武僧的实时狂暴/减伤）
    p._reflected = true;
    if (p.sx !== undefined && p.sy !== undefined && p.arcHeight !== undefined) {
        // ── 抛物线类（凡设 sx/sy/arcHeight 的弹道均适用，不限迫击炮/公主群箭）：
        //    以武僧为起点、发起者为落点重新抛射 ──
        const oldDist = Math.max(1, p.maxDist || dR);
        p.sx = monk.x; p.sy = monk.y;
        p.tx = origin.x; p.ty = origin.y;
        p.dist = 0;
        p.maxDist = dR;
        p.arcHeight = Math.max(60, (p.arcHeight || 100) * (dR / oldDist)); // 弧高按距离比例缩放，保持原弧度感（最小60防贴脸变平）
        if (p.latX !== undefined || p.latY !== undefined) { p.latX = 0; p.latY = 0; } // 重新瞄准发起者：取消原随机散布
    } else if (p.vx !== undefined && p.vy !== undefined) {
        // ── 直线类：从武僧位置朝发起者重新发射 ──
        p.x = monk.x; p.y = monk.y;
        p.vx = (origin.x - monk.x) / dR;
        p.vy = (origin.y - monk.y) / dR;
        p.dist = 0; // 射程重新累计（从武僧重新出发）
    } else {
        // ── 追踪类（含电磁炮落点制）：目标直接改为发起者 ──
        p.x = monk.x; p.y = monk.y; // 从武僧位置出发（不再飞向原目标）
        p.tx = origin.x; p.ty = origin.y;
        p.targetId = origin.id;
    }
    // 反弹特效：青色返回箭头（呼应光晕）
    game.spellEffects.push({ x: monk.x, y: monk.y - 20, char: '↩️', size: 20, color: '#00e5ff', timer: 0.4, maxTimer: 0.4 });
    return true;
}

/* ═══════════════════════════════════════════
 * 🧘 武僧超脱·飞行中反弹法术弹道（火球术/箭雨：从主塔抛物线飞向落点 → 弹道途中判定）
 *  超脱光晕期间（_transcendTimer>0）：飞行物途中经过敌方武僧光晕 → 立即掉头反弹，
 *  从武僧位置重新抛向施法方大本营（team 翻转归属武僧方），原落点不造成任何伤害/爆炸
 *  已反弹（_reflected）不再二次判定；地震（地面震动）/大雷电（锁定劈雷）非飞行弹道，不处理
 * ═══════════════════════════════════════════ */
function tryReflectSpellFlight(f, deltaSec) {
    if (f._reflected) return false;
    // 飞行当前位置（与 render.js 插值一致：水平插值 + 抛物线弧高）
    const k = Math.min(1, Math.max(0, 1 - f.timer / f.maxTimer));
    const d0 = Math.max(1, Math.hypot(f.x1 - f.x0, f.y1 - f.y0));
    const arcH = f.arrows ? Math.min(300, Math.max(150, d0 * 1.0)) : Math.min(220, Math.max(100, d0 * 0.45));
    const lift = Math.sin(k * Math.PI);
    const bx = f.x0 + (f.x1 - f.x0) * k;
    const arcY = f.y0 + (f.y1 - f.y0) * k - arcH * lift;
    // 判定半径 = 武僧命中半径 + 超脱光晕(20px) + 余量8px + 本帧步长前瞻（防慢半拍漏判）
    const step = (d0 / Math.max(0.001, f.maxTimer)) * (deltaSec || 1 / 60);
    let monk = null;
    for (const e of game.entities) {
        if (e.cardId === 'monk' && e.hp > 0 && e.team !== f.team && (e._transcendTimer || 0) > 0) {
            if (Math.hypot(e.x - bx, e.y - arcY) <= getHitRadius(e) + 20 + 8 + step) { monk = e; break; }
        }
    }
    if (!monk) return false;
    // 施法方大本营（存活才反弹；大本营已被摧毁则法术正常落地）
    const base = game.entities.find(en => en.type === 'main_tower' && en.team === f.team && en.hp > 0);
    if (!base) return false;
    // 掉头反弹：从武僧位置重新抛向施法方大本营，飞行时间按新距离比例缩放（保持飞行速度感）
    const newDist = Math.max(1, Math.hypot(base.x - monk.x, base.y - monk.y));
    f.x0 = monk.x; f.y0 = monk.y;
    f.x1 = base.x; f.y1 = base.y;
    f.x = base.x; f.y = base.y;      // 火球落地结算坐标同步（箭雨结算用 x1/y1）
    f.team = monk.team;
    f._reflected = true;
    f.maxTimer *= newDist / d0;
    f.timer = f.maxTimer;            // 从武僧处重新起飞
    // 反弹特效：武僧处青色返回箭头（呼应光晕）+ 大本营处青色警示爆点
    game.spellEffects.push({ x: monk.x, y: monk.y - 20, char: '↩️', size: 20, color: '#00e5ff', timer: 0.4, maxTimer: 0.4 });
    game.spellEffects.push({ x: base.x, y: base.y - 20, char: '🔥', size: 26, color: '#00e5ff', timer: 0.5, maxTimer: 0.5 });
    return true;
}

/** 🧘 游侠穿透箭的武僧超脱反弹（独立数组，字段不同：dx/dy + traveled） */
function tryReflectPierceArrow(a, deltaSec) {
    if (a._reflected) return false;
    // 弹道当前位置 = 发射点 + 方向×已飞行路程（穿透箭 x/y 固定为发射点、traveled 累计路程）
    const px = a.x + a.dx * a.traveled;
    const py = a.y + a.dy * a.traveled;
    // 判定半径 = 命中判定半径(16) + 本帧步长前瞻 + 拦截余量8px（穿透箭速度350，防移动后命中先于反弹）
    const step = a.speed * (deltaSec || 1 / 60);
    let monk = null;
    for (const e of game.entities) {
        if (e.cardId === 'monk' && e.hp > 0 && e.team !== a.team && (e._transcendTimer || 0) > 0) {
            if (Math.hypot(e.x - px, e.y - py) <= getHitRadius(e) + 16 + step + 8) { monk = e; break; } // 穿透箭宽2，半径按+16判定
        }
    }
    if (!monk) return false;
    const origin = game.entities.find(en => en.id === a.ownerId && en.hp > 0);
    if (!origin) return false;
    const dR = Math.hypot(origin.x - monk.x, origin.y - monk.y);
    if (dR < 1) return false;
    a.x = monk.x; a.y = monk.y;
    a.dx = (origin.x - monk.x) / dR;
    a.dy = (origin.y - monk.y) / dR;
    a.traveled = 0;      // 从武僧位置重新飞行
    a.team = monk.team;
    a.ownerId = monk.id;
    a.hitIds = new Set(); // 反弹后重新计数命中
    a._reflected = true;
    game.spellEffects.push({ x: monk.x, y: monk.y - 20, char: '↩️', size: 20, color: '#00e5ff', timer: 0.4, maxTimer: 0.4 });
    return true;
}

/* ═══════════════════════════════════════════
 * 🧘 武僧超脱·反弹火箭法术（特殊弹道：火箭屏外/影子段不可见，仅俯冲段0.5s（elapsed 3.0→3.5）可见可拦截）
 *  超脱光晕期间（_transcendTimer>0）：火箭俯冲途中经过敌方武僧光晕 → 立即掉头反弹，
 *  从武僧位置直线飞向施法方大本营（team 翻转归属武僧阵营），原落点不造成任何伤害/爆炸/蘑菇云
 *  已反弹（_reflected）不再二次判定
 * ═══════════════════════════════════════════ */
function tryReflectRocket(r, deltaSec) {
    if (r._reflected) return false;
    const elapsed = r.maxTimer - r.timer; // 0→3.5 总进度
    if (elapsed < 3.0) return false; // 仅俯冲段（火箭可见）可拦截
    // 俯冲当前位置（与 render.js 落地段插值一致：垂直下落 + 轻微左右摆动）
    const k3 = Math.min(1, (elapsed - 3) / 0.5);
    const rx = r.x + Math.sin(elapsed * 10) * 3 * k3;
    const ry = -25 + (r.y + 25) * k3;
    // 判定半径 = 武僧命中半径 + 超脱光晕(20px) + 余量8px + 本帧步长前瞻（俯冲速度约(r.y+25)/0.5，防慢半拍漏判）
    const step = ((r.y + 25) / 0.5) * (deltaSec || 1 / 60);
    let monk = null;
    for (const e of game.entities) {
        if (e.cardId === 'monk' && e.hp > 0 && e.team !== r.team && (e._transcendTimer || 0) > 0) {
            if (Math.hypot(e.x - rx, e.y - ry) <= getHitRadius(e) + 20 + 8 + step) { monk = e; break; }
        }
    }
    if (!monk) return false;
    // 施法方大本营（存活才反弹；大本营已被摧毁则火箭正常落地）
    const base = game.entities.find(en => en.type === 'main_tower' && en.team === r.team && en.hp > 0);
    if (!base) return false;
    // 掉头反弹：从武僧位置直线飞向施法方大本营，飞行时间按距离/速度（900px/s）
    const newDist = Math.max(1, Math.hypot(base.x - monk.x, base.y - monk.y));
    r._reflected = true;
    r._monkId = monk.id;
    r._sx = monk.x; r._sy = monk.y;      // 返回弹道起点（武僧）
    r._bx = base.x; r._by = base.y;      // 返回弹道目标（施法方大本营）
    r.team = monk.team;                  // 归属武僧阵营
    r.maxTimer = newDist / 900;
    r.timer = r.maxTimer;                // 从武僧处重新起飞
    // 移除释放时的淡红提示圈（火箭已被拦截，原落点不再提示）
    game.deployEffects = game.deployEffects.filter(d => !(d.static && d.x === r.x && d.y === r.y));
    // 反弹特效：武僧处青色返回箭头（呼应光晕）+ 大本营处青色警示爆点
    game.spellEffects.push({ x: monk.x, y: monk.y - 20, char: '↩️', size: 20, color: '#00e5ff', timer: 0.4, maxTimer: 0.4 });
    game.spellEffects.push({ x: base.x, y: base.y - 20, char: '🔥', size: 26, color: '#00e5ff', timer: 0.5, maxTimer: 0.5 });
    return true;
}
function rageMult(e) {
    return e && e._rageTimer > 0 ? 1.3 : 1.0;
}

/* ═══════════════════════════════════════════
 * 召唤系统统一（务实版：行为零变化）
 *  周期性召唤统一走 tickSpawner：spawnTimer 累计 → 到间隔按 spawnUnit 创建召唤物
 *  数据源兼容两种：兵营走实体字段(e)，女巫/暗夜女巫走 CARDS 配置（渲染层进度条依赖，不能改）
 * ═══════════════════════════════════════════ */

/** 召唤物创建映射：spawnUnit → 创建函数（保留各自的分布/飞行参数） */
const SUMMON_CREATORS = {
    bat: createBat,                        // 蝙蝠：暗夜女巫，jitter 30/20 + 飞行可对空
    skeleton: createSkeleton,              // 骷髅：女巫，spread 圆散半径50 + _isSpawned
    goblin: (x, y, team) => createSummon(BASE_UNITS.goblin || GOBLIN_TEMPLATE, 'goblin', x, y, team, { jitterX: 20, jitterY: 15 }),
};

/** 周期性召唤通用循环（女巫/暗夜女巫/兵营共用）：
 *  src 为配置源（实体 或 CARDS 条目，含 spawnInterval/spawnCount/spawnUnit）；
 *  opts.inheritCopy=true 时复制体召唤的衍生物继承 1 滴血（仅兵种召唤者） */
function tickSpawner(e, deltaSec, src, opts) {
    opts = opts || {};
    if (!src || !src.spawnInterval || !src.spawnUnit) return;
    const creator = SUMMON_CREATORS[src.spawnUnit] || ((x, y, team) =>
        createSummon(BASE_UNITS[src.spawnUnit] || GOBLIN_TEMPLATE, src.spawnUnit, x, y, team, { jitterX: 20, jitterY: 15 }));
    e.spawnTimer += deltaSec * rageMult(e);
    while (e.spawnTimer >= src.spawnInterval) {
        e.spawnTimer -= src.spawnInterval;
        for (let i = 0; i < (src.spawnCount || 1); i++) {
            const spawned = creator(e.x, e.y, e.team);
            // 🔷 复制体召唤的衍生物也继承复制特性：1滴血；护盾随父体（父体带盾则子代1盾，父体无盾则子代无盾）
            if (opts.inheritCopy && e.isCopy) { spawned.hp = 1; spawned.maxHp = 1; spawned.shield = (e.maxShield || 0) > 0 ? 1 : 0; spawned.maxShield = spawned.shield; spawned.isCopy = true; }
            game.entities.push(spawned);
        }
    }
}

/** 发射塔弹道（通用）：基础字段 + opts 覆盖（堡垒/法师塔/炮塔/十字弩/迫击炮共用） */
function spawnTowerProjectile(e, target, opts) {
    game.projectiles.push(Object.assign({
        x: e.x, y: e.y,
        tx: target.x, ty: target.y,
        timer: 0.25,
        damage: e.atk, // 原始伤害，命中时统一走 calcActualDmg（吃目标实时减伤+攻击者实时狂暴）
        team: e.team,
        targetId: target.id,
        ownerId: e.id, // 攻击者：弹道命中结算时吃狂暴/减伤
    }, opts || {}));
}

/**
 * 死亡结算分发器：把原先 13 个复制粘贴的"for(e) if(e.hp<=0 && cardId==='x')"块
 * 收拢为配置驱动的 resolver 列表。每个死亡实体依次匹配所有条目（顺序保持原代码执行顺序）。
 * ⚠️ 必须在死亡清理（game.entities = filter(hp>0)）之前调用。
 */
const DEATH_RESOLVERS = [
    // ---- 🤢 中毒扩散：中毒单位死亡时，将中毒传给45px内同阵营友军 ----
    {
        match: e => e.hp <= 0 && e._poisonTimer > 0 && !e._poisonSpreadDone,
        handler: e => {
            e._poisonSpreadDone = true; // 同一次死亡只扩散一次，避免死亡清理前重复触发
            const spreadRadius = AOE_RANGE_LARGE; // 与飞龙群攻范围一致：45px
            for (const ally of game.entities) {
                if (ally === e || ally.hp <= 0 || ally.team !== e.team || ally._headHidden) continue;
                if (Math.hypot(ally.x - e.x, ally.y - e.y) <= spreadRadius) {
                    applyPoison(ally);
                }
            }
            // 淡红色静态范围圈：提示本次中毒扩散的真实范围
            game.deployEffects.push({
                x: e.x, y: e.y,
                radius: spreadRadius,
                timer: 0.4, maxTimer: 0.4,
                color: AOE_RING_COLOR, static: true,
            });
            game.spellEffects.push({
                x: e.x, y: e.y, char: '🤢', size: 24,
                timer: 0.45, maxTimer: 0.45,
            });
        },
    },
    // ---- 哥布林牢笼：建筑破损后出现1只强壮哥布林 ----
    {
        match: e => e.hp <= 0 && e.cardId === 'goblin_cage',
        handler: e => {
            game.entities.push(createSummon(STRONG_GOBLIN_TEMPLATE, 'strong_goblin', e.x, e.y, e.team, { jitterX: 30, jitterY: 20 }));
            // 牢笼破碎特效
            game.spellEffects.push({ x: e.x, y: e.y, char: '💥', size: 40, timer: 0.6, maxTimer: 0.6 });
            game.spellEffects.push({ x: e.x, y: e.y, char: '💪', size: 26, timer: 0.4, maxTimer: 0.4 });
            // 木屑飞溅（3个小碎片）
            for (let i = 0; i < 3; i++) {
                game.spellEffects.push({
                    x: e.x + (rand() - 0.5) * 20,
                    y: e.y + (rand() - 0.5) * 20,
                    char: '🪵', size: 12,
                    timer: 0.3 + rand() * 0.3,
                    maxTimer: 0.5,
                });
            }
        },
    },
    // ---- 👜 哥布林巨人：死亡后袋子里蹦出2只哥布林投矛手 ----
    {
        match: e => e.hp <= 0 && e.cardId === 'goblin_giant',
        handler: e => {
            for (let i = 0; i < 2; i++) {
                const t = createGoblinThrower(e.x, e.y, e.team);
                // 🔷 复制体巨人死亡召唤的投矛手也继承复制特性：1滴血；护盾随父体
                if (e.isCopy) {
                    t.hp = 1; t.maxHp = 1;
                    t.shield = (e.maxShield || 0) > 0 ? 1 : 0;
                    t.maxShield = t.shield;
                    t.isCopy = true;
                }
                game.entities.push(t);
            }
            // 袋子爆开特效
            game.spellEffects.push({ x: e.x, y: e.y, char: '💥', size: 40, timer: 0.6, maxTimer: 0.6 });
            game.spellEffects.push({ x: e.x, y: e.y - 8, char: '👜', size: 22, timer: 0.5, maxTimer: 0.5 });
            game.spellEffects.push({ x: e.x, y: e.y + 6, char: '🔱', size: 20, timer: 0.4, maxTimer: 0.4 });
        },
    },
    // ---- 哥布林小屋：被摧毁后出现3只哥布林投矛手 ----
    {
        match: e => e.hp <= 0 && e.cardId === 'goblin_hut',
        handler: e => {
            const cnt = CARDS.goblin_hut.deathSpawnCount || 3;
            for (let i = 0; i < cnt; i++) {
                game.entities.push(createGoblinThrower(e.x, e.y, e.team));
            }
            // 小屋倒塌特效
            game.spellEffects.push({ x: e.x, y: e.y, char: '💥', size: 40, timer: 0.6, maxTimer: 0.6 });
            game.spellEffects.push({ x: e.x, y: e.y, char: '🔱', size: 26, timer: 0.4, maxTimer: 0.4 });
            // 木屑飞溅（3个小碎片）
            for (let i = 0; i < 3; i++) {
                game.spellEffects.push({
                    x: e.x + (rand() - 0.5) * 20,
                    y: e.y + (rand() - 0.5) * 20,
                    char: '🪵', size: 12,
                    timer: 0.3 + rand() * 0.3,
                    maxTimer: 0.5,
                });
            }
        },
    },
    // ---- 哥布林钻机：被摧毁后钻出2只哥布林 ----
    {
        match: e => e.hp <= 0 && e.cardId === 'goblin_drill',
        handler: e => {
            const cnt = CARDS.goblin_drill.deathSpawnCount || 2;
            for (let i = 0; i < cnt; i++) {
                game.entities.push(createGoblinMelee(e.x, e.y, e.team));
            }
            // 钻机爆炸特效
            game.spellEffects.push({ x: e.x, y: e.y, char: '💥', size: 42, timer: 0.6, maxTimer: 0.6 });
            game.spellEffects.push({ x: e.x, y: e.y, char: '🛠️', size: 26, timer: 0.4, maxTimer: 0.4 });
            // 零件飞溅（3个小碎片）
            for (let i = 0; i < 3; i++) {
                game.spellEffects.push({
                    x: e.x + (rand() - 0.5) * 20,
                    y: e.y + (rand() - 0.5) * 20,
                    char: '🔩', size: 12,
                    timer: 0.3 + rand() * 0.3,
                    maxTimer: 0.5,
                });
            }
        },
    },
    // ---- 炮车：被打爆后原地变形成炮台建筑（第二条命）----
    {
        match: e => e.hp <= 0 && e.cardId === 'cannon_cart' && !e._turretMode,
        handler: e => {
            e._turretMode = true;    // 变形标记
            e.type = 'tower';        // 变成建筑（被巨人/攻城人/送水人优先攻击，可被地震法术克制）
            e.hp = e.maxHp;          // 回满血 = 第二条命
            e.range = 135;           // 🛡️ 变形后射程保持135不变（与车形态一致，2026-08-26调整：两段生命450/范围恒135）
            delete e.moveSpeed;      // 建筑不再有移速字段：击退(武僧/迫击炮/火球)/飓风拉拢/移动判定(moveSpeed===undefined即非兵种)天然排除
            // 变形后不再是兵种：清除营地收编🚩标记（炮台作为独立建筑行动，不参与营地巡逻、不占名额）
            e._campFlag = false;
            e._campId = undefined;
            e._patrolX = undefined; e._patrolY = undefined;
            e._patrolDir = undefined; e._patrolR = undefined;
            // 变形特效
            game.spellEffects.push({ x: e.x, y: e.y, char: '🛡️', size: 30, timer: 0.5, maxTimer: 0.5 });
            game.spellEffects.push({ x: e.x, y: e.y, char: '💥', size: 40, timer: 0.4, maxTimer: 0.4 });
        },
    },
    // ---- 暗夜女巫：死亡召唤蝙蝠（在清除前处理）----
    {
        match: e => e.hp <= 0 && e.cardId === 'night_witch',
        handler: e => {
            const card = CARDS[e.cardId];
            if (card && card.deathSpawnCount) {
                for (let i = 0; i < card.deathSpawnCount; i++) {
                    const bat = createBat(e.x, e.y, e.team);
                    // 🔷 复制体女巫死亡召唤的蝙蝠也继承复制特性：1滴血；护盾随父体
                    if (e.isCopy) { bat.hp = 1; bat.maxHp = 1; bat.shield = (e.maxShield || 0) > 0 ? 1 : 0; bat.maxShield = bat.shield; bat.isCopy = true; }
                    game.entities.push(bat);
                }
            }
        },
    },
    // ---- 死亡爆炸（通用）：凡配置了deathBoomRadius/deathBoomDmg的卡牌（熔岩猎犬/巨人等）死亡时，对周围圆形范围内所有敌方单位造成伤害（在清除前处理）----
    {
        match: e => e.hp <= 0 && CARDS[e.cardId] && CARDS[e.cardId].deathBoomRadius,
        handler: e => {
            const card = CARDS[e.cardId];
            // 💥 死亡爆炸：对周围(radius)px内所有敌方单位造成dmg伤害
            game.entities.forEach(e2 => {
                if (e2.team === e.team || e2.hp <= 0 || e2._headHidden) return;
                if (Math.hypot(e2.x - e.x, e2.y - e.y) <= card.deathBoomRadius) {
                    const bd = calcActualDmg(card.deathBoomDmg, null, e2);
                    e2.hp -= bd;
                    spawnDmgNum(e2.x, e2.y - 20, bd);
                }
            });
            // 爆炸特效
            game.spellEffects.push({ x: e.x, y: e.y, char: '💥', size: 42, timer: 0.6, maxTimer: 0.6 });
            // 范围提示：淡红色小环（同群攻，静态真实范围）
            game.deployEffects.push({ x: e.x, y: e.y, radius: card.deathBoomRadius, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
        },
    },
    // ---- 熔岩猎犬：死亡召唤6只猎犬幼崽（在清除前处理）----
    {
        match: e => e.hp <= 0 && e.cardId === 'lava_hound',
        handler: e => {
            const card = CARDS[e.cardId];
            if (card && card.deathSpawnCount) {
                for (let i = 0; i < card.deathSpawnCount; i++) {
                    const ang = rand() * Math.PI * 2;
                    const r = Math.sqrt(rand()) * 70;
                    const pup = createLavaPup(e.x + Math.cos(ang) * r, e.y + Math.sin(ang) * r, e.team);
                    // 🔷 复制体熔岩猎犬爆炸召唤的幼崽也继承复制特性：1滴血；护盾随父体
                    if (e.isCopy) { pup.hp = 1; pup.maxHp = 1; pup.shield = (e.maxShield || 0) > 0 ? 1 : 0; pup.maxShield = pup.shield; pup.isCopy = true; }
                    game.entities.push(pup);
                }
            }
        },
    },
    // ---- 大送水人：死亡分裂出送水人 ----
    {
        match: e => e.hp <= 0 && e.cardId === 'water_carrier',
        handler: e => {
            const card = CARDS[e.cardId];
            if (card && card.deathSpawnCount) {
                for (let i = 0; i < card.deathSpawnCount; i++) {
                    const child = createCraftedWaterCarrier(e.x, e.y, e.team);
                    // 🔷 复制体送水人分裂出的子代也继承复制特性：1滴血；护盾随父体
                    if (e.isCopy) { child.hp = 1; child.maxHp = 1; child.shield = (e.maxShield || 0) > 0 ? 1 : 0; child.maxShield = child.shield; child.isCopy = true; }
                    game.entities.push(child);
                }
                game.spellEffects.push({ x: e.x, y: e.y, char: '💧', size: 24, timer: 0.4, maxTimer: 0.4 });
            }
        },
    },
    // ---- 送水人：死亡分裂出小送水人 ----
    {
        match: e => e.hp <= 0 && e.cardId === 'crafted_water_carrier',
        handler: e => {
            for (let i = 0; i < 2; i++) {
                const child = createSmallWaterCarrier(e.x, e.y, e.team);
                // 🔷 复制体送水人分裂出的子代也继承复制特性：1滴血；护盾随父体
                if (e.isCopy) { child.hp = 1; child.maxHp = 1; child.shield = (e.maxShield || 0) > 0 ? 1 : 0; child.maxShield = child.shield; child.isCopy = true; }
                game.entities.push(child);
            }
            game.spellEffects.push({ x: e.x, y: e.y, char: '💧', size: 18, timer: 0.35, maxTimer: 0.35 });
        },
    },
    // ---- 小送水人：死亡给敌方增加1圣水 ----
    {
        match: e => e.hp <= 0 && e.cardId === 'small_water_carrier',
        handler: e => {
            if (e.team === 'player') {
                game.elixir.ai = Math.min(game.elixir.ai + 1, 10);
            } else {
                game.elixir.player = Math.min(game.elixir.player + 1, 10);
            }
        },
    },
    // ---- 巫师🐛标记：死亡召唤小虫 ----
    {
        match: e => e.hp <= 0 && e._wormMarkTimer > 0,
        handler: e => {
            game.entities.push(createWorm(e.x, e.y, e._wormMarkTeam));
            // 小虫出现特效
            game.spellEffects.push({ x: e.x, y: e.y, char: '🐛', size: 18, timer: 0.5, maxTimer: 0.5 });
        },
    },
    // ---- 🧪 哥布林魔咒·诅咒领域：领域内死亡的敌军（不含防御工事）召唤一只我方近战哥布林 ----
    {
        match: e => e.hp <= 0 && !e.fortification && !e._curseSummoned,
        handler: e => {
            // 仅「敌方单位」死于领域内才转化：己方单位死亡不召唤（修复：曾对己方也生效）
            const zone = game.curseZones.find(z => z.team !== e.team && dist(e, z) <= z.radius);
            if (!zone) return;
            e._curseSummoned = true;
            const g = createGoblinMelee(e.x, e.y, zone.team);
            game.entities.push(g);
            // 召唤特效
            game.spellEffects.push({ x: e.x, y: e.y, char: '👺', size: 24, timer: 0.6, maxTimer: 0.6 });
        },
    },
    // ---- 💣 攻城人 / 哥布林爆破手（含复制体）：死亡留下炸弹（任何死法统一结算，与狂暴/自爆状态无关；自爆只管自杀）----
    {
        match: e => e.hp <= 0 && (e.isSiege || e.cardId === 'goblin_bomber'),
        handler: e => {
            const bomb = { x: e.x, y: e.y, timer: 0.5, maxTimer: 0.5, team: e.team, ownerId: e.id };
            if (e.cardId === 'goblin_bomber') bomb.dmg = 120; // 🧨 爆破手狂暴炸弹：固定120伤害（参考攻城人留💣）
            game.bombs.push(bomb);
            game.spellEffects.push({ x: e.x, y: e.y, char: '💥', size: 16, timer: 0.15, maxTimer: 0.15 });
        },
    },
    // ---- 气球兵：死亡留下💣（2秒后爆炸，范围45px同法师塔群攻，111范围伤害，防重复）----
    {
        match: e => e.hp <= 0 && e.cardId === 'balloon' && !e._balloonBombDropped,
        handler: e => {
            e._balloonBombDropped = true;
            game.bombs.push({ x: e.x, y: e.y, timer: 2.0, maxTimer: 2.0, team: e.team, ownerId: e.id, dmg: 222, radius: 45 });
            game.spellEffects.push({ x: e.x, y: e.y, char: '💥', size: 16, timer: 0.15, maxTimer: 0.15 });
        },
    },
    // ---- 冰豆：死亡自爆（被攻击打死也触发范围减速，已自爆的跳过防重复）----
    {
        match: e => e.hp <= 0 && e._iceBean && !e._selfDestructed,
        handler: e => {
            for (let en of game.entities) {
                if (en.team === e.team || en.hp <= 0 || en._headHidden) continue;
                if (Math.hypot(e.x - en.x, e.y - en.y) <= 45) {
                    const bd = calcActualDmg(25, e, en); // 冰豆自爆：45px范围25伤害+减速80%持续1.5秒
                    en.hp -= bd;
                    spawnDmgNum(en.x, en.y - 20, bd);
                    en.slowFactor = 0.2;
                    en.slowTimer = 1.5;
                }
            }
            // 范围提示：淡红色小环（同群攻，静态真实范围）
            game.deployEffects.push({ x: e.x, y: e.y, radius: 45, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
        },
    },
    // ---- 🧊 小冰人：死亡冰爆（45px范围18伤害+减速80%持续1.5秒，范围/效果参考冰豆，防重复）----
    {
        match: e => e.hp <= 0 && e.cardId === 'small_ice_man' && !e._iceDeathDone,
        handler: e => {
            e._iceDeathDone = true;
            for (let en of game.entities) {
                if (en.team === e.team || en.hp <= 0 || en._headHidden) continue;
                if (Math.hypot(e.x - en.x, e.y - en.y) <= 45) {
                    const bd = calcActualDmg(18, e, en); // 小冰人死亡冰爆：45px范围18伤害+减速80%持续1.5秒（参考冰豆）
                    en.hp -= bd;
                    spawnDmgNum(en.x, en.y - 20, bd);
                    en.slowFactor = 0.2;   // 减速80%
                    en.slowTimer = 1.5;    // 持续1.5秒
                }
            }
            // 范围提示：淡红色小环（同冰豆，静态真实范围）
            game.deployEffects.push({ x: e.x, y: e.y, radius: 45, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
        },
    },
    // ---- 火豆：死亡自爆（被攻击打死也触发爆炸+灼烧，已自爆的跳过防重复）----
    {
        match: e => e.hp <= 0 && e._fireBean && !e._selfDestructed,
        handler: e => {
            for (let en of game.entities) {
                if (en.team === e.team || en.hp <= 0 || en._headHidden) continue;
                if (Math.hypot(e.x - en.x, e.y - en.y) <= 35) {
                    const bd2 = calcActualDmg(10, e, en);
                    en.hp -= bd2;
                    spawnDmgNum(en.x, en.y - 20, bd2);
                    en._burnDamage = 20;
                    en._burnTimer = 3.0;
                }
            }
            game.spellEffects.push({ x: e.x, y: e.y, char: '💥', size: 24, timer: 0.3, maxTimer: 0.3 });
            game.spellEffects.push({ x: e.x, y: e.y, char: '🔥', size: 35, timer: 0.5, maxTimer: 0.5 });
            // 范围提示：淡红色小环（同群攻，静态真实范围）
            game.deployEffects.push({ x: e.x, y: e.y, radius: 35, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
        },
    },
    // ---- 冥王：收集死亡灵魂升级（场上所有冥王独立计数）----
    {
        match: e => e.hp <= 0 && !e._soulCounted,
        handler: e => {
            const hadesList = game.entities.filter(h => h.cardId === 'hades' && h.hp > 0);
            for (let h of hadesList) {
                if (e.id === h.id) continue; // 冥王不给自己计数
                h._souls++;
                const newLevel = Math.min(Math.floor(h._souls / h._soulsPerLevel) + 1, h._maxLevel);
                if (newLevel > h._level) {
                    h._level = newLevel;
                    const mult = h._level; // level 1=1x, level 10=10x
                    if (h.isCopy) {
                        // 🔷 复制体冥王：血量锁死 1（升级只涨攻击，避免"新maxHp-已损失血量"把1血复制体回满成大量生命）
                        h.maxHp = 1;
                        h.hp = 1;
                    } else {
                        const hpLost = h.maxHp - h.hp; // 保存已损失的血量
                        h.maxHp = Math.floor(h._baseHp * mult);
                        h.hp = h.maxHp - hpLost; // 新上限减去已损失血量，不补之前损失
                    }
                    h.atk = Math.floor(h._baseAtk * mult);
                    game.spellEffects.push({ x: h.x, y: h.y, char: '💀', size: 40, timer: 0.6, maxTimer: 0.6 });
                }
            }
            e._soulCounted = true;
        },
    },
];

/** 执行死亡结算（必须在死亡清理之前调用） */
function resolveDeaths() {
    for (const e of game.entities) {
        if (e.hp > 0) continue;
        for (const r of DEATH_RESOLVERS) {
            if (r.match(e)) r.handler(e);
        }
    }
}

/** 核心更新函数：每帧调用一次 */
function update(deltaSec) {
    if (game.gameOver) return;

    // ---- 逻辑帧计数 + 渲染插值基准快照（Fixed Timestep：本帧开头记录上一逻辑帧位置）----
    game.tick++;
    // ---- 联机模式：执行已到期的同步指令（Lockstep 延迟缓冲，指令对齐后双方一致推进）----
    executeDueNetCommands();
    for (const e of game.entities) {
        if (e.prevX === undefined) { e.prevX = e.x; e.prevY = e.y; } // 防御兜底
        e.prevX = e.x;
        e.prevY = e.y;
    }

    // ---- 圣水回复（各边独立，丢堡方加速帮扶） ----
    const playerRate = game.baseElixirRate * game.elixirMultiplier.player;
    const aiRate     = game.baseElixirRate * game.elixirMultiplier.ai;
    game.elixir.player = Math.min(game.maxElixir, game.elixir.player + playerRate * deltaSec);
    game.elixir.ai     = Math.min(game.maxElixir, game.elixir.ai + aiRate * deltaSec);
    game.time += deltaSec;

    // ---- AI 决策计时（经典 vs API vs 双人本地）----
    if (game.gameMode !== 'local_multi' && game.gameMode !== 'online') {
        game.aiDecisionTimer += deltaSec;
        if (game.gameMode === 'api') {
            // LLM 模式：由 apiAI.js 自行重置计时器（决策完成后再重置）
            if (game.aiDecisionTimer >= 2.5 && !game.aiThinking) {
                llmAiMakeDecision();
            }
        } else {
            // 经典模式：2秒间隔，同步调用
            if (game.aiDecisionTimer >= 2.0) {
                game.aiDecisionTimer = 0;
                aiMakeDecision();
            }
        }
    }

    // ---- 卡牌冷却计时 ----
    for (let teamName of ['player', 'ai']) {
        const cooldowns = game.cardCooldowns[teamName];
        for (let cid in cooldowns) {
            if (cooldowns[cid] > 0) {
                cooldowns[cid] = Math.max(0, cooldowns[cid] - deltaSec);
            }
        }
    }

    // ---- 🧭 烟引 pending 倒计时（20s 内放烟；超时 buff 消失 → 无冷却直接变回烟引卡 → 清槽）----
    for (const teamName of ['player', 'ai']) {
        for (const isMirror of [false, true]) {
            const pend = getSmokePending(teamName, isMirror);
            if (!pend) continue;
            pend.timer -= deltaSec;
            if (pend.timer <= 0) {
                // 超时：只清除对应来源的 🧭 闪烁 buff，不能影响另一张烟引
                for (const e of game.entities) {
                    if (e.team !== teamName) continue;
                    if (isMirror) e._smokePendingBuffMirror = false;
                    else e._smokePendingBuff = false;
                }
                // ★ 超时无冷却：对应卡牌直接恢复可用，不影响另一张烟引
                const bucket = isMirror ? game.mirrorSmokePending : game.smokePending;
                bucket[teamName] = null;
                const selKey = teamName === 'player' ? 'selectedCardId' : 'selectedCardId2';
                const selectedId = isMirror ? 'mirror' : 'smoke_guide';
                if (game.uiState[selKey] === selectedId) {
                    game.uiState[selKey] = null;
                    const panelSel = teamName === 'player' ? '#cardPanel .card-btn' : '#topCardPanel .card-btn';
                    document.querySelectorAll(panelSel).forEach(b => b.classList.remove('selected'));
                }
            }
        }
    }

    // ---- 🕊️ 精英主动技能：死亡冷却计时（精英死亡后才开始，deploy 模式下递减）+ 技能冷却计时（释放后按卡牌 activeSkill.cooldown 递减）----
    for (let teamName of ['player', 'ai']) {
        const es = game.eliteSkills[teamName];
        if (!es) continue;
        for (let cid in es) {
            const st = es[cid];
            if (st.mode === 'deploy' && st.cdLeft > 0) st.cdLeft = Math.max(0, st.cdLeft - deltaSec);
            if (st.skillCdLeft > 0) st.skillCdLeft = Math.max(0, st.skillCdLeft - deltaSec); // ⏳ 精英技能冷却
        }
    }

    // ---- 部署延迟倒计时 ----
    for (let i = game.deploying.length - 1; i >= 0; i--) {
        const item = game.deploying[i];
        item.timer -= deltaSec;
        if (item.timer <= 0) {
            finishDeployItem(item);
            game.deploying.splice(i, 1);
        }
    }

    // ---- 🧭 烟引·引导处理（倒计时环 → 冒烟10秒 → 引导友军前进 → 到达/超时消散）----
    // 注：引导移动=仅改变寻路位置——实体遍历的 _sgActive 分支只记录 _guideX/_guideY 覆盖点，
    //     实际移动由 moveToward / 巡逻移动（patrolOrbit/守卫绕圈）统一拦截为朝烟点（其余行为特性不变）
    for (let i = game.smokeGuides.length - 1; i >= 0; i--) {
        const sg = game.smokeGuides[i];
        const unit = sg.unitId == null ? null : game.entities.find(e => e.id === sg.unitId && e.hp > 0 && e.team === sg.team);
        // 被引导单位死亡/消失 → 烟雾立即消散（标记随死亡实体清理，无需处理）
        // 纯特效引导（unitId=null，空放时的烟点特效）不受单位状态影响，只按自身计时
        if (!unit && sg.unitId != null) {
            game.smokeGuides.splice(i, 1);
            continue;
        }
        if (sg.phase === 'countdown') {
            // 计时特效阶段：不冒烟、不引导，结束后进入 active
            sg.countdown -= deltaSec;
            if (sg.countdown <= 0) {
                sg.phase = 'active';
                sg.timer = CARDS.smoke_guide.smokeDuration || 17;
                sg.maxTimer = sg.timer;
                if (unit) unit._smokeGuide = true;   // 🧭 buff 标记（状态图标显示；引导结束/消散时清除）
            }
            continue;
        }
        // active 阶段：烟雾计时 + 到达/超时检测（移动由 moveToward/巡逻移动拦截为朝烟点）
        sg.timer -= deltaSec;
        const arrived = unit ? Math.hypot(unit.x - sg.tx, unit.y - sg.ty) <= 10 : false;
        if (arrived || sg.timer <= 0) {
            // 若无其他引导仍指向该单位，清除 🧭 buff 标记
            if (unit && !game.smokeGuides.some(s => s !== sg && s.unitId === sg.unitId && s.team === sg.team)) {
                unit._smokeGuide = false;
            }
            game.smokeGuides.splice(i, 1);
        }
    }

    // ---- ⚡ 极速法术·加速区域处理 ----
    for (let i = game.speedZones.length - 1; i >= 0; i--) {
        const zone = game.speedZones[i];
        zone.timer -= deltaSec;
        if (zone.timer <= 0) {
            game.speedZones.splice(i, 1);
            continue;
        }
        // 对范围内的友方实体施加加速buff
        for (let e of game.entities) {
            if (e.hp <= 0 || e.team !== zone.team) continue;
            if (dist(e, zone) <= zone.radius) {
                e._speedBoosted = true;
                e._speedBoostTimer = zone.boostDuration;
            }
        }
    }

    // ---- 😡 狂暴法术·狂暴区域处理 ----
    for (let i = game.rageZones.length - 1; i >= 0; i--) {
        const zone = game.rageZones[i];
        zone.timer -= deltaSec;
        if (zone.timer <= 0) {
            game.rageZones.splice(i, 1);
            continue;
        }
        // 每0.5秒脉冲一次：对范围内友方实体施加持续1.5秒的狂暴buff
        zone.pulseTimer -= deltaSec;
        if (zone.pulseTimer <= 0) {
            zone.pulseTimer = zone.rageTick || 0.5;
            for (let e of game.entities) {
                if (e.hp <= 0 || e.team !== zone.team) continue;
                if (dist(e, zone) <= zone.radius) {
                    e._rageTimer = Math.max(e._rageTimer || 0, zone.boostDuration);
                }
            }
        }
    }

    // ---- ❄️ 冰冻法术·冰封区域计时（纯展示，4秒后消失）----
    for (let i = game.freezeZones.length - 1; i >= 0; i--) {
        const zone = game.freezeZones[i];
        zone.timer -= deltaSec;
        if (zone.timer <= 0) {
            game.freezeZones.splice(i, 1);
        }
    }

    // ---- 🌪️ 飓风法术·飓风领域（持续1.5秒：每0.5秒一跳8伤害并刷新圈内敌人拉拢标记，持续向中心牵引）----
    for (let i = game.hurricaneZones.length - 1; i >= 0; i--) {
        const zone = game.hurricaneZones[i];
        zone.timer -= deltaSec;
        if (zone.timer <= 0) {
            game.hurricaneZones.splice(i, 1);
            continue;
        }
        // 伤害/拉拢 tick：每0.5秒一次
        zone.tickTimer -= deltaSec;
        if (zone.tickTimer <= 0) {
            zone.tickTimer = zone.tickInterval;
            zone.pullAndDamage();
        }
    }

    // ---- 🧪 哥布林魔咒·诅咒领域（持续6秒，每秒1次对圈内所有敌人造成10点伤害；绿泡低频率冒出上浮）----
    for (let i = game.curseZones.length - 1; i >= 0; i--) {
        const zone = game.curseZones[i];
        zone.timer -= deltaSec;
        if (zone.timer <= 0) {
            game.curseZones.splice(i, 1);
            continue;
        }
        // 伤害 tick：一秒一次
        zone.tickTimer -= deltaSec;
        if (zone.tickTimer <= 0) {
            zone.tickTimer = 1.0;
            for (let e of game.entities) {
                if (e.hp <= 0 || e.team === zone.team || e._headHidden) continue;
                if (dist(e, zone) <= zone.radius) {
                    const dmg = calcActualDmg(e.fortification ? zone.dps * (zone.towerDmgMul || 0.5) : zone.dps, null, e); // 法术伤害统一收口（框架第13条），无攻击者狂暴；主塔/堡垒伤害减半
                    e.hp -= dmg;
                    spawnDmgNum(e.x, e.y - 20, dmg);
                }
            }
        }
        // 🐌 领域减速：圈内敌军持续减速20%（走出领域后1秒内恢复；取更强减速，不覆盖冰豆80%这类更强效果）
        for (let e of game.entities) {
            if (e.hp <= 0 || e.team === zone.team || e._headHidden) continue;
            if (dist(e, zone) <= zone.radius) {
                e.slowFactor = Math.min(e.slowFactor || 1.0, 0.8);
                e.slowTimer = Math.max(e.slowTimer || 0, 1.0);
            }
        }
        // 低频率冒出小绿泡（每1.2~2秒一个，缓慢上浮，寿命约1.5秒）
        zone.bubbleTimer -= deltaSec;
        if (zone.bubbleTimer <= 0) {
            zone.bubbleTimer = 1.2 + rand() * 0.8;
            zone.bubbles.push({
                x: zone.x + (rand() - 0.5) * zone.radius * 1.5,
                y: zone.y + (rand() - 0.5) * zone.radius * 1.5,
                timer: 1.5, maxTimer: 1.5,
                vy: -(10 + rand() * 15), // 缓慢上浮
            });
        }
        for (let b = zone.bubbles.length - 1; b >= 0; b--) {
            const bubble = zone.bubbles[b];
            bubble.timer -= deltaSec;
            bubble.y += bubble.vy * deltaSec;
            if (bubble.timer <= 0) {
                zone.bubbles.splice(b, 1);
            }
        }
    }

    // ---- 遍历所有实体 ----
    for (let e of game.entities) {
        if (e.hp <= 0) continue;

        // ---- 🔥🐲 光束类单位（地狱塔/地狱飞龙）：打断状态统一断开光束锁定（机制级处理）----
        // 任何打断攻击的方式（眩晕💫/冰冻🧊/后续新增…）都强制解除锁定并清零蓄热：
        // 必须放在冰冻 continue 之前——冰冻会跳过全部行动逻辑，若在 continue 之后处理则 _beamTargetId 残留 → 渲染仍画光束（表现为"被打断却没中断"）
        if (e._beamTargetId && (e._stunTimer > 0 || e.freezeTimer > 0)) {
            e._beamTargetId = null;
            e._beamTimer = 0;
        }

        // --- ❄️ 冰冻状态：暂停一切行动（不能移动/攻击/蓄力/召唤/生产等，如同按下暂停键）---
        if (e.freezeTimer > 0) {
            e.freezeTimer -= deltaSec;
            if (e.freezeTimer <= 0) e.freezeTimer = 0;
            continue;   // 冻结期间跳过所有行动逻辑（仍可被攻击，伤害由攻击方结算）
        }

        // --- 🌀 飓风拉拢：独立于移动逻辑，对所有单位统一生效（含暂时不移动/待命/眩晕单位）---
        if (e._pullTimer > 0) {
            e._pullTimer -= deltaSec;
            if (e._pullTimer > 0) {
                const dx = e._pullToX - e.x, dy = e._pullToY - e.y;
                const len = Math.hypot(dx, dy);
                if (len >= 2) {
                    const step = 60 * deltaSec;
                    e.x += (dx / len) * step;
                    e.y += (dy / len) * step;
                    e.x = Math.min(W - 25, Math.max(25, e.x));
                    e.y = Math.min(H - 25, Math.max(25, e.y));
                }
            } else {
                e._pullTimer = 0;
                delete e._pullToX;
                delete e._pullToY;
            }
        }

        // --- 🧭 烟引引导中：仅暂时改变寻路位置（移动目标=烟点）---
        //    攻击/索敌/技能/巡逻等其他行为特性一律不变，照常执行下方通用逻辑；
        //    移动目标统一在 moveToward / 巡逻移动（patrolOrbit/守卫绕圈）中拦截为烟点
        const _sgActive = game.smokeGuides.find(s => s.phase === 'active' && s.unitId === e.id && s.team === e.team);
        if (_sgActive) {
            e._guideX = _sgActive.tx;
            e._guideY = _sgActive.ty;
        } else {
            e._guideX = undefined;
            e._guideY = undefined;
        }

        // --- ⚡ 极速法术buff计时衰减 ---
        if (e._speedBoostTimer > 0) {
            e._speedBoostTimer -= deltaSec;
            if (e._speedBoostTimer <= 0) {
                e._speedBoosted = false;
                e._speedBoostTimer = 0;
            }
        }

        // --- 😡 狂暴法术buff计时衰减 ---
        if (e._rageTimer > 0) {
            e._rageTimer -= deltaSec;
            if (e._rageTimer <= 0) e._rageTimer = 0;
        }

        // --- 🛡️ 免伤盾计时衰减 ---
        if (e._shieldTimer > 0) {
            e._shieldTimer -= deltaSec;
            if (e._shieldTimer <= 0) {
                e._shieldTimer = 0;
                e._damageReduction = 0;
            } else {
                e._damageReduction = 0.3;
            }
        }

        // --- ❤️‍🩹 常驻自动回复（蛋 + 龙均可享受）---
        if (e._hasRegen && e.hp > 0 && e.hp < e.maxHp) {
            const healRate = CARDS[e.cardId]?.healRate || 0;
            e.hp = Math.min(e.maxHp, e.hp + healRate * deltaSec * rageMult(e));
        }

        // --- 🐛 巫师标记计时衰减 ---
        if (e._wormMarkTimer > 0) {
            e._wormMarkTimer -= deltaSec;
            if (e._wormMarkTimer <= 0) e._wormMarkTimer = 0;
        }

        // --- 🔥 灼烧伤害计时 ---
        if (e._burnTimer > 0) {
            e._burnTimer -= deltaSec;
            e._burnAccumulator = (e._burnAccumulator || 0) + e._burnDamage * deltaSec;
            if (e._burnAccumulator >= 1) {
                const dmgTick = Math.floor(e._burnAccumulator);
                e.hp -= calcActualDmg(dmgTick, null, e);
                e._burnAccumulator -= dmgTick;
            }
            if (e._burnTimer <= 0) {
                e._burnTimer = 0;
                e._burnDamage = 0;
                e._burnAccumulator = 0;
            }
        }

        // --- 🤢 中毒伤害：每秒10点，持续4秒；重复施加只刷新时间，不叠加伤害 ---
        if (e._poisonTimer > 0) {
            e._poisonTimer -= deltaSec;
            e._poisonAccumulator = (e._poisonAccumulator || 0) + 10 * deltaSec;
            if (e._poisonAccumulator >= 1) {
                const poisonTick = Math.floor(e._poisonAccumulator);
                e.hp -= calcActualDmg(poisonTick, null, e);
                e._poisonAccumulator -= poisonTick;
            }
            if (e._poisonTimer <= 0) {
                e._poisonTimer = 0;
                e._poisonAccumulator = 0;
            }
        }

        // --- 兵营生产（spawnUnit 驱动 + tickSpawner 统一循环；建筑产兵不继承复制特性）---
        if (e.type === 'barrack') {
            tickSpawner(e, deltaSec, e, { inheritCopy: false });
        }

        // --- 圣水生成器 ---
        if (e.type === 'collector') {
            e.generateTimer += deltaSec;
            while (e.generateTimer >= e.generateInterval) {
                e.generateTimer -= e.generateInterval;
                if (e.team === 'player')
                    game.elixir.player = Math.min(game.maxElixir, game.elixir.player + 1);
                else
                    game.elixir.ai = Math.min(game.maxElixir, game.elixir.ai + 1);
                // 💧 生成成功特效：瓶口冒一滴水珠，向上飘并慢慢变淡（复用飘字通道）
                game.dmgNumbers.push({
                    x: e.x, y: e.y - 26,
                    amount: '💧',
                    color: '#9b59b6',
                    timer: 1.0, maxTimer: 1.0,
                    _frame: game.time,
                });
            }
        }

        // --- 主塔：跳过，不攻击 ---
        if (e.type === 'main_tower') {
            // ★ 主塔护盾破碎 → 召唤主塔守卫（一次性，参考熔岩猎犬死亡召唤幼崽：主塔周围45~70px环形随机生成）
            if (e._shieldJustBroke) {
                e._shieldJustBroke = false;
                const ang = rand() * Math.PI * 2;
                const r = 45 + rand() * 25;
                const guard = createSummon(BASE_UNITS.main_tower_guard, 'main_tower_guard',
                    e.x + Math.cos(ang) * r, e.y + Math.sin(ang) * r, e.team,
                    { extra: { _patrolX: e.x, _patrolY: e.y } });
                game.entities.push(guard);
                game.spellEffects.push({ x: e.x, y: e.y, char: '🛡️', size: 36, timer: 0.5, maxTimer: 0.5 });
            }
            continue;
        }

        // --- ⛺ 临时营地：收编附近友军（名额2，60px内友军施加🚩buff并标记巡逻中心） ---
        if (e.cardId === 'camp') {
            const campCap = CARDS.camp.campCapacity || 2;
            const campR = CARDS.camp.campRadius || 60;
            const members = game.entities.filter(en => en._campFlag && en._campId === e.id && en.hp > 0);
            if (members.length < campCap) {
                for (const en of game.entities) {
                    if (members.length >= campCap) break;
                    if (en.team !== e.team || en.hp <= 0) continue;
                    if ((en.type !== 'troop' && en.type !== 'healer') || en._campFlag || en.isCopy) continue; // 已被🚩标记或复制体不捕获（复制体不占名额、不施加🚩）；治疗兵也可被收编
                    if (en.cardId === 'main_tower_guard') continue; // 主塔守卫有自己的巡逻逻辑，不加入营地
                    if (CARDS[en.cardId] && CARDS[en.cardId].category === 'elite') continue; // 🗡️ 精英单位（如剑仙）不可被营地收编
                    if (Math.hypot(en.x - e.x, en.y - e.y) <= campR) {
                        en._campFlag = true;                 // 施加🚩buff（巡逻状态标记）
                        en._campId = e.id;                   // 归属营地
                        en._patrolX = e.x; en._patrolY = e.y; // 巡逻中心=营地位置
                        // 巡逻轨道按“空缺优先”分配：优先内圈40，内圈被占才用外圈60
                        // （内圈成员死亡后新捕获兵种会补内圈空位，不再固定按加入顺序取外圈）
                        const patrolRList = CARDS.camp.campPatrolR || [];
                        const occupiedRs = members.map(m => m._patrolR);
                        let chosenR = (patrolRList[0] !== undefined) ? patrolRList[0] : (CARDS.camp.campRadius || 60);
                        for (const r of patrolRList) {
                            if (!occupiedRs.includes(r)) { chosenR = r; break; }
                        }
                        en._patrolR = chosenR;
                        if (en._patrolDir === undefined) en._patrolDir = rand() < 0.5 ? 1 : -1;
                        members.push(en);
                    }
                }
            }
        }

        // --- 堡垒 / 防御塔攻击 ---
        if (e.type === 'bastion' || e.type === 'tower') {
            // ★ 每帧更新 targetId（用于炮管指向渲染）
            let currentTarget = null;
            if (e.type === 'bastion') {
                const enemies = game.entities.filter(
                    e2 => e2.team !== e.team && e2.hp > 0 && !e2._stealthed && dist(e, e2) <= e.range
                );
                currentTarget = enemies.sort((a, b) => dist(e, a) - dist(e, b))[0] || null;
            } else {
                currentTarget = findTargetInRangeForTower(e, e.range);
            }
            e.targetId = currentTarget ? currentTarget.id : null;

            // 哥布林小屋：每秒自流血14；125px内有敌人时每2.2秒出兵1只哥布林投矛手（无攻击力）
            if (e.cardId === 'goblin_hut') {
                e.hp -= (CARDS.goblin_hut.burnPerSec || 14) * deltaSec; // 自流血
                const hutRange = CARDS.goblin_hut.spawnRange || 125;
                const hasEnemy = game.entities.some(en => en.team !== e.team && en.hp > 0 && !en._stealthed && dist(e, en) <= hutRange);
                if (hasEnemy) {
                    e._spawnTimer = (e._spawnTimer || 0) + deltaSec;
                    const hutInterval = CARDS.goblin_hut.spawnInterval || 2.2;
                    while (e._spawnTimer >= hutInterval) {
                        e._spawnTimer -= hutInterval;
                        game.entities.push(createGoblinThrower(e.x, e.y, e.team));
                    }
                }
                continue; // 无攻击力，跳过后续攻击逻辑
            }

            // 哥布林钻机：每秒自流血50；每3秒无条件钻出1只哥布林（近战小刀，无攻击力）
            if (e.cardId === 'goblin_drill') {
                e.hp -= (CARDS.goblin_drill.burnPerSec || 50) * deltaSec; // 自流血
                e._spawnTimer = (e._spawnTimer || 0) + deltaSec;
                const drillInterval = CARDS.goblin_drill.spawnInterval || 3;
                while (e._spawnTimer >= drillInterval) {
                    e._spawnTimer -= drillInterval;
                    game.entities.push(createGoblinMelee(e.x, e.y, e.team));
                }
                continue; // 无攻击力，跳过后续攻击逻辑
            }

            // 电磁塔：露头机制（射程内有敌人才露头，2.5秒未攻击缩回）
            if (e.cardId === 'tesla_tower') {
                if (currentTarget) {
                    e._headTimer = 2.5;
                } else if ((e._headTimer || 0) > 0) {
                    e._headTimer -= deltaSec;
                    if (e._headTimer < 0) e._headTimer = 0;
                }
                e._stealthed = !(e._headTimer > 0);  // 未露头=隐身：不被锁定（通用隐身机制）
                e._headHidden = !(e._headTimer > 0); // 电磁塔独有：未露头不受伤（无敌）
            }

            // ===== 🎯 地狱塔：光束灼烧逻辑（死锁目标不切换）=====
            if (e.cardId === 'inferno_tower') {
                // 🎯 特殊索敌：一旦锁定绝不换目标，除非死亡/脱范围/隐身
                if (e._beamTargetId) {
                    const lockedTarget = game.entities.find(
                        en => en.id === e._beamTargetId && en.hp > 0 &&
                              !en._stealthed && dist(e, en) <= e.range
                    );
                    if (lockedTarget) {
                        currentTarget = lockedTarget;
                    } else {
                        // 锁定目标失效 → 清空，进入切换冷却
                        e._beamTargetId = null;
                        e._beamTimer = 0;
                        e._beamSwitchCooldown = 1.0;
                    }
                }

                // 无锁定状态 → 冷却中不寻敌，冷却结束才允许锁新目标
                if (!e._beamTargetId) {
                    if (e._beamSwitchCooldown > 0) {
                        e._beamSwitchCooldown -= deltaSec;
                    }
                    if (e._beamSwitchCooldown <= 0 && currentTarget) {
                        e._beamTargetId = currentTarget.id;
                    } else if (e._beamSwitchCooldown > 0) {
                        // 冷却中 → 不攻击
                        currentTarget = null;
                    }
                }

                // 同步 targetId（渲染用）
                e.targetId = currentTarget ? currentTarget.id : null;

                // 💫 眩晕：攻击直接断开（解除锁定，光束消失，眩晕结束后重新索敌锁定）
                // ★ 塔分支无眩晕continue拦截，块内"无锁定→冷却结束重新锁定"可能复活光束，故此处必须二次断束
                if (e._stunTimer > 0) {
                    e._beamTargetId = null;
                    e._beamTimer = 0;
                }

                // 光束持续增温（锁定中才计时；被眩晕💫打断，火力归零）
                if (currentTarget && e._beamTargetId) {
                    e._beamTimer = e._stunTimer > 0 ? 0 : (e._beamTimer || 0) + deltaSec;
                } else {
                    e._beamTimer = 0;
                }

                // 攻击伤害：第一秒内基础6；之后按每秒+4、+7、+10、+13、+16、+19分段递增，最高75——眩晕中不攻击
                if (e.atkCooldown > 0) e.atkCooldown -= deltaSec * rageMult(e);
                if ((e._stunTimer || 0) <= 0 && e.atkCooldown <= 0 && currentTarget && e._beamTargetId) {
                    // 已完成的增伤梯度：第2~7秒分别增加4/7/10/13/16/19，总增伤69；第7秒后封顶
                    const elapsedSeconds = Math.floor(e._beamTimer || 0);
                    const rampSteps = [0, ...(CARDS[e.cardId].infernoRamp || [4, 7, 10, 13, 16, 19])];
                    const rampBonus = rampSteps.slice(0, Math.min(elapsedSeconds, rampSteps.length - 1) + 1).reduce((sum, value) => sum + value, 0);
                    const finalAtk = e.atk + rampBonus;
                    currentTarget.hp -= calcActualDmg(finalAtk, e, currentTarget);
                    e.atkCooldown = e.atkSpeed;
                }
                // 地狱塔自燃：每秒扣25HP（地狱飞龙不自燃）
                e.hp -= 25 * deltaSec;
            } else {
                // ===== 其他塔：常规攻击（眩晕💫中暂停）=====
                // 电磁塔自燃：每秒扣10HP（地狱塔才扣25）
                if (e.cardId === 'tesla_tower') e.hp -= 10 * deltaSec; // 电磁塔自燃：每秒扣10HP
                // 十字弩自流血：每秒扣24HP（寿命约50秒）
                if (e.cardId === 'crossbow') e.hp -= 24 * deltaSec;
                // 🛡️ 炮台（炮车变形）自流血：每秒扣12HP（第二条命代价）
                if (e.cardId === 'cannon_cart' && e._turretMode) e.hp -= 12 * deltaSec;
                if ((e._stunTimer || 0) <= 0 && e.atkCooldown > 0) e.atkCooldown -= deltaSec * rageMult(e);
                // 攻击：冷却结束且有目标才开火
                if ((e._stunTimer || 0) <= 0 && e.atkCooldown <= 0 && currentTarget) {
                    const target = currentTarget;
                    // 有弹道的塔（堡垒/法师塔/炮塔/炮台/迫击炮/十字弩）：改为弹道命中才结算伤害
                    const towerShot = e.type === 'bastion' || e.cardId === 'mage_tower' || e.cardId === 'cannon_tower' || e.cardId === 'cannon_cart' || e.cardId === 'mortar' || e.cardId === 'crossbow';
                    if (!towerShot) {
                        const td = calcActualDmg(e.atk, e, target);
                        target.hp -= td;
                        spawnDmgNum(target.x, target.y - 20, td);
                    }
                    e.atkCooldown = e.atkSpeed;
                    // （法师塔溅射改为弹道命中时结算，见弹道更新逻辑）
                    // 堡垒弹道（命中才结算伤害）
                    if (e.type === 'bastion') {
                        spawnTowerProjectile(e, target, {
                            char: '●', size: 10, speed: 400,
                            color: e.team === 'player' ? '#64b5f6' : '#ef9a9a',
                        });
                    }
                    // 法师塔弹道（命中才结算伤害，含溅射）
                    if (e.cardId === 'mage_tower') {
                        spawnTowerProjectile(e, target, {
                            char: '✦', size: 16, speed: 380,
                            color: e.team === 'player' ? '#ce93d8' : '#ef9a9a',
                            aoeRadius: e.splash,
                            hitsAir: true, // 法师塔可对空，溅射波及空中
                        });
                    }
                    // 炮塔/炮台（炮车变形）弹道（黑色实心炮弹，命中才结算伤害）
                    if (e.cardId === 'cannon_tower' || e.cardId === 'cannon_cart') {
                        spawnTowerProjectile(e, target, {
                            isCannonball: true, size: 8, speed: 420, timer: 0.3,
                        });
                    }
                    // 十字弩弹道（► 弩箭，追踪制命中才扣血，只对地）
                    if (e.cardId === 'crossbow') {
                        spawnTowerProjectile(e, target, {
                            char: '►', size: 11, speed: 520, timer: 0.3,
                            color: e.team === 'player' ? '#d4a373' : '#ef9a9a',
                        });
                    }
                    // 迫击炮弹道（🪨 抛物线：发射瞬间锁定落点位置，不追踪；落地范围伤害+轻微击退）
                    if (e.cardId === 'mortar') {
                        // 炮口起点：炮管固定朝上（最多偏转±20°），取真实炮口位置
                        const maxTilt = Math.PI / 9; // 20°
                        let mAngle = Math.atan2(target.y - e.y, target.x - e.x);
                        let mDiff = mAngle + Math.PI / 2; // 相对朝上的偏转角
                        while (mDiff > Math.PI) mDiff -= Math.PI * 2;
                        while (mDiff < -Math.PI) mDiff += Math.PI * 2;
                        mAngle = -Math.PI / 2 + Math.max(-maxTilt, Math.min(maxTilt, mDiff));
                        const msx = e.x + 18 * Math.cos(mAngle);
                        const msy = e.y + 18 * Math.sin(mAngle);
                        const mtx = target.x, mty = target.y; // 锁定落点（发射时目标所在位置，不再追踪）
                        const mDist = Math.max(1, Math.hypot(mtx - msx, mty - msy));
                        spawnTowerProjectile(e, target, {
                            x: msx, y: msy, sx: msx, sy: msy,
                            tx: mtx, ty: mty,
                            isMortar: true, char: '🪨', size: 16,
                            speed: 170, timer: 1.5, maxTimer: 1.5, // 飞得更慢
                            aoeRadius: e.splash || AOE_RANGE_MED, // 范围伤害中档35
                            knockback: 18,             // 轻微击退
                            dist: 0, maxDist: mDist,
                            arcHeight: Math.min(200, Math.max(90, mDist * 0.7)), // 抛得更高
                        });
                    }
                    // 电磁塔：闪电单点特效（参考雷电法师折线，不连锁）+ 眩晕0.2秒
                    if (e.cardId === 'tesla_tower') {
                        target._stunTimer = Math.max(target._stunTimer || 0, 0.2);
                        game.lightningChains.push({
                            points: [
                                { x: e.x, y: e.y - 26 },   // 塔顶小圆球发射
                                { x: target.x, y: target.y }
                            ],
                            timer: 0.25,
                            maxTimer: 0.25
                        });
                    }
                }  // ← 关闭 if (e.atkCooldown <= 0 && currentTarget)
            }  // ← 关闭 else 块

            // ---- 盔甲铺：蓄力6s蓄满 → 范围内(85px)未持盾友军兵种加100盾（每次1人，加完重新蓄力）----
            if (e.cardId === 'armor_smith') {
                if (e._chargeTimer === undefined) e._chargeTimer = 0; // 防御兜底
                e._chargeTimer += deltaSec;
                if (e._chargeTimer > e._chargeMax) e._chargeTimer = e._chargeMax;
                // 蓄满：每帧尝试给盾，成功才清零（没人可给就蓄着，类似电磁炮等待目标）
                if (e._chargeTimer >= e._chargeMax) {
                    // 选择机制：范围内血量最低的未持盾友军兵种（含复制体），最需要保护的优先
                    let best = null, bestHp = Infinity;
                    for (const t of game.entities) {
                        if (t.team !== e.team || t.hp <= 0 || t === e) continue;
                        if (t.type !== 'troop' && t.type !== 'healer') continue; // 只给兵种加，堡垒/建筑不给
                        if ((t.shield || 0) > 0) continue;                        // 已持盾不给
                        if (dist(e, t) - getHitRadius(t) > (e.range || 85)) continue;
                        if (t.hp < bestHp) { bestHp = t.hp; best = t; }
                    }
                    if (best) {
                        grantShield(best, e.shieldAmount || 100);
                        e._chargeTimer = 0; // 给完重新蓄力
                        // 特效：加盾闪光 + 绿色 +80 飘字
                        game.spellEffects.push({ x: best.x, y: best.y, char: '🛡️', size: 24, timer: 0.6, maxTimer: 0.6 });
                        spawnDmgNum(best.x, best.y - 14, e.shieldAmount || 100, true);
                    }
                }
            }

        }  // ← 关闭 bastion/tower if

        // --- 女巫/暗夜女巫：周期性召唤（骷髅/蝙蝠），按 spawnUnit 查 SUMMON_CREATORS ---
        if (e.type === 'troop' && (e.cardId === 'night_witch' || e.cardId === 'witch')) {
            tickSpawner(e, deltaSec, CARDS[e.cardId], { inheritCopy: true });
        }

        // --- 减速计时器衰减 ---
        if (e.slowTimer > 0) {
            e.slowTimer -= deltaSec;
            if (e.slowTimer <= 0) {
                e.slowTimer = 0;
                e.slowFactor = 1.0;
            }
        }

        // --- 眩晕计时器衰减 ---
        if (e._stunTimer > 0) {
            e._stunTimer -= deltaSec;
            if (e._stunTimer <= 0) e._stunTimer = 0;
        }

        // --- 浪人反弹冷却衰减（0=就绪可格挡反弹） ---
        if (e._reflectTimer > 0) {
            e._reflectTimer -= deltaSec;
            if (e._reflectTimer <= 0) e._reflectTimer = 0;
        }

        // --- 兵种行为 ---
        if (e.type === 'troop') {
            // 冰豆（不能移动不能攻击）跳过行为逻辑，但检查触碰自爆
            if (e._iceBean) {
                // 冰豆：敌人触碰（25px内）→ 直接自爆，45px范围纯减速80%持续1.5秒，无伤害
                const nearbyEnemy = game.entities.find(en => en.team !== e.team && en.hp > 0 && Math.hypot(e.x - en.x, e.y - en.y) <= 25);
                if (nearbyEnemy) {
                    e._selfDestructed = true;
                    for (let en of game.entities) {
                        if (en.team === e.team || en.hp <= 0 || en._headHidden) continue;
                        if (Math.hypot(e.x - en.x, e.y - en.y) <= 45) {
                            const bd = calcActualDmg(25, e, en); // 冰豆自爆：45px范围25伤害+减速80%持续1.5秒
                            en.hp -= bd;
                            spawnDmgNum(en.x, en.y - 20, bd);
                            en.slowFactor = 0.2;
                            en.slowTimer = 1.5;
                        }
                    }
                    // 范围提示：淡红色小环（同群攻，静态真实范围）
                    game.deployEffects.push({ x: e.x, y: e.y, radius: 45, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
                    e.hp = 0; // 冰豆消失
                }
                continue;   // 冰豆跳过其他兵种行为
            }

            // ---- 🥷 忍者翻滚：快速位移+旋转+变淡；不设无敌，正常受伤 ----
            if (e.cardId === 'ninja' && (e._ninjaRollRemain || 0) > 0) {
                const rollSpeed = 100; // 30px / 0.3s
                const step = Math.min(rollSpeed * deltaSec, e._ninjaRollRemain);
                e.x += (e._ninjaRollVx || 0) * step;
                e.y += (e._ninjaRollVy || 0) * step;
                e._ninjaRollRemain -= step;
                e._ninjaRollAngle = (e._ninjaRollAngle || 0) + (e._ninjaRollSpin || 0) * deltaSec;
                e.x = Math.min(W - 25, Math.max(25, e.x));
                e.y = Math.min(H - 25, Math.max(25, e.y));
                if (e._ninjaRollRemain <= 0) {
                    e._ninjaRollRemain = 0;
                    e._stealthed = false; // 翻滚结束立即现身
                }
                continue;
            }

            // ---- 火豆：跳跃自爆（🚩被收编时索敌范围受巡逻圈约束：只打圈内敌人，圈内无敌→绕营巡逻）----
            if (e._fireBean) {
                // 收编状态：索敌约束在营地索敌圈（200px 以营地圆心）；未收编：全图索敌
                const camp = e._campFlag
                    ? game.entities.find(c => c.id === e._campId && c.hp > 0)
                    : null;
                if (e._campFlag && !camp) {
                    // 营地被摧毁 → 解除🚩，恢复自由行动（全图索敌）
                    e._campFlag = false;
                    e._campId = undefined;
                    e._patrolX = undefined; e._patrolY = undefined; e._patrolDir = undefined;
                    e._patrolR = undefined;
                }
                // 寻找最近的敌方单位（不锁定隐身单位，如隐身幽灵🌫️）
                let nearest = null, minDist = Infinity;
                for (let en of game.entities) {
                    if (en.team === e.team || en.hp <= 0 || en._stealthed) continue;
                    if (camp && Math.hypot(en.x - camp.x, en.y - camp.y) > (CARDS.camp.campDetectR || 200)) continue; // 收编：圈外敌人不理会
                    const d = Math.hypot(e.x - en.x, e.y - en.y);
                    if (d < minDist) { minDist = d; nearest = en; }
                }
                const JUMP_RANGE = 90; // 跳跃触发范围（同暗夜女巫射程）
                if (nearest && minDist <= JUMP_RANGE) {
                    // 🔥 真正的抛物线跳跃：本体离场，生成抛物线弹道（锁定落点不追踪，落地以落点为中心自爆）
                    const sx = e.x, sy = e.y;
                    const tx = nearest.x, ty = nearest.y; // 发射瞬间锁定落点（不追踪）
                    const d0 = Math.max(1, Math.hypot(tx - sx, ty - sy));
                    game.projectiles.push({
                        x: sx, y: sy, sx, sy,
                        char: '🔥', size: 15,
                        speed: 250, timer: 0.9, maxTimer: 0.9, // 滞空明显
                        isFireJump: true, dist: 0, maxDist: d0,
                        tx, ty, // 锁定落点
                        arcHeight: Math.min(160, Math.max(80, d0 * 0.8)), // 抛物线弧高（比迫击炮0.7略抖）
                        damage: 10, team: e.team, ownerId: e.id,
                        aoeRadius: 35, // 自爆范围同火豆
                        burnDamage: 20, burnTimer: 3.0, // 灼烧3秒20/秒
                    });
                    e._selfDestructed = true; // 防死亡自爆重复结算
                    e.hp = 0; // 本体离场（跳跃中由弹道呈现）
                } else if (nearest) {
                    // 未进入跳跃范围，向敌人移动（移速34）
                    moveToward(e, nearest.x, nearest.y, deltaSec);
                } else if (camp) {
                    // 圈内无敌 → 绕营巡逻
                    patrolOrbit(e, deltaSec);
                }
                continue; // 火豆跳过其他兵种行为
            }

            // 🦸 超级骑士：抛物线跳跃飞行中（水平匀速+垂直正弦弧线，先升后降；不攻击不移动，可被攻击）
            if (e.cardId === 'super_knight' && e._leapJumping) {
                e._leapDist = Math.min(e._leapMaxDist, e._leapDist + e._leapSpeed * deltaSec * rageMult(e));
                const lt = e._leapDist / e._leapMaxDist;
                e.x = e._leapSx + (e._leapTx - e._leapSx) * lt;
                e.y = e._leapSy + (e._leapTy - e._leapSy) * lt - e._leapArc * Math.sin(Math.PI * lt);
                if (lt >= 1) {
                    e.x = e._leapTx; e.y = e._leapTy;
                    e._leapJumping = false;
                    // 落地击退效果（原逻辑不变：40px范围伤害+击退15，仅兵种）
                    const spell = CARDS[e.cardId].deploySpell;
                    if (spell) {
                        const radius = spell.radius || 40;
                        const damage = spell.damage || 120;
                        const knockback = 15;
                        for (const e2 of game.entities) {
                            if (e2.team === e.team || e2.hp <= 0 || e2._headHidden) continue;
                            if (e2.flying && !canTargetFlying(e)) continue; // 🕊️ 超骑落地冲击不打空中（如御剑剑仙）
                            const dd = dist(e2, { x: e.x, y: e.y });
                            if (dd <= radius) {
                                const dmgL = calcActualDmg(damage, null, e2); // 超骑落地法术伤害统一收口（无攻击者）
                                e2.hp -= dmgL;
                                spawnDmgNum(e2.x, e2.y - 20, dmgL);
                                // 击退仅兵种生效（参考迫击炮/火球，建筑不被推）：标记剩余位移向量，帧驱动渐进滑动（位移式击退，不瞬移）
                                if (e2.moveSpeed !== undefined && !e2.fortification) {
                                    const angle = Math.atan2(e2.y - e.y, e2.x - e.x);
                                    e2._kbX = Math.cos(angle) * knockback;
                                    e2._kbY = Math.sin(angle) * knockback;
                                }
                            }
                        }
                    }
                    // ★ 落地效果加强（原逻辑不变）：更多更大的下坠虚影 + 大爆点（范围仍限在攻击覆盖40px内）
                    const shadowCount = 8;
                    for (let i = 0; i < shadowCount; i++) {
                        game.spellEffects.push({
                            x: e.x, y: e.y - 200 + i * 28,
                            char: '🦸', size: 16 + i * 5,
                            timer: 0.06 + i * 0.05, maxTimer: 0.45,
                            color: `rgba(255,200,80,${0.2 + i * 0.1})`,
                        });
                    }
                    game.spellEffects.push({ x: e.x, y: e.y, char: '💥', size: 52, timer: 0.35, maxTimer: 0.35 });
                    game.spellEffects.push({ x: e.x, y: e.y, char: '⚡', size: 36, timer: 0.25, maxTimer: 0.25 });
                    // 落地冲击：淡红冲击圈（贴攻击覆盖范围40px）+ 白色冲击波（半径40）
                    game.deployEffects.push({ x: e.x, y: e.y, radius: 40, timer: 0.5, maxTimer: 0.5 }); // 原有金色冲击圈（原样保留）
                    // 范围提示：淡红色小环（通用提示，不覆盖任何原有特效）
                    game.deployEffects.push({ x: e.x, y: e.y, radius: 40, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
                    game.spellEffects.push({ x: e.x, y: e.y, size: 80, timer: 0.4, maxTimer: 0.4, isPulse: true });
                }
                continue; // ⛔ 跳跃飞行中，跳过后续索敌/攻击/移动
            }

            // ---- 巨龙蛋：跳动动画计时 + 满血孵化 ----
            if (e._isEgg) {
                // ❤️‍🩹 回血已由通用 buff 模块处理，此处只做动画和孵化检测
                
                // 跳动计时（纯动画用）
                e._eggPulseTimer = (e._eggPulseTimer || 0) + deltaSec;
                
                // 满血孵化 → 巨龙
                if (e.hp >= e.maxHp) {
                    e.hp = e.maxHp;
                    e._isEgg = false;
                    e._eggPulseTimer = 0;
                    e._hasRegen = true;  // 龙也保持❤️‍🩹自回
                    // 变换为巨龙属性
                    e.atk = DRAGON_STATS.atk;
                    e.atkSpeed = DRAGON_STATS.atkSpeed;
                    e.atkCooldown = 0;
                    e.moveSpeed = DRAGON_STATS.moveSpeed;
                    e.range = DRAGON_STATS.range;
                    e.targetMode = DRAGON_STATS.targetMode;
                    e.flying = true;
                    e.splash = 0;
                    // 孵化特效
                    game.spellEffects.push({ x: e.x, y: e.y, char: '✨', size: 36, timer: 0.8, maxTimer: 0.8 });
                    game.spellEffects.push({ x: e.x, y: e.y, char: '🐉', size: 28, timer: 0.5, maxTimer: 0.5 });
                }
                
                continue;   // 蛋不移动不攻击
            }

            // ---- 幽灵：隐身计时逻辑 ----
            if (e.cardId === 'ghost') {
                if (e._stealthed) {
                    // 隐身中：可以行动（寻敌/攻击），但攻击后会在 attackTroop 中解除隐身
                } else {
                    e._stealthTimer += deltaSec;
                    if (e._stealthTimer >= 3.0) {
                        e._stealthed = true;
                        e._stealthTimer = 0;
                    }
                }
            }

            // ---- 矿工：潜伏阶段为纯土堆特效（entities.js 两段式部署处理），实体生成即破土，无需额外计时 ----

            // ---- 骑士：冲锋倒计时 ----
            if (e.cardId === 'knight' && !e._charging) {
                e._chargeTimer -= deltaSec * rageMult(e);
                if (e._chargeTimer <= 0) {
                    e._charging = true;
                    e._chargeTimer = 0;
                }
            }
            // ---- 骑士：被眩晕💫时退出冲锋 ----
            if (e.cardId === 'knight' && e._stunTimer > 0 && e._charging) {
                e._charging = false;
                e._chargeTimer = 3.5; // 重置计时，眩晕结束后重新倒计时3.5秒再冲锋
            }

            // ---- 免伤法徒：每1秒给范围内友军加🛡️buff（持续1秒）----
            if (e.cardId === 'immunity_disciple') {
                if (e._shieldPulseTimer === undefined) e._shieldPulseTimer = 0;
                e._shieldPulseTimer += deltaSec;
                if (e._shieldPulseTimer >= 1.0) {
                    e._shieldPulseTimer -= 1.0;
                    const range = CARDS.immunity_disciple.range;
                    for (let friend of game.entities) {
                        if (friend.hp <= 0 || friend.team !== e.team) continue;
                        if (Math.hypot(e.x - friend.x, e.y - friend.y) <= range) {
                            friend._shieldTimer = 1.0;
                            friend._damageReduction = 0.3;
                        }
                    }
                }
            }

            // ---- 💚 战斗天使：持续治疗脉冲（登场/攻击触发，1.2秒内每0.3秒一次共4次）----
            if (e.cardId === 'battle_angel' && e._healActive > 0) {
                e._healActive -= deltaSec;
                if (e._healTicks > 0) {
                    if (e._healTickTimer === undefined) e._healTickTimer = 0;
                    e._healTickTimer += deltaSec;
                    const healInterval = CARDS.battle_angel.healInterval || 0.3;
                    if (e._healTickTimer >= healInterval) {
                        e._healTickTimer -= healInterval;
                        e._healTicks -= 1;
                        const healRadius = CARDS.battle_angel.healRadius || 75;
                        for (let a of game.entities) {
                            if (a.team !== e.team || a.hp <= 0 || a.hp >= a.maxHp) continue;
                            if (a.fortification || a.cardId === 'tesla_tower') continue;
                            if (dist(a, e) <= healRadius) {
                                const amt = Math.min(a.maxHp - a.hp, e._healAmount);
                                a.hp += amt;
                                if (amt > 0) spawnDmgNum(a.x, a.y - 20, amt, true);
                            }
                        }
                        if (e._healTicks > 0) game.spellEffects.push({ x: e.x, y: e.y - 15, char: '💚', size: 18, timer: 0.3, maxTimer: 0.3 });
                    }
                }
                if (e._healActive <= 0) { e._healTicks = 0; e._healActive = 0; }
            }

            // ---- 电磁炮：持续蓄能（不受目标限制）----
            if (e.cardId === 'electro_cannon') {
                // 被眩晕💫时打断蓄力
                if (e._stunTimer > 0) {
                    e._chargeTimer = 0;
                } else {
                    // 蓄能
                    e._chargeTimer += deltaSec * rageMult(e);
                    if (e._chargeTimer > e._chargeMax) e._chargeTimer = e._chargeMax;
                }
            }

            // ---- 后坐力缓动（电磁炮开炮 / 烟花炮手命中后，通用）----
            if (e._recoilTimer > 0) {
                e.x += e._recoilVx * deltaSec;
                e.y += e._recoilVy * deltaSec;
                e._recoilTimer -= deltaSec;
                e.x = Math.min(W - 30, Math.max(30, e.x));
                e.y = Math.min(H - 30, Math.max(30, e.y));
            }
            // 💥 狂战士爆发：0.6s 施法蓄力 → 进入爆发（背后浮现暗色虚影+血红眼睛，持续4s；buff 数值后续再调）
            if (e._berserkCast > 0) {
                e._berserkCast -= deltaSec;
                if (e._berserkCast <= 0) e._berserkTimer = 6.0;
            }
            if (e._berserkTimer > 0) e._berserkTimer -= deltaSec;
            // 🌫️ 弓箭女皇隐身：0.5s 施法蓄力 → 隐身（不可被锁定）+ 攻击力提升200%，持续3.6s；隐身结束自动现身
            //    （隐身期间女皇可继续攻击/移动但不现身，与幽灵的出手现身机制不同）
            if (e.cardId === 'bow_queen') {
                if (e._queenStealthCast > 0) {
                    e._queenStealthCast -= deltaSec;
                    if (e._queenStealthCast <= 0) {
                        e._queenStealthCast = 0;
                        e._stealthed = true;
                        e._queenStealthTimer = 3.6;
                    }
                }
                if (e._queenStealthTimer > 0) {
                    e._queenStealthTimer -= deltaSec;
                    if (e._queenStealthTimer <= 0) {
                        e._queenStealthTimer = 0;
                        e._stealthed = false; // 隐身结束现身
                    }
                }
            }
            // 🗡️/🐾 狂战士：挥刀刺击特效计时递减（通用帧循环，0.3s 短促；兽爪血痕改用全局 clawEffects 列表管理）
            if (e._swingTimer > 0) e._swingTimer -= deltaSec;
            // 🪵 木桶护卫：长矛前戳动画计时递减（与剑仙同款0.3秒节奏）
            if (e._spearTimer > 0) e._spearTimer -= deltaSec;
            // 🥋 武僧：强化普攻🫸虚影计时递减（0.3s，与推掌同步淡出）
            if (e._strongPunchTimer > 0) e._strongPunchTimer -= deltaSec;
            // 🏹 弓箭女皇：拉弓动画计时递减（0.35s：蓄力→放箭回弹，通用帧循环）
            if (e._drawBowTimer > 0) {
                const bowPrev = e._drawBowTimer;
                e._drawBowTimer -= deltaSec;
                // 🏹 拉满瞬间放箭：蓄力到顶(t=0.18)那一刻生成追踪箭，实现「拉满再放箭」
                if (e._queenArrowPending && bowPrev > 0.18 && e._drawBowTimer <= 0.18) {
                    const pq = e._queenArrowPending;
                    e._queenArrowPending = null;
                    game.projectiles.push({
                        x: e.x, y: e.y,
                        tx: pq.tx, ty: pq.ty,
                        targetId: pq.targetId,
                        isQueenArrow: true, size: 6, // 特别细：受击判定半径更精准
                        speed: 460, timer: 0.4, maxTimer: 0.4, // 追踪弹：有目标时 timer 不衰减，必中
                        damage: pq.atkVal, // 原始伤害，命中结算统一走 calcActualDmg
                        team: e.team, hitsAir: true, // 可对空
                        ownerId: e.id,
                    });
                }
            }
            // ---- 击退剩余位移帧驱动渐进滑动（超骑部署冲击/滚木共用，位移式击退而不是瞬移；框架第11条：坐标推进只在 update.js）----
            if (e._kbX || e._kbY) {
                const kbSpeed = 300; // 击退滑动速度 px/s（滚木30px约0.1s滑完、超骑15px约0.05s）
                const step = kbSpeed * deltaSec;
                const dx = Math.sign(e._kbX) * Math.min(step, Math.abs(e._kbX));
                const dy = Math.sign(e._kbY) * Math.min(step, Math.abs(e._kbY));
                e.x += dx;
                e.y += dy;
                e._kbX -= dx;
                e._kbY -= dy;
                if (Math.abs(e._kbX) < 0.01) e._kbX = 0;
                if (Math.abs(e._kbY) < 0.01) e._kbY = 0;
                e.x = Math.min(W - 30, Math.max(30, e.x));
                e.y = Math.min(H - 30, Math.max(30, e.y));
            }

            // ---- 巨人：半血🛡️减伤（法徒的盾优先保留）----
            if (e.cardId === 'giant') {
                if (e.hp <= e.maxHp / 2) {
                    e._damageReduction = 0.3;
                } else if (!e._shieldTimer || e._shieldTimer <= 0) {
                    e._damageReduction = 0;
                }
                // 若 _shieldTimer > 0，保留法徒给的0.3，不覆盖
            }
            // ---- 🧨 哥布林爆破手：半血狂暴（参考攻城人：不再攻击、锁定建筑冲过去自爆留💣）----
            if (e.cardId === 'goblin_bomber' && !e.isSiege && e.hp <= e.maxHp / 2) {
                e.isSiege = true;           // 触碰建筑自爆（复用攻城人逻辑）
                e.targetMode = 'buildings'; // 只锁定建筑
                e.range = 10;               // 贴脸才爆（原远程105）
                e.moveSpeed = 40;           // 速度提升 28→40
                e.targetId = null;          // 立即重新索敌建筑
                game.spellEffects.push({ x: e.x, y: e.y, char: '🔥', size: 22, timer: 0.5, maxTimer: 0.5 }); // 狂暴提示
            }
            // 🧘 武僧超脱：0.6s 前摇（止步诵念，手移到嘴边）→ 全身冒青色光晕持续5s，减伤70%，全程不移动不攻击
            if (e.cardId === 'monk') {
                if (e._transcendChant > 0) {
                    e._transcendChant -= deltaSec;
                    if (e._transcendChant <= 0) { e._transcendChant = 0; e._transcendTimer = 5.0; }
                    continue; // 前摇：止步不动不攻击
                }
                if (e._transcendTimer > 0) {
                    e._transcendTimer -= deltaSec;
                    if (e._transcendTimer <= 0) {
                        e._transcendTimer = 0;
                        e._damageReduction = 0; // 超脱结束还原（法徒盾若还在，免伤盾块下帧自动恢复0.3）
                    } else {
                        e._damageReduction = 0.7; // 🛡️ 减伤70%
                    }
                    continue; // 超脱：止步不动不攻击
                }
            }
            // ---- 眩晕中：不能移动/攻击，跳过行动 ----
            if (e._stunTimer > 0) continue;

            // ============ ⛺ 临时营地成员：绕营巡逻（巡逻机制参考主塔守卫） ============
            // 🚩标记状态：巡逻圆心=营地位置，半径=50；索敌范围=200：圈内有敌→出击，圈内无→绕营巡逻
            // ★ 新增机制：自身攻击范围（e.range）内有敌同样出击（杀敌>赶路，巡逻中不放过身边敌人）
            if (e._campFlag) {
                const camp = game.entities.find(en => en.id === e._campId && en.hp > 0);
                if (!camp) {
                    // 营地被摧毁/消失 → 解除🚩，恢复普通行为
                    e._campFlag = false;
                    e._campId = undefined;
                    e._patrolX = undefined; e._patrolY = undefined; e._patrolDir = undefined;
                    e._patrolR = undefined;
                } else {
                    if (e._patrolX === undefined) { e._patrolX = camp.x; e._patrolY = camp.y; }
                    if (e._patrolDir === undefined) {
                        // 巡逻绕圈方向随机（顺/逆时针）
                        e._patrolDir = rand() < 0.5 ? 1 : -1;
                    }
                    const detectR = CARDS.camp.campDetectR || 200;  // 索敌范围（固定200）
                    // 索敌：营地圈内 / 自身攻击范围 e.range 内（双判定，任一命中即出击；治疗兵不打人→找圈内受伤友军；其余 targetMode=all，建筑/兵种都打）
                    let nearest = null, minDist = detectR;
                    if (e.type === 'healer') {
                        for (const en of game.entities) {
                            if (en.team !== e.team || en.hp <= 0 || en.hp >= en.maxHp) continue;
                            if (en.fortification || en.cardId === 'tesla_tower') continue; // 主塔/堡垒/电磁塔不可被治疗
                            const dC = Math.hypot(en.x - e._patrolX, en.y - e._patrolY);
                            const dS = Math.hypot(en.x - e.x, en.y - e.y);
                            if (dC > detectR && dS > (e.range || 0)) continue; // 营地圈外且自身射程外→不理会
                            const d = Math.min(dC, dS);
                            if (d < minDist) { minDist = d; nearest = en; }
                        }
                    } else {
                        for (const en of game.entities) {
                            if (en.team === e.team || en.hp <= 0 || en._stealthed) continue;
                            if (!canTargetFlying(e) && en.flying) continue;
                            // 只打建筑的兵种（如巨人）：营地索敌同样只认建筑
                            if (e.targetMode === 'buildings') {
                                const isB = en.type === 'main_tower' || en.type === 'bastion'
                                    || en.type === 'tower' || en.type === 'barrack' || en.type === 'collector';
                                if (!isB) continue;
                            }
                            const dC = Math.hypot(en.x - e._patrolX, en.y - e._patrolY);
                            const dS = Math.hypot(en.x - e.x, en.y - e.y);
                            if (dC > detectR && dS > (e.range || 0)) continue; // 营地圈外且自身射程外→不理会
                            const d = Math.min(dC, dS);
                            if (d < minDist) { minDist = d; nearest = en; }
                        }
                    }
                    if (nearest) {
                        e.targetId = nearest.id;   // 圈内有目标 → 出击（交给下方通用攻击/移动逻辑）
                    } else {
                        // 圈内无目标 → 绕营巡逻（绕营地转圈 + 径向回圈修正；治疗兵同样主动巡逻）
                        e.targetId = null;
                        patrolOrbit(e, deltaSec);
                        continue; // 巡逻中不执行下方通用索敌/攻击
                    }
                }
            }

            // ============ 🛡️ 主塔守卫：巡逻机制 ============
            // 巡逻圈以己方主塔为圆心（召唤时记录 _patrolX/_patrolY），半径=70；
            // 索敌范围=250：圈内有敌人→出击，圈内无敌人→回内圈继续巡逻
            // ★ 新增机制：自身攻击范围（e.range）内有敌同样出击（杀敌>赶路，巡逻中不放过身边敌人）
            if (e.cardId === 'main_tower_guard') {
                if (e._patrolX === undefined) {
                    // 兜底：未记录巡逻中心时查找己方主塔
                    const myTower = game.entities.find(en => en.type === 'main_tower' && en.team === e.team && en.hp > 0);
                    if (myTower) { e._patrolX = myTower.x; e._patrolY = myTower.y; }
                    else { e._patrolX = e.x; e._patrolY = e.y; }
                }
                if (e._patrolDir === undefined) {
                    // 巡逻绕圈方向随机（顺/逆时针）——独立兜底：召唤时已带 _patrolX 的守卫同样需要初始化，否则 -ry*undefined=NaN 坐标污染导致守卫消失
                    e._patrolDir = rand() < 0.5 ? 1 : -1;
                }
                const patrolR = 70;    // 巡逻半径（固定70，不再跟随法师塔攻击范围）
                const detectR = 250;   // 索敌范围（固定250）
                // 索敌：巡逻中心圈内 / 自身攻击范围 e.range 内（双判定，任一命中即出击；targetMode=all，建筑/兵种都打）
                let nearest = null, minDist = detectR;
                for (const en of game.entities) {
                    if (en.team === e.team || en.hp <= 0 || en._stealthed) continue;
                    if (!canTargetFlying(e) && en.flying) continue;
                    const dC = Math.hypot(en.x - e._patrolX, en.y - e._patrolY);
                    const dS = Math.hypot(en.x - e.x, en.y - e.y);
                    if (dC > detectR && dS > (e.range || 0)) continue; // 巡逻圈外且自身射程外→不理会
                    const d = Math.min(dC, dS);
                    if (d < minDist) { minDist = d; nearest = en; }
                }
                if (nearest) {
                    e.targetId = nearest.id;   // 圈内有敌 → 出击（交给下方通用攻击/移动逻辑）
                } else {
                    // 圈内无敌 → 回内圈继续巡逻（绕主塔转圈 + 径向回圈修正）
                    e.targetId = null;
                    // 🧭 烟引引导中：巡逻寻路暂时改为朝烟点（仅改变移动目标，其余行为特性不变）
                    if (e._guideX !== undefined && e._guideY !== undefined) {
                        moveToward(e, e._guideX, e._guideY, deltaSec);
                        continue;
                    }
                    const dx = e.x - e._patrolX, dy = e.y - e._patrolY;
                    const distC = Math.hypot(dx, dy) || 1;
                    // 巡逻速度与通用移动一致：吃减速/极速/狂暴因子（守卫仅巡逻行为与索敌范围特殊，其余与普通兵种一致）
                    const speed = e.moveSpeed * (e.slowFactor || 1.0) * (e._poisonTimer > 0 ? 0.6 : 1.0) * (e._speedBoosted ? 2.0 : 1.0) * (e._charging ? 3.0 : 1.0) * rageMult(e);
                    const step = speed * deltaSec;
                    const rx = dx / distC, ry = dy / distC;                    // 径向单位向量（中心→守卫）
                    const tx = -ry * e._patrolDir, ty = rx * e._patrolDir;     // 切线单位向量（绕圈方向）
                    const err = distC - patrolR;                               // >0 太远, <0 太近
                    const radialPull = err > 0 ? Math.min(step, err) : Math.max(-step, err * 0.3);
                    e.x += tx * step * 0.6 - rx * radialPull;
                    e.y += ty * step * 0.6 - ry * radialPull;
                    // 边界限制（同 moveToward）
                    e.x = Math.min(W - 25, Math.max(25, e.x));
                    e.y = Math.min(H - 25, Math.max(25, e.y));
                    continue; // 巡逻中不执行下方通用索敌/攻击
                }
            }

            // ============ 🗡️ 剑仙：飞剑技能 ============
            // 每9.5秒生成1把飞剑（最多3把）；飞剑围绕剑仙在50轨道旋转飞行（参考巡逻机制）；
            // 以剑仙为圆心200范围内有敌 → 全部飞剑从各自位置直线射出（不追踪），命中第一个敌人即伤害消散，未命中无最大距离限制一直飞出场外
            if (e.cardId === 'sword_immortal') {
                // 🕊️ 御剑倒计时（10秒）：到时丝滑还原——解除空中状态（flying/_rideSword），
                //    剑自动平滑飞回身侧（渲染读 _rideSword 过渡），脚下阴影/升浮消失，并弹出金色「落！」
                if (e._rideSword) {
                    e._rideTimer = (e._rideTimer || 10) - deltaSec;
                    if (e._rideTimer <= 0) {
                        e._rideSword = false;
                        e.flying = false;
                        e._rideTimer = 0;
                        // 🕊️ 御剑结束：飞行中的金色穿透剑立即恢复普通（非穿透、伤害还原150）
                        for (const p of game.projectiles) {
                            if (p.isSword && p.ownerId === e.id && p.gold) {
                                p.gold = false;
                                p.pierce = false;
                                p.damage = 150;
                            }
                        }
                        game.spellEffects.push({
                            x: e.x, y: e.y,
                            char: '落！', size: 15, color: '#ffd700',
                            timer: 0.8, maxTimer: 0.8,
                        });
                    }
                }
                if (!e._swords) { e._swords = []; e._swordTimer = 9.5; e._swordBase = 0; }
                // 1) 每9.5秒生成一把（旋转中最多3把）；槽位 = 当前剑数（0/1/2 → 0°/120°/240°）
                e._swordTimer -= deltaSec;
                if (e._swordTimer <= 0) {
                    e._swordTimer = 9.5;
                    if (e._swords.length < 3) e._swords.push({ slot: e._swords.length });
                }
                // 2) 旋转：共享基准角递增，每把剑角度 = 基准角 + 槽位×120°（永远严格均分，不会挨在一起）
                e._swordBase = (e._swordBase + 1.5 * deltaSec) % (2 * Math.PI);
                for (const s of e._swords) s.angle = e._swordBase + s.slot * (Math.PI * 2 / 3);
                // 3) 索敌200（以剑仙为圆心，飞剑可对空）：有敌 → 全部飞剑直线射出
                let nearestS = null, minDistS = 200;
                for (const en of game.entities) {
                    if (en.team === e.team || en.hp <= 0 || en._headHidden || en._stealthed) continue;
                    const d = Math.hypot(en.x - e.x, en.y - e.y);
                    if (d <= minDistS) { minDistS = d; nearestS = en; }
                }
                if (nearestS && e._swords.length > 0) {
                    const firing = e._swords.splice(0);
                    for (const s of firing) {
                        const sx = e.x + Math.cos(s.angle) * 50; // 轨道半径50
                        const sy = e.y + Math.sin(s.angle) * 50;
                        const baseA = Math.atan2(nearestS.y - sy, nearestS.x - sx); // 发射方向锁定：朝敌人当前位置直线飞（不追踪）
                        game.projectiles.push({
                            x: sx, y: sy,
                            char: '🗡', size: 11,
                            vx: Math.cos(baseA), vy: Math.sin(baseA),
                            speed: 260, timer: 30, maxTimer: 30,
                            isSword: true, dist: 0, maxDist: 50000, // 无最大飞行距离（出界才消散）
                            damage: 150, // 飞剑伤害150（独立于普攻75）
                            team: e.team, hitsAir: true, // 可对空
                            ownerId: e.id,
                            hitIds: [],
                            _turns: 0, // 🕊️ 金剑穿透改向次数（最多4次）
                            gold: !!e._rideSword,    // 🕊️ 御剑状态：飞剑变金色
                            pierce: !!e._rideSword,  // 🕊️ 御剑状态：可穿透（伤害逐次衰减）
                        });
                    }
                }

                // 4) 🗡️ 战斗姿态：与攻击绑定 + 50px警戒（剑横指攻击目标，慢慢飞过去）
                //    攻击绑定用与攻击循环一致的判定（dist-受击半径<=射程；主塔/堡垒半径28较大，
                //    打塔时剑仙可站在50~63px出手，50px警戒查不到→改为直接看攻击目标，打塔剑也会横指）
                //    🕊️ 御剑形态同款特效：剑从脚下飞入手中横指，攻击时刺出（与地面一致）
                if (e._stabTimer > 0) e._stabTimer -= deltaSec;
                let aimTarget = null;
                if (e.targetId) {
                    const t = game.entities.find(en => en.id === e.targetId && en.hp > 0 && !en._headHidden && !en._stealthed);
                    if (t && dist(e, t) - getHitRadius(t) <= (e.range || 35)) aimTarget = t;
                }
                if (!aimTarget) {
                    for (const en of game.entities) {
                        if (en.team === e.team || en.hp <= 0 || en._headHidden || en._stealthed) continue;
                        if (Math.hypot(en.x - e.x, en.y - e.y) <= 50) { aimTarget = en; break; }
                    }
                }
                if (aimTarget) {
                    e._combatMode = true;
                    e._aimAngle = Math.atan2(aimTarget.y - e.y, aimTarget.x - e.x);
                } else {
                    e._combatMode = false;
                }

                // 5) 🗡️ 剑姿态平滑过渡：日常 ⇄ 战斗横指，剑（含流光）慢慢飞过去
                //    目标状态（地面）：日常=剑柄(x-14, y+11)、角度-π/2（剑尖朝上）；战斗=剑柄(x-6, y+6)、角度指向敌人
                //    🕊️ 御剑形态：日常=剑横置脚下(x-10, y+12, 0)；战斗=飞入手中横指+刺击（与地面同款特效）
                if (e._swordGX === undefined) {
                    e._swordGX = e._rideSword ? e.x - 10 : e.x - 14;
                    e._swordGY = e._rideSword ? e.y + 12 : e.y + 11;
                    e._swordAngle = e._rideSword ? 0 : -Math.PI / 2;
                }
                const idleX = e._rideSword ? e.x - 10 : e.x - 14;
                const idleY = e._rideSword ? e.y + 12 : e.y + 11;
                const idleAng = e._rideSword ? 0 : -Math.PI / 2;
                const tGX = e._combatMode ? e.x - 6 : idleX;
                const tGY = e._combatMode ? e.y + 6 : idleY;
                const tAng = e._combatMode ? (e._aimAngle || 0) : idleAng;
                const k = 1 - Math.exp(-deltaSec * 7); // 每秒向目标收敛约70%（≈0.5s到位）
                e._swordGX += (tGX - e._swordGX) * k;
                e._swordGY += (tGY - e._swordGY) * k;
                let dA = tAng - e._swordAngle;          // 角度差归一化，避免绕大圈
                while (dA > Math.PI) dA -= 2 * Math.PI;
                while (dA < -Math.PI) dA += 2 * Math.PI;
                e._swordAngle += dA * k;
            }

                        // ============ 🐲 地狱飞龙：索敌+攻击 完全复用「地狱塔」同款机制 ============
            // 攻击与移动分离：索敌/死锁/切换冷却/蓄热梯度照抄地狱塔（唯一差异：切换冷却0.4s vs 地狱塔1.0s）
            // 移动走通用逻辑（moveTargetRange 65 vs 攻击索敌75）；打断断束由循环顶部统一机制处理（💫眩晕/🧊冰冻等）
            if (e.cardId === 'inferno_dragon') {
                // 射程内索敌（地狱塔同款 findTargetInRangeForTower）
                let currentTarget = findTargetInRangeForTower(e, e.range);

                // 🎯 特殊索敌：一旦锁定绝不换目标，除非死亡/隐身/脱射程
                if (e._beamTargetId) {
                    const lockedTarget = game.entities.find(
                        en => en.id === e._beamTargetId && en.hp > 0 &&
                              !en._stealthed && dist(e, en) <= e.range
                    );
                    if (lockedTarget) {
                        currentTarget = lockedTarget;
                    } else {
                        // 锁定目标失效 → 清空，进入切换冷却
                        e._beamTargetId = null;
                        e._beamTimer = 0;
                        e._beamSwitchCooldown = 0.4;
                    }
                }

                // 无锁定状态 → 冷却中不寻敌，冷却结束才允许锁新目标
                if (!e._beamTargetId) {
                    if (e._beamSwitchCooldown > 0) {
                        e._beamSwitchCooldown -= deltaSec;
                    }
                    if (e._beamSwitchCooldown <= 0 && currentTarget) {
                        e._beamTargetId = currentTarget.id;
                    } else if (e._beamSwitchCooldown > 0) {
                        // 冷却中 → 不攻击
                        currentTarget = null;
                    }
                }

                // 同步 targetId（渲染用）
                e.targetId = currentTarget ? currentTarget.id : null;

                // 光束持续增温（锁定中才计时；打断归零由循环顶部统一机制处理）
                // ★ 飞龙走兵种分支：眩晕/冰冻时被顶部 continue 整块跳过，块内无需二次断束（死代码已删）
                if (currentTarget && e._beamTargetId) {
                    e._beamTimer = (e._beamTimer || 0) + deltaSec;
                } else {
                    e._beamTimer = 0;
                }

                // 攻击伤害：地狱飞龙基础5；梯度7/15/23/31/39，最高120——眩晕中不攻击
                if (e.atkCooldown > 0) e.atkCooldown -= deltaSec * rageMult(e);
                if ((e._stunTimer || 0) <= 0 && e.atkCooldown <= 0 && currentTarget && e._beamTargetId) {
                    const elapsedSeconds = Math.floor(e._beamTimer || 0);
                    const rampSteps = [0, ...(CARDS[e.cardId].infernoRamp || [7, 15, 23, 31, 39])];
                    const rampBonus = rampSteps.slice(0, Math.min(elapsedSeconds, rampSteps.length - 1) + 1).reduce((sum, value) => sum + value, 0);
                    const finalAtk = e.atk + rampBonus;
                    currentTarget.hp -= calcActualDmg(finalAtk, e, currentTarget);
                    e.atkCooldown = e.atkSpeed;
                }

                // 🚶 移动：正常移动（无特殊AI，与普通部队一致）
                //    攻击索敌=射程75（光束锁定射程）；移动索敌=moveTargetRange 65（距离>65靠近，≤65站桩灼烧）
                //    空中/地面都索敌（canHitAir:true）；烟引引导由 moveToward 内部统一处理（赶路优先）
                if (currentTarget) {
                    const moveStop = CARDS.inferno_dragon.moveTargetRange || 65;
                    if (dist(e, currentTarget) > moveStop) {
                        moveToward(e, currentTarget.x, currentTarget.y, deltaSec);
                    }
                } else {
                    // 无锁定目标：用通用寻敌驱动正常前进（射程内锁定不限制移动索敌，像普通部队一样推进）
                    const moveTarget = findTarget(e);
                    if (moveTarget) moveToward(e, moveTarget.x, moveTarget.y, deltaSec);
                }
                continue;
            }

            // ============ 🎯 纯净寻敌与重评估逻辑 开始 ============
            // 1. 检查当前目标是否有效
            if (e.targetId) {
                const t = game.entities.find(en => en.id === e.targetId && en.hp > 0 && !en._stealthed);
                if (!t) {
                    e.targetId = null;  // 🚨 只有目标死亡或隐身才放弃！绝不因距离远放弃！
                } else if (t.flying && !canTargetFlying(e)) {
                    // 🕊️ 目标已升空（如剑仙御剑）且本兵不能对空 → 解除锁定重新索敌（否则会继续追着空中的剑仙打）
                    e.targetId = null;
                } else {
                    // 主动重评估（优化）：防路过建筑不回头
                    const nearest = findTarget(e);
                    // 如果发现更近的敌人（比原目标近至少 20 像素以上，防抖动），果断切换目标
                    if (nearest && nearest.id !== e.targetId && dist(e, nearest) < dist(e, t) - 20) {
                        e.targetId = nearest.id;
                    }
                }
            }

            // 2. 如果没有目标，寻找新目标
            if (!e.targetId) {
                const newTarget = findTarget(e);
                if (newTarget) {
                    e.targetId = newTarget.id;
                } else {
                    // 🚨 【终极排查器】如果真的找不到目标，把真凶打印出来！
                    const enemyTower = game.entities.find(en => en.type === 'main_tower' && en.team !== e.team);
                    console.log(`[真凶抓捕] ${e.cardId}(id=${e.id}) 找不到目标！当前敌方主塔状态:`, enemyTower);
                }
            }

            // 3. 执行攻击或移动（地狱飞龙已在上方独立 continue，不会走到这里）
// ---- 王子增援：护驾冲锋中 → 沿固定方向快速冲锋105px，沿途敌人50伤害+击退（参考暗影刺客冲刺/超骑击退），不普攻不移动 ----
            if (e.cardId === 'prince_reinforcement' && e._escortCharging) {
                const chargeSpeed = (e.moveSpeed || 22) * 8; // 💨 快速冲锋（参考暗影刺客 移速×8）
                const step = Math.min(chargeSpeed * deltaSec, e._escortRemain);
                if (step > 0) {
                    e.x += (e._escortDirX || 0) * step;
                    e.y += (e._escortDirY || 0) * step;
                    e._escortRemain -= step;
                    // 沿途伤害+击退（参考超骑落地击退：半径40、击退15px、仅兵种；每个敌人只结算一次）
                    const radius = 40;
                    for (const e2 of game.entities) {
                        if (e2.team === e.team || e2.hp <= 0 || e2._headHidden || e2._stealthed) continue;
                        if (e2.flying && !canTargetFlying(e)) continue; // 🕊️ 冲锋不打空中（如御剑剑仙）
                        if (dist(e2, e) <= radius && !e._escortHit[e2.id]) {
                            e._escortHit[e2.id] = true;
                            const dmgL = calcActualDmg(50, null, e2); // 冲锋伤害统一收口（无攻击者）
                            e2.hp -= dmgL;
                            spawnDmgNum(e2.x, e2.y - 20, dmgL);
                            // 击退仅兵种生效（注释原意，补齐判断；建筑不被推）：标记剩余位移向量，帧驱动渐进滑动（位移式击退，不瞬移）
                            if (e2.moveSpeed !== undefined && !e2.fortification) {
                                const angle = Math.atan2(e2.y - e.y, e2.x - e.x);
                                e2._kbX = Math.cos(angle) * 15;
                                e2._kbY = Math.sin(angle) * 15;
                            }
                            game.spellEffects.push({ x: e2.x, y: e2.y, char: '💥', size: 24, timer: 0.25, maxTimer: 0.25 });
                        }
                    }
                }
                e.x = Math.min(W - 30, Math.max(30, e.x));
                e.y = Math.min(H - 30, Math.max(30, e.y));
                if (e._escortRemain <= 0) {
                    // ✅ 冲锋结束：恢复正常行为
                    e._escortCharging = false;
                    e._escortHit = null;
                }
                continue; // ⛔ 冲锋中，跳过后续索敌/攻击/移动
            }
            if (e.targetId) {
                const target = game.entities.find(en => en.id === e.targetId);

                // ---- 🪵 木桶护卫：长矛自动对准当前目标（角度平滑过渡） ----
                if (e.cardId === 'barrel_guard' && target && target.hp > 0) {
                    const targetAngle = Math.atan2(target.y - e.y, target.x - e.x);
                    if (e._spearAngle === undefined) e._spearAngle = targetAngle;
                    let angleDelta = targetAngle - e._spearAngle;
                    while (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
                    while (angleDelta < -Math.PI) angleDelta += Math.PI * 2;
                    const angleStep = 1 - Math.exp(-deltaSec * 10);
                    e._spearAngle += angleDelta * angleStep;
                }

                // ---- 🥷 忍者：攻击与移动完全分离 ----
                // 攻击：目标进入135px攻击范围即持续发射追踪飞镖；移动：独立保持100~110px距离
                if (e.cardId === 'ninja' && target && target.hp > 0 && !target._stealthed) {
                    const ninjaDist = dist(e, target);
                    const ninjaInAttackRange = ninjaDist - getHitRadius(target) <= (e.range || 135);
                    if (ninjaInAttackRange && (e._stunTimer || 0) <= 0) {
                        e.atkCooldown -= deltaSec * rageMult(e);
                        if (e.atkCooldown <= 0) {
                            attackTroop(e, target);
                            // 每两次攻击后立即随机翻滚30px；翻滚期间可以正常受到伤害
                            if ((e._ninjaAttackCount || 0) % 2 === 0) {
                                const rollA = rand() * Math.PI * 2;
                                e._ninjaRollRemain = 30;
                                e._ninjaRollVx = Math.cos(rollA);
                                e._ninjaRollVy = Math.sin(rollA);
                                e._ninjaRollAngle = 0;
                                e._ninjaRollSpin = (rand() < 0.5 ? -1 : 1) * Math.PI * 8;
                                e._stealthed = true; // 翻滚期间进入隐身：可受伤，但不被敌方锁定
                            }
                            e.atkCooldown = e.atkSpeed;
                        }
                    }
                    // 移动独立于攻击：>110靠近，<100远离，100~110停下
                    if (e._guideX !== undefined && e._guideY !== undefined) {
                        moveToward(e, e._guideX, e._guideY, deltaSec);
                    } else if (ninjaDist > 110) {
                        moveToward(e, target.x, target.y, deltaSec);
                    } else if (ninjaDist < 100) {
                        moveAwayFrom(e, target, deltaSec);
                    }
                    continue; // 忍者不再进入下方通用“攻击/移动二选一”逻辑
                }

                // ---- 超级骑士：蓄力中 → 不攻击不移动 ----
                if (e.cardId === 'super_knight' && e._leapCharging) {
                    const leapTarget = game.entities.find(en => en.id === e._leapTargetId);
                    const shouldCancel = !leapTarget || leapTarget.hp <= 0 || leapTarget._stealthed || (e._stunTimer > 0)
                        || (leapTarget.flying && !canTargetFlying(e)); // 🕊️ 目标已升空（如剑仙御剑）且不能对空 → 取消蓄力重新索敌
                    if (shouldCancel) {
                        // ❌ 取消蓄力，随后走正常攻击/移动逻辑
                        e._leapCharging = false;
                        e._leapTimer = 0;
                        e._leapTargetId = null;
                    } else {
                        // ✅ 蓄力继续，原地罚站
                        e._leapTimer -= deltaSec * rageMult(e);
                        if (e._leapTimer <= 0) {
                            // 🦸 跳跃！从当前位置沿抛物线飞向落点（落点=目标位置偏移12px避免重叠，弧线飞行由帧循环插值）
                            const preAngle = Math.atan2(leapTarget.y - e.y, leapTarget.x - e.x);
                            const landOffset = 12;
                            const leapX = leapTarget.x - Math.cos(preAngle) * landOffset;
                            const leapY = leapTarget.y - Math.sin(preAngle) * landOffset;
                            const lDist = Math.max(1, Math.hypot(leapX - e.x, leapY - e.y));
                            e._leapJumping = true;   // 进入抛物线跳跃
                            e._leapSx = e.x; e._leapSy = e.y;
                            e._leapTx = leapX; e._leapTy = leapY;
                            e._leapDist = 0;
                            e._leapMaxDist = lDist;
                            e._leapArc = Math.min(150, Math.max(70, lDist * 0.75)); // 弧高：大个子跳得高
                            e._leapSpeed = 220; // 飞行速度（滞空感明显）
                            e._leapCharging = false;
                            e._leapTimer = 0;
                            e._leapTargetId = null;
                        }
                        continue; // ⛔ 蓄力中，跳过后续攻击/移动
                    }
                }
                // ---- 暗影刺客：突袭蓄力/冲刺中 → 短暂隐身（不可被锁定），不普攻 ----
                if (e.cardId === 'shadow_assassin' && e._assaultCharging) {
                    const atkTarget = game.entities.find(en => en.id === e._assaultTargetId);
                    const shouldCancel = !atkTarget || atkTarget.hp <= 0 || atkTarget._stealthed || (e._stunTimer > 0);
                    if (shouldCancel) {
                        // ❌ 取消突袭：解除隐身，随后走正常攻击/移动逻辑
                        e._assaultCharging = false;
                        e._assaultTimer = 0;
                        e._assaultTargetId = null;
                        e._stealthed = false;
                    } else {
                        e._assaultTimer -= deltaSec * rageMult(e);
                        if (e._assaultTimer <= 0) {
                            // 💨 冲刺：高速冲向目标（移速×8）
                            const dashSpeed = e.moveSpeed * 8 * rageMult(e);
                            const step = dashSpeed * deltaSec;
                            const dd = Math.hypot(atkTarget.x - e.x, atkTarget.y - e.y);
                            if (dd > 0) {
                                e.x += (atkTarget.x - e.x) / dd * Math.min(step, dd);
                                e.y += (atkTarget.y - e.y) / dd * Math.min(step, dd);
                            }
                            // 进入攻击范围 → 冲刺命中：双倍伤害（60×2=120）
                            if (dist(e, atkTarget) - getHitRadius(atkTarget) <= e.range) {
                                const aDmg = calcActualDmg(e.atk * 2, e, atkTarget);
                                // 浪人：格挡突袭冲刺（近战）并200%反弹
                                if (atkTarget.cardId === 'ronin' && (atkTarget._reflectTimer || 0) <= 0) {
                                    atkTarget._reflectTimer = CARDS.ronin.reflectCooldown || 3.5;
                                    const rd = Math.floor(aDmg * (CARDS.ronin.reflectMultiplier || 2));
                                    const rdDmg = calcActualDmg(rd, atkTarget, e); // 反弹伤害统一收口：吃被反弹者减伤
                                    e.hp -= rdDmg;
                                    spawnDmgNum(e.x, e.y - 20, rdDmg);
                                    // 特效：🚫 出现在被反弹者（突袭者）头顶
                                    game.spellEffects.push({ x: e.x, y: e.y - 20, char: '🚫', size: 30, color: '#ff4757', timer: 0.4, maxTimer: 0.4 });
                                } else {
                                    atkTarget.hp -= aDmg;
                                    spawnDmgNum(atkTarget.x, atkTarget.y - 20, aDmg);
                                    game.spellEffects.push({ x: atkTarget.x, y: atkTarget.y, char: '⚔️', size: 30, timer: 0.25, maxTimer: 0.25 });
                                }
                                e.atkCooldown = e.atkSpeed; // 冲刺后重置攻击节奏
                                e._assaultCharging = false;
                                e._assaultTimer = 0;
                                e._assaultTargetId = null;
                                e._stealthed = false; // 现身
                            }
                        }
                        continue; // ⛔ 突袭中，跳过后续攻击/移动
                    }
                }
                // ---- 渔夫：钩子三阶段（蓄力 → 甩钩飞行 → 收线拖拽），期间不移动不普攻 ----
                if (e.cardId === 'fisherman' && (e._hookCharging || e._hookFlying || e._hookPulling)) {
                    const hookTarget = game.entities.find(en => en.id === e._hookTargetId);
                    const isBuilding = hookTarget && (hookTarget.type === 'tower' || hookTarget.type === 'barrack'
                        || hookTarget.type === 'collector' || hookTarget.type === 'main_tower'
                        || hookTarget.type === 'bastion');
                    const shouldCancel = !hookTarget || hookTarget.hp <= 0 || hookTarget._stealthed;
                    const lineSpeed = CARDS.fisherman.hookLineSpeed || 700;
                    const pullSpeed = CARDS.fisherman.hookPullSpeed || 260;
                    // 查找当前鱼线
                    const findLine = () => (game.fishingLines || []).find(l => l.id === e._hookLineId);
                    const removeLine = () => {
                        if (game.fishingLines) game.fishingLines = game.fishingLines.filter(l => l.id !== e._hookLineId);
                        e._hookLineId = null;
                    };

                    // ① 蓄力中：倒计时，被眩晕/目标失效则取消
                    if (e._hookCharging) {
                        if (shouldCancel || e._stunTimer > 0) {
                            e._hookCharging = false;
                            e._hookTimer = 0;
                            e._hookTargetId = null;
                        } else {
                            e._hookTimer -= deltaSec * rageMult(e);
                            if (e._hookTimer <= 0) {
                                // 蓄力完成 → 甩钩：棕线从竿尖甩出（参照游侠弹道渲染）
                                e._hookCharging = false;
                                e._hookFlying = true;
                                const sx = e.x + 10, sy = e.y - 16;
                                const dx = hookTarget.x - sx, dy = (hookTarget.y - 10) - sy;
                                const d = Math.hypot(dx, dy);
                                game.fishingLines = game.fishingLines || [];
                                game._fishingLineSeq = (game._fishingLineSeq || 0) + 1;
                                game.fishingLines.push({
                                    id: game._fishingLineSeq,
                                    ownerId: e.id,
                                    targetId: hookTarget.id,
                                    x: sx, y: sy,
                                    dx: d > 0 ? dx / d : 1, dy: d > 0 ? dy / d : 0,
                                    traveled: 0, speed: lineSpeed,
                                    lineLen: 60, pulling: false,
                                });
                                e._hookLineId = game._fishingLineSeq;
                            }
                        }
                    }
                    // ② 甩钩飞行中：线随钩头前进，命中目标后进入收线
                    else if (e._hookFlying) {
                        const line = findLine();
                        if (shouldCancel || !line) {
                            removeLine();
                            e._hookFlying = false;
                            e._hookTargetId = null;
                        } else {
                            line.traveled += line.speed * deltaSec;
                            const hookX = line.x + line.dx * line.traveled;
                            const hookY = line.y + line.dy * line.traveled;
                            const dd = Math.hypot((hookTarget.y - 10) - hookY, hookTarget.x - hookX);
                            if (dd <= line.speed * deltaSec + 4) {
                                // 🪝 命中目标 → 开始收线拖拽
                                line.pulling = true;
                                e._hookFlying = false;
                                e._hookPulling = true;
                                game.spellEffects.push({ x: hookTarget.x, y: hookTarget.y - 10, char: '🪝', size: 20, timer: 0.3, maxTimer: 0.3 });
                            }
                        }
                    }
                    // ③ 收线拖拽中：兵种被线拖向渔夫；建筑则渔夫被线拖向建筑
                    else if (e._hookPulling) {
                        const line = findLine();
                        if (shouldCancel) {
                            removeLine();
                            e._hookPulling = false;
                            e._hookTargetId = null;
                        } else {
                            const step = pullSpeed * deltaSec;
                            const dd = dist(e, hookTarget);
                            if (isBuilding) {
                                // 渔夫被拖向建筑，贴脸为止
                                if (dd - getHitRadius(hookTarget) <= e.range + 5) {
                                    removeLine();
                                    e._hookPulling = false;
                                    e._hookTargetId = null;
                                } else if (dd > 0) {
                                    e.x += (hookTarget.x - e.x) / dd * step;
                                    e.y += (hookTarget.y - e.y) / dd * step;
                                }
                            } else {
                                // 敌人被拖到面前（贴攻击范围为止）
                                if (dd - getHitRadius(hookTarget) <= e.range + 5) {
                                    const ang = Math.atan2(hookTarget.y - e.y, hookTarget.x - e.x);
                                    const rr = getHitRadius(hookTarget) + 10;
                                    hookTarget.x = e.x + Math.cos(ang) * rr;
                                    hookTarget.y = e.y + Math.sin(ang) * rr;
                                    hookTarget.targetId = null; // 被钩目标重新评估目标
                                    removeLine();
                                    e._hookPulling = false;
                                    e._hookTargetId = null;
                                    e.atkCooldown = 0; // 拉完立刻能普攻
                                } else if (dd > 0) {
                                    hookTarget.x += (e.x - hookTarget.x) / dd * step;
                                    hookTarget.y += (e.y - hookTarget.y) / dd * step;
                                }
                            }
                        }
                    }
                    continue; // ⛔ 钩子进行中，跳过后续攻击/移动
                }
                // 👜 哥布林巨人：腰间袋中2名投矛手——各自独立索敌/冷却/锁定目标（左袋+右袋，各投各的矛，可对空）
                if (e.cardId === 'goblin_giant' && (e._stunTimer || 0) <= 0) {
                    const tRange = GOBLIN_THROWER_TEMPLATE.range;
                    const bags = [
                        { cd: '_throwerCdL', tgt: '_throwerTargetL', ox: -7.5 },
                        { cd: '_throwerCdR', tgt: '_throwerTargetR', ox: 7.5 },
                    ];
                    for (const bag of bags) {
                        e[bag.cd] = (e[bag.cd] || 0) - deltaSec * rageMult(e);
                        if (e[bag.cd] > 0) continue;
                        // 锁定目标仍有效（存活/未隐形/在射程内）则继续打它，否则重新索敌
                        let t2 = null;
                        const lockedId = e[bag.tgt];
                        if (lockedId != null) {
                            const en = game.entities.find(x => x.id === lockedId);
                            if (en && en.team !== e.team && en.hp > 0 && !en._stealthed
                                && dist(e, en) - getHitRadius(en) <= tRange) t2 = en;
                        }
                        if (!t2) {
                            // 随机锁敌：从射程内所有有效敌人中随机挑一个锁定（两个投矛手各锁各的）
                            const candidates = game.entities.filter(en =>
                                en.team !== e.team && en.hp > 0 && !en._stealthed
                                && dist(e, en) - getHitRadius(en) <= tRange);
                            if (candidates.length) t2 = candidates[Math.floor(rand() * candidates.length)];
                        }
                        e[bag.tgt] = t2 ? t2.id : null;
                        if (t2) {
                            const sx = e.x + bag.ox, sy = e.y + 5;
                            const baseA = Math.atan2(t2.y - sy, t2.x - sx);
                            game.projectiles.push({
                                x: sx, y: sy,
                                char: '🔱', size: 14,
                                vx: Math.cos(baseA), vy: Math.sin(baseA),
                                speed: 180, timer: 2.0, maxTimer: 2.0,
                                isSpear: true, dist: 0, maxDist: tRange,
                                damage: GOBLIN_THROWER_TEMPLATE.atk,
                                team: e.team, hitsAir: true,
                                ownerId: e.id,
                                hitIds: [],
                            });
                        }
                        e[bag.cd] = GOBLIN_THROWER_TEMPLATE.atkSpeed;
                    }
                }
                if (target && dist(e, target) - getHitRadius(target) <= e.range) {
                    // ---- 电磁炮：满蓄时发射（蓄能已在持续模块处理）----
                    if (e.cardId === 'electro_cannon') {
                        if (e._chargeTimer >= e._chargeMax) {
                            e._chargeTimer = 0;
                            // ── 弹道：白色电磁团（命中时才结算35px范围伤害） ──
                            game.projectiles.push({
                                x: e.x, y: e.y,
                                tx: target.x, ty: target.y,
                                char: '●', size: 14,
                                color: '#ffffff',
                                speed: 500,
                                timer: 0.15, maxTimer: 0.15,
                                isElectro: true,
                                damage: e.atk, // 原始伤害，命中结算统一走 calcActualDmg
                                team: e.team,
                                targetId: target.id,
                                ownerId: e.id, // 攻击者：命中结算时吃狂暴/减伤
                                aoeRadius: AOE_RANGE_MED, // 中档35
                                fullAoe: true,
                                hitsAir: true, // 电磁炮远程可对空，爆炸波及空中
                            });
                            // ── 爆炸脉冲：白色光圈 ──
                            game.spellEffects.push({
                                x: target.x, y: target.y,
                                size: 70,
                                timer: 0.35, maxTimer: 0.35,
                                isPulse: true,
                            });
                            // ── 后坐力：平滑后退10px（0.2秒完成） ──
                            const dx = e.x - target.x;
                            const dy = e.y - target.y;
                            const d = Math.hypot(dx, dy);
                            if (d > 0) {
                                e._recoilVx = (dx / d) * 50;
                                e._recoilVy = (dy / d) * 50;
                                e._recoilTimer = 0.2;
                            }
                        }
                    } else if (e.isSiege) {
                        e.hp = 0;   // 💣 自爆只管自杀：死亡后由死亡结算统一留下💣
                    } else {
                        // 在攻击范围内 → 攻击
                        // 💥 狂战士爆发：buff期间攻速提升（冷却递减速度不变，由下方攻击间隔控制 0.2s）
                        e.atkCooldown -= deltaSec * rageMult(e);
                        if (e.atkCooldown <= 0) {
                            attackTroop(e, target);
                            // 🥷 忍者：每两次攻击后，第二次攻击发出后立即随机方向翻滚30px；翻滚期间仍可受伤
                            if (e.cardId === 'ninja' && (e._ninjaAttackCount || 0) % 2 === 0) {
                                const rollA = rand() * Math.PI * 2;
                                e._ninjaRollRemain = 30;
                                e._ninjaRollVx = Math.cos(rollA);
                                e._ninjaRollVy = Math.sin(rollA);
                                e._ninjaRollAngle = 0;
                                e._ninjaRollSpin = (rand() < 0.5 ? -1 : 1) * Math.PI * 8;
                            }
                            // 👑 小王子：连续攻击同一目标攻速递增（每射一箭-0.2s，下限0.4s）；切换目标后重新从1.2s开始
                            if (e.cardId === 'little_prince') {
                                if (e._princeLastTarget !== target.id) {
                                    e._princeLastTarget = target.id;
                                    e._princeCombo = 0;
                                } else {
                                    e._princeCombo = (e._princeCombo || 0) + 1;
                                }
                                e.atkCooldown = Math.max(0.4, e.atkSpeed - e._princeCombo * 0.2);
                            } else {
                                // 💥 狂战士爆发：攻击间隔 0.2s（超高攻速，与爪痕特效时长同步 → 上一组未消散下一组又来，交汇成X）
                                e.atkCooldown = e._berserkTimer > 0 ? 0.2 : e.atkSpeed;
                            }
                        }
                    }
                    // 🧭 烟引引导中：攻击不停止移动——边走边打（能打到就打，打不到继续赶路，赶路优先）
                    if (e._guideX !== undefined && e._guideY !== undefined) {
                        moveToward(e, e._guideX, e._guideY, deltaSec);
                    } else if (e.cardId === 'ninja' && dist(e, target) < 75) {
                        // 敌人太近：边攻击边后撤，不中断本次攻击
                        moveAwayFrom(e, target, deltaSec);
                    } else {
                        // 🎯 索敌分离：移动索敌<攻击索敌时，靠近到移动索敌距离再站桩（边走边打，不贴脸）
                        // ⚠️ 安全访问：召唤物（goblin_melee 等）不在 CARDS 里，直接 CARDS[e.cardId] 会抛错
                        const mStop = (CARDS[e.cardId] || {}).moveTargetRange;
                        if (mStop !== undefined && dist(e, target) > mStop) {
                            moveToward(e, target.x, target.y, deltaSec);
                        }
                    }
                } else if (target) {
                    const d = dist(e, target);
                    // ---- 暗影刺客：未突袭 → 距离锁定敌人85~105px进入突袭（短暂隐身+蓄力1秒冲刺）----
                    if (e.cardId === 'shadow_assassin') {
                        if (e._guideX !== undefined && e._guideY !== undefined) {
                            // 🧭 烟引引导中：赶路优先，不触发突袭（保持朝烟点前进）
                            moveToward(e, e._guideX, e._guideY, deltaSec);
                        } else if (d >= 115 && d <= 135) {
                            // 🔒 锁定目标，进入突袭：短暂隐身buff + 蓄力1秒
                            e._assaultCharging = true;
                            e._assaultTimer = 1.0;
                            e._assaultTargetId = target.id;
                            e._stealthed = true;
                        } else {
                            moveToward(e, target.x, target.y, deltaSec);
                        }
                    } else if (e.cardId === 'fisherman') {
                        // 🎣 距离锁定目标（钩子范围内）→ 蓄力1.2秒甩钩
                        const hMin = CARDS.fisherman.hookMin || 90;
                        const hMax = CARDS.fisherman.hookMax || 150;
                        if (e._guideX !== undefined && e._guideY !== undefined) {
                            // 🧭 烟引引导中：赶路优先，不甩钩（保持朝烟点前进）
                            moveToward(e, e._guideX, e._guideY, deltaSec);
                        } else if (d >= hMin && d <= hMax) {
                            e._hookCharging = true;
                            e._hookTimer = CARDS.fisherman.hookCharge || 1.2;
                            e._hookTargetId = target.id;
                        } else {
                            moveToward(e, target.x, target.y, deltaSec);
                        }
                    } else if (e.cardId === 'super_knight') {
                        if (e._guideX !== undefined || (d < 85 || d > 105)) {
                            moveToward(e, target.x, target.y, deltaSec);
                        } else {
                            // 🔒 锁定目标，开始蓄力
                            e._leapCharging = true;
                            e._leapTimer = 1.5;
                            e._leapTargetId = target.id;
                        }
                    } else if (e.cardId === 'ninja') {
                        // 🥷 忍者保持75~105px：范围外靠近；75~105内不主动贴近
                        if (e._guideX !== undefined || d > 105) moveToward(e, target.x, target.y, deltaSec);
                    } else {
                        // 🎯 索敌分离：移动停止距离 = moveTargetRange（默认=攻击索敌range），超过才靠近
                        // ⚠️ 安全访问：召唤物（goblin_melee 等）不在 CARDS 里，直接 CARDS[e.cardId] 会抛错
                        const mStop = (CARDS[e.cardId] || {}).moveTargetRange || e.range;
                        if (d > mStop) moveToward(e, target.x, target.y, deltaSec);
                    }
                }
            }
            // 🧭 烟引引导中（无目标时）：持续朝烟点赶路（能打到就打，打不到继续走，赶路优先）
            if (!e.targetId && e._guideX !== undefined && e._guideY !== undefined) {
                moveToward(e, e._guideX, e._guideY, deltaSec);
            }
            // ============ 🎯 纯净寻敌与重评估逻辑 结束 ============
        }

        // --- 治疗兵行为 ---
        if (e.type === 'healer') {
            if (e.targetId) {
                const t = game.entities.find(
                    en => en.id === e.targetId && en.hp > 0 && en.hp < en.maxHp
                );
                if (!t || dist(e, t) > e.range + 10) e.targetId = null;
            }
            if (!e.targetId) {
                const healTarget = findHealTarget(e);
                if (healTarget) e.targetId = healTarget.id;
            }
            if (e.targetId) {
                const target = game.entities.find(en => en.id === e.targetId);
                if (target && dist(e, target) <= e.range) {
                    e.healCooldown = (e.healCooldown || 0) - deltaSec;
                    if (e.healCooldown <= 0) {
                        const healAmt = Math.min(target.maxHp - target.hp, e.healAmount);
                        target.hp = Math.min(target.maxHp, target.hp + e.healAmount);
                        e.healCooldown = e.healSpeed;
                        if (healAmt > 0) spawnDmgNum(target.x, target.y - 20, healAmt, true);
                        // 绿色 ➕ 治疗弹道特效
                        game.projectiles.push({
                            x: e.x, y: e.y,
                            tx: target.x, ty: target.y,
                            char: '➕', size: 16,
                            speed: 200, timer: 0.4,
                            color: '#4caf50',
                        });
                    }
                    // 🧭 烟引引导中：治疗不停止移动——边走边治（赶路优先）
                    if (e._guideX !== undefined && e._guideY !== undefined) {
                        moveToward(e, e._guideX, e._guideY, deltaSec);
                    }
                } else if (target) {
                    moveToward(e, target.x, target.y, deltaSec);
                }
            }
            // 🧭 烟引引导中（无目标时）：持续朝烟点赶路
            if (!e.targetId && e._guideX !== undefined && e._guideY !== undefined) {
                moveToward(e, e._guideX, e._guideY, deltaSec);
            }
        }
    }

    // ---- 更新弹道：统一查表分发（PROJECTILE_HANDLERS 处理器表见文件顶部）----
    for (let p of game.projectiles) {
        tryReflectProjectile(p, deltaSec); // 🧘 武僧超脱反弹：先于本帧移动检测（判定含本帧步长前瞻，命中结算前必先反弹）
        PROJECTILE_HANDLERS[p.isElectro ? 'electro' : p.isShard ? 'shard' : p.isHuntShot ? 'huntShot' : p.isRocket ? 'rocket' : p.isMortar ? 'mortar' : p.isBomber ? 'bomber' : p.isFireJump ? 'fireJump' : p.isPrincessSalvo ? 'princessSalvo' : p.isSpear ? 'spear' : p.isAxe ? 'axe' : p.isDart ? 'dart' : p.isSword ? 'sword' : 'tracking'].update(p, deltaSec);
    }
    game.projectiles = game.projectiles.filter(p => p.timer > 0);

    // ---- 更新穿透箭（游侠）----
    for (let a of game.pierceArrows) {
        if (tryReflectPierceArrow(a, deltaSec)) continue; // 🧘 超脱反弹：本帧从武僧位置重新出发（traveled=0）
        const prevTraveled = a.traveled;
        a.traveled += a.speed * deltaSec;
        // 精细碰撞检测：分段检查路径上的所有敌人
        const segStep = 10;
        const startSeg = Math.floor(prevTraveled / segStep);
        const endSeg = Math.ceil(a.traveled / segStep);
        for (let seg = startSeg; seg <= endSeg; seg++) {
            const t = seg * segStep;
            if (t < 0 || t > a.traveled) continue;
            const px = a.x + a.dx * t;
            const py = a.y + a.dy * t;
            for (let e of game.entities) {
                if (e.team === a.team || e.hp <= 0 || e._headHidden || a.hitIds.has(e.id)) continue;
                if (Math.hypot(px - e.x, py - e.y) < 16) {
                    const atkEnt = game.entities.find(en => en.id === a.ownerId) || null;
                    const dmgA = calcActualDmg(a.damage, atkEnt, e); // 穿透箭对每个目标单独吃减伤
                    e.hp -= dmgA;
                    spawnDmgNum(e.x, e.y - 20, dmgA);
                    a.hitIds.add(e.id);
                }
            }
        }
    }
    game.pierceArrows = game.pierceArrows.filter(a => a.traveled < a.maxTravel);

    // ---- 清理渔夫鱼线：关联渔夫已死或钩子已结束则移除 ----
    if (game.fishingLines && game.fishingLines.length) {
        game.fishingLines = game.fishingLines.filter(l => {
            const owner = game.entities.find(en => en.id === l.ownerId);
            return owner && owner.cardId === 'fisherman' && (owner._hookFlying || owner._hookPulling);
        });
    }

    // ---- 更新法术特效 ----
    for (let s of game.spellEffects) s.timer -= deltaSec;
    game.spellEffects = game.spellEffects.filter(s => s.timer > 0);

    // ---- 🐾 更新狂战士爆发·兽爪血痕（全局特效层，渲染在所有实体之上）----
    if (game.clawEffects && game.clawEffects.length) {
        for (let i = game.clawEffects.length - 1; i >= 0; i--) {
            game.clawEffects[i].timer -= deltaSec;
            if (game.clawEffects[i].timer <= 0) game.clawEffects.splice(i, 1);
        }
    }

    // ---- 👑 护驾：延迟1s后在小王子前方一点点召唤王子增援，并立即冲锋 ----
    if (game.princeGuardSpawns && game.princeGuardSpawns.length) {
        for (let i = game.princeGuardSpawns.length - 1; i >= 0; i--) {
            const ps = game.princeGuardSpawns[i];
            ps.timer -= deltaSec;
            if (ps.timer <= 0) {
                // 召唤者（小王子）阵亡则取消召唤
                const owner = game.entities.find(en => en.id === ps.ownerId && en.hp > 0);
                if (owner) {
                    // 召唤完成 → 解除护驾施法期的暂停移动（小王子恢复移动）
                    owner._holdMove = 0;
                    // 召唤点：小王子前方一点点（沿面向方向偏移15px，参考超骑落地偏移）
                    const spawnX = ps.x + ps.dirX * 15;
                    const spawnY = ps.y + ps.dirY * 15;
                    const r = createPrinceReinforcement(spawnX, spawnY, ps.team, { jitterX: 0, jitterY: 0 });
                    // 💨 快速冲锋105px（参考暗影刺客冲刺），沿途50伤害+击退
                    r._escortCharging = true;
                    r._escortRemain = 105;
                    r._escortDirX = ps.dirX;
                    r._escortDirY = ps.dirY;
                    r._escortHit = {};
                    game.entities.push(r);
                    game.spellEffects.push({ x: spawnX, y: spawnY, char: '⚔️', size: 28, timer: 0.4, maxTimer: 0.4 });
                }
                game.princeGuardSpawns.splice(i, 1);
            }
        }
    }

    // ---- 更新伤害飘字（上飘 + 淡出）----
    for (let n of game.dmgNumbers) {
        n.y -= 30 * deltaSec;
        n.timer -= deltaSec;
    }
    game.dmgNumbers = game.dmgNumbers.filter(n => n.timer > 0);

    // ---- 更新炸弹💣倒计时 & 爆炸 ----
    for (let i = game.bombs.length - 1; i >= 0; i--) {
        const bomb = game.bombs[i];
        bomb.timer -= deltaSec;
        if (bomb.timer <= 0) {
            // 💥 爆炸！范围伤害（radius：攻城人45 / 气球兵45同法师塔群攻）
            const radius = bomb.radius || 45;
            game.entities.forEach(e2 => {
                if (e2.team === bomb.team || e2.hp <= 0 || e2._headHidden) return;
                if (e2.flying) return; // 地面炸弹炸不到空中
                // 命中判定从受击表面起算（+受击半径）：大建筑（堡垒/主塔 hitRadius 28）贴脸炸弹也能炸到
                if (Math.hypot(bomb.x - e2.x, bomb.y - e2.y) <= radius + getHitRadius(e2)) {
                    const isBuilding = e2.type === 'tower' || e2.type === 'barrack' || e2.type === 'collector'
                        || e2.type === 'main_tower' || e2.type === 'bastion'; // 主塔/堡垒也归建筑（主塔已归为建筑）
                    // 自定义炸弹（如气球兵💣）用自身伤害；攻城人💣对建筑3倍伤害（60→180，含主塔/堡垒）
                    const sDmg2 = bomb.dmg !== undefined ? bomb.dmg : (isBuilding ? 180 : 60);
                    const atkEnt = game.entities.find(en => en.id === bomb.ownerId) || null;
                    const dmgB = calcActualDmg(sDmg2, atkEnt, e2); // 炸弹伤害统一收口
                    e2.hp -= dmgB;
                    spawnDmgNum(e2.x, e2.y - 20, dmgB);
                }
            });
            game.spellEffects.push({ x: bomb.x, y: bomb.y, char: '💥', size: 28, timer: 0.35, maxTimer: 0.35 });
            // 爆炸范围提示：淡红色小环（同群攻，静态真实范围，不覆盖爆炸特效）
            game.deployEffects.push({ x: bomb.x, y: bomb.y, radius: radius, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
            game.bombs.splice(i, 1);
        }
    }

    // ---- 🌧️ 箭雨飞行：三波各自独立（每波先等 launchDelay 倒计时，再完整飞向落点，落地结算一段伤害）----
    for (let i = game.arrowRainFlights.length - 1; i >= 0; i--) {
        const f = game.arrowRainFlights[i];
        if (f.launchDelay > 0) { f.launchDelay -= deltaSec; continue; } // 波次未到出发时刻（在主塔待命）
        tryReflectSpellFlight(f, deltaSec); // 🧘 武僧超脱：飞行中碰到光晕即掉头反弹（不再落地弹走）
        f.timer -= deltaSec;
        if (f.timer <= 0) {
            // 落地：接入单段下箭结算（strikesLeft=1；武僧超脱反弹已在飞行途中处理）
            game.arrowRainStrikes.push({
                x: f.x1, y: f.y1,
                radius: f.radius,
                team: f.team,
                damage: f.damage,
                mul: f.mul,
                strikesLeft: 1,
                interval: 0,
                timer: 0,
            });
            // 落地特效：箭束插地爆点 + 落点范围提示（淡红色小环，同哥布林飞桶）
            game.spellEffects.push({ x: f.x1, y: f.y1, char: '💥', size: 30, timer: 0.3, maxTimer: 0.3 });
            game.spellEffects.push({ x: f.x1, y: f.y1, char: '།', size: 18, timer: 0.4, maxTimer: 0.4 });
            game.deployEffects.push({ x: f.x1, y: f.y1, radius: f.radius, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
            game.arrowRainFlights.splice(i, 1);
        }
    }

    // ---- 箭雨：三段延迟伤害（每0.3秒一段，共3段，每段触发一次特效）----
    for (let i = game.arrowRainStrikes.length - 1; i >= 0; i--) {
        const s = game.arrowRainStrikes[i];
        s.timer -= deltaSec;
        while (s.timer <= 0 && s.strikesLeft > 0) {
            s.strikesLeft--;
            s.timer += s.interval;
            // 本段伤害（与火球/原箭雨一致：防御工事×towerDmgMul；武僧超脱反弹已在飞行途中处理）
            game.entities.forEach(e => {
                if (e.team === s.team || e.hp <= 0 || e._headHidden) return;
                if (dist(e, { x: s.x, y: s.y }) <= s.radius) {
                    const dmg2 = e.fortification ? s.damage * s.mul : s.damage;
                    const dmgS = calcActualDmg(dmg2, null, e); // 箭雨法术伤害统一收口（无攻击者）
                    e.hp -= dmgS;
                    spawnDmgNum(e.x, e.y - 20, dmgS);
                }
            });
            // 本段特效：箭雨
            for (let j = 0; j < 8; j++) {
                const angle = rand() * 2 * Math.PI;
                const r = rand() * s.radius * 0.7;
                game.spellEffects.push({
                    x: s.x + Math.cos(angle) * r,
                    y: s.y + Math.sin(angle) * r,
                    char: '།', size: 16,
                    timer: 0.5 + rand() * 0.3,
                    maxTimer: 0.8,
                });
            }
            // ★ 本段落地冲击（参考超骑落地效果）
            game.deployEffects.push({ x: s.x, y: s.y, radius: s.radius * 0.3, timer: 0.3, maxTimer: 0.3 });
        }
        if (s.strikesLeft <= 0) game.arrowRainStrikes.splice(i, 1);
    }

    // ---- 地震法术：持续3秒三段伤害（每1.5秒一段），对建筑10倍 ----
    for (let i = game.earthquakeStrikes.length - 1; i >= 0; i--) {
        const s = game.earthquakeStrikes[i];
        s.timer -= deltaSec;
        while (s.timer <= 0 && s.strikesLeft > 0) {
            s.strikesLeft--;
            s.timer += s.interval;
            game.entities.forEach(e => {
                if (e.team === s.team || e.hp <= 0 || e._headHidden) return;
                if (e.flying) return; // 🌍 地震只震地面，不影响空中单位
                if (dist(e, { x: s.x, y: s.y }) <= s.radius) {
                    // 建筑（各类塔/兵营/采集器）受10倍伤害；主塔/堡垒除外（仅基础伤害）
                    // 兵种也吃基础伤害
                    const isBuilding = e.type === 'tower' || e.type === 'barrack'
                        || e.type === 'collector';
                    const dmg2 = isBuilding ? s.damage * s.buildingMul : s.damage;
                    const dmgS = calcActualDmg(dmg2, null, e); // 地震法术伤害统一收口（无攻击者）
                    e.hp -= dmgS;
                    spawnDmgNum(e.x, e.y - 20, dmgS);
                }
            });
            // 每段震动特效：冲击圈 + 震点
            game.deployEffects.push({ x: s.x, y: s.y, radius: s.radius, timer: 0.35, maxTimer: 0.35 });
            game.spellEffects.push({ x: s.x, y: s.y, char: '💥', size: 30, timer: 0.35, maxTimer: 0.35 });
        }
        if (s.strikesLeft <= 0) game.earthquakeStrikes.splice(i, 1);
    }

    // ---- 大雷电：三道落雷（每0.5秒一道），按锁定顺序逐次劈下 ----
    for (let i = game.thunderStrikes.length - 1; i >= 0; i--) {
        const s = game.thunderStrikes[i];
        s.timer -= deltaSec;
        while (s.timer <= 0 && s.strikeIndex < s.targets.length) {
            s.timer += s.interval;
            const t = s.targets[s.strikeIndex];
            s.strikeIndex++;
            // 目标仍存活才结算伤害（已死亡则雷劈向原位置，仅保留特效）
            // 实体移除的唯一途径是 hp<=0 死亡结算（update.js 末尾 filter 重建数组但保留对象引用），故 hp>0 即视为存活，无需 includes 复查
            const alive = t && t.hp > 0;
            if (alive) {
                // 防御工事（主塔/堡垒）伤害为原伤害1/4，普通建筑与兵种满伤害
                const dmg2 = t.fortification ? s.damage * (s.towerDmgMul || 0.25) : s.damage;
                const dmgS = calcActualDmg(dmg2, null, t); // 大雷电法术伤害统一收口（无攻击者）
                t.hp -= dmgS;
                spawnDmgNum(t.x, t.y - 20, dmgS);
                // 💫 命中眩晕0.2秒（同电磁塔）
                t._stunTimer = Math.max(t._stunTimer || 0, 0.2);
            }
            const hitX = t ? t.x : s.x;
            const hitY = t ? t.y : s.y;
            // 落雷特效（参考雷电法师落地：从天而降的落雷）+ 落点⚡与冲击圈
            game.deployLightnings.push({ x: hitX, y: hitY, length: 150, timer: 0.35, maxTimer: 0.35 });
            game.spellEffects.push({ x: hitX, y: hitY, char: '⚡', size: 30, timer: 0.25, maxTimer: 0.25 });
            game.deployEffects.push({ x: hitX, y: hitY, radius: 24, timer: 0.3, maxTimer: 0.3 });
        }
        if (s.strikeIndex >= s.targets.length) game.thunderStrikes.splice(i, 1);
    }

    // ---- 蝙蝠法术：延迟分批召唤（释放1秒后开始，每0.2秒出2只，共6只）----
    for (let i = game.batSpawns.length - 1; i >= 0; i--) {
        const s = game.batSpawns[i];
        s.timer -= deltaSec;
        while (s.timer <= 0 && s.wavesLeft > 0) {
            s.timer += s.interval;
            s.wavesLeft--;
            for (let k = 0; k < s.perWave; k++) {
                const bx = s.x + (rand() - 0.5) * s.radius * 2;
                const by = s.y + (rand() - 0.5) * s.radius * 2;
                game.entities.push(createBat(bx, by, s.team));
            }
            // 每波出蝙蝠特效（小号、淡出快）
            game.spellEffects.push({ x: s.x, y: s.y, char: '🦇', size: 14, timer: 0.3, maxTimer: 0.3 });
        }
        if (s.wavesLeft <= 0) game.batSpawns.splice(i, 1);
    }

    // ---- 🛢️ 哥布林飞桶：木桶飞行结束 → 落地摔出3只近战哥布林（120°均匀分布在法术圈上）----
    for (let i = game.goblinBarrels.length - 1; i >= 0; i--) {
        const b = game.goblinBarrels[i];
        b.timer -= deltaSec;
        if (b.timer <= 0) {
            // 三只哥布林：占据落点法术圈圆环上三点，两两成120°（随机起始角）
            const baseAngle = rand() * Math.PI * 2;
            for (let g = 0; g < b.count; g++) {
                const ang = baseAngle + g * (Math.PI * 2 / 3);
                const gx = Math.min(W - 30, Math.max(30, b.x1 + Math.cos(ang) * b.radius));
                const gy = Math.min(H - 30, Math.max(30, b.y1 + Math.sin(ang) * b.radius));
                game.entities.push(createSummon(GOBLIN_MELEE_TEMPLATE, 'goblin_melee', gx, gy, b.team, { jitterX: 0, jitterY: 0 }));
            }
            // 落地特效：木桶碎裂爆点 + 木屑四溅
            game.spellEffects.push({ x: b.x1, y: b.y1, char: '💥', size: 36, timer: 0.35, maxTimer: 0.35 });
            game.spellEffects.push({ x: b.x1, y: b.y1, char: '🪵', size: 20, timer: 0.4, maxTimer: 0.4 });
            for (let j = 0; j < 4; j++) {
                const a = rand() * Math.PI * 2;
                const r = rand() * b.radius * 0.6;
                game.spellEffects.push({
                    x: b.x1 + Math.cos(a) * r,
                    y: b.y1 + Math.sin(a) * r,
                    char: '🪵', size: 11 + rand() * 4,
                    timer: 0.3 + rand() * 0.3,
                    maxTimer: 0.6,
                });
            }
            // 落地范围提示：淡红色小环（贴法术圈，同通用法术提示）
            game.deployEffects.push({ x: b.x1, y: b.y1, radius: b.radius, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
            game.goblinBarrels.splice(i, 1);
        }
    }

    // ---- 🔥 火球术：从主塔抛物线飞向落点（落地时伤害+击退+爆炸特效）----
    for (let i = game.fireballFlights.length - 1; i >= 0; i--) {
        const f = game.fireballFlights[i];
        tryReflectSpellFlight(f, deltaSec); // 🧘 武僧超脱：飞行中碰到光晕即掉头反弹（不再落地弹走）
        f.timer -= deltaSec;
        if (f.timer <= 0) {
            // 落地伤害（与箭雨一致：防御工事×towerDmgMul）
            game.entities.forEach(e => {
                if (e.team === f.team || e.hp <= 0 || e._headHidden) return;
                if (dist(e, { x: f.x, y: f.y }) <= f.radius) {
                    const dmg2 = e.fortification ? f.damage * f.mul : f.damage;
                    const dmgF = calcActualDmg(dmg2, null, e); // 火球法术伤害统一收口（无攻击者）
                    e.hp -= dmgF;
                    spawnDmgNum(e.x, e.y - 20, dmgF);
                    // ★ 火球击退（参考超骑落地击退）：仅兵种生效；标记剩余位移向量，帧驱动渐进滑动（位移式击退，不瞬移）
                    if (e.moveSpeed !== undefined && !e.fortification) {
                        const angle = Math.atan2(e.y - f.y, e.x - f.x);
                        e._kbX = Math.cos(angle) * f.knockback;
                        e._kbY = Math.sin(angle) * f.knockback;
                    }
                }
            });
            // ★ 落地特效：爆点 + 火焰 + 金色冲击圈 + 淡红色静态范围小红圈（两者并存）
            game.spellEffects.push({ x: f.x, y: f.y, char: '💥', size: 44, timer: 0.35, maxTimer: 0.35 });
            game.spellEffects.push({ x: f.x, y: f.y, char: '🔥', size: 40, timer: 0.6, maxTimer: 0.6 });
            game.deployEffects.push({ x: f.x, y: f.y, radius: f.radius, timer: 0.4, maxTimer: 0.4 });
            game.deployEffects.push({ x: f.x, y: f.y, radius: f.radius, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
            game.fireballFlights.splice(i, 1);
        }
    }

    // ---- 🚀 火箭法术：主塔开洞→火箭钻出垂直升空出屏→出屏等1s→落点影子越来越大→命中（5s，主塔/堡垒1/3，范围同火球；命中后蘑菇云1s消散）----
    for (let i = game.rocketFlights.length - 1; i >= 0; i--) {
        const r = game.rocketFlights[i];
        if (r.cloud) {
            // 蘑菇云尾段：1s 消散后移除
            r.timer -= deltaSec;
            if (r.timer <= 0) game.rocketFlights.splice(i, 1);
            continue;
        }
        if (r._reflected) {
            // 返回弹道：被武僧超脱反弹，直线飞向施法方大本营，命中结算（对主塔1/3）
            r.timer -= deltaSec;
            if (r.timer <= 0) {
                const base = game.entities.find(en => en.type === 'main_tower' && en.hp > 0
                    && Math.hypot(en.x - r._bx, en.y - r._by) < 5);
                if (base) {
                    const monk = game.entities.find(en => en.id === r._monkId && en.hp > 0);
                    const dmgR = calcActualDmg(Math.floor(r.damage * r.mul), monk || null, base); // 反弹伤害归属武僧
                    base.hp -= dmgR;
                    spawnDmgNum(base.x, base.y - 20, dmgR);
                }
                // 命中特效：爆点 + 金色冲击圈（反弹命中无淡红圈、无蘑菇云）
                game.spellEffects.push({ x: r._bx, y: r._by, char: '💥', size: 48, timer: 0.35, maxTimer: 0.35 });
                game.deployEffects.push({ x: r._bx, y: r._by, radius: r.radius, timer: 0.4, maxTimer: 0.4 });
                game.rocketFlights.splice(i, 1);
            }
            continue;
        }
        tryReflectRocket(r, deltaSec); // 🧘 武僧超脱：俯冲段碰到光晕即掉头反弹（原落点无伤害）
        r.timer -= deltaSec;
        if (r.timer <= 0) {
            // 命中：范围伤害（与火球一致：防御工事×towerDmgMul，范围同火球术）+ 击退（比火球更强）
            game.entities.forEach(e => {
                if (e.team === r.team || e.hp <= 0 || e._headHidden) return;
                if (dist(e, { x: r.x, y: r.y }) <= r.radius) {
                    const dmg2 = e.fortification ? r.damage * r.mul : r.damage;
                    const dmgR = calcActualDmg(dmg2, null, e); // 火箭法术伤害统一收口（无攻击者）
                    e.hp -= dmgR;
                    spawnDmgNum(e.x, e.y - 20, dmgR);
                    // ★ 火箭击退（比火球更强）：仅兵种生效；标记剩余位移向量，帧驱动渐进滑动（位移式击退，不瞬移）
                    if (e.moveSpeed !== undefined && !e.fortification) {
                        const angle = Math.atan2(e.y - r.y, e.x - r.x);
                        e._kbX = Math.cos(angle) * r.knockback;
                        e._kbY = Math.sin(angle) * r.knockback;
                    }
                }
            });
            // 命中特效：爆点 + 金色冲击圈（淡红提示圈已在释放时生成并随弹道同步消失）
            game.spellEffects.push({ x: r.x, y: r.y, char: '💥', size: 48, timer: 0.35, maxTimer: 0.35 });
            game.deployEffects.push({ x: r.x, y: r.y, radius: r.radius, timer: 0.4, maxTimer: 0.4 });
            r.cloud = true;
            r.timer = 1; r.maxTimer = 1; // 蘑菇云持续1s
        }
    }

    // ---- 🪵 滚木：竖直木头横向滚动前进 + 沿途命中判定（法术影响范围：长=滚动扫过的560px区间，宽=剑仙攻击范围直径65；只打地面单位不影响空中；每个敌人仅一次伤害一次击退）----
    for (let i = game.logRolls.length - 1; i >= 0; i--) {
        const lg = game.logRolls[i];
        const prevX = lg.x;
        lg.x += lg.dir * lg.speed * deltaSec;
        // 命中判定：敌人 y 方向在影响范围宽内（±halfW=32.5），x 方向在本帧木头扫过的区间内（木头厚度±logWidth/2，防高速穿透漏判）
        const xMin = Math.min(prevX, lg.x) - lg.logWidth / 2;
        const xMax = Math.max(prevX, lg.x) + lg.logWidth / 2;
        for (const e of game.entities) {
            if (e.team === lg.team || e.hp <= 0 || e._headHidden) continue;
            if (e.flying) continue; // 滚木只打地面，不影响空中单位
            if (lg.hitIds.has(e.id)) continue; // 每个敌人仅结算一次
            if (e.x >= xMin && e.x <= xMax && Math.abs(e.y - lg.y) <= lg.halfW) {
                lg.hitIds.add(e.id);
                // 主塔/堡垒（防御工事）法术伤害减半，普通建筑与兵种满额；统一走 calcActualDmg 吃目标减伤（无攻击者）
                const dmgL = calcActualDmg(e.fortification ? lg.damage * lg.mul : lg.damage, null, e);
                e.hp -= dmgL;
                spawnDmgNum(e.x, e.y - 20, dmgL);
                // 击退（沿滚动方向推30px，位移式滑动不瞬移）：仅兵种生效（建筑/主塔不被推）；标记剩余位移向量，由帧驱动渐进应用
                if (e.moveSpeed !== undefined && !e.fortification) {
                    e._kbX = lg.dir * lg.knockback;
                    e._kbY = 0;
                }
                // 命中特效：小木屑 + 撞击
                game.spellEffects.push({ x: e.x, y: e.y - 6, char: '🪵', size: 12, timer: 0.25, maxTimer: 0.25 });
                game.spellEffects.push({ x: e.x, y: e.y + 4, char: '💥', size: 10, timer: 0.2, maxTimer: 0.2 });
            }
        }
        // 滚动距离耗尽（滚到头了）→ 消散
        if (Math.abs(lg.x - lg.startX) >= lg.distance) game.logRolls.splice(i, 1);
    }

    // ---- 更新闪电链特效 ----
    for (let c of game.lightningChains) c.timer -= deltaSec;
    game.lightningChains = game.lightningChains.filter(c => c.timer > 0);

    // ---- 更新落雷特效（雷电法师部署）----
    for (let d of game.deployLightnings) d.timer -= deltaSec;
    game.deployLightnings = game.deployLightnings.filter(d => d.timer > 0);

    // ---- 更新范围冲击特效（超级骑士部署）----
    for (let d of game.deployEffects) d.timer -= deltaSec;
    game.deployEffects = game.deployEffects.filter(d => d.timer > 0);

    // ---- 胜负判定（通过主塔实体判断）----
    const playerMainTower = game.entities.find(e => e.type === 'main_tower' && e.team === 'player');
    const aiMainTower = game.entities.find(e => e.type === 'main_tower' && e.team === 'ai');
    if (playerMainTower && (playerMainTower.hp <= 0 || isNaN(playerMainTower.hp))) {
        game.gameOver = true;
        game.winner = 'ai';
        playerMainTower.hp = 0;
    } else if (aiMainTower && (aiMainTower.hp <= 0 || isNaN(aiMainTower.hp))) {
        game.gameOver = true;
        game.winner = 'player';
        aiMainTower.hp = 0;
    }

    // ---- 同队单位碰撞分离（防叠加）----
    applySeparation();

    // 💥 狂战士爆发：锁血最低 1（爆发期间任何来源的伤害致死都会在此拉回，先于死亡结算 resolveDeaths）
    for (const e of game.entities) {
        if (e.cardId === 'berserker' && e._berserkTimer > 0 && e.hp <= 0) e.hp = 1;
    }

    // ---- 死亡结算（配置驱动 DEATH_RESOLVERS，见文件顶部；必须在死亡清理之前）----
    resolveDeaths();

    // 🔷 复制体生命/护盾锁：复制体（含冥王升级等任何途径）hp/maxHp、shield/maxShield 不允许超过 1——只向下压、不向上拉（不复活已死亡的0血单位）
    for (const e of game.entities) {
        if (e.isCopy) {
            if (e.maxHp > 1) e.maxHp = 1;
            if (e.hp > 1) e.hp = 1;
            if (e.maxShield > 1) e.maxShield = 1;
            if (e.shield > 1) e.shield = 1;
        }
    }

    // ---- 🕊️ 精英主动技能：死亡结算（本体与🪞镜像精英各自独立，互不影响）----
    //    本体死亡 → 恢复本体卡（deploy + 死亡冷却，死亡后才计时）；镜像精英不计入"本体存活"判断
    //    🪞镜像精英死亡 → 只清理镜像槽（镜像法术卡恢复为普通镜像法术），不影响本体槽
    for (const e of game.entities) {
        if (e.hp > 0 || isNaN(e.hp)) continue;
        if (e.isCopy) continue;                       // 复制法术复制体不触发恢复
        if (e.isMirrored) {
            // 🪞 镜像精英死亡：删除独立镜像槽 → 镜像卡恢复为镜像法术；
            //    🕊️ 精英镜像冷却从此刻才开始读秒（继承该精英卡的冷却，如剑仙15s），读秒期间镜像卡为黑色不可用
            const esM = game.eliteSkills[e.team];
            if (esM && esM['mirror_' + e.cardId]) delete esM['mirror_' + e.cardId];
            const dCard = CARDS[e.cardId];
            if (dCard && dCard.cooldown) {
                setMirrorCooldown(e.team, dCard.cooldown);
            }
            continue;
        }
        const card = CARDS[e.cardId];
        if (!card || !card.activeSkill) continue;
        // 场上还有其他存活的本体 → 暂不恢复（镜像精英不计入，本体槽独立）
        if (game.entities.some(x => x !== e && x.cardId === e.cardId && x.team === e.team && x.hp > 0 && !x.isCopy && !x.isMirrored)) continue;
        const es = game.eliteSkills[e.team];
        if (!es || !es[e.cardId]) continue;
        const st = es[e.cardId];
        st.mode = 'deploy';
        st.cdLeft = card.cooldown;       // 死亡后才开始冷却计时（15秒）
        st.skillCdLeft = 0;              // 清除技能冷却，重新部署后御剑可直接使用
        // 🛕 神赐：神庙死亡 → 费用重置11（不在场不累计，重新部署后从11重新减费）
        if (card.activeSkill.id === 'goblin_bless') st.blessCost = card.activeSkill.cost;
    }

    // ---- 移除死亡实体（同时过滤掉 hp 为 NaN 的脏数据）----
    game.entities = game.entities.filter(e => e.hp > 0 && !isNaN(e.hp));

    // ---- 堡垒爆破 → 圣水加速（帮扶机制：丢堡方加速，敌方不变）----
    const alivePlayerBastions = game.entities.filter(e => e.type === 'bastion' && e.team === 'player').length;
    const aliveAiBastions    = game.entities.filter(e => e.type === 'bastion' && e.team === 'ai').length;
    game.bastionsLost.player = 2 - alivePlayerBastions;
    game.bastionsLost.ai     = 2 - aliveAiBastions;

    // 各边独立计算倍率——谁丢堡谁加速
    game.elixirMultiplier.player = game.bastionsLost.player >= 2 ? 1.4
                               : game.bastionsLost.player >= 1 ? 1.2 : 1.0;
    game.elixirMultiplier.ai    = game.bastionsLost.ai >= 2 ? 1.4
                               : game.bastionsLost.ai >= 1 ? 1.2 : 1.0;

    // 触发告警提示（仅在有新堡垒被摧毁时弹出）
    const totalLost = game.bastionsLost.player + game.bastionsLost.ai;
    let promptLevel = totalLost >= 2 ? 2 : totalLost >= 1 ? 1 : 0;
    if (promptLevel > game.lastBastionPromptLevel) {
        game.lastBastionPromptLevel = promptLevel;
        showBastionAlert();
    }

    // ---- 更新 UI 圣水显示 ----
    document.getElementById('playerElixirDisplay').textContent = game.elixir.player.toFixed(1);
    document.getElementById('aiElixirDisplay').textContent = game.elixir.ai.toFixed(1);

    // ---- 双人 / 联机模式：更新上方（红方）圣水 ----
    if (game.gameMode === 'local_multi' || game.gameMode === 'online') {
        const topDisplay = document.getElementById('topPlayerElixirDisplay');
        if (topDisplay) topDisplay.textContent = game.elixir.ai.toFixed(1);
    }

    // ---- 更新卡牌冷却显示（UI 状态刷新，与圣水同属帧驱动 UI 更新）----
    if (typeof refreshCardCooldowns === 'function') refreshCardCooldowns();
    // 双人 / 联机模式：刷新上方卡牌冷却
    if ((game.gameMode === 'local_multi' || game.gameMode === 'online') && typeof refreshTopCardCooldowns === 'function') {
        refreshTopCardCooldowns();
    }
}

/* ---- 同队单位碰撞分离（所有实体类型参与，静态实体只推不移动） ---- */
const SEPARATION_FORCE = 0.3;     // 每帧推动比例（越小越稳）
const MASS_RATIO = 2.25;          // 质量悬殊阈值：一方≥对方2.25倍(半径1.5倍)时，重方视为不可推动

/** 获取实体碰撞半径（按类型/卡牌动态取值） */
function getCollisionRadius(e) {
    if (e.type === 'bastion' || e.type === 'main_tower') return 28;
    if (e.type === 'tower' || e.type === 'barrack' || e.type === 'collector') return 15;
    if (e.cardId === 'giant' || e.cardId === 'water_carrier') return 15;
    if (e.cardId === 'goblin' || e.cardId === 'goblin_gang' || e.cardId === 'skeleton_guard' || e.cardId === 'small_water_carrier') return 8;
    return 10;  // 默认普通单位
}

/** 判断实体是否为静态（不可被推动） */
function isStaticEntity(e) {
    return e.type === 'bastion' || e.type === 'main_tower'
        || e.type === 'tower' || e.type === 'barrack' || e.type === 'collector';
}

/** 通用质量：静态实体无限重（不可推动）；单位质量=碰撞半径²，新单位自动推导、零配置 */
function getMass(e) {
    return isStaticEntity(e) ? Infinity : getCollisionRadius(e) * getCollisionRadius(e);
}

/** 推力分配比例：悬殊时重方0（纹丝不动）、轻方1（全收）；相近体型按质量反比分摊 */
function sepShare(mine, other) {
    if (other >= mine * MASS_RATIO) return 1;  // 对方远重于我：我全收推力（被弹开）
    if (mine >= other * MASS_RATIO) return 0;  // 我远重于对方：我纹丝不动
    return other / (mine + other);             // 相近：按质量反比
}

function applySeparation() {
    const allUnits = game.entities.filter(e => e.hp > 0);
    for (let i = 0; i < allUnits.length; i++) {
        for (let j = i + 1; j < allUnits.length; j++) {
            const a = allUnits[i], b = allUnits[j];
            // 所有实体参与碰撞分离（包括建筑），视觉上近战单位会被建筑推开
            // 但攻击判定已减去建筑的受击半径 hitRadius，使近战单位能正常攻击
            const aStatic = isStaticEntity(a);
            const bStatic = isStaticEntity(b);
            if (aStatic && bStatic) continue; // 建筑互撞跳过
            // 飞行单位只与飞行单位碰撞，不和地面/建筑互相挤
            // ⚠️ 用布尔值比较：地面单位(flying:false)与建筑(无flying字段)才能正常碰撞，
            //    否则 false !== undefined 会误跳过建筑碰撞，导致单位穿过己方堡垒/建筑
            if (!!a.flying !== !!b.flying) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const dist = Math.hypot(dx, dy);
            const minDist = getCollisionRadius(a) + getCollisionRadius(b);
            if (dist < 1 || dist >= minDist) continue;
            const overlap = minDist - dist;
            const pushX = (dx / dist) * overlap * SEPARATION_FORCE;
            const pushY = (dy / dist) * overlap * SEPARATION_FORCE;
            // 按质量分配推力：大单位重、被推得少；悬殊时重方纹丝不动（静态实体无限重自动全收）
            const wa = sepShare(getMass(a), getMass(b));  // a 承受的推力比例
            const wb = sepShare(getMass(b), getMass(a));  // b 承受的推力比例
            if (!isStaticEntity(a)) {
                a.x -= pushX * wa;
                a.y -= pushY * wa;
            }
            if (!isStaticEntity(b)) {
                b.x += pushX * wb;
                b.y += pushY * wb;
            }
            // 边界限制（仅对非静态实体）
            const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
            if (!isStaticEntity(a)) {
                a.x = clamp(a.x, 25, W - 25);
                a.y = clamp(a.y, 25, H - 25);
            }
            if (!isStaticEntity(b)) {
                b.x = clamp(b.x, 25, W - 25);
                b.y = clamp(b.y, 25, H - 25);
            }
        }
    }
}

/* ---- 辅助函数 ---- */

/** 获取受击半径（攻击距离从目标表面起算，让近战单位能贴到建筑边缘就攻击） */
function getHitRadius(e) {
    // 建筑有自定义受击半径则用自定义；单位缺省用碰撞半径，攻击自动从表面起算，
    // 避免小单位被碰撞分离挡在攻击范围外（近战贴脸即可攻击）
    return e.hitRadius || getCollisionRadius(e) || 0;
}

/** 判断单位能否攻击飞行 */
function canTargetFlying(entity) {
    if (entity.canHitAir) return true;                  // 蝙蝠：近战但可对空
    if (entity.groundOnly) return false;                // 炮车：只对地
    if (entity.type === 'bastion') return true;            // 堡垒对空对地
    if (entity.type === 'tower' && entity.cardId !== 'mage_tower' && entity.cardId !== 'inferno_tower' && entity.cardId !== 'tesla_tower') return false; // 炮塔默认只能对地，法师塔/地狱塔/电磁塔可对空
    if (entity.range <= 30) return false;       // 近战不能打飞行
    // 🕊️ 剑仙：地面近战不能对空；御剑升空（flying）后可对空
    if (entity.cardId === 'sword_immortal' && !entity.flying) return false;
    return true;                                 // 远程可以打飞行
}

/** 通用寻敌：索最近敌人（三类通吃），巨人只索建筑，飞行免疫保留，且跳过隐身幽灵 */
function findTarget(entity) {
    // 治疗兵不打人：永不寻敌方目标（只治疗友军，见 findHealTarget），也避免收编后重评估抢走友军治疗目标
    if (entity.type === 'healer') return null;
    const enemies = game.entities.filter(e =>
        e.team !== entity.team && e.hp > 0 && !e._stealthed
    );

    // 巨人：只打建筑（主塔、堡垒、防御塔、兵营、收集器）
    if (entity.targetMode === 'buildings') {
        const buildings = enemies.filter(
            e => e.type === 'main_tower' || e.type === 'bastion'
              || e.type === 'tower' || e.type === 'barrack' || e.type === 'collector'
        ).filter(e => !(e.flying && !canTargetFlying(entity))); // 🕊️ 空中建筑（法术屏障）：打不到空中的锁定建筑单位（地面近战/气球兵）不锁定；可对空的（熔岩猎犬远程）照常锁定
        return buildings.sort((a, b) => dist(entity, a) - dist(entity, b))[0] || null;
    }

    // 不能打飞行 → 过滤飞行，否则全目标
    const valid = canTargetFlying(entity) ? enemies : enemies.filter(e => !e.flying);
    return valid.sort((a, b) => dist(entity, a) - dist(entity, b))[0] || null;
}

/** 防御塔寻敌（与通用逻辑一致），跳过隐身幽灵；支持 minRange 最小射程（太近打不到，如迫击炮） */
function findTargetInRangeForTower(tower, range) {
    const enemies = game.entities.filter(e =>
        e.team !== tower.team && e.hp > 0 && !e._stealthed && dist(tower, e) <= range
        && !(tower.minRange && dist(tower, e) < tower.minRange)
    );
    const valid = canTargetFlying(tower) ? enemies : enemies.filter(e => !e.flying);
    return valid.sort((a, b) => dist(tower, a) - dist(tower, b))[0] || null;
}

/** 治疗兵寻友：寻找范围内受伤友军（跳过防御工事——主塔和堡垒不可被治疗）；🚩收编后锁定营地圈内友军 */
function findHealTarget(healer) {
    // 🚩 收编：治疗索敌约束在营地索敌圈内（同火豆的圈约束），圈外受伤友军不追；★新增：自身治疗范围内（e.range）受伤友军同样可治疗
    const camp = healer._campFlag
        ? game.entities.find(en => en.id === healer._campId && en.hp > 0)
        : null;
    const allies = game.entities.filter(
        e => e.team === healer.team && e.hp > 0 && e.hp < e.maxHp
          && !e.fortification && e.cardId !== 'tesla_tower'
          && (!camp || Math.hypot(e.x - camp.x, e.y - camp.y) <= (CARDS.camp.campDetectR || 200)
                        || Math.hypot(e.x - healer.x, e.y - healer.y) <= (healer.range || 0))
    );
    return allies.sort((a, b) => dist(healer, a) - dist(healer, b))[0] || null;
}

/** 攻击目标（含溅射伤害 + 弹道特效 + 雷电法师连锁闪电 + 冰豆减速 + 幽灵隐身解除） */
function attackTroop(attacker, target) {
    // 电磁塔未露头（隐藏）时免疫一切普攻/弹道
    if (target._headHidden) return;
    // 🕊️ 防御检查：目标已升空（如剑仙御剑）且攻击者不能对空 → 打不到，直接跳过结算
    if (target.flying && !canTargetFlying(attacker)) return;
    // 🥷 忍者：记录本次攻击；第三次发射后由攻击循环立即触发翻滚
    if (attacker.cardId === 'ninja') attacker._ninjaAttackCount = (attacker._ninjaAttackCount || 0) + 1;
    // 🗡️ 剑仙：攻击触发刺击特效（剑向前刺一下再缩回，仅特效不影响结算）
    if (attacker.cardId === 'sword_immortal') attacker._stabTimer = 0.3;
    // 🪵 木桶护卫：攻击触发长矛前戳特效（仅视觉，不改变伤害判定）
    if (attacker.cardId === 'barrel_guard') attacker._spearTimer = 0.3;
    // 🏹 弓箭女皇：攻击触发拉弓动画（0.17s蓄力拉满 → 放箭回弹0.18s，仅特效不影响结算）
    if (attacker.cardId === 'bow_queen') attacker._drawBowTimer = 0.35;
    // 🥋 武僧：攻击触发挥掌特效（推掌向前推出再缩回，仅特效不影响结算，狂战士同款）
    if (attacker.cardId === 'monk') {
        attacker._swingTimer = 0.3;
        // 💪 三连击强化：每攻击两次，第三次（%3==0）为强化普攻——伤害90+击退25px（参考超骑跃击）
        attacker._punchCount = (attacker._punchCount || 0) + 1;
        if (attacker._punchCount % 3 === 0) {
            attacker._strongPunchTimer = 0.3; // 渲染：手掌浮现大🫸虚影推向敌人
        }
    }
    // 🗡️ 狂战士：攻击触发刺击特效（双刀向前刺出再缩回，仅特效不影响结算，剑仙同款）
    if (attacker.cardId === 'berserker') {
        attacker._swingTimer = 0.3;
        // 🐾 普通攻击与爆发共用：敌人接触点一组三条爪痕、左右交替抓；特效时长适配当前攻速
        //    （爆发攻速0.2s→0.2s快节奏密集X；普通攻速0.6s→0.6s慢节奏，爪痕在下一次攻击前刚好消散）
        //    特效推入全局 clawEffects 列表 → 渲染在所有实体之上，不被建模遮挡
        attacker._clawFlip = !attacker._clawFlip;          // 左右交替
        const clawA = Math.atan2(target.y - attacker.y, target.x - attacker.x);
        const clawR = getHitRadius(target) || 8;
        const clawDur = attacker._berserkTimer > 0 ? 0.2 : (attacker.atkSpeed || 0.6);
        (game.clawEffects = game.clawEffects || []).push({
            x: target.x - Math.cos(clawA) * clawR * 0.6,
            y: target.y - Math.sin(clawA) * clawR * 0.6,
            dir: clawA,                                    // 抓痕方向（狂战士→敌人）
            flip: attacker._clawFlip,
            timer: clawDur, maxTimer: clawDur,
        });
    }
    // ---- 冥王：群体攻击——攻击范围内所有敌人全额伤害（含受击半径补偿）----
    if (attacker.cardId === 'hades') {
        const range = attacker.range || 30;
        const hitsAir = canTargetFlying(attacker); // 冥王近战不能对空
        game.entities.forEach(e => {
            if (e.team === attacker.team || e.hp <= 0 || e._headHidden) return;
            if (e.flying && !hitsAir) return; // 群体攻击不波及空中
            // 和原攻击判定一致：dist - hitRadius <= range
            if (dist(attacker, e) - getHitRadius(e) <= range) {
                const ad = calcActualDmg(attacker.atk, attacker, e);
                e.hp -= ad;
                spawnDmgNum(e.x, e.y - 20, ad);
            }
        });
        // 群体攻击特效
        game.spellEffects.push({ x: attacker.x, y: attacker.y, char: '💀', size: 36, timer: 0.35, maxTimer: 0.35 });
        // 范围提示：淡红色小环（同群攻，静态真实范围）
        game.deployEffects.push({ x: attacker.x, y: attacker.y, radius: range, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
        return; // 已处理群体伤害，跳过后续单体和溅射逻辑
    }

    // 远程弹道单位：护盾/减伤延迟到弹道命中才统一结算（不在此预结算）
    // （否则开头预结算会提前消耗目标护盾，弹道命中再结算一次 = 一次攻击双吃，如游侠穿透箭对护盾单位）
    const isRanged = (attacker.range || 0) > 50;
    // 弹道单位（真实弹道，伤害延迟到弹道命中才结算）：与下方弹道发射逻辑一一对应
    const rangedShot = attacker.cardId === 'archer' || attacker.cardId === 'ranger'
        || attacker.cardId === 'cannon_tower' || attacker.cardId === 'crossbow' || attacker.cardId === 'dragon'
        || attacker.cardId === 'cannon_cart'  // 🛡️ 炮车：炮塔同款黑色实心炮弹弹道（命中才结算伤害）
        || (attacker.flying && (attacker.range || 0) > 50)  // 🦇 空中近战分支：飞行但射程≤50（蝙蝠/气球兵/苍蝇海/战斗天使/剑仙御剑等）不发射弹道，走即时近战结算；能否对空看各自描述（canHitAir等）
        || attacker.cardId === 'firework_gunner' || attacker.cardId === 'hunter'
        || attacker.cardId === 'witch' || attacker.cardId === 'night_witch'
        || attacker.cardId === 'goblin_thrower'  // 🔱 哥布林投矛手：投矛直线弹道（命中才结算伤害）
        || attacker.cardId === 'goblin_blowgun'  // 🎯 哥布林吹箭手：吹箭直线弹道（命中才结算伤害）
        || attacker.cardId === 'fat_tiger'  // 🪓 飞斧胖虎：飞斧直线往返弹道（命中才结算伤害，否则攻击瞬间+去程+返程三吃）
        || attacker.cardId === 'main_tower_guard'  // 🛡️ 主塔守卫：堡垒同款弹道（命中才结算伤害）
        || attacker.cardId === 'little_prince'  // 👑 小王子：十字弩同款追踪弹道（命中才结算伤害）
        || attacker.cardId === 'bow_queen'  // 🏹 弓箭女皇：绿色细追踪箭（命中才结算伤害）
        || attacker.cardId === 'princess'  // 👸 公主：群箭迫击炮弹道（命中落点才结算伤害）
        || attacker.cardId === 'goblin_bomber'  // 🧨 哥布林爆破手：迫击炮同款抛物线（命中落点才结算伤害）
        || attacker.cardId === 'ninja';  // 🥷 忍者：追踪飞镖（命中才结算伤害）
    // 弹道单位不在开头立即结算（护盾/减伤在命中时才吃）；近战/即时结算单位在此立即结算
    // 🗡️ 剑仙：御剑期间大剑强化——普攻伤害 75→80（御剑结束 _rideSword=false 自动还原75）
    // 💥 狂战士爆发：伤害固定 30（爆发结束 _berserkTimer<=0 自动还原 e.atk）
    // 🥋 武僧强化普攻：三连击第3下伤害固定 90（_punchCount %3==0）
    // 🌫️ 弓箭女皇隐身：攻击力提升200%（50→150，隐身结束 _queenStealthTimer<=0 自动还原 e.atk）
    const atkVal = attacker.cardId === 'sword_immortal' && attacker._rideSword ? 80
        : (attacker.cardId === 'berserker' && attacker._berserkTimer > 0) ? 30
        : (attacker.cardId === 'monk' && (attacker._punchCount || 0) % 3 === 0) ? 90
        : (attacker.cardId === 'bow_queen' && (attacker._queenStealthTimer || 0) > 0) ? attacker.atk * 3
        : attacker.atk;
    let dmg = rangedShot ? 0 : calcActualDmg(atkVal, attacker, target);

    // ---- 矿工：对主塔/堡垒（防御工事）伤害 1/3 ----
    if (attacker.cardId === 'miner' && target.fortification && attacker.towerDmgMul !== undefined) {
        dmg = Math.floor(dmg * attacker.towerDmgMul);
    }

    // ---- 电车小队：单体近战命中→眩晕0.5秒💫 + 电磁塔同款闪电链特效⚡ ----
    if (attacker.cardId === 'tram_squad') {
        target._stunTimer = Math.max(target._stunTimer || 0, 0.5);
        game.lightningChains.push({
            points: [
                { x: attacker.x, y: attacker.y },
                { x: target.x, y: target.y }
            ],
            timer: 0.25,
            maxTimer: 0.25
        });
    }

    // 远程弹道单位：伤害延迟到弹道命中才结算（不在此立即扣血，见上方弹道发射逻辑）
    // 游侠穿透箭 / 弓箭手·炮塔·飞龙·飞行单位弹道，均命中后才扣血
    // 战斗天使例外：近战飞行（range 25），直接近战挥击结算
    // 暗夜女巫/女巫：远程能量球弹道，命中后才扣血（不触发近战格挡反弹）

    // ---- 幽灵：出手即现身（解除隐身、重置计时）----
    //     放在浪人反弹判定之前：被格挡反弹也算出手，避免反弹 return 跳过导致计时不重置而提前隐身
    if (attacker.cardId === 'ghost' && attacker._stealthed) {
        attacker._stealthed = false;
        attacker._stealthTimer = 0;
    }

    // ---- 浪人：格挡近战伤害并200%反弹（3.5s冷却，只反弹贴身物理攻击）----
    //      近战判定 = 非弹道远程 且 非远射程：
    //      · 弹道远程（弓箭/能量球/飞行🔥弹道，含蝙蝠等飞行单位）→ rangedShot 不反弹
    //      · 远射程（巫师/雷电法师/电车小队/炮车等即时结算远程）→ isRanged 不反弹
    //      · 两者皆非（地面近战兵/战斗天使贴身挥击）→ 反弹
    if (!rangedShot && !isRanged && target.cardId === 'ronin' && (target._reflectTimer || 0) <= 0) {
        target._reflectTimer = CARDS.ronin.reflectCooldown || 3.5;
        // 骑士冲锋：额外3倍伤害也属于本次近战攻击，一并纳入反弹基数（总伤害400%）
        let reflectBase = dmg;
        if (attacker.cardId === 'knight') {
            attacker._chargeTimer = 3.5; // 被格挡也算出手：重置冲锋计时
            if (attacker._charging) {
                reflectBase += calcActualDmg(attacker.atk * 3, attacker, target); // 额外3倍
                attacker._charging = false; // 冲锋被格挡打断，退出冲锋
            }
        }
        const rd = Math.floor(reflectBase * (CARDS.ronin.reflectMultiplier || 2));
        const rdDmg = calcActualDmg(rd, target, attacker); // 反弹伤害直接结算（不再触发反弹判定），吃被反弹者减伤
        attacker.hp -= rdDmg;
        spawnDmgNum(attacker.x, attacker.y - 20, rdDmg);
        // 特效：🚫 出现在被反弹者（攻击者）头顶
        game.spellEffects.push({ x: attacker.x, y: attacker.y - 20, char: '🚫', size: 30, color: '#ff4757', timer: 0.4, maxTimer: 0.4 });
        return; // 本次近战攻击被格挡：跳过后续伤害结算（含骑士冲锋额外伤害）
    }

    if (!rangedShot) {
        target.hp -= dmg;
        spawnDmgNum(target.x, target.y - 20, dmg);
        // 🥋 武僧强化普攻：击退目标25px（参考超骑跃击，仅兵种生效）；标记剩余位移向量，帧驱动渐进滑动（位移式击退，不瞬移）
        if (attacker.cardId === 'monk' && (attacker._punchCount || 0) % 3 === 0
            && target.moveSpeed !== undefined && !target.fortification) {
            const kbAngle = Math.atan2(target.y - attacker.y, target.x - attacker.x);
            target._kbX = Math.cos(kbAngle) * 25;
            target._kbY = Math.sin(kbAngle) * 25;
        }
        // 🎈 气球兵：炸弹下落攻击特效（纯视觉无伤害、非弹道实体）——
        //     💣 从气球底部掉到脚下阴影处（下落28px）→ 💥 爆炸放大淡出；总时长0.5s适配2.0s攻速节奏
        if (attacker.cardId === 'balloon') {
            game.spellEffects.push({
                type: 'balloon_bomb',
                x: attacker.x,
                y0: attacker.y + 10, // 气球底部
                y1: attacker.y + 38, // 阴影处
                char: '💣', size: 16,
                timer: 0.5, maxTimer: 0.5,
            });
        }
    }

    // ---- 骑士：冲锋状态伤害400%（额外3倍），攻击后退出冲锋 ----
    //      任何攻击都重置冲锋计时 → 只有脱战（3.5秒未攻击）才能再次冲锋
    if (attacker.cardId === 'knight') {
        attacker._chargeTimer = 3.5; // 任何攻击都重置计时（脱战3.5秒才能再次冲锋）
        if (attacker._charging) {
            const cDmg = calcActualDmg(attacker.atk * 3, attacker, target);
            target.hp -= cDmg; // 额外3倍 = 总伤害400%
            spawnDmgNum(target.x, target.y - 20, cDmg);
            game.spellEffects.push({ x: target.x, y: target.y, char: '✦', size: 36, color: '#ff6600', timer: 0.25, maxTimer: 0.25 });
            attacker._charging = false;  // 退出冲锋
        }
    }

    // ---- 战斗天使：每次攻击触发持续1.2秒治疗（每0.3秒一次共4次，每次10；绿色光环仅治疗期间显示）----
    if (attacker.cardId === 'battle_angel') {
        attacker._healActive = CARDS.battle_angel.healDuration || 1.2;
        attacker._healTicks = CARDS.battle_angel.healTicks || 4;
        attacker._healTickTimer = CARDS.battle_angel.healInterval || 0.3; // 首帧即触发第1次
        attacker._healAmount = CARDS.battle_angel.attackHeal || 10;
        game.spellEffects.push({ x: attacker.x, y: attacker.y - 15, char: '💚', size: 18, timer: 0.3, maxTimer: 0.3 });
    }

    // ---- 冰豆：被攻击时让攻击者减速80%，头顶❄️标记持续1.5秒 ----
    if (target._iceBean) {
        attacker.slowFactor = 0.2;    // 减速80%
        attacker.slowTimer = 1.5;     // 持续1.5秒
    }

    // ---- 雷电法师：连锁闪电 ----
    if (attacker.cardId === 'lightning_wizard') {
        // 主目标眩晕0.5秒💫
        target._stunTimer = Math.max(target._stunTimer || 0, 0.5);

        const card = CARDS[attacker.cardId];
        const chainRange = card.chainRange || 50;
        const chainCount = card.chainCount || 2;
        const chainDmgMul = card.chainDmgMul || 0.65;

        const chainPoints = [{ x: attacker.x, y: attacker.y }, { x: target.x, y: target.y }];
        let currentTarget = target;
        const hitIds = new Set([target.id]);

        for (let i = 0; i < chainCount; i++) {
            let best = null, bestDist = Infinity;
            for (const e of game.entities) {
                if (e.team === attacker.team || e.hp <= 0 || e._headHidden) continue;
                if (hitIds.has(e.id)) continue;
                const d = dist(currentTarget, e);
                if (d <= chainRange && d < bestDist) {
                    bestDist = d;
                    best = e;
                }
            }
            if (!best) break;
            // 第 i+1 跳伤害 = atk × chainDmgMul^(i+1)，对每个连锁目标单独结算、吃目标自身减伤（框架第13条）
            const chainDmg = calcActualDmg(attacker.atk * Math.pow(chainDmgMul, i + 1), attacker, best);
            best.hp -= chainDmg;
            spawnDmgNum(best.x, best.y - 20, chainDmg);
            best._stunTimer = Math.max(best._stunTimer || 0, 0.5); // 连锁目标眩晕💫
            hitIds.add(best.id);
            chainPoints.push({ x: best.x, y: best.y });
            currentTarget = best;
        }

        // 记录闪电链路径（至少连到1个额外目标才画）
        if (chainPoints.length > 1) {
            game.lightningChains.push({
                points: chainPoints,
                timer: 0.3,
                maxTimer: 0.3
            });
        }
    }

    // ---- 巫师：单体🫧气泡攻击 + 上🐛标记 ----
    if (attacker.cardId === 'wizard') {
        // 命中目标上🫧特效
        game.spellEffects.push({ x: target.x, y: target.y, char: '🫧', size: 22, timer: 0.4, maxTimer: 0.4 });
        target._wormMarkTimer = 5.0;  // 🐛标记持续5秒
        target._wormMarkTeam = attacker.team;  // 记录下标记的巫师阵营
    }

    // ---- 超级骑士：近战攻击特效💥（大范围震击）----
    if (attacker.cardId === 'super_knight') {
        game.spellEffects.push({
            x: target.x, y: target.y,
            char: '💥', size: 36,
            timer: 0.3, maxTimer: 0.3,
        });
        game.spellEffects.push({
            x: target.x, y: target.y,
            char: '⚡', size: 28,
            timer: 0.2, maxTimer: 0.2,
        });
    }

    // ---- 溅射伤害（即时结算的近战/施法单位）----
    //     女巫例外：她的溅射由弹道命中时统一结算（proj.aoeDamage=25），攻击时不再走即时溅射块，
    //     否则攻击瞬间溅射一次、法球命中再溅射一次，同一目标吃双份伤害
    //     👸 公主同理：伤害完全由群箭落地结算（落点45px内全额伤害），攻击瞬间不走溅射块
    if (attacker.splash && attacker.splash > 0 && attacker.cardId !== 'witch' && attacker.cardId !== 'princess' && attacker.cardId !== 'goblin_bomber') {
        const r = attacker.splash;
        const hitsAir = canTargetFlying(attacker);
        game.entities.forEach(e => {
            if (e.id === target.id || e.team === attacker.team || e.hp <= 0 || e._headHidden) return;
            if (e.flying && !hitsAir) return; // 不能对空的单位溅射不波及空中
            if (dist(target, e) <= r) {
                // 幽灵群攻特例：溅射全额伤害40（同主目标）；其余溅射单位（飞龙/超骑等）保持60%
                const sDmg = calcActualDmg(attacker.cardId === 'ghost' ? attacker.atk : attacker.atk * 0.6, attacker, e);
                e.hp -= sDmg;
                spawnDmgNum(e.x, e.y - 20, sDmg);
            }
        });
        // 攻击范围提示：淡红色小环（飞龙/超骑等普攻溅射单位）
        game.deployEffects.push({ x: target.x, y: target.y, radius: r, timer: 0.4, maxTimer: 0.4, color: AOE_RING_COLOR, static: true });
    }

    // ---- 游侠：穿透箭（黄色线条，穿透路径上所有敌人）----
    if (attacker.cardId === 'ranger') {
        const card = CARDS[attacker.cardId];
        const arrowRange = card.arrowRange || 225;
        const dx = target.x - attacker.x;
        const dy = target.y - attacker.y;
        const d = Math.hypot(dx, dy);
        if (d > 0) {
            game.pierceArrows.push({
                x: attacker.x, y: attacker.y,
                dx: dx / d, dy: dy / d,
                traveled: 0, maxTravel: arrowRange,
                damage: attacker.atk, // 原始伤害，命中每个目标时统一走 calcActualDmg（吃各目标实时减伤）
                team: attacker.team,
                ownerId: attacker.id,
                hitIds: new Set(),
                speed: 350,
                width: 2,
            });
        }
        return; // 穿透箭已处理伤害，不用再执行普通弹道
    }

    // ---- 生成弹道/攻击特效 ----
    let projChar = null, projSize = 14, projColor = null;
    let projSpeed = 350 + rand() * 100;
    let projTimer = 0.25;
    if (attacker.cardId === 'ninja') {
        // 🥷 忍者：复用通用 tracking 追踪弹道
        projChar = '🎯'; projSize = 14;
        projSpeed = 300;
        projTimer = 0.8;
        // 四角手里剑：旋转角度只用于视觉，不影响追踪弹道运动
        // 采用发射时随机初始角，避免多个飞镖完全同相位
        projIsNinjaDart = true;
    } else if (attacker.cardId === 'archer') {
        projChar = '།'; projSize = 14;
    } else if (attacker.cardId === 'cannon_tower') {
        projChar = '●'; projSize = 10; projColor = '#222';
    } else if (attacker.cardId === 'night_witch') {
        // 🧛 暗夜女巫：慢速蓝色能量球弹道
        projChar = '🔵'; projSize = 16;
        projSpeed = 150;   // 弹道飞行速度慢
        projTimer = 0.8;   // 慢速弹道需要更长寿命
    } else if (attacker.cardId === 'witch') {
        // 🧙‍♀️ 女巫：绿色能量球弹道（命中溅射）
        projChar = '🟢'; projSize = 16;
        projSpeed = 260;
        projTimer = 0.6;
    } else if (attacker.cardId === 'firework_gunner') {
        // 🎆 烟花炮手：超慢速火箭🚀（发射即后坐力，命中后分裂）
        projChar = '🚀'; projSize = 18;
        projSpeed = 100;   // 飞行速度更慢
        projTimer = 2.0;   // 慢速弹道需要更长寿命
    } else if (attacker.cardId === 'main_tower_guard') {
        // 🛡️ 主塔守卫：堡垒同款弹道（● 追踪弹，命中才结算伤害，吃目标减伤/护盾）
        projChar = '●'; projSize = 10;
        projSpeed = 400;
        projColor = attacker.team === 'player' ? '#64b5f6' : '#ef9a9a';
    } else if (attacker.cardId === 'little_prince') {
        // 👑 小王子：十字弩同款弩箭（► 追踪制，命中才结算伤害）
        projChar = '►'; projSize = 11;
        projSpeed = 520;
        projTimer = 0.3;
        projColor = attacker.team === 'player' ? '#d4a373' : '#ef9a9a';
    } else if ((attacker.flying && (attacker.range || 0) > 50) || attacker.cardId === 'dragon') {
        // 🦇 空中近战分支：飞行但射程≤50（蝙蝠/气球兵/苍蝇海/战斗天使/剑仙御剑等）不喷🔥火球，走即时近战结算
        projChar = '🔥'; projSize = 18;
    }
    // ---- 🛡️ 炮车：炮塔同款黑色实心炮弹弹道（命中才结算伤害，吃目标实时减伤/护盾 + 攻击者实时狂暴）----
    if (attacker.cardId === 'cannon_cart') {
        spawnTowerProjectile(attacker, target, {
            isCannonball: true, size: 8, speed: 420, timer: 0.3,
        });
        return; // 炮弹弹道已生成，不走普通单发弹道
    }
    // ---- 🏹 猎人：120°扇形随机散射10发弹药（45×10，直线飞行命中即消散，可对空）----
    //      散弹特性：距离越近子弹越密集、命中同一目标的弹数越多、伤害越高
    if (attacker.cardId === 'hunter') {
        const baseA = Math.atan2(target.y - attacker.y, target.x - attacker.x);
        const halfSpread = Math.PI * 60 / 180; // 总夹角120°，半角60°
        for (let i = 0; i < (attacker.shotCount || 10); i++) {
            const a = baseA + (rand() * 2 - 1) * halfSpread;
            game.projectiles.push({
                x: attacker.x, y: attacker.y,
                char: '➶', size: 12,
                vx: Math.cos(a), vy: Math.sin(a),
                speed: 420, timer: 1.5, maxTimer: 1.5,
                isHuntShot: true, dist: 0, maxDist: attacker.range || 105,
                damage: attacker.atk, // 原始伤害，命中结算统一走 calcActualDmg
                team: attacker.team, hitsAir: true,
                ownerId: attacker.id,
                hitIds: [],
            });
        }
        return; // 散射弹道已生成，不走普通单发弹道
    }
    // ---- 🪓 飞斧胖虎：直线穿透飞斧，135px折返，一去一回同目标最多2段伤害 ----
    if (attacker.cardId === 'fat_tiger') {
        const baseA = Math.atan2(target.y - attacker.y, target.x - attacker.x);
        game.projectiles.push({
            id: 'axe_' + (game._projSeq = (game._projSeq || 0) + 1), // 唯一id：实体标记防重结算
            x: attacker.x, y: attacker.y,
            char: '🪓', size: 19, // 建模稍大；命中判定已在 scanEnemies 同步加宽（hitPad: 10）
            vx: Math.cos(baseA), vy: Math.sin(baseA),
            speed: 180, timer: 2.0, maxTimer: 2.0, // 慢速滞空：去程0.75s，一去一回1.5s
            isAxe: true, dist: 0, maxDist: 135,
            damage: attacker.atk, team: attacker.team, hitsAir: true,
            ownerId: attacker.id,
        });
        return;
    }
    // ---- 🔱 哥布林投矛手：单发投矛直线弹道（不追踪，命中第一个敌人即消散；未命中飞满射程消失；可对空）----
    if (attacker.cardId === 'goblin_thrower') {
        const baseA = Math.atan2(target.y - attacker.y, target.x - attacker.x);
        game.projectiles.push({
            x: attacker.x, y: attacker.y,
            char: '🔱', size: 14,
            vx: Math.cos(baseA), vy: Math.sin(baseA),
            speed: 180, timer: 2.0, maxTimer: 2.0, // 弹道飞行速度慢
            isSpear: true, dist: 0, maxDist: attacker.range || 105,
            damage: attacker.atk, // 原始伤害，命中结算统一走 calcActualDmg
            team: attacker.team, hitsAir: true, // 可对空
            ownerId: attacker.id,
            hitIds: [],
        });
        return; // 投矛弹道已生成，不走普通单发弹道
    }
    // ---- 🎯 哥布林吹箭手：单发吹箭直线弹道（不追踪，命中第一个敌人即消散；未命中飞满射程消失；可对空）----
    if (attacker.cardId === 'goblin_blowgun') {
        const baseA = Math.atan2(target.y - attacker.y, target.x - attacker.x);
        game.projectiles.push({
            x: attacker.x, y: attacker.y,
            char: '🎯', size: 12,
            vx: Math.cos(baseA), vy: Math.sin(baseA),
            speed: 300, timer: 1.5, maxTimer: 1.5, // 吹箭轻快，飞行较快
            isDart: true, dist: 0, maxDist: attacker.range || 135,
            damage: attacker.atk, // 原始伤害，命中结算统一走 calcActualDmg
            team: attacker.team, hitsAir: true, // 可对空
            ownerId: attacker.id,
            hitIds: [],
        });
        return; // 吹箭弹道已生成，不走普通单发弹道
    }
    // ---- 👸 公主：群箭迫击炮（巡敌锁定目标当前位置发射，不追踪；落点范围伤害45px，落地效果同剑雨）----
    if (attacker.cardId === 'princess') {
        const tx = target.x, ty = target.y; // 发射瞬间锁定落点（不再追踪）
        const sx = attacker.x, sy = attacker.y;
        const d0 = Math.max(1, Math.hypot(tx - sx, ty - sy));
        const arcH = Math.min(300, Math.max(150, d0 * 1.0)); // 抛物线弧高：比迫击炮(0.7系数)更抖
        const sharedHitIds = []; // 群箭共享去重：落地只结算一次
        for (let i = 0; i < 5; i++) {
            // 以落点为中心向四周随机散布（圆内均匀）：最大半径32 < 群攻45，不会散出范围
            const ang = rand() * Math.PI * 2;
            const rr = 32 * Math.sqrt(rand());
            const latX = Math.cos(ang) * rr;
            const latY = Math.sin(ang) * rr;
            const tOff = (rand() - 0.5) * 0.2; // 落地时间稍微错开（±0.1s）
            game.projectiles.push({
                x: sx, y: sy, sx, sy,
                char: '།', size: 11,
                speed: 190, timer: 1.6 + tOff, maxTimer: 1.6 + tOff, // 箭速放慢：更明显的抛物线滞空感
                isPrincessSalvo: true, dist: 0, maxDist: d0 + 12,
                tx, ty, // 锁定落点
                arcHeight: arcH,
                latX, latY, // 落点处四周随机散开（发射集中、越飞越散，最大不超群攻45）
                damage: attacker.atk, // 原始伤害，落地结算统一走 calcActualDmg
                team: attacker.team, hitsAir: true, // 可对空（落地同剑雨波及空中）
                ownerId: attacker.id,
                hitIds: sharedHitIds,
                isLandSettler: i === 0, // 第一支箭负责落点伤害+特效结算
                aoeRadius: attacker.splash || 45,
            });
        }
        return; // 群箭弹道已生成，不走普通单发弹道
    }
    // ---- 🧨 哥布林爆破手：迫击炮同款抛物线（发射瞬间锁定落点不追踪），落地35px群攻（同迫击炮中档，只对地，无击退）----
    if (attacker.cardId === 'goblin_bomber') {
        const tx = target.x, ty = target.y; // 锁定落点（发射时目标所在位置，不再追踪）
        const sx = attacker.x, sy = attacker.y;
        const d0 = Math.max(1, Math.hypot(tx - sx, ty - sy));
        game.projectiles.push({
            x: sx, y: sy, sx, sy,
            char: '🧨', size: 20,
            speed: 170, timer: 1.5, maxTimer: 1.5, // 同迫击炮：飞得慢，抛物线滞空明显
            isBomber: true, dist: 0, maxDist: d0,
            tx, ty, // 锁定落点
            arcHeight: Math.min(120, Math.max(45, d0 * 0.35)), // 抛物线再矮一点（迫击炮同款为0.7系数）
            damage: attacker.atk, // 原始伤害，落地结算统一走 calcActualDmg
            team: attacker.team,
            ownerId: attacker.id,
            aoeRadius: attacker.splash || AOE_RANGE_MED, // 群攻范围35px（同迫击炮中档）
        });
        return; // 炸药包弹道已生成，不走普通单发弹道
    }
    // ---- 🏹 弓箭女皇：绿色细追踪箭（拉满再放箭：攻击瞬间只记录待射目标，蓄力0.17s到顶时在帧循环生成弹道）----
    if (attacker.cardId === 'bow_queen') {
        attacker._queenArrowPending = {
            targetId: target.id,
            tx: target.x, ty: target.y,
            atkVal, // 原始伤害，命中结算统一走 calcActualDmg
        };
        return; // 待拉弓蓄力完成后放箭，不走普通单发弹道
    }
    if (projChar) {
        // 远程弹道单位：真实弹道——命中目标后才结算伤害
        const proj = {
            x: attacker.x, y: attacker.y,
            tx: target.x, ty: target.y,
            char: projChar,
            size: projSize,
            color: projColor,
            speed: projSpeed,
            timer: projTimer,
            damage: atkVal, // 原始伤害（🗡️ 剑仙御剑期间=80），命中结算统一走 calcActualDmg
            team: attacker.team,
            targetId: target.id,
            ownerId: attacker.id, // 攻击者：命中结算时吃狂暴/减伤
        };
        if (attacker.cardId === 'ninja') {
            proj.isNinjaDart = true;
            proj.spinOffset = rand() * Math.PI * 2;
        }
        // 烟花炮手：火箭改为直线弹道（锁定发射方向不追踪；碰到敌人即伤害+分裂，飞满射程未命中则在最远点分裂）+ 发射即后坐力
        if (attacker.cardId === 'firework_gunner') {
            proj.isRocket = true;
            proj.ownerId = attacker.id;
            const fdx = target.x - attacker.x, fdy = target.y - attacker.y;
            const fd = Math.hypot(fdx, fdy) || 1;
            proj.vx = fdx / fd;   // 直线飞行方向（不追踪）
            proj.vy = fdy / fd;
            proj.dist = 0;
            proj.maxDist = attacker.range || 135; // 弹道射程=攻击射程：飞满未命中则在最远点分裂
            proj.hitsAir = true;  // 可对空
            // 发射即后坐力：向后弹开（稍强于电磁炮的50，且不依赖命中）
            attacker._recoilVx = -(fdx / fd) * 70;
            attacker._recoilVy = -(fdy / fd) * 70;
            attacker._recoilTimer = 0.3;
        }
        // 🧙‍♀️ 女巫：命中溅射（群伤），溅射可波及空中
        if (attacker.cardId === 'witch') {
            proj.aoeRadius = attacker.splash || AOE_RANGE_SMALL;
            proj.hitsAir = true;  // 可对空
            proj.aoeDamage = 32;  // 女巫专属：溅射范围伤害固定32（原始值，命中结算统一走 calcActualDmg）
        }
        game.projectiles.push(proj);
    }
}

/** ⛺ 绕圆心巡逻：切线绕圈 + 径向回圈修正（营地巡逻分支 / 收编火豆共用） */
function patrolOrbit(e, deltaSec) {
    // 🧭 烟引引导中：巡逻寻路暂时改为朝烟点（仅改变移动目标，其余行为特性不变）
    if (e._guideX !== undefined && e._guideY !== undefined) {
        moveToward(e, e._guideX, e._guideY, deltaSec);
        return;
    }
    const patrolR = e._patrolR || CARDS.camp.campRadius || 60;
    const dx = e.x - e._patrolX, dy = e.y - e._patrolY;
    const distC = Math.hypot(dx, dy) || 1;
    // 巡逻速度与通用移动一致：吃减速/极速/狂暴因子
    const speed = e.moveSpeed * (e.slowFactor || 1.0) * (e._poisonTimer > 0 ? 0.6 : 1.0) * (e._speedBoosted ? 2.0 : 1.0) * (e._charging ? 3.0 : 1.0) * rageMult(e);
    const step = speed * deltaSec;
    const rx = dx / distC, ry = dy / distC;                    // 径向单位向量（中心→成员）
    const tx = -ry * e._patrolDir, ty = rx * e._patrolDir;     // 切线单位向量（绕圈方向）
    const err = distC - patrolR;                               // >0 太远, <0 太近
    const radialPull = err > 0 ? Math.min(step, err) : Math.max(-step, err * 0.3);
    e.x += tx * step * 0.6 - rx * radialPull;
    e.y += ty * step * 0.6 - ry * radialPull;
    // 边界限制（同 moveToward）
    e.x = Math.min(W - 25, Math.max(25, e.x));
    e.y = Math.min(H - 25, Math.max(25, e.y));
}

function applyPoison(target) {
    if (!target || target.hp <= 0) return;
    target._poisonTimer = 4.0;
    // 不重置累计伤害：重复命中只刷新持续时间，不叠加毒伤
    if (target._poisonAccumulator === undefined) target._poisonAccumulator = 0;
}

function moveAwayFrom(entity, target, deltaSec) {
    const dx = entity.x - target.x, dy = entity.y - target.y;
    const len = Math.hypot(dx, dy) || 1;
    moveToward(entity, entity.x + dx / len * 100, entity.y + dy / len * 100, deltaSec);
}

function moveToward(entity, tx, ty, deltaSec, opts) {
    // 🛡️ 护驾施法期间暂停移动（倒计时由护驾召唤循环同步管理，召唤完成自动恢复）
    if (entity._holdMove && entity._holdMove > 0) return;

    // 🧭 烟引引导中：仅改变寻路目的地为烟点——移动速度完全按正常公式计算（吃减速/极速/狂暴/冲锋等全部因子）
    //    无速度单位（炮台/蛋等）不引导移动（原地行为不变，防 NaN）
    if (entity._guideX !== undefined && entity._guideY !== undefined) {
        if (!entity.moveSpeed) return;
        tx = entity._guideX;
        ty = entity._guideY;
    }

    const dx = tx - entity.x, dy = ty - entity.y;
    const len = Math.hypot(dx, dy);

    // 如果已经贴脸了，就不动
    if (len < 2) return;

    // 💥 狂战士爆发：移速固定 40（爆发结束 _berserkTimer<=0 自动还原 e.moveSpeed）
    // 🕊️ 剑仙御剑：御剑期间移速固定 40（御剑结束 _rideSword=false 自动还原 e.moveSpeed）
    // 正常速度公式（烟引引导已无 pureSpeed 压制：引导仅改目的地，速度吃减速/极速/狂暴/冲锋全因子）
    let speed = (entity.cardId === 'berserker' && entity._berserkTimer > 0)
        || (entity.cardId === 'sword_immortal' && entity._rideSword) ? 40 : entity.moveSpeed;
    if (!(opts && opts.pureSpeed)) {
        speed = speed * (entity.slowFactor || 1.0) * (entity._poisonTimer > 0 ? 0.6 : 1.0) * (entity._speedBoosted ? 2.0 : 1.0) * (entity._charging ? 3.0 : 1.0) * rageMult(entity);
    }
    const step = speed * deltaSec;

    // 执行移动
    entity.x += (dx / len) * step;
    entity.y += (dy / len) * step;

    // 边界限制
    entity.x = Math.min(W - 25, Math.max(25, entity.x));
    entity.y = Math.min(H - 25, Math.max(25, entity.y));
}

/** 🦔 反甲：攻击者在75px范围内攻击反甲巨人时，受到35伤害并眩晕0.5秒 */
function triggerAntiArmor(attacker, target) {
    if (!attacker || !target || target.cardId !== 'anti_armor_giant'
        || attacker.team === target.team || attacker === target
        || attacker.hp <= 0 || attacker._antiArmorReflected) return;
    const radius = CARDS.anti_armor_giant?.thornsRadius || 75;
    if (Math.hypot(attacker.x - target.x, attacker.y - target.y) > radius) return;

    attacker._stunTimer = Math.max(attacker._stunTimer || 0, CARDS.anti_armor_giant?.thornsStun || 0.5);
    attacker._antiArmorReflected = true;
    const reflected = CARDS.anti_armor_giant?.thornsDamage || 35;
    const actual = calcActualDmg(reflected, target, attacker);
    attacker.hp -= actual;
    spawnDmgNum(attacker.x, attacker.y - 20, actual);
    game.spellEffects.push({
        x: attacker.x, y: attacker.y, char: '🦔', size: 22,
        timer: 0.35, maxTimer: 0.35, color: '#d6e4ea'
    });
    // 仅锁到当前伤害结算末尾，防止同一次嵌套伤害递归；下一次攻击自动恢复资格
    attacker._antiArmorReflected = false;
}

/** 计算实际伤害：应用攻击者狂暴加成（😡 +30%）+ 目标减伤系数 */
function calcActualDmg(baseDmg, attacker, target) {
    // 反甲在统一伤害入口触发，覆盖近战即时伤害和弹道命中伤害
    triggerAntiArmor(attacker, target);
    let dmg = baseDmg;
    if (attacker) dmg *= rageMult(attacker);
    const reduction = target._damageReduction || 0;
    dmg = Math.floor(dmg * (1 - reduction));
    // ★ 通用护盾机制（任何单位 shield>0 即生效）：本次伤害全部由护盾吸收、不穿透生命；
    //   哪怕只剩1点护盾也能完整挡下一次攻击，护盾归零后剩余伤害才扣生命
    if (target.shield > 0) {
        target.shield = Math.max(0, target.shield - dmg);
        // ★ 主塔护盾破碎标记：由帧循环统一处理（召唤主塔守卫），不在结算函数内直接创建实体
        if (target.shield === 0 && target.type === 'main_tower') target._shieldJustBroke = true;
        // 🛡️ 护盾吸收伤害也冒出数字（蓝色飘字，区别于红色扣血；统一收口在 calcActualDmg，所有调用处自动生效）
        spawnDmgNum(target.x, target.y - 20, dmg, false, true);
        return 0;
    }
    return dmg;
}

/** 通用加盾：给目标增加护盾。加盾可突破原上限（例：骷髅守卫自带80盾上限，盔甲铺加100盾应给足100，而不是被80截断）；原本无盾则以本次加盾量为上限，未来加盾卡牌/法术统一走这里 */
function grantShield(target, amount) {
    const cur = target.shield || 0;
    const max = Math.max(target.maxShield || 0, cur + amount);
    target.maxShield = max;
    target.shield = Math.min(max, cur + amount);
}

// ---- 伤害飘字：受击红字 / 治疗绿字 / 护盾蓝字，向上飘并淡出 ----
function spawnDmgNum(x, y, amount, isHeal, isShield) {
    if (amount <= 0) return;
    const amt = Math.round(amount);
    const color = isShield ? '#4fc3f7' : (isHeal ? '#4caf50' : '#ff5252');
    // 同帧同位置合并：同一目标同一帧被多段命中时（猎人多弹同时命中/骑士冲锋普攻+冲锋伤），
    // 飘字叠加为总伤害，避免多个飘字重叠只看到单次伤害的误导（如猎人只显示45、骑士只显示80）
    const existing = game.dmgNumbers.find(n =>
        n._frame === game.time && n.color === color &&
        Math.abs(n.x - x) < 10 && Math.abs(n.y - y) < 10
    );
    if (existing) {
        existing.amount += amt;
        return;
    }
    game.dmgNumbers.push({
        x: x, y: y,
        amount: amt,
        color: color,
        timer: 0.8, maxTimer: 0.8,
        _frame: game.time, // 记录创建帧（game.time 同一帧内不变）
    });
}
