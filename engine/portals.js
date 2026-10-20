// Portale: Was zeichnet das Programm überhaupt? Nur die Räume, die man
// von hier aus sehen kann. Ein Raum hat Wände; in einen anderen sieht man
// nur durch eine Öffnung, eine Tür oder ein Loch. Diese Öffnungen heißen
// Portale (so machten es Spiele wie Descent und Duke Nukem 3D).
//
// Gesucht wird so: Du stehst in einem Raum, den siehst du (soweit er im
// Bild ist). Jedes Portal dieses Raums wird aufs Bild gerechnet, als
// Rechteck. Liegt es im Bild, siehst du hindurch in den Raum dahinter, aber
// nur durch dieses Rechteck. Von dort geht es durch dessen Portale weiter,
// jedes Mal beschnitten auf das Rechteck, durch das man gerade schaut. Wird
// das Rechteck leer, endet der Weg. Alle Räume, die so erreicht werden,
// werden gezeichnet, alle anderen nicht; ein Becken spiegelt nur, wenn sein
// Raum dabei ist.
//
// Rechtecke sind gröber als die Öffnung selbst: Manchmal wird ein Raum
// gezeichnet, den eine Wand doch verdeckt. Nie aber fehlt einer, den man sieht.
import * as THREE from 'three';

const MAX_DEPTH = 24;      // so viele Portale hintereinander, höchstens
const MARGIN = 0.02;       // jedes Rechteck etwas größer: sicher ist sicher (Rot-Cyan-Brille: zwei Augen)

export class Portals {
    constructor(level) {
        this.level = level;
        const { width, depth, layers, settings } = level;
        const cell = settings.cell;
        // je Raum: [{ to, corners }], corners: vier Punkte in der Welt
        this.byRoom = level.rooms.map(() => []);
        this.list = [];
        const add = (a, b, corners) => {
            const portal = { a, b, corners };
            this.list.push(portal);
            this.byRoom[a].push({ to: b, portal });
            this.byRoom[b].push({ to: a, portal });
        };
        // Wie weit ist in einem Feld Luft, an zwei Ecken (in Feldern)? [unten, oben]
        const air = (x, z, k, room, cornersXZ) => {
            const top = level.ceilingOfCell(x, z, k);
            const floors = cornersXZ.map(([cx, cz]) => level.floorAt(cx, cz, room) - level.sunk(x, z, k));
            const arch = level.archAt(x, z, k);   // eine runde Tür: bis ganz oben in ihren Bogen
            return [Math.min(...floors), arch ? arch.top : Math.max(...cornersXZ.map(([cx, cz]) => top(cx, cz)))];
        };
        // Öffnungen in der Wand: zwei Felder nebeneinander aus verschiedenen
        // Räumen, deren Luft sich an der gemeinsamen Kante überschneidet
        const edges = new Map();   // zum Zusammenlegen: gleiche Räume, gleiche Linie, gleiche Höhe
        for (let k = 0; k < layers; k++) {
            for (let z = 0; z < depth; z++) {
                for (let x = 0; x < width; x++) {
                    if (level.kindAt(x, z, k) !== 'floor') continue;
                    const a = level.roomAt(x, z, k);
                    for (const [nx, nz, edge, alongX] of [[x + 1, z, [[x + 1, z], [x + 1, z + 1]], false], [x, z + 1, [[x, z + 1], [x + 1, z + 1]], true]]) {
                        for (const slab of level.slabs(nx, nz)) {
                            if (slab.room === a) continue;
                            const [lowA, highA] = air(x, z, k, a, edge);
                            const [lowB, highB] = air(nx, nz, slab.layer, slab.room, edge);
                            const low = Math.max(lowA, lowB), high = Math.min(highA, highB);
                            if (high - low < 0.05) continue;
                            const [p, q] = edge;
                            const key = `${Math.min(a, slab.room)}:${Math.max(a, slab.room)}:${alongX ? 'x' : 'z'}:${alongX ? p[1] : p[0]}:${low.toFixed(2)}:${high.toFixed(2)}`;
                            if (!edges.has(key)) edges.set(key, { a, b: slab.room, alongX, line: alongX ? p[1] : p[0], low, high, spans: [] });
                            edges.get(key).spans.push(alongX ? p[0] : p[1]);
                        }
                    }
                }
            }
        }
        for (const { a, b, alongX, line, low, high, spans } of edges.values()) {
            spans.sort((s, t) => s - t);
            let start = 0;
            while (start < spans.length) {
                let end = start;
                while (end + 1 < spans.length && spans[end + 1] === spans[end] + 1) end += 1;
                const from = spans[start] * cell, to = (spans[end] + 1) * cell, at = line * cell;
                const point = (s, y) => (alongX ? new THREE.Vector3(s, y, at) : new THREE.Vector3(at, y, s));
                add(a, b, [point(from, low), point(to, low), point(to, high), point(from, high)]);
                start = end + 1;
            }
        }
        // Löcher: unten ein Feld ohne Decke, oben der Raum mit dem Loch im Boden
        for (let k = 0; k < layers; k++) {
            for (let z = 0; z < depth; z++) {
                for (let x = 0; x < width; x++) {
                    if (level.kindAt(x, z, k) !== 'floor' || !level.ceilingOpen(x, z, k)) continue;
                    const lower = level.roomAt(x, z, k);
                    for (let j = 0; j < layers; j++) {
                        if (level.kindAt(x, z, j) !== 'hole') continue;
                        const upper = level.roomAt(x, z, j);
                        const y = level.floorAt(x + 0.5, z + 0.5, upper);
                        add(lower, upper, [[x, z], [x + 1, z], [x + 1, z + 1], [x, z + 1]].map(([cx, cz]) => new THREE.Vector3(cx * cell, y, cz * cell)));
                    }
                }
            }
        }
        this.clip = new THREE.Vector4();
        this.matrix = new THREE.Matrix4();
    }

