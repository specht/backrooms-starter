// Baut aus dem Grundriss Boden, Decke und Wände. Jede Fläche bekommt ein
// eigenes Rechteck in der Lichtkarte (uv1), damit das Licht für jede Stelle
// einzeln ausgerechnet werden kann.
import * as THREE from 'three';

export const EDGE_ANGLE = 4;          // ab so vielen Grad Knick ist eine Kante eine Kante (Linien, Automap)
const GUTTER = 1;                     // Rand um jedes Rechteck, gegen Nähte

// Packt Rechtecke zeilenweise in ein Quadrat (»Regalbretter«).
function packRectangles(rects) {
    const area = rects.reduce((sum, r) => sum + (r.w + 2 * GUTTER) * (r.h + 2 * GUTTER), 0);
    let size = 256;
    while (size * size < area * 1.15) size *= 2;
    for (;;) {
        let x = 0, y = 0, shelf = 0, fits = true;
        const sorted = rects.slice().sort((a, b) => b.h - a.h);
        for (const r of sorted) {
            const w = r.w + 2 * GUTTER, h = r.h + 2 * GUTTER;
            if (x + w > size) { x = 0; y += shelf; shelf = 0; }
            if (y + h > size) { fits = false; break; }
            r.ax = x + GUTTER; r.ay = y + GUTTER;
            x += w; shelf = Math.max(shelf, h);
        }
        if (fits) return size;
        size *= 2;
    }
}

// Die Normale einer Fläche aus allen ihren Ecken (Newell): auch richtig für
// ein Viereck mit zwei gleichen Ecken, ein Dreieck. Solche entstehen, wo sich
// zwei schräge Decken an einer Tür kreuzen; aus nur drei Ecken käme dort
// keine Richtung heraus und im Licht NaN. Ohne Fläche: [0, 0, 0].
function faceNormal(corners) {
    const n = [0, 0, 0];
    for (let i = 0; i < corners.length; i++) {
        const [x0, y0, z0] = corners[i], [x1, y1, z1] = corners[(i + 1) % corners.length];
        n[0] += (y0 - y1) * (z0 + z1);
        n[1] += (z0 - z1) * (x0 + x1);
        n[2] += (x0 - x1) * (y0 + y1);
    }
    const length = Math.hypot(...n);
    return length > 1e-9 ? n.map((v) => v / length) : [0, 0, 0];
}

// In welche Richtung eine Wand ins Feld zeigt
const INWARD = { north: [0, 0, 1], south: [0, 0, -1], west: [1, 0, 0], east: [-1, 0, 0] };

// Anfang und Ende einer Wand (in Feldern), so herum, dass ihre Vorderseite
// ins Feld zeigt (gegen den Uhrzeigersinn von innen gesehen)
function wallEnds(direction, line, from, to) {
    switch (direction) {
    case 'north': return [[from, line], [to, line]];
    case 'south': return [[to, line], [from, line]];
    case 'west': return [[line, to], [line, from]];
    default: return [[line, from], [line, to]];
    }
}

// Wo ein Modell oder ein Block nah an einer Fläche steht, wirft es feine
// Schatten, die das normale Raster der Lichtkarte nicht fassen kann. Dort
// bekommt die Fläche zusätzlich ein Detailstück Lichtkarte mit bis zu
// FINE-mal so vielen Punkten, über den Umriss (plus MARGIN). Das Detailstück
// wird über die Fläche gemischt und blendet am Rand über FADE Meter aus:
// kein Sprung, keine Naht. Liegen auf einer Fläche mehrere Gruppen weit
// auseinander (Säulen in einer Halle), wird sie zwischen ihnen geteilt, jedes
// Stück mit eigenem Detailstück; sonst teilen sie sich eins, höchstens
// DETAIL_BUDGET Punkte groß (sonst gröber). Gezeichnet wird so schnell wie
// vorher, nur das Backen hat ein paar Punkte mehr.
const FINE = 4;
const FINE_BLOCK = 3;   // bei Blöcken: Ihre Kanten sind gerade, ihre Schatten einfacher
const MARGIN = 0.6;   // Meter um das Modell: so weit reichen seine weichen Schatten
const FADE = 0.3;
const DETAIL_BUDGET = 400000;
const ATLAS_LIMIT = 2048;   // so groß soll die Lightmap höchstens werden, wenn es irgend geht

// Rechtecke [s0, s1, t0, t1, wie fein], die sich überlappen, zu einem zusammengefasst
function mergeRectangles(list) {
    const rects = list.map((r) => r.slice());
    for (let changed = true; changed;) {
        changed = false;
        for (let i = 0; i < rects.length && !changed; i++) {
            for (let j = i + 1; j < rects.length && !changed; j++) {
                const a = rects[i], b = rects[j];
                if (a[0] > b[1] || b[0] > a[1] || a[2] > b[3] || b[2] > a[3]) continue;
                rects[i] = [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4])];
                rects.splice(j, 1);
                changed = true;
            }
        }
    }
    return rects;
}

// Teilt [0, 1]² zwischen den Rechtecken, mit geraden Schnitten durch das
// ganze Stück, solange einer zwischen ihnen hindurchpasst. Ergibt Stücke
// { s0, s1, t0, t1, rect } (rect in Koordinaten der ganzen Fläche).
function cutBetween(rects, piece = { s0: 0, s1: 1, t0: 0, t1: 1 }) {
    if (rects.length > 1) {
        for (const [lo, hi, from, to] of [[0, 1, 's0', 's1'], [2, 3, 't0', 't1']]) {
            const sorted = rects.slice().sort((a, b) => a[lo] - b[lo]);
            let reach = sorted[0][hi];
            for (let i = 1; i < sorted.length; i++) {
                if (sorted[i][lo] > reach + 1e-6) {
                    const at = (reach + sorted[i][lo]) / 2;
                    return [...cutBetween(sorted.slice(0, i), { ...piece, [to]: at }),
                        ...cutBetween(sorted.slice(i), { ...piece, [from]: at })];
                }
                reach = Math.max(reach, sorted[i][hi]);
            }
        }
    }
    const box = rects.reduce((a, r) => [Math.min(a[0], r[0]), Math.max(a[1], r[1]), Math.min(a[2], r[2]), Math.max(a[3], r[3]), Math.max(a[4], r[4])]);
    return [{ ...piece, rect: box }];
}

function addDetail(faces, boxes) {
    if (boxes.length === 0) return faces;
    const sub = (a, b) => a.map((v, i) => v - b[i]);
    const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
    const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    const result = [], extra = [], plans = [];
    for (const face of faces) {
        if ((face.subdivide ?? 1) > 1 || face.shape) { result.push(face); continue; }
        const [c0, c1, c2, c3] = face.corners;
        const e1 = sub(c1, c0), e3 = sub(c3, c0);
        // eine Seite eines Blocks, die an einem anderen anliegt, sieht niemand
        const middle = lerp(lerp(c0, c2, 0.5), face.normal, 0.01 / Math.hypot(...face.normal));
        const inside = (box, p) => p[0] > box.min.x && p[0] < box.max.x && p[1] > box.min.y && p[1] < box.max.y && p[2] > box.min.z && p[2] < box.max.z;
        if (face.owner !== undefined && boxes.some((box) => box.owner !== undefined && !box.turned && inside(box, middle))) { result.push(face); continue; }
        const rects = [];
        for (const box of boxes) {
            if (box.owner !== undefined && box.owner === face.owner) continue;   // ein Block braucht für sich selbst keins
            // nur was vor der Fläche aufragt, wirft Schatten auf sie
            const own = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z]);
            if (Math.max(...own.map((p) => dot(sub(p, c0), face.normal))) < 1e-3) continue;
            const lo = [box.min.x - MARGIN, box.min.y - MARGIN, box.min.z - MARGIN];
            const hi = [box.max.x + MARGIN, box.max.y + MARGIN, box.max.z + MARGIN];
            const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]]);
            // liegt die Ebene der Fläche im erweiterten Kasten?
            const sides = corners.map((p) => dot(sub(p, c0), face.normal));
            if (Math.min(...sides) > 0 || Math.max(...sides) < 0) continue;
            // der Kasten in Koordinaten der Fläche: s entlang c0 -> c1, t entlang c0 -> c3
            const ss = corners.map((p) => dot(sub(p, c0), e1) / dot(e1, e1));
            const ts = corners.map((p) => dot(sub(p, c0), e3) / dot(e3, e3));
            const a = Math.max(0, Math.min(...ss)), b = Math.min(1, Math.max(...ss));
            const c = Math.max(0, Math.min(...ts)), d = Math.min(1, Math.max(...ts));
            if (b - a < 1e-3 || d - c < 1e-3) continue;
            rects.push([a, b, c, d, box.owner === undefined ? FINE : FINE_BLOCK]);
        }
        if (rects.length === 0) { result.push(face); continue; }
        // jedes Stück der Fläche wie die Fläche selbst, nur kleiner: Ecken,
        // Richtungen und Texturkoordinaten an seinen Rändern
        const at = (s, t) => lerp(lerp(c0, c1, s), lerp(c3, c2, s), t);
        const corner4 = (four, s, t) => lerp(lerp(four[0], four[1], s), lerp(four[3], four[2], s), t);
        for (const { s0: S0, s1: S1, t0: T0, t1: T1, rect: [r0, r1, r2, r3, fine] } of cutBetween(mergeRectangles(rects))) {
            let piece = face;
            if (S0 > 0 || S1 < 1 || T0 > 0 || T1 < 1) {
                const four = [[S0, T0], [S1, T0], [S1, T1], [S0, T1]];
                const corners = four.map(([s, t]) => at(s, t));
                piece = {
                    ...face, corners,
                    w: Math.max(2, Math.round(face.w * (S1 - S0))), h: Math.max(2, Math.round(face.h * (T1 - T0))),
                    normals: face.normals && four.map(([s, t]) => corner4(face.normals, s, t)),
                    uv4: face.uv4 && four.map(([s, t]) => corner4(face.uv4, s, t)),
                    arc: face.arc && [face.arc[0] + (face.arc[1] - face.arc[0]) * S0, face.arc[0] + (face.arc[1] - face.arc[0]) * S1],
                    uvAt: face.uvAt && ((s, t) => face.uvAt(S0 + s * (S1 - S0), T0 + t * (T1 - T0))),
                };
            }
            result.push(piece);
            // das Rechteck in Koordinaten des Stücks
            const s0 = (r0 - S0) / (S1 - S0), s1 = (r1 - S0) / (S1 - S0);
            const t0 = (r2 - T0) / (T1 - T0), t1 = (r3 - T0) / (T1 - T0);
            const coarse = piece.w * (s1 - s0) * piece.h * (t1 - t0);
            const factor = Math.min(fine, Math.sqrt(DETAIL_BUDGET / Math.max(coarse, 1)));
            if (factor < 1.5) continue;
            plans.push({ piece, s0, s1, t0, t1, r0, r1, r2, r3, factor, coarse });
        }
    }
    // Alles zusammen soll in eine Lightmap von ATLAS_LIMIT passen (beim Backen
    // acht Bilder dieser Größe: mit 2048 × 2048 rund 256 MB, mit 4096 viermal
    // so viel, zu viel für ein Tablet). Sonst werden alle feineren Stücke
    // gleich viel gröber, und zu grobe fallen weg.
    const area = (w, h) => (w + 2) * (h + 2);
    const room = ATLAS_LIMIT * ATLAS_LIMIT / 1.2 - result.reduce((sum, f) => sum + area(f.w, f.h), 0);
    const wanted = plans.reduce((sum, plan) => sum + plan.coarse * plan.factor * plan.factor, 0);
    const shrink = wanted > room ? Math.sqrt(Math.max(0, room) / wanted) : 1;
    for (const plan of plans) {
        const { piece, s0, s1, t0, t1, r0, r1, r2, r3 } = plan;
        const factor = plan.factor * shrink;
        if (factor < 1.5) continue;
        {
            const [p0, p1, p2, p3] = piece.corners;
            const atPiece = (s, t) => lerp(lerp(p0, p1, s), lerp(p3, p2, s), t);
            const detail = {
                ...piece, detailOnly: true, density: factor, normals: undefined,
                corners: [atPiece(s0, t0), atPiece(s1, t0), atPiece(s1, t1), atPiece(s0, t1)],
                w: Math.max(2, Math.round(piece.w * (s1 - s0) * factor)), h: Math.max(2, Math.round(piece.h * (t1 - t0) * factor)),
            };
            // wie weit das Ausblenden in Koordinaten des Stücks reicht; wo das
            // Detailstück an den Rand der Fläche stößt, blendet es nicht aus
            // (an einem Schnitt schon: Dort liegt kein Rand der Fläche)
            const lengthS = Math.hypot(...sub(p1, p0)), lengthT = Math.hypot(...sub(p3, p0));
            const fade = (length, from, to) => Math.min(FADE / Math.max(length, 1e-6), (to - from) / 2);
            piece.detail = {
                target: detail, s0, s1, t0, t1,
                fadeS: [r0 > 1e-3 ? fade(lengthS, s0, s1) : 0, r1 < 1 - 1e-3 ? fade(lengthS, s0, s1) : 0],
                fadeT: [r2 > 1e-3 ? fade(lengthT, t0, t1) : 0, r3 < 1 - 1e-3 ? fade(lengthT, t0, t1) : 0],
            };
            extra.push(detail);
        }
    }
    return result.concat(extra);
}

