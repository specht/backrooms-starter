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
    const standing = (x, z) => level.kindAt(x, z, k) === 'floor' && !level.poolAt(x, z, k) && !level.liftAt(x, z, k);   // nicht an der Seite einer Treppe oder eines Podests
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
    const walls = [];   // die oberen Rohre: Dort kommt man beim Laufen nicht durch (main.js)
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
        walls.push([trimmed.top[0].clone().setY(floor + tops[0]), trimmed.top[1].clone().setY(floor + tops[0])]);
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
    group.userData.walls = walls.map(([a, b]) => wallBox(a, b));
    group.updateMatrixWorld(true);
    return group.children.length ? group : null;
}

// Ein Rohr als Hindernis beim Laufen: ein schmaler Kasten von a nach b, bis
// einen Meter darunter (dort steht man)
function wallBox(a, b) {
    const pad = 0.04;
    return { x0: Math.min(a.x, b.x) - pad, x1: Math.max(a.x, b.x) + pad, z0: Math.min(a.z, b.z) - pad, z1: Math.max(a.z, b.z) + pad,
        y0: Math.min(a.y, b.y) - 1.05, y1: Math.max(a.y, b.y) };
}

// Das Geländer an den Treppen und Podesten eines Raums (railing = on bei
// stairs oder raise): wo es an der Seite mehr als einen halben Meter
// hinuntergeht, 6 cm innerhalb der Kante, 1 m über dem, worauf man steht. Es
// ist ein Geländer für alle zusammen, wie um ein Becken: Kanten auf einer
// Linie werden ein Rohr, an einer Ecke biegt es um (beide waagerecht) oder
// trifft sich auf einem Pfosten (eine Treppe oben an einem Podest, ein
// Absatz). An einer Treppe läuft es schräg mit den Stufen hinauf.
export function liftRailing(level, groups) {
    const cell = level.settings.cell, k = groups[0].layer;
    const metal = new THREE.MeshStandardMaterial({ color: '#c4c9cd', metalness: 1, roughness: 0.12 });
    const out = new THREE.Group();
    const walls = [];
    const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
    const up = v3(0, 1, 0);
    const pipe = (a, b, radius) => {
        const length = a.distanceTo(b);
        if (length < 1e-3) return;
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 14, 1, true), metal);
        mesh.position.copy(a).add(b).multiplyScalar(0.5);
        mesh.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize());
        out.add(mesh);
    };
    const ball = (at, radius) => { const joint = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 10), metal); joint.position.copy(at); out.add(joint); };
    const post = (x, y, z, top) => {
        pipe(v3(x, y, z), v3(x, top, z), 0.022);
        ball(v3(x, top, z), 0.026);
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.046, 0.014, 18), metal);
        foot.position.set(x, y + 0.007, z);
        out.add(foot);
    };
    class Quarter extends THREE.Curve {
        constructor(center, from, to, r) { super(); Object.assign(this, { center, from, to, r }); }
        getPoint(t, target = new THREE.Vector3()) {
            const a = t * Math.PI / 2;
            return target.copy(this.center).addScaledVector(this.from, this.r * Math.cos(a)).addScaledVector(this.to, this.r * Math.sin(a));
        }
    }
    const bend = (center, from, to, r, radius) => out.add(new THREE.Mesh(new THREE.TubeGeometry(new Quarter(center, from, to, r), 10, radius, 14, false), metal));

    // Worauf man an einer Stelle (Meter) einer Gruppe steht, und wo ihr
    // Geländer verläuft: auf einem Podest gleich hoch, an einer Treppe
    // gleichmäßig von unten nach oben (die Stelle wird in die Treppe gerückt)
    const climb = (g, x, z) => {
        const { direction } = g.stairs;
        const cx = Math.min(Math.max(x / cell, g.x0), g.x1 + 1), cz = Math.min(Math.max(z / cell, g.z0), g.z1 + 1);
        const u = direction === 'east' ? cx - g.x0 : direction === 'west' ? g.x1 + 1 - cx : direction === 'south' ? cz - g.z0 : g.z1 + 1 - cz;
        return u * cell;
    };
    const railBase = (g, x, z) => (g.stairs ? g.floor + g.base + climb(g, x, z) / g.length * (g.stairs.rise - g.base) : g.floor + g.raise);
    const surface = (g, x, z) => {
        if (!g.stairs) return g.floor + g.raise;
        const u = Math.min(climb(g, x, z), g.length - 1e-6);
        return g.floor + Math.min(g.stairs.rise, g.base + (Math.floor(Math.max(0, u) / g.tread + 1e-6) + 1) * g.stepHeight);
    };
    // wie tief es neben einer Stelle (px, pz in Feldern) hinuntergeht, auf der Seite des Felds nx, nz
    const drop = (here, nx, nz, px, pz) => {
        if (level.kindAt(nx, nz, k) !== 'floor') return 0;
        return here - (level.floorAt(px, pz, level.roomAt(nx, nz, k)) - level.sunk(nx, nz, k) + level.lift(nx, nz, k, px, pz));
    };
    const inside = 0.06;

    // die offenen Kanten jeder Gruppe, auf jeder Linie zu Stücken zusammengelegt
    // (fixed: die Linie in Metern, n: nach außen, s0..s1: entlang)
    const lines = new Map();
    for (const g of groups) {
        for (const { x, z } of g.cells) {
            for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
                if (level.liftAt(x + dx, z + dz, k) === g) continue;
                const mx = x + 0.5 + dx * 0.51, mz = z + 0.5 + dz * 0.51;
                const here = level.lift(x, z, k, x + 0.5 + dx * 0.49, z + 0.5 + dz * 0.49) + g.floor;
                if (drop(here, x + dx, z + dz, mx, mz) < 0.5) continue;
                const alongX = dz !== 0;
                const fixed = (alongX ? z + (dz > 0 ? 1 : 0) : x + (dx > 0 ? 1 : 0)) * cell;
                const s = (alongX ? x : z) * cell;
                const key = `${alongX ? 'x' : 'z'}${fixed}:${dx}${dz}:${groups.indexOf(g)}`;
                if (!lines.has(key)) lines.set(key, { g, alongX, fixed, n: [dx, dz], spans: [] });
                lines.get(key).spans.push([s, s + cell]);
            }
        }
    }
    const runs = [];
    for (const line of lines.values()) {
        line.spans.sort((p, q) => p[0] - q[0]);
        for (const span of line.spans) {
            const last = runs[runs.length - 1];
            if (last && last.line === line && Math.abs(span[0] - last.s1) < 1e-6) last.s1 = span[1];
            else runs.push({ line, s0: span[0], s1: span[1] });
        }
    }
    // Die Rohre liegen 6 cm innen; jede Ecke (x, z in Metern) einer Kante
    const offsetOf = (line) => line.fixed - (line.alongX ? line.n[1] : line.n[0]) * inside;
    const point = (run, s) => (run.line.alongX ? [s, offsetOf(run.line)] : [offsetOf(run.line), s]);
    const corner = (run, end) => (run.line.alongX ? [end ? run.s1 : run.s0, run.line.fixed] : [run.line.fixed, end ? run.s1 : run.s0]);
    const same = (p, q) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
    // an jedem Ende: trifft es ein Stück quer dazu, reicht es bis zu dessen Linie
    for (const run of runs) {
        run.ends = [0, 1].map((end) => {
            const p = corner(run, end);
            const across = runs.find((other) => other !== run && other.line.alongX !== run.line.alongX && [0, 1].some((e) => same(corner(other, e), p)));
            const along = runs.find((other) => other !== run && other.line.alongX === run.line.alongX && other.line.fixed === run.line.fixed && [0, 1].some((e) => same(corner(other, e), p)));
            const s = across ? offsetOf(across.line) : end ? run.s1 : run.s0;
            return { s, across, along };
        });
    }
    const y = (run, s, lift) => {
        const [x, z] = point(run, s);
        return railBase(run.line.g, x, z) + lift;
    };
    const posts = new Map();   // Stelle -> [x, z, Fuß, Kopf]
    const addPost = (run, s, top) => {
        const [x, z] = point(run, s);
        const id = `${x.toFixed(3)},${z.toFixed(3)}`;
        if (!posts.has(id)) posts.set(id, [x, z, surface(run.line.g, x, z), top]);
    };
    const bends = new Set();
    const tops = [1, 0.024], mids = [0.5, 0.014];
    for (const run of runs) {
        const [e0, e1] = run.ends;
        const length = Math.abs(e1.s - e0.s);
        const level0 = !run.line.g.stairs || !run.line.alongX === ['east', 'west'].includes(run.line.g.stairs.direction);
        // waagerecht um eine Ecke (beide Stücke ohne Steigung): ein Bogen
        const flat = (other) => other && (!other.line.g.stairs || !other.line.alongX === ['east', 'west'].includes(other.line.g.stairs.direction));
        const r = Math.min(0.14, length / 3);
        const trim = [0, 0];
        run.ends.forEach((end, i) => {
            const dir = i === 0 ? Math.sign(e1.s - e0.s) : Math.sign(e0.s - e1.s);   // ins Stück hinein
            if (end.across && level0 && flat(end.across) && Math.abs(y(run, end.s, 0) - y(end.across, offsetOf(run.line), 0)) < 0.01) {
                trim[i] = dir * r;
                const [px, pz] = point(run, end.s);
                const id = `${px.toFixed(3)},${pz.toFixed(3)}`;
                if (!bends.has(id)) {
                    bends.add(id);
                    const other = end.across;
                    const otherFar = Math.abs(other.ends[0].s - offsetOf(run.line)) > Math.abs(other.ends[1].s - offsetOf(run.line)) ? other.ends[0].s : other.ends[1].s;
                    const u = run.line.alongX ? v3(dir, 0, 0) : v3(0, 0, dir);
                    const vs = Math.sign(otherFar - offsetOf(run.line));
                    const v = other.line.alongX ? v3(vs, 0, 0) : v3(0, 0, vs);
                    const center = v3(px, 0, pz).addScaledVector(u, r).addScaledVector(v, r);
                    for (const [lift, radius] of [tops, mids]) bend(center.clone().setY(y(run, end.s, lift)), v.clone().negate(), u.clone().negate(), r, radius);
                    const middle = center.clone().addScaledVector(u.clone().add(v), -r / Math.SQRT2);
                    posts.set(id, [middle.x, middle.z, surface(run.line.g, middle.x, middle.z), y(run, end.s, 1)]);
                }
            } else {
                addPost(run, end.s, y(run, end.s, 1));   // ein freies Ende, ein Absatz oder eine Treppe am Podest: ein Pfosten
            }
        });
        const a = e0.s + trim[0], b = e1.s + trim[1];
        for (const [lift, radius] of [tops, mids]) {
            const [ax, az] = point(run, a), [bx, bz] = point(run, b);
            pipe(v3(ax, y(run, a, lift), az), v3(bx, y(run, b, lift), bz), radius);
        }
        // das obere Rohr als Hindernis, in Stücken, jedes nur so hoch, wie es dort ist
        const pieces = level0 ? 1 : 8;
        for (let i = 0; i < pieces; i++) {
            const s = a + (b - a) * i / pieces, t = a + (b - a) * (i + 1) / pieces;
            const [px, pz] = point(run, s), [qx, qz] = point(run, t);
            walls.push(wallBox(v3(px, y(run, s, 1), pz), v3(qx, y(run, t, 1), qz)));
        }
        // Pfosten dazwischen, höchstens 1,2 m auseinander
        const count = Math.max(1, Math.ceil(length / POST_SPACING));
        for (let i = 1; i < count; i++) addPost(run, e0.s + (e1.s - e0.s) * i / count, y(run, e0.s + (e1.s - e0.s) * i / count, 1));
    }
    for (const [x, z, foot, top] of posts.values()) post(x, foot, z, top);
    out.userData.walls = walls;
    out.updateMatrixWorld(true);
    return out.children.length ? out : null;
}