    // Das Rechteck eines Portals im Bild der Kamera ([x0, y0, x1, y1], -1 bis 1),
    // oder null, wenn es ganz hinter ihr liegt. Was hinter der Kamera liegt,
    // wird vorher abgeschnitten.
    rectangle(corners) {
        const points = corners.map((p) => new THREE.Vector4(p.x, p.y, p.z, 1).applyMatrix4(this.matrix));
        // an der Ebene direkt vor der Kamera abschneiden (w > z: vor ihr)
        const inside = (v) => v.w + v.z > 0;
        const kept = [];
        for (let i = 0; i < points.length; i++) {
            const p = points[i], q = points[(i + 1) % points.length];
            if (inside(p)) kept.push(p);
            if (inside(p) !== inside(q)) {
                const t = (p.w + p.z) / ((p.w + p.z) - (q.w + q.z));
                kept.push(p.clone().lerp(q, t));
            }
        }
        if (kept.length === 0) return null;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const v of kept) {
            const w = Math.max(v.w, 1e-6);
            x0 = Math.min(x0, v.x / w); x1 = Math.max(x1, v.x / w);
            y0 = Math.min(y0, v.y / w); y1 = Math.max(y1, v.y / w);
        }
        return [x0 - MARGIN, y0 - MARGIN, x1 + MARGIN, y1 + MARGIN];
    }

    // Welche Räume sieht die Kamera, die im Raum start steht? { rooms, seen }:
    // die Räume (eine Menge) und die Portale, durch die man schaut, mit ihren
    // Rechtecken (für die Automap). start < 0: alle. fresh: Die Matrizen der
    // Kamera stimmen schon (ein Auge in VR: three.js rechnet sie aus der Brille
    // und dem Platz des Spielers; neu ausgerechnet fehlte der Platz).
    visible(camera, start, fresh = false) {
        const rooms = new Set();
        const seen = [];
        if (start < 0) {
            this.level.rooms.forEach((room) => rooms.add(room.index));
            return { rooms, seen };
        }
        if (!fresh) camera.updateMatrixWorld();
        this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const window = new Map();   // je Raum: das Rechteck, durch das man ihn schon sieht (alle zusammen)
        const visit = (room, view, depth) => {
            rooms.add(room);
            const known = window.get(room);
            // schon durch ein größeres Rechteck gesehen: nichts Neues
            if (known && known[0] <= view[0] && known[1] <= view[1] && known[2] >= view[2] && known[3] >= view[3]) return;
            window.set(room, known ? [Math.min(known[0], view[0]), Math.min(known[1], view[1]), Math.max(known[2], view[2]), Math.max(known[3], view[3])] : view);
            if (depth >= MAX_DEPTH) return;
            for (const { to, portal } of this.byRoom[room]) {
                const r = this.rectangle(portal.corners);
                if (!r) continue;
                const cut = [Math.max(r[0], view[0]), Math.max(r[1], view[1]), Math.min(r[2], view[2]), Math.min(r[3], view[3])];
                if (cut[0] >= cut[2] || cut[1] >= cut[3]) continue;
                seen.push({ portal, from: room, to });
                visit(to, cut, depth + 1);
            }
        };
        visit(start, [-1, -1, 1, 1], 0);
        return { rooms, seen };
    }
}
