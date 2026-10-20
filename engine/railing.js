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
    const metal = new THREE.MeshStandardMaterial({ color: '#cfd3d6', metalness: 1, roughness: 0.22 });
    const group = new THREE.Group();
    const posts = new Map();
    const tube = (radius, length) => new THREE.CylinderGeometry(radius, radius, length, 12, 1, false);
    for (const { alongX, fixed, spans } of lines.values()) {
        spans.sort((p, q) => p[0] - q[0]);
        const merged = [];
        for (const span of spans) {
            const last = merged[merged.length - 1];
            if (last && span[0] <= last[1] + 1e-3) last[1] = Math.max(last[1], span[1]);
            else merged.push([...span]);
        }
        for (const [lo, hi] of merged) {
            const at = (s) => (alongX ? [s, fixed] : [fixed, s]);
            for (const [height, radius] of [[RAIL_HEIGHT, 0.024], [RAIL_HEIGHT / 2, 0.014]]) {
                const rail = new THREE.Mesh(tube(radius, hi - lo), metal);
                const [cx, cz] = at((lo + hi) / 2);
                rail.position.set(cx, floor + height, cz);
                rail.rotation.set(alongX ? 0 : Math.PI / 2, 0, alongX ? Math.PI / 2 : 0);
                group.add(rail);
            }
            const count = Math.max(1, Math.ceil((hi - lo) / POST_SPACING));
            for (let i = 0; i <= count; i++) {
                const [px, pz] = at(lo + ((hi - lo) * i) / count);
                posts.set(`${px.toFixed(2)},${pz.toFixed(2)}`, [px, pz]);
            }
        }
    }
    for (const [px, pz] of posts.values()) {
        const post = new THREE.Mesh(tube(0.022, RAIL_HEIGHT), metal);
        post.position.set(px, floor + RAIL_HEIGHT / 2, pz);
        group.add(post);
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.012, 16), metal);
        foot.position.set(px, floor + 0.006, pz);
        group.add(foot);
    }
    group.updateMatrixWorld(true);
    return group.children.length ? group : null;
}