// modelBoxes: der Kasten um jedes Modell, für feinere Lichtkarte in ihrer Nähe (um Blöcke auch)
const SLAB_COLOR = '#8e8a80';   // die Decke zwischen zwei Räumen übereinander, am Rand eines Lochs
const ROUND_SIDES = 32;         // so viele schmale Flächen hat eine runde Säule ringsum
const ARCH_STEPS = 64;          // so viele Stücke hat der Halbkreis eines Bogens, wie breit er auch ist
// Eine Tür zwischen zwei Räumen: innen (Laibung, Sturz, Gewölbe) heller Putz;
// mit casing = on auf beiden Seiten der Wand um die Öffnung eine Bekleidung in der Farbe der
// Sockelleiste ihres Raums (ohne: hell gestrichen), so breit und so weit vor der Wand
const LINING_COLOR = '#e4dfd4';
const THRESHOLD_COLOR = '#cdc6b8';   // der Boden in der Tür: eine Schwelle aus hellem Stein, von Bekleidung zu Bekleidung
const CASING_WIDTH = 0.08;
const CASING_PAINT = '#d9d3c6';   // die Bekleidung in einem Raum ohne Sockelleiste
const CASING_DEPTH = 0.02;     // etwas weiter vor als die Sockelleiste (1,5 cm), die darunter endet

