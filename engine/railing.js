// Ein Geländer aus Metall um ein Becken (railing = on in seinem Abschnitt).
// Es wirft beim Backen Schatten: Darum gehört diese Datei zum Fingerabdruck
// des gespeicherten Lichts (main.js), die Wasserfläche (water.js) nicht.
import * as THREE from 'three';

// Überall dort, wo man am Rand stehen kann, 10 cm hinter der Kante. Rohre:
// oben in 1 m Höhe, eins in der Mitte, Pfosten an den Ecken und höchstens
// 1,2 m auseinander. Es wird wie ein Modell behandelt (main.js): Licht für
// jede Ecke, Schatten beim Backen, Spiegelungen.
const RAIL_OFFSET = 0.1;
const RAIL_HEIGHT = 1.0;
const POST_SPACING = 1.2;
const BEND = 0.14;        // so eng biegt das Rohr um eine Ecke (Radius, Meter)

export function railing(level, pool) {
    const cell = level.settings.cell;
    const k = pool.layer;
    const inPool = (x, z) => level.poolAt(x, z, k) === pool;
    // am Rand stehen kann man auf Boden, der nicht zu einem Becken gehört
    const standing = (x, z) => level.kindAt(x, z, k) === 'floor' && !level.poolAt(x, z, k);
    const floor = level.rooms[pool.room].elevation + (pool.rim?.[0] ?? 0);   // mit einem Rand: auf ihm
    // die Kanten des Beckens, an denen man steht: Stücke einer Linie in Metern
    const runs = [];
    for (const { x, z } of pool.cells) {
        for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
            if (!standing(x + dx, z + dz)) continue;
            // die Kante: von a nach b, entlang t, nach außen n
            const t = [Math.abs(dz), Math.abs(dx)];
            const mid = [x + 0.5 + dx * 0.5, z + 0.5 + dz * 0.5];
            const a = [mid[0] - t[0] * 0.5, mid[1] - t[1] * 0.5], b = [mid[0] + t[0] * 0.5, mid[1] + t[1] * 0.5];
            // an jedem Ende: geht der Rand gerade weiter, biegt er nach außen
            // um (dann läuft das Geländer um die Ecke) oder nach innen?
            const end = (sign) => {
                const nx = x + t[0] * sign, nz = z + t[1] * sign;
                if (inPool(nx, nz)) return inPool(nx + dx, nz + dz) ? -RAIL_OFFSET : 0;   // innere Ecke: kürzer
                return standing(nx, nz) ? RAIL_OFFSET : 0;                                  // äußere Ecke: um sie herum
            };
            const from = [a[0] * cell - t[0] * end(-1) + dx * RAIL_OFFSET, a[1] * cell - t[1] * end(-1) + dz * RAIL_OFFSET];
            const to = [b[0] * cell + t[0] * end(1) + dx * RAIL_OFFSET, b[1] * cell + t[1] * end(1) + dz * RAIL_OFFSET];
            runs.push({ from, to, alongX: t[0] === 1 });
        }
    }
    // Stücke auf einer Linie, die sich berühren, werden ein Rohr
    const key = (r) => (r.alongX ? `x${r.from[1].toFixed(3)}` : `z${r.from[0].toFixed(3)}`);
    const lines = new Map();
    for (const r of runs) {
        const i = r.alongX ? 0 : 1;
        const lo = Math.min(r.from[i], r.to[i]), hi = Math.max(r.from[i], r.to[i]);
        if (!lines.has(key(r))) lines.set(key(r), { alongX: r.alongX, fixed: r.alongX ? r.from[1] : r.from[0], spans: [] });
        lines.get(key(r)).spans.push([lo, hi]);
    }
    // glatter Edelstahl: spiegelt scharf (main.js nimmt dafür das feine Rundumbild)
    const metal = new THREE.MeshStandardMaterial({ color: '#c4c9cd', metalness: 1, roughness: 0.12 });
    const group = new THREE.Group();
    const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
    const up = v3(0, 1, 0);
    // ein gerades Rohr von a nach b
    const straight = (a, b, radius) => {
        const length = a.distanceTo(b);
        if (length < 1e-3) return;
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 14, 1, true), metal);
        pipe.position.copy(a).add(b).multiplyScalar(0.5);
        pipe.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize());
        group.add(pipe);
    };
    // ein Viertelkreis um center, von center + r·from nach center + r·to: ein gebogenes Rohr
    class Quarter extends THREE.Curve {
        constructor(center, from, to, r) { super(); Object.assign(this, { center, from, to, r }); }
        getPoint(t, target = new THREE.Vector3()) {
            const a = t * Math.PI / 2;
            return target.copy(this.center).addScaledVector(this.from, this.r * Math.cos(a)).addScaledVector(this.to, this.r * Math.sin(a));
        }
    }
    const bend = (center, from, to, r, radius) => group.add(new THREE.Mesh(new THREE.TubeGeometry(new Quarter(center, from, to, r), 10, radius, 14, false), metal));
    const ball = (at, radius) => { const joint = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 10), metal); joint.position.copy(at); group.add(joint); };

    // die geraden Stücke, auf jeder Linie zusammengelegt
    const segments = [];
    for (const { alongX, fixed, spans } of lines.values()) {
        spans.sort((p, q) => p[0] - q[0]);
        const merged = [];
        for (const span of spans) {
            const last = merged[merged.length - 1];
            if (last && span[0] <= last[1] + 1e-3) last[1] = Math.max(last[1], span[1]);
            else merged.push([...span]);
        }
        for (const [lo, hi] of merged) {
            const at = (t) => (alongX ? v3(t, 0, fixed) : v3(fixed, 0, t));
            segments.push({ ends: [at(lo), at(hi)], length: hi - lo });
        }
    }
    // An jedem Ende: trifft dort ein Stück quer dazu (eine Ecke) oder hört das Geländer auf?
    const same = (a, b) => a.distanceToSquared(b) < 1e-6;
    const posts = [];   // [Stelle (x, 0, z), Höhe]
    const corners = new Set();
    const tops = [RAIL_HEIGHT, 0.024], mids = [RAIL_HEIGHT / 2, 0.014];
    for (const segment of segments) {
        const [a, b] = segment.ends;
        const r = Math.min(BEND, segment.length / 3);
        const inward = [b.clone().sub(a).normalize(), a.clone().sub(b).normalize()];   // von jedem Ende ins Stück hinein
        const trimmed = { top: [a.clone(), b.clone()], mid: [a.clone(), b.clone()] };
        const postAt = [a.clone(), b.clone()];
        segment.ends.forEach((p, e) => {
            const other = segments.find((s) => s !== segment && s.ends.some((q) => same(p, q)));
            const u = inward[e];
            if (other) {
                // eine Ecke: oben und in der Mitte biegt das Rohr um sie herum, der Pfosten steht unter der Mitte des Bogens
                const q = other.ends.find((x) => same(p, x));
                const otherEnd = other.ends.find((x) => !same(p, x));
                const v = otherEnd.clone().sub(q).normalize();
                const rc = Math.min(r, other.length / 3);
                trimmed.top[e].addScaledVector(u, rc);
                trimmed.mid[e].addScaledVector(u, rc);
                const id = `${p.x.toFixed(3)},${p.z.toFixed(3)}`;
                postAt[e] = null;
                if (!corners.has(id)) {
                    corners.add(id);
                    const center = p.clone().addScaledVector(u, rc).addScaledVector(v, rc);
                    for (const [height, radius] of [tops, mids]) {
                        bend(center.clone().setY(floor + height), v.clone().negate(), u.clone().negate(), rc, radius);
                    }
                    const middle = center.clone().addScaledVector(u.clone().add(v), -rc / Math.SQRT2);
                    posts.push([middle, RAIL_HEIGHT]);
                }
            } else {
                // ein freies Ende: oben biegt das Rohr hinunter in den letzten Pfosten
                trimmed.top[e].addScaledVector(u, r);
                const center = p.clone().addScaledVector(u, r).setY(floor + RAIL_HEIGHT - r);
                bend(center, up.clone(), u.clone().negate(), r, tops[1]);
                posts.push([p.clone(), RAIL_HEIGHT - r]);
                postAt[e] = null;
            }
        });
        straight(trimmed.top[0].clone().setY(floor + tops[0]), trimmed.top[1].clone().setY(floor + tops[0]), tops[1]);
        straight(trimmed.mid[0].clone().setY(floor + mids[0]), trimmed.mid[1].clone().setY(floor + mids[0]), mids[1]);
        // Pfosten dazwischen, höchstens POST_SPACING auseinander
        const count = Math.max(1, Math.ceil(segment.length / POST_SPACING));
        for (let i = 1; i < count; i++) posts.push([a.clone().lerp(b, i / count), RAIL_HEIGHT]);
    }
    for (const [at, height] of posts) {
        straight(at.clone().setY(floor), at.clone().setY(floor + height), 0.022);
        if (height >= RAIL_HEIGHT) ball(at.clone().setY(floor + height), 0.026);   // wo der Pfosten das Rohr trägt
        // ein runder Fuß, mit dem er auf den Fliesen sitzt
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.046, 0.014, 18), metal);
        foot.position.copy(at).setY(floor + 0.007);
        group.add(foot);
    }
    group.updateMatrixWorld(true);
    return group.children.length ? group : null;
}

