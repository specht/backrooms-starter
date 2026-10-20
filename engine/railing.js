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
    const floor = level.rooms[pool.room].elevation;
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