export function buildGeometry(level, modelBoxes = []) {
    const { width, depth, layers, settings } = level;
    const cell = settings.cell;
    // Räume können übereinander liegen (Schichten, level.js): at und roomOf
    // fragen eine Schicht, slabs alle
    const at = (x, z, k = 0) => level.kindAt(x, z, k);
    const roomOf = (x, z, k = 0) => level.roomAt(x, z, k);
    // Decken- und Bodenhöhe an einer Ecke (in Feldern), so wie der Raum dieses Feldes sie will
    const ceiling = (x, z, room) => level.ceilingAt(x, z, room);
    const floorAt = (x, z, room) => level.floorAt(x, z, room);

    let faces = [];
    // Auflösung der Lichtkarte: detail Punkte pro Meter (level.ini)
    const texels = (meters) => Math.max(2, Math.round(meters * settings.detail));
    // eine Fläche ohne Fläche (alle Ecken auf einer Linie) gibt es nicht
    const add = (kind, room, corners, w, h, subdivide = 1) => {
        const normal = faceNormal(corners);
        if (normal.some((v) => v !== 0)) faces.push({ kind, room, corners, normal, w, h, subdivide });
    };
    // die Laibung einer Tür: heller Putz, für beide Räume gleich
    const lining = (room, corners, w, h) => {
        const normal = faceNormal(corners);
        if (normal.some((v) => v !== 0)) faces.push({ kind: 'block', color: LINING_COLOR, material: 'plain', room, corners, normal, w, h });
    };
    // Der Boden einer Tür kann verdreht sein (an jeder Kante so schräg wie der
    // Raum dahinter): gezeichnet als feines Gitter, damit er genau auf der
    // Fläche liegt, mit der Strahlen und Füße rechnen
    const DOOR_GRID = 16;   // je Stück unter einem Grad Knick: Für Kanten zählt erst mehr (EDGE_ANGLE)
    // Ein Durchgang mit Rahmen (casing = on): ein Feld mit Boden (eine Tür), quer zur Wand auf beiden
    // Seiten der Boden zweier verschiedener Räume, gleich hoch. Seine Hälften
    // gehören den Räumen, auf deren Seite sie liegen: Wand, Sockelleiste,
    // Boden und Decke wie dort. So sieht man der Wand ihre Dicke an, statt
    // dass ein Raum bis an die Tapete des anderen reicht. axis: quer durch
    // die Wand; near: der Raum auf der Seite der kleineren Zahl, far: der andere
    const passage = (x, z, k) => {
        // nur eine Tür mit casing = on hat einen Rahmen; jede andere gehört dem Raum, dem ihr Feld gehört
        if (!level.framedDoorAt(x, z, k) || !level.doorAt(x, z, k) || at(x, z, k) !== 'floor' || level.twistedDoors.has(level.index(x, z, k)) || level.poolAt(x, z, k) || level.liftAt(x, z, k)) return null;
        const own = roomOf(x, z, k);
        for (const [axis, a, b] of [['z', [x, z - 1], [x, z + 1]], ['x', [x - 1, z], [x + 1, z]]]) {
            if (at(a[0], a[1], k) !== 'floor' || at(b[0], b[1], k) !== 'floor') continue;
            const near = roomOf(a[0], a[1], k), far = roomOf(b[0], b[1], k);
            if (near === far || (near !== own && far !== own)) continue;
            if (Math.abs(floorAt(x + 0.5, z + 0.5, near) - floorAt(x + 0.5, z + 0.5, far)) > 0.01) continue;
            return { axis, near, far };
        }
        return null;
    };

    // Boden und Decke: pro Raum die größten Rechtecke aus Feldern, damit
    // die Lichtkarte über eine ganze Fläche durchgeht (keine Nähte an jedem
    // Feld). Unter einem Satteldach nur Streifen entlang des Firsts, denn
    // die Decke knickt am First; auf einer Rampe Streifen quer zu ihr, denn
    // der Boden knickt an ihren Enden. Beides: einzelne Felder.
    // forCeiling: Felder für die Decke (auch über einem Loch im eigenen
    // Boden, aber nicht unter einem Loch in der eigenen Decke)
    const rectangles = (room, onlyAlong, forCeiling = false) => {
        const used = new Set();
        const k = level.rooms[room].layer;
        const kinds = forCeiling ? ['floor', 'hole'] : ['floor'];
        // Türen mit verdrehtem Boden (zwischen zwei verschieden schrägen
        // Räumen) sind eigene Felder; alle anderen gehören zum Boden ihres Raums
        const door = (x, z) => level.twistedDoors.has(level.index(x, z, k));
        // ein Becken hat seinen eigenen Boden, tief unten (pools unten); die Decke darüber gehört dem Raum
        const mine = (x, z) => kinds.includes(at(x, z, k)) && roomOf(x, z, k) === room && !(forCeiling && level.ceilingOpen(x, z, k))
            && (forCeiling || (!level.poolAt(x, z, k) && !level.liftAt(x, z, k))) && !(forCeiling && level.archAt(x, z, k));   // Becken, Treppen und Podeste haben ihren eigenen Boden, eine runde Tür ihren Bogen
        const inRoom = (x, z) => mine(x, z) && !used.has(z * width + x) && !door(x, z) && !passage(x, z, k);
        const result = [];
        for (let z = 0; z < depth; z++) {
            for (let x = 0; x < width; x++) {
                if (mine(x, z) && door(x, z)) { result.push({ x, z, w: 1, d: 1, door: true }); continue; }
                if (!inRoom(x, z)) continue;
                let w = 1, d = 1;
                if (onlyAlong !== 'z' && onlyAlong !== 'cell') while (inRoom(x + w, z)) w += 1;
                if (onlyAlong !== 'x' && onlyAlong !== 'cell') {
                    while (z + d < depth && [...Array(w).keys()].every((i) => inRoom(x + i, z + d))) d += 1;
                }
                for (let dz = 0; dz < d; dz++) for (let dx = 0; dx < w; dx++) used.add((z + dz) * width + x + dx);
                result.push({ x, z, w, d });
            }
        }
        return result;
    };

    level.rooms.forEach((room) => {
        const r = room.index;
        const h = (cx, cz) => ceiling(cx, cz, r);
        const f = (cx, cz) => floorAt(cx, cz, r);
        const gable = room.settings.slope === 'gable' ? (room.width >= room.depth ? 'x' : 'z') : null;
        // eine Rampe nach Osten oder Westen ändert sich entlang x: Streifen entlang z
        const ramp = room.settings.ramp ? (['east', 'west'].includes(room.settings.ramp.direction) ? 'z' : 'x') : null;
        const both = gable && ramp && gable !== ramp ? 'cell' : gable ?? ramp;
        for (const { x, z, w, d, door } of rectangles(r, ramp)) {
            const x0 = x * cell, x1 = (x + w) * cell, z0 = z * cell, z1 = (z + d) * cell;
            add('floor', r, [[x0, f(x, z + d), z1], [x1, f(x + w, z + d), z1], [x1, f(x + w, z), z0], [x0, f(x, z), z0]],
                texels(w * cell), texels(d * cell), door ? DOOR_GRID : 1);
        }
        for (const { x, z, w, d, door } of rectangles(r, both, true)) {
            const x0 = x * cell, x1 = (x + w) * cell, z0 = z * cell, z1 = (z + d) * cell;
            add('ceiling', r, [[x0, h(x, z), z0], [x1, h(x + w, z), z0], [x1, h(x + w, z + d), z1], [x0, h(x, z + d), z1]],
                texels(w * cell), texels(d * cell), door ? DOOR_GRID : 1);
        }
        // die Durchgänge dieses Raums: unten eine Schwelle über die ganze
        // Tiefe der Tür, oben der Sturz aus Putz, beide für die zwei Räume gleich
        const k = room.layer;
        for (let z = 0; z < depth; z++) {
            for (let x = 0; x < width; x++) {
                if (roomOf(x, z, k) !== r) continue;
                const pass = passage(x, z, k);
                if (!pass) continue;
                const top = level.ceilingOfCell(x, z, k);
                const fl = (cx, cz) => floorAt(cx, cz, r);
                const sill = [[x * cell, fl(x, z + 1), (z + 1) * cell], [(x + 1) * cell, fl(x + 1, z + 1), (z + 1) * cell], [(x + 1) * cell, fl(x + 1, z), z * cell], [x * cell, fl(x, z), z * cell]];
                const normal = faceNormal(sill);
                if (normal.some((v) => v !== 0)) faces.push({ kind: 'block', color: THRESHOLD_COLOR, material: 'plain', room: r, corners: sill, normal, w: texels(cell), h: texels(cell) });
                for (const [half, owner] of [[0, pass.near], [1, pass.far]]) {
                    const [hx0, hx1, hz0, hz1] = pass.axis === 'z' ? [x, x + 1, z + half / 2, z + (half + 1) / 2] : [x + half / 2, x + (half + 1) / 2, z, z + 1];
                    if (level.ceilingOpen(x, z, k) || level.archAt(x, z, k)) continue;
                    lining(owner, [[hx0 * cell, top(hx0, hz0), hz0 * cell], [hx1 * cell, top(hx1, hz0), hz0 * cell], [hx1 * cell, top(hx1, hz1), hz1 * cell], [hx0 * cell, top(hx0, hz1), hz1 * cell]],
                        texels((hx1 - hx0) * cell), texels((hz1 - hz0) * cell));
                }
            }
        }
    });

    // Wände: erst jedes Stück einzeln, dann Stücke auf derselben Linie im
    // selben Raum zu einer Fläche zusammen, solange ihre Oberkante gerade bleibt
    const pieces = new Map();
    // Die Lücken einer Wand: Von unten nach oben ist Wand, wo hinter der
    // Kante keine Luft ist. Luft hinter ihr kommt von jedem Raum, der dort
    // einen Boden hat, in jeder Schicht (a und b: die beiden Enden der Kante).
    // slab: die Lücke liegt zwischen zwei Räumen übereinander dahinter (die
    // Decke zwischen ihnen, etwa am Rand eines Lochs), nicht unter oder über allem
    const gaps = (bottom, top, open) => {
        const result = [];
        let low = bottom, between = false;
        for (const o of [...open].sort((p, q) => p.floor[0] + p.floor[1] - q.floor[0] - q.floor[1])) {
            const high = [Math.min(o.floor[0], top[0]), Math.min(o.floor[1], top[1])];
            if (high[0] > low[0] + 0.01 || high[1] > low[1] + 0.01) result.push([low, [Math.max(high[0], low[0]), Math.max(high[1], low[1])], between]);
            low = [Math.max(low[0], o.ceiling[0]), Math.max(low[1], o.ceiling[1])];
            between = true;
        }
        if (top[0] > low[0] + 0.01 || top[1] > low[1] + 0.01) result.push([[Math.min(low[0], top[0]), Math.min(low[1], top[1])], top, false]);
        return result;
    };
    // Eine gebogene Fläche: shape(s, t) gibt für s und t von 0 bis 1 die Stelle
    // in der Welt; in s steps Stücke (gebogen), in t gerade. Ein Stück
    // Lichtkarte für alles, so dicht wie jede andere Fläche (meters: wie
    // lang und breit sie ist). uvAt(s, t): Texturkoordinaten, sonst wie eine Wand.
    // Eine Stelle auf einem runden Bogen zwischen uS und uE (Meter entlang
    // der Tür), in gleichen Winkeln statt gleichen Abständen entlang der Tür:
    // So sind die Stücke des Bogens auch an seinem Fuß, wo er fast senkrecht
    // steht, so lang wie oben, und die Punkte der Lichtkarte liegen gleichmäßig
    const angleOf = (arch, u) => Math.acos(Math.min(1, Math.max(-1, (arch.center - u) / arch.radius)));
    const alongArc = (arch, uS, uE, s) => {
        const a = angleOf(arch, uS), b = angleOf(arch, uE);
        return arch.center - arch.radius * Math.cos(a + (b - a) * s);
    };
    const arcSteps = (arch, uS, uE) => Math.max(8, Math.ceil(ARCH_STEPS * Math.abs(angleOf(arch, uE) - angleOf(arch, uS)) / Math.PI));
    const curved = (kind, room, shape, steps, metersS, metersT, uvAt = null, extra = {}) => {
        const samples = [...Array(steps + 1).keys()].flatMap((i) => [shape(i / steps, 0), shape(i / steps, 1)]);
        const corners = [shape(0, 0), shape(1, 0), shape(1, 1), shape(0, 1)];
        const normal = faceNormal([shape(0.45, 0), shape(0.55, 0), shape(0.55, 1), shape(0.45, 1)]);
        if (normal.every((v) => v === 0)) return;
        faces.push({ kind, room, corners, normal, w: texels(metersS), h: texels(metersT), shape, steps, uvAt, samples, ...extra });
    };
    // Eine Sockelleiste vor einem Stück Wand von p nach q (in Feldern), auf
    // dem Boden bei y: vorne und oben, 1,5 cm vor der Wand
    const skirting = (room, direction, p, q, y0) => {
        const board = level.rooms[room].settings.baseboard;
        if (!board) return;
        const n = INWARD[direction], y = y0 + board.height, o = 0.015;
        const length = Math.hypot(q[0] - p[0], q[1] - p[1]) * cell;
        const front = [[p[0] * cell + n[0] * o, y0, p[1] * cell + n[2] * o], [q[0] * cell + n[0] * o, y0, q[1] * cell + n[2] * o],
            [q[0] * cell + n[0] * o, y, q[1] * cell + n[2] * o], [p[0] * cell + n[0] * o, y, p[1] * cell + n[2] * o]];
        const upper = [[p[0] * cell, y, p[1] * cell], [q[0] * cell, y, q[1] * cell], [q[0] * cell + n[0] * o, y, q[1] * cell + n[2] * o], [p[0] * cell + n[0] * o, y, p[1] * cell + n[2] * o]];
        for (const [face, want, sw, sh] of [[front, n, length, board.height], [upper, [0, 1, 0], length, 0.2]]) {
            let c = face;
            if (faceNormal(c).reduce((sum, v, k) => sum + v * want[k], 0) < 0) c = [c[0], c[3], c[2], c[1]];
            faces.push({ kind: 'baseboard', color: board.color, room, corners: c, normal: faceNormal(c), w: texels(sw), h: texels(sh) });
        }
    };
    // Eine Leiste oben (cornice), wo die Wand von p nach q (in Feldern) an die
    // Decke stößt (bei topP und topQ): ein Streifen schräg, 45° zwischen Wand und Decke
    const crown = (room, direction, p, q, topP, topQ) => {
        const cornice = level.rooms[room].settings.cornice;
        if (!cornice) return;
        const n = INWARD[direction], hgt = cornice.height;
        const length = Math.hypot(q[0] - p[0], q[1] - p[1]) * cell;
        // An einer Außenecke (die Wand biegt vom Raum weg, etwa an der Kante
        // einer Türöffnung bis unter die Decke) reicht die Leiste oben um ihre
        // Höhe weiter: Die Leisten beider Wände treffen sich dort auf Gehrung,
        // sonst bliebe ein dreieckiges Loch. Außenecke: hinter dem Ende ist auf
        // beiden Seiten der Wand Boden.
        const d = [(q[0] - p[0]) / (length / cell), (q[1] - p[1]) / (length / cell)];
        const k = level.rooms[room].layer;
        const open = (x, z) => at(Math.floor(x), Math.floor(z), k) === 'floor';
        const outside = (e, sign) => {
            const x = e[0] + sign * d[0] * 0.5, z = e[1] + sign * d[1] * 0.5;
            return open(x + n[0] * 0.5, z + n[2] * 0.5) && open(x - n[0] * 0.5, z - n[2] * 0.5);
        };
        const ep = outside(p, -1) ? hgt : 0, eq = outside(q, 1) ? hgt : 0;
        let c = [[p[0] * cell, topP - hgt, p[1] * cell], [q[0] * cell, topQ - hgt, q[1] * cell],
            [q[0] * cell + n[0] * hgt + d[0] * eq, topQ, q[1] * cell + n[2] * hgt + d[1] * eq],
            [p[0] * cell + n[0] * hgt - d[0] * ep, topP, p[1] * cell + n[2] * hgt - d[1] * ep]];
        // zeigt schräg nach unten in den Raum
        const want = [n[0], -1, n[2]];
        if (faceNormal(c).reduce((sum, v, k) => sum + v * want[k], 0) < 0) c = [c[0], c[3], c[2], c[1]];
        const normal = faceNormal(c);
        if (normal.some((v) => v !== 0)) faces.push({ kind: 'baseboard', color: cornice.color, room, corners: c, normal, w: texels(length), h: texels(hgt * 1.42) });
    };
    // Die Wand vor einer runden Tür, auf der Seite des Raums room (die Kante
    // direction/line/along, top: die Decke dort): neben dem Bogen ganz Wand,
    // mit Sockelleiste, über ihm eine Fläche, deren Unterkante ihm folgt.
    const archWall = (room, direction, line, along, arch, top) => {
        const [a, b] = wallEnds(direction, line, along, along + 1);
        const u = (p) => (arch.alongX ? p[0] : p[1]) * cell - arch.start;
        const ua = u(a), ub = u(b);
        const pointAt = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const cuts = [0, 1, ...[arch.center - arch.radius, arch.center + arch.radius].map((c) => (c - ua) / (ub - ua))]
            .filter((t) => t > -1e-9 && t < 1 + 1e-9).sort((p, q) => p - q);
        for (let i = 0; i + 1 < cuts.length; i++) {
            const t0 = cuts[i], t1 = cuts[i + 1];
            if (t1 - t0 < 1e-6) continue;
            const p = pointAt(t0), q = pointAt(t1);
            const length = (t1 - t0) * cell;
            if (arch.height(ua + (ub - ua) * (t0 + t1) / 2) === null) {
                // neben dem Bogen: eine gewöhnliche Wand vom Boden bis zur Decke, mit Sockelleiste
                const corners = [[p[0] * cell, arch.floor, p[1] * cell], [q[0] * cell, arch.floor, q[1] * cell],
                    [q[0] * cell, top(q[0], q[1]), q[1] * cell], [p[0] * cell, top(p[0], p[1]), p[1] * cell]];
                add('wall', room, corners, texels(length), texels(Math.max(top(p[0], p[1]), top(q[0], q[1])) - arch.floor));
                skirting(room, direction, p, q, arch.floor);
                crown(room, direction, p, q, top(p[0], p[1]), top(q[0], q[1]));
                continue;
            }
            // über dem Bogen: unten rund, oben die Decke. Die Ecken in gleichen
            // Winkeln wie das Gewölbe darunter (sonst klaffte die Kante), die
            // Lichtkarte aber gleichmäßig entlang der Wand (texelAt)
            const uS = ua + (ub - ua) * t0, uE = ua + (ub - ua) * t1;
            const shape = (s, t) => {
                const w = pointAt((alongArc(arch, uS, uE, Math.min(1, Math.max(0, s))) - ua) / (ub - ua));
                const low = arch.height(u(w)) ?? arch.spring, high = Math.max(top(w[0], w[1]), low);
                return [w[0] * cell, low + (high - low) * t, w[1] * cell];
            };
            const texelAt = (s) => (alongArc(arch, uS, uE, s) - uS) / (uE - uS);
            const highest = Math.max(top(p[0], p[1]), top(q[0], q[1])) - arch.spring;
            curved('wall', room, shape, arcSteps(arch, uS, uE), length, Math.max(highest, 0.2), null, { texelAt });
            crown(room, direction, p, q, top(p[0], p[1]), top(q[0], q[1]));
        }
    };
    for (let k = 0; k < layers; k++) {
        for (let z = 0; z < depth; z++) {
            for (let x = 0; x < width; x++) {
                if (at(x, z, k) !== 'floor') continue;
                const room = roomOf(x, z, k);
                const h = level.ceilingOfCell(x, z, k);   // unter einem Loch: bis an die Decke darüber
                const above = level.roomAbove(x, z, k);    // der Raum über dem Loch, falls eins da ist
                const f = (cx, cz) => floorAt(cx, cz, room);
                // [Nachbar, Richtung, Linie, Stelle entlang der Linie]
                const edges = [
                    [x, z - 1, 'north', z, x],
                    [x, z + 1, 'south', z + 1, x],
                    [x - 1, z, 'west', x, z],
                    [x + 1, z, 'east', x + 1, z],
                ];
                for (const [nx, nz, direction, line, along] of edges) {
                    // vor einer runden Tür: die Wand über ihrem Bogen, unten rund (auch im selben Raum)
                    const arch = level.archAt(x, z, k) ? null : level.slabs(nx, nz).map((slab) => level.archAt(nx, nz, slab.layer)).find(Boolean);
                    if (arch && (arch.alongX === (direction === 'north' || direction === 'south'))) {
                        archWall(room, direction, line, along, arch, h);
                        continue;
                    }
                    // derselbe Raum in derselben Schicht: keine Wand, außer am Rand des
                    // Schachts unter einem Loch (er reicht höher als der Nachbar)
                    if (at(nx, nz, k) === 'floor' && roomOf(nx, nz, k) === room &&
                        level.ceilingOpen(x, z, k) === level.ceilingOpen(nx, nz, k)) continue;
                    const [a, b] = wallEnds(direction, line, along, along + 1);
                    const bottom = [f(a[0], a[1]), f(b[0], b[1])];
                    // Am Rand des Schachts unter einem Loch: nur bis an den Boden darüber.
                    // Weiter oben ist dort eine Wand des Raums darüber oder seine Luft,
                    // sonst stünde die Wand von unten wie ein Brett im Raum darüber.
                    const capped = above !== undefined && level.roomAbove(nx, nz, k) !== above;
                    const top = capped
                        ? [floorAt(a[0], a[1], above), floorAt(b[0], b[1], above)]
                        : [h(a[0], a[1]), h(b[0], b[1])];
                    // Luft dahinter, die mit der eigenen überlappt
                    const open = level.slabs(nx, nz).map((slab) => {
                        const top = level.ceilingOfCell(nx, nz, slab.layer);
                        return {
                            floor: [floorAt(a[0], a[1], slab.room), floorAt(b[0], b[1], slab.room)],
                            ceiling: [top(a[0], a[1]), top(b[0], b[1])],
                        };
                    }).filter((o) => o.ceiling[0] > bottom[0] + 0.01 || o.ceiling[1] > bottom[1] + 0.01)
                        .filter((o) => o.floor[0] < top[0] - 0.01 || o.floor[1] < top[1] - 0.01);
                    const pass = passage(x, z, k);
                    if (pass && !open.length && !level.ceilingOpen(x, z, k) && (pass.axis === 'z') === (direction === 'west' || direction === 'east')) {
                        // die Seite eines Durchgangs: die Laibung, Putz, ohne Sockelleiste
                        for (const [lo, hi, owner] of [[along, along + 0.5, pass.near], [along + 0.5, along + 1, pass.far]]) {
                            const [p, q] = wallEnds(direction, line, lo, hi);
                            const low = [f(p[0], p[1]), f(q[0], q[1])], high = [h(p[0], p[1]), h(q[0], q[1])];
                            lining(owner, [[p[0] * cell, low[0], p[1] * cell], [q[0] * cell, low[1], q[1] * cell], [q[0] * cell, high[1], q[1] * cell], [p[0] * cell, high[0], p[1] * cell]],
                                texels(cell / 2), texels(Math.max(high[0] - low[0], high[1] - low[1])));
                        }
                        continue;
                    }
                    if (!open.length && !level.ceilingOpen(x, z, k)) {
                        // eine ganze Wand: Stücke auf einer Linie werden unten zusammengelegt
                        // (nicht am Schacht unter einem Loch: die reicht bis an die Decke darüber).
                        // Über einem Becken ist sie ein eigenes Stück: ohne Sockelleiste
                        const pool = level.poolAt(x, z, k) !== null;
                        const key = `${room}:${direction}:${line}${pool ? ':pool' : ''}`;
                        if (!pieces.has(key)) pieces.set(key, { room, direction, line, pool, list: [] });
                        pieces.get(key).list.push(along);
                        continue;
                    }
                    // Durchgang zu einem Raum mit anderem Boden oder anderer Decke:
                    // eine Stufe darunter, ein Stück Wand darüber, und dazwischen
                    // eine Decke zwischen zwei Räumen übereinander
                    for (const [low, high, between] of gaps(bottom, top, open)) {
                        // am Rand eines Lochs: über der Decke des Nachbarn bis an den Boden
                        // darüber ist es die Decke zwischen den beiden Räumen
                        const slab = between || (capped && (low[0] > bottom[0] + 0.01 || low[1] > bottom[1] + 0.01));
                        const corners = [[a[0] * cell, low[0], a[1] * cell], [b[0] * cell, low[1], b[1] * cell],
                            [b[0] * cell, high[1], b[1] * cell], [a[0] * cell, high[0], a[1] * cell]];
                        const w = texels(cell), h = texels(Math.max(high[0] - low[0], high[1] - low[1], 0.2));
                        // die Decke zwischen zwei Räumen: roher Beton, keine Tapete
                        const normal = faceNormal(corners);
                        if (slab && normal.some((v) => v !== 0)) faces.push({ kind: 'block', color: SLAB_COLOR, material: 'plain', room, corners, normal, w, h });
                        else if (!slab) {
                            add('wall', room, corners, w, h);
                            // reicht die Wand bis an die eigene Decke (über einer Tür): oben die Leiste
                            if (Math.abs(high[0] - top[0]) < 1e-3 && Math.abs(high[1] - top[1]) < 1e-3) crown(room, direction, a, b, high[0], high[1]);
                            // die Wand unter einer hohen Tür steht auf dem Boden: mit Sockelleiste
                            const flat = Math.abs(bottom[0] - bottom[1]) < 1e-3 && Math.abs(low[0] - bottom[0]) < 1e-3 && Math.abs(low[1] - bottom[1]) < 1e-3;
                            if (flat && high[0] - low[0] > 1 && !level.poolAt(x, z, k)) skirting(room, direction, a, b, bottom[0]);
                        }
                    }
                }
            }
        }
    }
    for (const { room, direction, line, pool, list } of pieces.values()) {
        list.sort((p, q) => p - q);
        const h = (cx, cz) => ceiling(cx, cz, room);
        const f = (cx, cz) => floorAt(cx, cz, room);
        const point = (along) => (direction === 'north' || direction === 'south' ? [along, line] : [line, along]);
        // gerade: die Höhe an jeder Feldgrenze dazwischen liegt auf der Linie von
        // Anfang zu Ende, oben an der Decke und unten am Boden
        const straight = (from, to) => {
            for (const height of [h, f]) {
                const ha = height(...point(from)), hb = height(...point(to));
                for (let k = from + 1; k < to; k++) {
                    if (Math.abs(height(...point(k)) - (ha + (hb - ha) * (k - from) / (to - from))) > 1e-3) return false;
                }
            }
            return true;
        };
        let start = 0;
        while (start < list.length) {
            let end = start;
            while (end + 1 < list.length && list[end + 1] === list[end] + 1 && straight(list[start], list[end + 1] + 1)) end += 1;
            const [a, b] = wallEnds(direction, line, list[start], list[end] + 1);
            const ha = h(a[0], a[1]), hb = h(b[0], b[1]);
            const fa0 = f(a[0], a[1]), fb0 = f(b[0], b[1]);
            const length = (list[end] + 1 - list[start]) * cell;
            add('wall', room, [[a[0] * cell, fa0, a[1] * cell], [b[0] * cell, fb0, b[1] * cell],
                [b[0] * cell, hb, b[1] * cell], [a[0] * cell, ha, a[1] * cell]],
                texels(length), texels(Math.max(ha - fa0, hb - fb0)));
            // Sockelleiste: vorne und oben, 1,5 cm vor der Wand
            crown(room, direction, a, b, ha, hb);
            // auch an einer Rampe: Dort läuft sie schräg mit dem Boden
            const board = pool ? null : level.rooms[room].settings.baseboard;
            if (board) {
                const n = INWARD[direction], depthOut = 0.015, y = board.height;
                // Die Enden: An einer äußeren Ecke (die Wand biegt weg, wie an
                // einer Tür) laufen beide Leisten um ihre Dicke weiter, bis ihre
                // Vorderseiten sich treffen; an einer inneren Ecke hört die Leiste
                // entlang z vor der Vorderseite der anderen auf. Das Quadrat in
                // der Ecke deckt oben nur die Leiste entlang x, sonst lägen zwei
                // Flächen aufeinander. Wo eine Wand nur geteilt ist (schräge
                // Decke, anderer Raum), bleibt alles, wie es ist.
                const lengthCells = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
                const d = [(b[0] - a[0]) / lengthCells, (b[1] - a[1]) / lengthCells];
                const alongX = direction === 'north' || direction === 'south';
                const layer = level.rooms[room].layer;
                const corner = (p, out) => {
                    const cellAt = (side) => [Math.floor(p[0] + out[0] * 0.5 + n[0] * 0.5 * side), Math.floor(p[1] + out[1] * 0.5 + n[2] * 0.5 * side)];
                    const probe = (side) => at(...cellAt(side), layer);
                    // an einer Tür mit Bekleidung endet sie unter ihr
                    if (probe(-1) === 'floor' && passage(...cellAt(-1), layer) && level.framedDoorAt(...cellAt(-1), layer)) return 'straight';
                    if (probe(-1) === 'floor') return 'outer';
                    if (probe(1) !== 'floor') return 'inner';
                    return 'straight';
                };
                // um wie viel Meter Vorderseite und Oberseite an einem Ende weiterlaufen
                const reach = (kind) => ({
                    outer: [depthOut, alongX ? depthOut : 0],
                    inner: [alongX ? 0 : -depthOut, alongX ? 0 : -depthOut],
                    straight: [0, 0],
                })[kind];
                const [frontStart, topStart] = reach(corner(a, [-d[0], -d[1]]));
                const [frontEnd, topEnd] = reach(corner(b, d));
                const along = (p, extra, sign, offset) => [
                    p[0] * cell + sign * d[0] * extra + n[0] * offset, p[1] * cell + sign * d[1] * extra + n[2] * offset];
                const fa = along(a, frontStart, -1, depthOut), fb = along(b, frontEnd, 1, depthOut);
                const ta = along(a, topStart, -1, 0), tb = along(b, topEnd, 1, 0);
                const tfa = along(a, topStart, -1, depthOut), tfb = along(b, topEnd, 1, depthOut);
                const put = (corners, sw, sh, want) => {
                    let face = corners;
                    if (faceNormal(face).reduce((sum, v, i) => sum + v * want[i], 0) < 0) face = [face[0], face[3], face[2], face[1]];
                    faces.push({ kind: 'baseboard', color: board.color, room, corners: face, normal: faceNormal(face), w: texels(sw), h: texels(sh) });
                };
                // die Leiste folgt dem Boden; über ihre kurzen Verlängerungen an den Ecken genügt die Höhe an ihren Enden
                put([[fa[0], fa0, fa[1]], [fb[0], fb0, fb[1]], [fb[0], fb0 + y, fb[1]], [fa[0], fa0 + y, fa[1]]], length + frontStart + frontEnd, y, n);
                put([[ta[0], fa0 + y, ta[1]], [tb[0], fb0 + y, tb[1]], [tfb[0], fb0 + y, tfb[1]], [tfa[0], fa0 + y, tfa[1]]], length + topStart + topEnd, Math.max(depthOut, 0.2), [0, 1, 0]);
            }
            start = end + 1;
        }
    }

    // Runde Türen: Durch die Wand geht ein Gewölbe, schmale Streifen quer zur
    // Tür, jeder so hoch, wie der Bogen dort ist. Die Textur folgt dem Bogen.
    for (let k = 0; k < layers; k++) {
        for (let z = 0; z < depth; z++) {
            for (let x = 0; x < width; x++) {
                const arch = level.archAt(x, z, k);
                if (!arch || at(x, z, k) !== 'floor') continue;
                const room = roomOf(x, z, k);
                const r = arch.radius;
                const around = (u) => r * Math.acos(Math.min(1, Math.max(-1, (arch.center - u) / r)));   // Meter entlang des Bogens
                const point = (u, y, d) => (arch.alongX ? [arch.start + u, y, d] : [d, y, arch.start + u]);
                // nur über dem Bogen; ist er schmaler als die Tür, daneben die Seiten der Öffnung
                const from = Math.max(arch.u0, arch.center - r), to = Math.min(arch.u1, arch.center + r);
                // quer durch die Wand; in einem Durchgang jede Hälfte wie ihr Raum
                const pass = passage(x, z, k);
                const start = (arch.alongX ? z : x) * cell;
                const halves = pass ? [[start, start + cell / 2, pass.near], [start + cell / 2, start + cell, pass.far]] : [[start, start + cell, room]];
                for (const [d0, d1, owner] of halves) {
                    for (const [side, inward] of [[arch.center - r, 1], [arch.center + r, -1]]) {
                        if (side < arch.u0 + 1e-6 || side > arch.u1 - 1e-6) continue;
                        let corners = [point(side, arch.floor, d0), point(side, arch.floor, d1), point(side, arch.spring, d1), point(side, arch.spring, d0)];
                        const n = faceNormal(corners);
                        if ((arch.alongX ? n[0] : n[2]) * inward < 0) corners = [corners[0], corners[3], corners[2], corners[1]];
                        if (pass) lining(owner, corners, texels(d1 - d0), texels(arch.spring - arch.floor));
                        else add('wall', owner, corners, texels(d1 - d0), texels(arch.spring - arch.floor));
                    }
                    if (to <= from) continue;
                    // das Gewölbe: eine Fläche, gebogen, mit einem Stück Lichtkarte
                    const at = (s) => alongArc(arch, from, to, Math.min(1, Math.max(0, s)));   // in gleichen Winkeln
                    const vault = (s, t) => point(at(s), arch.height(at(s)), d0 + (d1 - d0) * t);
                    const down = faceNormal([vault(0.4, 0), vault(0.6, 0), vault(0.6, 1), vault(0.4, 1)])[1] < 0;
                    const shape = down ? vault : (s, t) => vault(s, 1 - t);
                    curved(pass ? 'block' : 'wall', owner, shape, arcSteps(arch, from, to), around(to) - around(from), d1 - d0,
                        (s, t) => [around(at(s)), d0 + (d1 - d0) * (down ? t : 1 - t)], pass ? { material: 'plain', color: LINING_COLOR } : {});
                }
            }
        }
    }

    // Die Bekleidung einer Tür: auf jeder Seite der Wand um die Öffnung eine
    // Leiste, CASING_WIDTH breit und CASING_DEPTH vor der Wand, in der Farbe
    // der Sockelleiste des Raums auf dieser Seite (ohne Sockelleiste hell gestrichen).
    // Seitlich vom Boden bis an den Sturz, oben quer darüber; bei einer runden
    // Tür im Bogen um die Öffnung. Rechnet in »along« (entlang der Wand) und
    // »across« (quer durch sie), Meter.
    const casingFace = (room, color, corners, want, w, h) => {
        let c = corners;
        if (faceNormal(c).reduce((sum, v, i) => sum + v * want[i], 0) < 0) c = [c[0], c[3], c[2], c[1]];
        const normal = faceNormal(c);
        if (normal.some((v) => v !== 0)) faces.push({ kind: 'baseboard', color, room, corners: c, normal, w: texels(w), h: texels(h) });
    };
    for (let k = 0; k < layers; k++) {
        for (let z = 0; z < depth; z++) {
            for (let x = 0; x < width; x++) {
                const pass = passage(x, z, k);
                if (!pass || !level.framedDoorAt(x, z, k)) continue;
                const alongX = pass.axis === 'z';
                const world = (a, y, c) => (alongX ? [a, y, c] : [c, y, a]);
                const dir = (da, dy, dc) => (alongX ? [da, dy, dc] : [dc, dy, da]);
                const a0 = (alongX ? x : z) * cell, a1 = a0 + cell, c0 = (alongX ? z : x) * cell;
                const wallAt = (step) => {
                    const nx = alongX ? x + step : x, nz = alongX ? z : z + step;
                    return at(nx, nz, k) !== 'floor';
                };
                const top = level.ceilingOfCell(x, z, k);
                const arch = level.archAt(x, z, k);
                for (const [owner, face, out] of [[pass.near, c0, -1], [pass.far, c0 + cell, 1]]) {
                    // in der Farbe der Sockelleiste, ohne Sockelleiste hell gestrichen
                    const board = level.rooms[owner].settings.baseboard;
                    const color = board ? board.color : CASING_PAINT, front = face + out * CASING_DEPTH;
                    const floorY = (a) => floorAt((alongX ? a : face) / cell, (alongX ? face : a) / cell, owner);
                    const roomTop = (a) => ceiling((alongX ? a : face) / cell, (alongX ? face : a) / cell, owner);
                    // ein Kasten vor der Wand: entlang lo..hi, von y0 bis y1; sides: welche Seiten offen liegen
                    const strip = (lo, hi, y0, y1, sides) => {
                        casingFace(owner, color, [world(lo, y0, front), world(hi, y0, front), world(hi, y1, front), world(lo, y1, front)], dir(0, 0, out), hi - lo, y1 - y0);
                        if (sides.low) casingFace(owner, color, [world(lo, y0, face), world(lo, y0, front), world(lo, y1, front), world(lo, y1, face)], dir(-1, 0, 0), CASING_DEPTH, y1 - y0);
                        if (sides.high) casingFace(owner, color, [world(hi, y0, face), world(hi, y0, front), world(hi, y1, front), world(hi, y1, face)], dir(1, 0, 0), CASING_DEPTH, y1 - y0);
                        if (sides.top) casingFace(owner, color, [world(lo, y1, face), world(hi, y1, face), world(hi, y1, front), world(lo, y1, front)], [0, 1, 0], hi - lo, CASING_DEPTH);
                        if (sides.bottom) casingFace(owner, color, [world(lo, y0, face), world(hi, y0, face), world(hi, y0, front), world(lo, y0, front)], [0, -1, 0], hi - lo, CASING_DEPTH);
                    };
                    if (arch) {
                        // einmal je Tür, im Feld, in dem der Bogen beginnt
                        const r = arch.radius, left = arch.start + arch.center - r, right = arch.start + arch.center + r;
                        if (left < a0 - 1e-6 || left >= a1 - 1e-6) continue;
                        const spring = arch.spring, w = CASING_WIDTH;
                        // die beiden Seiten bis zum Beginn des Bogens
                        strip(left - w, left, floorY(left), spring, { low: true, high: true });
                        strip(right, right + w, floorY(right), spring, { low: true, high: true });
                        // der Bogen: vorn ein Band von r bis r + w, innen und außen seine Kanten
                        const cx = arch.start + arch.center;
                        const ring = (radius, angle, c) => world(cx - Math.cos(angle) * radius, spring + Math.sin(angle) * radius, c);
                        const steps = Math.max(16, Math.ceil(ARCH_STEPS * r));
                        const length = Math.PI * (r + w / 2);
                        const fixFront = (shape) => {
                            const n = faceNormal([shape(0.45, 0), shape(0.55, 0), shape(0.55, 1), shape(0.45, 1)]);
                            const want = dir(0, 0, out);
                            return n.reduce((sum, v, i) => sum + v * want[i], 0) < 0 ? (s, t) => shape(s, 1 - t) : shape;
                        };
                        curved('baseboard', owner, fixFront((s, t) => ring(r + w * t, Math.PI * s, front)), steps, length, w, null, { color });
                        const edge = (radius, inward) => {
                            let shape = (s, t) => ring(radius, Math.PI * s, face + (front - face) * t);
                            const mid = ring(radius, Math.PI / 2, face), center = world(cx, spring, face);
                            const want = mid.map((v, i) => (center[i] - v) * inward);
                            const n = faceNormal([shape(0.45, 0), shape(0.55, 0), shape(0.55, 1), shape(0.45, 1)]);
                            if (n.reduce((sum, v, i) => sum + v * want[i], 0) < 0) shape = ((f0) => (s, t) => f0(s, 1 - t))(shape);
                            curved('baseboard', owner, shape, steps, Math.PI * radius, CASING_DEPTH, null, { color });
                        };
                        edge(r, 1);
                        edge(r + w, -1);
                        continue;
                    }
                    // eine eckige Tür: Seiten an den Feldern, neben denen Wand ist, oben über jedes Feld
                    const lowJamb = wallAt(-1), highJamb = wallAt(1);
                    const tLow = top((alongX ? a0 : face) / cell, (alongX ? face : a0) / cell), tHigh = top((alongX ? a1 : face) / cell, (alongX ? face : a1) / cell);
                    const lintel = Math.min(roomTop(a0), roomTop(a1)) > Math.max(tLow, tHigh) + CASING_WIDTH + 0.02;
                    const head = Math.min(tLow, tHigh);
                    const yTop = head;   // mit Sturz liegt die Ecke oben im Stück darüber
                    if (lowJamb) strip(a0 - CASING_WIDTH, a0, floorY(a0), yTop, { low: true, high: true, top: !lintel });
                    if (highJamb) strip(a1, a1 + CASING_WIDTH, floorY(a1), yTop, { low: true, high: true, top: !lintel });
                    if (lintel) strip(a0 - (lowJamb ? CASING_WIDTH : 0), a1 + (highJamb ? CASING_WIDTH : 0), head, head + CASING_WIDTH, { top: true, bottom: true, low: lowJamb, high: highJamb });
                }
            }
        }
    }

    // Treppen und Podeste (level.js, lifts): oben ihre Fläche (bei einer
    // Treppe jede Stufe mit Tritt und Stirn), und ringsum, wo daneben kein
    // so hoher Boden ist, eine Seite bis zu ihm hinunter
    for (const group of level.lifts) {
        const { room, layer: k, floor } = group;
        const look = (top) => (group.material ? { kind: 'block', material: group.material, color: group.color }
            : top ? { kind: 'floor' } : { kind: 'block', material: null, color: null });
        const put = (corners, sw, sh, top) => {
            const { kind, material, color } = look(top);
            const normal = faceNormal(corners);
            if (normal.some((v) => v !== 0)) faces.push({ kind, room, corners, normal, w: texels(sw), h: texels(sh), material, color });
        };
        const inGroup = (x, z) => level.liftAt(x, z, k) === group;
        // wie hoch der Boden auf der anderen Seite einer Kante liegt (oder null:
        // Wand); neben einem Becken nur bis zu seinem Rand: Darunter baut das
        // Becken seine Wand
        const across = (x, z, px, pz) => {
            if (level.kindAt(x, z, k) !== 'floor') return null;
            if (level.poolAt(x, z, k)) return level.floorAt(px, pz, level.roomAt(x, z, k));
            return level.floorAt(px, pz, level.roomAt(x, z, k)) - level.sunk(x, z, k) + level.lift(x, z, k, px, pz);
        };
        if (group.raise !== null) {
            const top = floor + group.raise;
            for (const { x, z } of group.cells) {
                const x0 = x * cell, x1 = (x + 1) * cell, z0 = z * cell, z1 = (z + 1) * cell;
                put([[x0, top, z1], [x1, top, z1], [x1, top, z0], [x0, top, z0]], cell, cell, true);
                for (const [nx, nz, direction, line, along] of [[x, z - 1, 'north', z, x], [x, z + 1, 'south', z + 1, x], [x - 1, z, 'west', x, z], [x + 1, z, 'east', x + 1, z]]) {
                    if (inGroup(nx, nz)) continue;
                    const [a, b] = wallEnds(direction, line, along, along + 1);
                    const mid = [(a[0] + b[0]) / 2 + (nx - x) * 0.01, (a[1] + b[1]) / 2 + (nz - z) * 0.01];
                    const low = across(nx, nz, mid[0], mid[1]);
                    if (low === null || low >= top - 0.01) continue;
                    // die Seite zeigt nach außen: wallEnds von der anderen Seite her
                    const [p, q] = wallEnds({ north: 'south', south: 'north', west: 'east', east: 'west' }[direction], line, along, along + 1);
                    put([[p[0] * cell, low, p[1] * cell], [q[0] * cell, low, q[1] * cell], [q[0] * cell, top, q[1] * cell], [p[0] * cell, top, p[1] * cell]], cell, top - low, false);
                }
            }
            continue;
        }
        // eine Treppe: u läuft in ihre Richtung, w quer dazu
        const { direction } = group.stairs;
        const alongX = direction === 'east' || direction === 'west';
        const sign = direction === 'east' || direction === 'south' ? 1 : -1;
        const start = sign > 0 ? (alongX ? group.x0 : group.z0) * cell : ((alongX ? group.x1 : group.z1) + 1) * cell;
        const w0 = (alongX ? group.z0 : group.x0) * cell, w1 = ((alongX ? group.z1 : group.x1) + 1) * cell;
        const at = (u, y, w) => (alongX ? [start + sign * u, y, w] : [w, y, start + sign * u]);
        const facing = (corners, want) => (faceNormal(corners).reduce((sum, v, i) => sum + v * want[i], 0) < 0 ? [corners[0], corners[3], corners[2], corners[1]] : corners);
        const forward = alongX ? [sign, 0, 0] : [0, 0, sign];
        for (let i = 0; i < group.steps; i++) {
            const u0 = i * group.tread, u1 = (i + 1) * group.tread, y0 = floor + group.base + i * group.stepHeight, y1 = floor + group.base + (i + 1) * group.stepHeight;
            // Tritt (oben) und Stirn (vorn, zur unteren Seite hin)
            put(facing([at(u0, y1, w0), at(u1, y1, w0), at(u1, y1, w1), at(u0, y1, w1)], [0, 1, 0]), group.tread, w1 - w0, true);
            put(facing([at(u0, y0, w0), at(u0, y0, w1), at(u0, y1, w1), at(u0, y1, w0)], forward.map((v) => -v)), w1 - w0, group.stepHeight, true);
            // die Seiten: wo daneben nichts so hoch ist, die Stufe bis zum Boden dort
            for (const [w, out] of [[w0, -1], [w1, 1]]) {
                const cx = Math.floor((alongX ? start + sign * (u0 + u1) / 2 : w + out * 0.01 * cell) / cell);
                const cz = Math.floor((alongX ? w + out * 0.01 * cell : start + sign * (u0 + u1) / 2) / cell);
                const px = (alongX ? start + sign * (u0 + u1) / 2 : w + out * 0.01) / cell, pz = (alongX ? w + out * 0.01 : start + sign * (u0 + u1) / 2) / cell;
                const low = across(cx, cz, px, pz);
                if (low === null || low >= y1 - 0.01) continue;
                const side = alongX ? [0, 0, out] : [out, 0, 0];
                put(facing([at(u0, low, w), at(u1, low, w), at(u1, y1, w), at(u0, y1, w)], side), group.tread, y1 - low, false);
            }
        }
        // oben am Ende: hinunter, wo dahinter nichts so hoch ist
        const end = group.length, topY = floor + group.stairs.rise;
        const ex = (alongX ? start + sign * (end + 0.01) : (w0 + w1) / 2) / cell, ez = (alongX ? (w0 + w1) / 2 : start + sign * (end + 0.01)) / cell;
        const behind = across(Math.floor(ex), Math.floor(ez), ex, ez);
        if (behind !== null && behind < topY - 0.01) put(facing([at(end, behind, w0), at(end, behind, w1), at(end, topY, w1), at(end, topY, w0)], forward), w1 - w0, topY - behind, false);
    }

    // Becken: ihr Boden tief unten und ringsum Wände aus Fliesen, vom Boden
    // des Beckens bis zum Rand (dem Boden des Raums) oder bis zum Boden
    // eines flacheren Beckens daneben. Darüber gilt, was ohnehin dort ist.
    for (const pool of level.pools) {
        const { room, layer: k, bottom } = pool;
        const tiles = (corners, w, h) => {
            const normal = faceNormal(corners);
            if (normal.some((v) => v !== 0)) faces.push({ kind: 'block', color: pool.color, material: 'tiles', room, corners, normal, w, h });
        };
        const inPool = new Set(pool.cells.map(({ x, z }) => z * width + x));
        // der Boden: die größten Rechtecke aus seinen Feldern
        const used = new Set();
        const free = (x, z) => inPool.has(z * width + x) && !used.has(z * width + x);
        for (const { x, z } of [...pool.cells].sort((p, q) => p.z - q.z || p.x - q.x)) {
            if (!free(x, z)) continue;
            let w = 1, d = 1;
            while (free(x + w, z)) w += 1;
            while ([...Array(w).keys()].every((i) => free(x + i, z + d))) d += 1;
            for (let dz = 0; dz < d; dz++) for (let dx = 0; dx < w; dx++) used.add((z + dz) * width + x + dx);
            const x0 = x * cell, x1 = (x + w) * cell, z0 = z * cell, z1 = (z + d) * cell;
            tiles([[x0, bottom, z1], [x1, bottom, z1], [x1, bottom, z0], [x0, bottom, z0]], texels(w * cell), texels(d * cell));
        }
        // die Wände: Stück für Stück, dann gleich hohe auf einer Linie zusammen
        const walls = new Map();
        for (const { x, z } of pool.cells) {
            for (const [nx, nz, direction, line, along] of [[x, z - 1, 'north', z, x], [x, z + 1, 'south', z + 1, x], [x - 1, z, 'west', x, z], [x + 1, z, 'east', x + 1, z]]) {
                if (inPool.has(nz * width + nx)) continue;
                const other = level.poolAt(nx, nz, k);
                const [a, b] = wallEnds(direction, line, along, along + 1);
                const top = other ? [other.bottom, other.bottom] : [floorAt(a[0], a[1], room), floorAt(b[0], b[1], room)];
                if (top[0] < bottom + 0.01 && top[1] < bottom + 0.01) continue;   // das tiefere Becken daneben baut sie
                const key = `${direction}:${line}:${top[0].toFixed(3)}:${top[1].toFixed(3)}`;
                if (!walls.has(key)) walls.set(key, { direction, line, top, list: [] });
                walls.get(key).list.push(along);
            }
        }
        for (const { direction, line, top, list } of walls.values()) {
            list.sort((p, q) => p - q);
            let start = 0;
            while (start < list.length) {
                let end = start;
                // nur wo die Oberkante eben ist (kein Raum mit Rampe hat ein Becken, nur Türen könnten anders liegen)
                while (end + 1 < list.length && list[end + 1] === list[end] + 1 && Math.abs(top[0] - top[1]) < 1e-3) end += 1;
                const [a, b] = wallEnds(direction, line, list[start], list[end] + 1);
                const length = (list[end] + 1 - list[start]) * cell;
                tiles([[a[0] * cell, bottom, a[1] * cell], [b[0] * cell, bottom, b[1] * cell], [b[0] * cell, top[1], b[1] * cell], [a[0] * cell, top[0], a[1] * cell]],
                    texels(length), texels(Math.max(top[0], top[1]) - bottom));
                start = end + 1;
            }
        }
        // der Rand (rim = höhe, breite): eine Stufe aus Fliesen um das Becken,
        // überall, wo man am Rand steht. Innen geht die Wand des Beckens weiter,
        // oben ein Streifen, außen eine Seite. An einer Ecke nach außen läuft der
        // Streifen entlang x um die Ecke, an einer Ecke nach innen hört er früher auf.
        if (pool.rim) {
            const [rh, rw] = pool.rim, y0 = level.rooms[room].elevation, y1 = y0 + rh;
            const standing = (x, z) => level.kindAt(x, z, k) === 'floor' && !level.poolAt(x, z, k) && !level.liftAt(x, z, k);
            for (const { x, z } of pool.cells) {
                for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
                    if (!standing(x + dx, z + dz)) continue;
                    const alongX = dx === 0;
                    const t = alongX ? [1, 0] : [0, 1];
                    const edge = alongX ? (dz < 0 ? z : z + 1) : (dx < 0 ? x : x + 1);   // die Linie der Kante, in Feldern
                    const span = alongX ? [x, x + 1] : [z, z + 1];
                    // an jedem Ende: um die Ecke (außen), früher aufhören (innen) oder gerade
                    const reach = (sign) => {
                        const nx = x + t[0] * sign, nz = z + t[1] * sign;
                        if (level.poolAt(nx, nz, k) === pool) return level.poolAt(nx + dx, nz + dz, k) === pool ? -rw : 0;
                        return standing(nx, nz) ? rw : 0;
                    };
                    const r0 = reach(-1), r1 = reach(1);
                    const point = (s, o, y) => (alongX ? [s * cell, y, edge * cell + (dz < 0 ? -o : o)] : [edge * cell + (dx < 0 ? -o : o), y, s * cell]);
                    const outward = [dx, 0, dz];
                    const facing = (corners, want) => (faceNormal(corners).reduce((sum, v, i) => sum + v * want[i], 0) < 0 ? [corners[0], corners[3], corners[2], corners[1]] : corners);
                    const s0 = span[0], s1 = span[1];
                    // innen: die Wand des Beckens weiter hinauf
                    tiles(facing([point(s0, 0, y0), point(s1, 0, y0), point(s1, 0, y1), point(s0, 0, y1)], outward.map((v) => -v)), texels(cell), texels(rh));
                    // oben: der Streifen (nur Kanten entlang x laufen um Ecken nach außen herum)
                    const top0 = alongX ? s0 - r0 / cell : s0, top1 = alongX ? s1 + r1 / cell : s1;
                    tiles(facing([point(top0, 0, y1), point(top1, 0, y1), point(top1, rw, y1), point(top0, rw, y1)], [0, 1, 0]), texels((top1 - top0) * cell), texels(rw));
                    // außen: die Seite, an Ecken nach außen bis zur Ecke, nach innen kürzer
                    const out0 = s0 - r0 / cell, out1 = s1 + r1 / cell;
                    tiles(facing([point(out0, rw, y0), point(out1, rw, y0), point(out1, rw, y1), point(out0, rw, y1)], outward), texels((out1 - out0) * cell), texels(rh));
                }
            }
        }
    }

    // Blöcke: mitten auf ihrem Feld, oben und vier Seiten, unten nur, wenn sie schweben.
    // Um sie herum wird die Lichtkarte feiner wie um Modelle (addDetail): Eine
    // Säule nah an der Wand oder an der Decke wirft dort einen harten Schatten.
    const blockBoxes = [];
    for (const block of level.things.filter((t) => t.type === 'block')) {
        const [w, h, d] = block.size;
        const cx = (block.x + 0.5) * cell + block.offset[0], cz = (block.z + 0.5) * cell + block.offset[2];
        const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
        const y0 = block.floor + block.base + block.offset[1], y1 = y0 + h;   // auf dem Boden seines Felds (oder höher)
        const room = block.room;
        const owner = blockBoxes.length;
        // gedreht (rotation): erst gerade gebaut, dann seine Flächen um die Mitte gedreht
        const yaw = block.yaw ?? 0, cos = Math.cos(yaw), sin = Math.sin(yaw);
        const turn = ([x, y, z]) => [cx + (x - cx) * cos + (z - cz) * sin, y, cz - (x - cx) * sin + (z - cz) * cos];
        const reach = (Math.abs(w * cos) + Math.abs(d * sin)) / 2, reachZ = (Math.abs(w * sin) + Math.abs(d * cos)) / 2;
        blockBoxes.push({ min: { x: cx - reach, y: y0, z: cz - reachZ }, max: { x: cx + reach, y: y1, z: cz + reachZ }, owner, turned: yaw !== 0 });
        const first = faces.length;
        const turnFaces = () => {
            if (yaw === 0) return;
            for (const face of faces.slice(first)) {
                face.corners = face.corners.map(turn);
                face.normal = faceNormal(face.corners);
                if (face.normals) face.normals = face.normals.map(([x, y, z]) => [x * cos + z * sin, y, -x * sin + z * cos]);
            }
        };
        const put = (corners, sw, sh, extra = {}) => faces.push({ kind: 'block', color: block.color, material: block.material, room, corners, normal: faceNormal(corners), w: texels(sw), h: texels(sh), owner, ...extra });
        if (block.shape === 'round') {
            // eine runde Säule (oval, wenn Breite und Tiefe verschieden sind):
            // ringsum ROUND_SIDES schmale Flächen. Jede Ecke zeigt genau nach
            // außen, so wird das Licht beim Backen rund, nicht eckig; die
            // Textur läuft um die Säule herum (arc: Meter entlang des Umfangs).
            const rx = w / 2, rz = d / 2;
            const ring = Array.from({ length: ROUND_SIDES + 1 }, (_, i) => {
                const a = (i / ROUND_SIDES) * Math.PI * 2;
                return { x: cx + Math.cos(a) * rx, z: cz - Math.sin(a) * rz, n: [Math.cos(a) / rx, 0, -Math.sin(a) / rz] };
            });
            const unit = (n) => { const l = Math.hypot(...n); return n.map((v) => v / l); };
            let around = 0;
            for (let i = 0; i < ROUND_SIDES; i++) {
                const p = ring[i], q = ring[i + 1];
                const side = Math.hypot(q.x - p.x, q.z - p.z);
                put([[p.x, y0, p.z], [q.x, y0, q.z], [q.x, y1, q.z], [p.x, y1, p.z]], side, h,
                    { normals: [unit(p.n), unit(q.n), unit(q.n), unit(p.n)], arc: [around, around + side] });
                around += side;
            }
            // oben und, wenn sie schwebt, unten: Dreiecke um die Mitte (Vierecke mit zwei gleichen Ecken)
            for (let i = 0; i < ROUND_SIDES; i++) {
                const p = ring[i], q = ring[i + 1];
                put([[cx, y1, cz], [q.x, y1, q.z], [p.x, y1, p.z], [p.x, y1, p.z]], Math.max(rx, rz), Math.max(rx, rz));
                if (block.base > 0.001) put([[cx, y0, cz], [p.x, y0, p.z], [q.x, y0, q.z], [q.x, y0, q.z]], Math.max(rx, rz), Math.max(rx, rz));
            }
            turnFaces();
            continue;
        }
        // Pappe braucht Koordinaten auf der Kiste (Meter): quer von der Mitte
        // der Fläche, an den Seiten nach oben vom unteren Rand, für Deckel,
        // Pfeile und Etikett (main.js)
        const box = block.material === 'cardboard';
        const onSide = (width, height) => (box ? { uvAt: (s, t) => [(s - 0.5) * width, t * height] } : {});
        const onTop = box ? { uvAt: (s, t) => [(s - 0.5) * w, (t - 0.5) * d] } : {};
        put([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], w, d, onTop);                 // oben
        if (block.base > 0.001) put([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], w, d, onTop); // unten
        put([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], w, h, onSide(w, h));                 // nach -z
        put([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], w, h, onSide(w, h));                 // nach +z
        put([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], d, h, onSide(d, h));                 // nach -x
        put([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], d, h, onSide(d, h));                 // nach +x
        turnFaces();
    }

    // Zweifarbige Wände (dado = höhe, farbe): jede Wand, die auf dem Boden
    // steht, wird in dieser Höhe geteilt, unten in der Farbe und dem
    // Material von dado
    faces = faces.flatMap((face) => {
        const dado = level.rooms[face.room]?.settings.dado;
        if (!dado || face.kind !== 'wall' || face.shape || Math.abs(face.normal[1]) > 0.1) return [face];
        const [c0, c1, c2, c3] = face.corners;
        const onFloor = (c) => Math.abs(c[1] - level.floorAt(c[0] / cell, c[2] / cell, face.room)) < 0.01;
        if (!onFloor(c0) || !onFloor(c1) || Math.min(c3[1] - c0[1], c2[1] - c1[1]) <= dado.height + 0.02) return [face];
        const lift = (c) => [c[0], c[1] + dado.height, c[2]];
        const length = Math.hypot(c1[0] - c0[0], c1[2] - c0[2]);
        const lower = { ...face, kind: 'block', color: dado.color, material: dado.material, corners: [c0, c1, lift(c1), lift(c0)], w: texels(length), h: texels(dado.height) };
        const upper = { ...face, corners: [lift(c0), lift(c1), c2, c3], h: texels(Math.max(c3[1] - c0[1], c2[1] - c1[1]) - dado.height) };
        const rail = level.rooms[face.room].settings.dado_rail;
        if (!rail) return [lower, upper];
        // die Leiste auf der Kante: vorn, oben und unten, 2 cm vor der Wand
        const n = face.normal, o = 0.02, half = rail.height / 2;
        const at = (c, dy, out) => [c[0] + n[0] * out, c[1] + dado.height + dy, c[2] + n[2] * out];
        const strip = (corners, want, sh) => {
            let c = corners;
            if (faceNormal(c).reduce((sum, v, k) => sum + v * want[k], 0) < 0) c = [c[0], c[3], c[2], c[1]];
            return { kind: 'baseboard', color: rail.color, material: null, room: face.room, corners: c, normal: faceNormal(c), w: texels(length), h: texels(sh) };
        };
        return [lower, upper,
            strip([at(c0, -half, o), at(c1, -half, o), at(c1, half, o), at(c0, half, o)], n, rail.height),
            strip([at(c0, half, 0), at(c1, half, 0), at(c1, half, o), at(c0, half, o)], [0, 1, 0], 0.2),
            strip([at(c0, -half, 0), at(c1, -half, 0), at(c1, -half, o), at(c0, -half, o)], [0, -1, 0], 0.2)];
    });
    faces = addDetail(faces, [...modelBoxes, ...blockBoxes]);
    const atlasSize = packRectangles(faces);

    // Eine Geometrie für jede Sorte Fläche in jedem Raum (eigene Tapete, eigener Teppich)
    const groups = new Map();
    for (const face of faces) {
        const key = `${face.kind}:${face.room}:${face.color ?? ''}:${face.material ?? ''}`;
        if (!groups.has(key)) groups.set(key, { kind: face.kind, room: face.room, color: face.color ?? null, material: face.material ?? null, faces: [] });
        groups.get(key).faces.push(face);
    }

    const meshes = [];
    for (const { kind, room, color, material, faces: list } of groups.values()) {
        const positions = [], normals = [], uvs = [], uv1s = [], detailUvs = [], detailWeights = [], indices = [];
        const bakePositions = [], bakeWorld = [], bakeNormal = [], bakeMin = [], bakeMax = [], bakeAmbient = [], bakeAlbedo = [], bakeDensity = [], bakeIndices = [];
        const roomSettings = level.rooms[room].settings;
        const ambient = roomSettings.ambient ?? settings.ambient;
        // Wie viel Licht die Fläche zurückwirft, in ihrer Farbe: die Farbe des
        // Raums für diese Fläche, etwas dunkler (Flecken und Muster der Textur)
        const style = kind === 'floor' ? roomSettings.floor : kind === 'ceiling' ? 'ceiling'
            : material ?? ((kind === 'block' || kind === 'baseboard') && color ? 'plain' : roomSettings.walls);
        const surfaceColor = style === 'marble' ? '#e2ddd2' : kind === 'floor' ? roomSettings.carpet
            : kind === 'ceiling' ? roomSettings.ceiling : (kind === 'block' || kind === 'baseboard') && color ? color : roomSettings.wallpaper;
        const albedo = new THREE.Color(surfaceColor).multiplyScalar(0.85);
        const lerp = (a, b, t) => a.map((value, i) => value + (b[i] - value) * t);
        const unique = (values) => [...new Set(values.map((v) => Math.min(1, Math.max(0, v))))].sort((a, b) => a - b);
        let base = 0, bakeBase = 0;
        for (const face of list) {
            const [c0, c1, c2, c3] = face.corners;
            const u0 = face.ax / atlasSize, u1 = (face.ax + face.w) / atlasSize;
            const v0 = face.ay / atlasSize, v1 = (face.ay + face.h) / atlasSize;
            const du = u1 - u0, dv = v1 - v0;
            // die Stelle auf der Fläche, bilinear zwischen den vier Ecken
            // eine gebogene Fläche (curved) hat ihre eigene Form
            const world = face.shape ?? ((s, t) => lerp(lerp(c0, c1, s), lerp(c3, c2, s), t));
            const points = face.samples ?? [c0, c1, c2, c3];
            const min = [0, 1, 2].map((i) => Math.min(...points.map((c) => c[i])));
            const max = [0, 1, 2].map((i) => Math.max(...points.map((c) => c[i])));
            const n = face.subdivide ?? 1;
            const nS = face.steps ?? n, nT = face.shape ? 1 : n;   // gebogen: Stücke nur entlang s

            // Backen: die Fläche in ihr Rechteck der Lichtkarte, um einen Texel
            // größer (der Rand); die Stelle in der Welt wird dabei über die
            // Fläche hinaus verlängert und im Shader wieder auf sie geklemmt.
            // Ein Detailstück wirft kein Licht zurück (Albedo -1): Das tut die
            // Fläche darunter schon.
            const tu = -(GUTTER / atlasSize) / du, tv = -(GUTTER / atlasSize) / dv;
            const edge = (value, outside) => (value === 0 ? outside : value === 1 ? 1 - outside : value);
            for (let i = 0; i < nS; i++) {
                for (let j = 0; j < nT; j++) {
                    const quad = [[i / nS, j / nT], [(i + 1) / nS, j / nT], [(i + 1) / nS, (j + 1) / nT], [i / nS, (j + 1) / nT]];
                    const normal = nS > 1 || nT > 1 ? faceNormal(quad.map(([s, t]) => world(s, t))) : face.normal;
                    quad.forEach(([s, t], corner) => {
                        const bs = edge(s, tu), bt = edge(t, tv);
                        // texelAt: wo die Stelle s in ihrem Stück Lichtkarte liegt (ohne: dort, wo s sagt)
                        bakePositions.push(u0 + (face.texelAt && s > 0 && s < 1 ? face.texelAt(s) : bs) * du, v0 + bt * dv, 0);
                        bakeWorld.push(...world(bs, bt));
                        // eine runde Säule: die Richtung an jeder Ecke, dazwischen gemischt
                        bakeNormal.push(...(face.normals && n === 1 ? face.normals[corner] : normal));
                        bakeMin.push(...min);
                        bakeMax.push(...max);
                        bakeAmbient.push(ambient);
                        if (face.detailOnly) bakeAlbedo.push(-1, -1, -1);
                        else bakeAlbedo.push(albedo.r, albedo.g, albedo.b);
                        bakeDensity.push(face.density ?? 1);
                    });
                    bakeIndices.push(bakeBase, bakeBase + 1, bakeBase + 2, bakeBase, bakeBase + 2, bakeBase + 3);
                    bakeBase += 4;
                }
            }
            if (face.detailOnly) continue;   // nur gebacken, gezeichnet wird es mit seiner Fläche

            // Zeichnen: Texturkoordinaten in Metern, die Textur wiederholt sich jeden Meter
            const vertical = Math.abs(face.normal[1]) < 0.5;
            const along = (p) => (vertical
                ? [Math.abs(face.normal[0]) > 0.5 ? p[2] : p[0], p[1]]
                : [p[0], p[2]]);
            // Stücke: ein verdrehter Boden als feines Gitter; eine Fläche mit
            // Detailstück an dessen Rändern geteilt, damit es dort ausblenden kann
            const detail = face.detail;
            let cutsS = [0, 1], cutsT = [0, 1];
            if (face.shape) cutsS = [...Array(nS + 1).keys()].map((k) => k / nS);
            else if (n > 1) cutsS = cutsT = [...Array(n + 1).keys()].map((k) => k / n);
            else if (detail) {
                cutsS = unique([0, detail.s0, detail.s0 + detail.fadeS[0], detail.s1 - detail.fadeS[1], detail.s1, 1]);
                cutsT = unique([0, detail.t0, detail.t0 + detail.fadeT[0], detail.t1 - detail.fadeT[1], detail.t1, 1]);
            }
            // wie viel vom Detailstück an einer Stelle gilt: innen ganz, zum Rand hin weniger
            const ramp = (x, a, b, [fa, fb]) => {
                if (x < a - 1e-9 || x > b + 1e-9) return 0;
                let w = 1;
                if (fa > 0) w = Math.min(w, (x - a) / fa);
                if (fb > 0) w = Math.min(w, (b - x) / fb);
                return Math.min(1, Math.max(0, w));
            };
            const target = detail?.target;
            for (let i = 0; i + 1 < cutsS.length; i++) {
                for (let j = 0; j + 1 < cutsT.length; j++) {
                    const quad = [[cutsS[i], cutsT[j]], [cutsS[i + 1], cutsT[j]], [cutsS[i + 1], cutsT[j + 1]], [cutsS[i], cutsT[j + 1]]];
                    const points = quad.map(([s, t]) => world(s, t));
                    const normal = n > 1 || face.shape ? faceNormal(points) : face.normal;
                    quad.forEach(([s, t], k) => {
                        positions.push(...points[k]);
                        normals.push(...normal);
                        // eigene Texturkoordinaten an den vier Ecken (ein Bogen): dazwischen gemischt
                        const uv4 = face.uv4 && ((a, b) => a.map((v, i) => v + (b[i] - v) * t))(
                            face.uv4[0].map((v, i) => v + (face.uv4[1][i] - v) * s), face.uv4[3].map((v, i) => v + (face.uv4[2][i] - v) * s));
                        uvs.push(...(face.uvAt ? face.uvAt(s, t) : uv4 ?? (face.arc ? [face.arc[0] + (face.arc[1] - face.arc[0]) * s, points[k][1]] : along(points[k]))));
                        uv1s.push(u0 + (face.texelAt ? face.texelAt(s) : s) * du, v0 + t * dv);
                        if (target) {
                            const ds = Math.min(1, Math.max(0, (s - detail.s0) / (detail.s1 - detail.s0)));
                            const dt = Math.min(1, Math.max(0, (t - detail.t0) / (detail.t1 - detail.t0)));
                            detailUvs.push((target.ax + ds * target.w) / atlasSize, (target.ay + dt * target.h) / atlasSize);
                            detailWeights.push(ramp(s, detail.s0, detail.s1, detail.fadeS) * ramp(t, detail.t0, detail.t1, detail.fadeT));
                        } else {
                            detailUvs.push(0, 0);
                            detailWeights.push(0);
                        }
                    });
                    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
                    base += 4;
                }
            }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1s, 2));
        geometry.setAttribute('detailUv', new THREE.Float32BufferAttribute(detailUvs, 2));
        geometry.setAttribute('detailWeight', new THREE.Float32BufferAttribute(detailWeights, 1));
        geometry.setIndex(indices);

        const bake = new THREE.BufferGeometry();
        bake.setAttribute('position', new THREE.Float32BufferAttribute(bakePositions, 3));
        bake.setAttribute('world', new THREE.Float32BufferAttribute(bakeWorld, 3));
        bake.setAttribute('normal', new THREE.Float32BufferAttribute(bakeNormal, 3));
        bake.setAttribute('faceMin', new THREE.Float32BufferAttribute(bakeMin, 3));
        bake.setAttribute('faceMax', new THREE.Float32BufferAttribute(bakeMax, 3));
        bake.setAttribute('ambient', new THREE.Float32BufferAttribute(bakeAmbient, 1));
        bake.setAttribute('albedo', new THREE.Float32BufferAttribute(bakeAlbedo, 3));
        bake.setAttribute('density', new THREE.Float32BufferAttribute(bakeDensity, 1));
        bake.setIndex(bakeIndices);
        meshes.push({ kind, room, color, material, geometry, bake });
    }
    const maxHeight = Math.max(...faces.map((f) => Math.max(...f.corners.map((c) => c[1]))));
    const minHeight = Math.min(...faces.map((f) => Math.min(...f.corners.map((c) => c[1]))));
    // wo jede Fläche in der Lightmap liegt, in Punkten (für ?show=atlas&face=…)
    const rects = faces.filter((f) => !f.detailOnly).map((f) => ({
        kind: f.kind, room: f.room, x: f.ax, y: f.ay, w: f.w, h: f.h,
        fine: f.detail ? { x: f.detail.target.ax, y: f.detail.target.ay, w: f.detail.target.w, h: f.detail.target.h } : null,
    }));
    return { meshes, atlasSize, faceCount: faces.length, maxHeight, minHeight, rects };
}