// Ein Geländer an einer Treppe oder um ein Podest (railing = on bei
// stairs oder raise): wo es an der Seite mehr als einen halben Meter
// hinuntergeht. An einer Treppe läuft es schräg mit den Stufen hinauf, um
// ein Podest gerade entlang seiner Kanten, 6 cm innerhalb.
export function liftRailing(level, group) {
    const cell = level.settings.cell, k = group.layer;
    const metal = new THREE.MeshStandardMaterial({ color: '#c4c9cd', metalness: 1, roughness: 0.12 });
    const out = new THREE.Group();
    const up = new THREE.Vector3(0, 1, 0);
    const pipe = (a, b, radius) => {
        const length = a.distanceTo(b);
        if (length < 1e-3) return;
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 14, 1, true), metal);
        mesh.position.copy(a).add(b).multiplyScalar(0.5);
        mesh.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize());
        out.add(mesh);
    };
    const post = (x, y, z, top) => {
        pipe(new THREE.Vector3(x, y, z), new THREE.Vector3(x, top, z), 0.022);
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.026, 14, 10), metal);
        ball.position.set(x, top, z);
        out.add(ball);
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.046, 0.014, 18), metal);
        foot.position.set(x, y + 0.007, z);
        out.add(foot);
    };
    // wie tief es neben einer Stelle (px, pz in Feldern) hinuntergeht, auf der Seite des Felds nx, nz
    const drop = (here, nx, nz, px, pz) => {
        if (level.kindAt(nx, nz, k) !== 'floor') return 0;
        return here - (level.floorAt(px, pz, level.roomAt(nx, nz, k)) - level.sunk(nx, nz, k) + level.lift(nx, nz, k, px, pz));
    };
    const inside = 0.06;
    if (group.stairs) {
        const { direction } = group.stairs;
        const alongX = direction === 'east' || direction === 'west';
        const sign = direction === 'east' || direction === 'south' ? 1 : -1;
        const start = sign > 0 ? (alongX ? group.x0 : group.z0) * cell : ((alongX ? group.x1 : group.z1) + 1) * cell;
        const w0 = (alongX ? group.z0 : group.x0) * cell, w1 = ((alongX ? group.z1 : group.x1) + 1) * cell;
        const at = (u, w) => (alongX ? [start + sign * u, w] : [w, start + sign * u]);
        const stepTop = (u) => group.floor + Math.min(group.stairs.rise, (Math.floor(Math.max(0, u) / group.tread + 1e-6) + 1) * group.stepHeight);
        for (const [w, outward] of [[w0 + inside, -1], [w1 - inside, 1]]) {
            // offen, wenn es neben der Mitte der Treppe tief genug hinuntergeht
            const [mx, mz] = at(group.length / 2, w + outward * (inside + 0.01));
            if (drop(stepTop(group.length / 2), Math.floor(mx / cell), Math.floor(mz / cell), mx / cell, mz / cell) < 0.5) continue;
            const u0 = group.tread / 2, u1 = group.length - group.tread / 2;
            const count = Math.max(1, Math.ceil((u1 - u0) / 1.2));
            const height = (u) => group.floor + group.stepHeight + (u - u0) / (u1 - u0) * (group.stairs.rise - group.stepHeight);
            for (const [lift, radius] of [[0.95, 0.024], [0.5, 0.014]]) {
                const [ax, az] = at(u0, w), [bx, bz] = at(u1, w);
                pipe(new THREE.Vector3(ax, height(u0) + lift, az), new THREE.Vector3(bx, height(u1) + lift, bz), radius);
            }
            for (let i = 0; i <= count; i++) {
                const u = u0 + (u1 - u0) * i / count, [px, pz] = at(u, w);
                post(px, stepTop(u), pz, height(u) + 0.95);
            }
        }
    } else {
        const top = group.floor + group.raise;
        for (const { x, z } of group.cells) {
            for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
                if (level.liftAt(x + dx, z + dz, k) === group) continue;
                const mx = x + 0.5 + dx * 0.51, mz = z + 0.5 + dz * 0.51;
                if (drop(top, x + dx, z + dz, mx, mz) < 0.5) continue;
                // die Kante, 6 cm nach innen
                const t = [Math.abs(dz), Math.abs(dx)];
                const cx = (x + 0.5 + dx * 0.5) * cell - dx * inside, cz = (z + 0.5 + dz * 0.5) * cell - dz * inside;
                const a = new THREE.Vector3(cx - t[0] * cell / 2, 0, cz - t[1] * cell / 2), b = new THREE.Vector3(cx + t[0] * cell / 2, 0, cz + t[1] * cell / 2);
                for (const [lift, radius] of [[1, 0.024], [0.5, 0.014]]) pipe(a.clone().setY(top + lift), b.clone().setY(top + lift), radius);
                post(a.x, top, a.z, top + 1);
                post(b.x, top, b.z, top + 1);
            }
        }
    }
    out.updateMatrixWorld(true);
    return out.children.length ? out : null;
}
