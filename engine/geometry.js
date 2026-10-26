// Baut aus dem Grundriss Boden, Decke und Wände. Jede Fläche bekommt ein
// eigenes Rechteck in der Lichtkarte (uv1), damit das Licht für jede Stelle
// einzeln ausgerechnet werden kann.
import * as THREE from 'three';

export const EDGE_ANGLE = 4;          // ab so vielen Grad Knick ist eine Kante eine Kante (Linien, Automap)
const GUTTER = 1;                     // Rand um jedes Rechteck, gegen Nähte

// Die Linien eines Meshs (Kanten E, Automap): wie THREE.EdgesGeometry die
// Kanten, an denen zwei Dreiecke um mehr als angle Grad knicken, und den
// Rand. Am Rand stoßen aber oft zwei Flächen in derselben Ebene aneinander,
// deren Ecken nicht aufeinanderliegen (eine lange Kante neben zwei kurzen,
// etwa am Viertelkreis einer runden Ecke): Dort knickt nichts, und dort ist
// keine Linie. Je Gerade in einer Ebene bleibt nur, was auf einer Seite frei ist.
export function outlineEdges(geometry, angle = EDGE_ANGLE) {
    const position = geometry.attributes.position, index = geometry.index;
    const count = index ? index.count : position.count;
    const vertex = (i) => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i) : i);
    const round = (v, scale) => `${Math.round(v.x * scale)},${Math.round(v.y * scale)},${Math.round(v.z * scale)}`;
    const edges = new Map();
    for (let i = 0; i + 2 < count; i += 3) {
        const corners = [vertex(i), vertex(i + 1), vertex(i + 2)];
        const normal = new THREE.Triangle(...corners).getNormal(new THREE.Vector3());
        if (normal.lengthSq() < 0.5) continue;   // ein Dreieck ohne Fläche
        for (let j = 0; j < 3; j++) {
            const a = corners[j], b = corners[(j + 1) % 3], ka = round(a, 1e4), kb = round(b, 1e4);
            if (ka === kb) continue;
            const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
            if (!edges.has(key)) edges.set(key, { a, b, sides: [] });
            edges.get(key).sides.push({ normal, third: corners[(j + 2) % 3] });
        }
    }
    const lines = [], lines2 = new Map();
    const flat = Math.cos(angle * Math.PI / 180);
    for (const { a, b, sides } of edges.values()) {
        if (sides.length === 2 && sides[0].normal.dot(sides[1].normal) >= flat) continue;
        if (sides.length !== 1) { lines.push(a, b); continue; }
        // ein Stück Rand: auf welcher Geraden in welcher Ebene, auf welcher Seite die Fläche liegt
        const { normal, third } = sides[0];
        const along = b.clone().sub(a).normalize();
        if (along.x < -1e-9 || (Math.abs(along.x) < 1e-9 && (along.y < -1e-9 || (Math.abs(along.y) < 1e-9 && along.z < 0)))) along.negate();
        const foot = a.clone().addScaledVector(along, -a.dot(along));
        const key = `${round(normal, 1e3)}|${round(along, 1e4)}|${round(foot, 1e4)}`;
        const side = Math.sign(third.clone().sub(a).dot(normal.clone().cross(along)));
        if (!lines2.has(key)) lines2.set(key, { along, foot, spans: [] });
        const u0 = a.dot(along), u1 = b.dot(along);
        lines2.get(key).spans.push([Math.min(u0, u1), Math.max(u0, u1), side]);
    }
    for (const { along, foot, spans } of lines2.values()) {
        const cuts = [...new Set(spans.flatMap(([u0, u1]) => [u0, u1]))].sort((p, q) => p - q);
        let from = null;
        for (let i = 0; i + 1 <= cuts.length; i++) {
            const middle = i + 1 < cuts.length ? (cuts[i] + cuts[i + 1]) / 2 : null;
            const covered = (side) => middle !== null && spans.some(([u0, u1, s]) => s === side && u0 <= middle && middle <= u1);
            const free = middle !== null && covered(1) !== covered(-1);
            if (free && from === null) from = cuts[i];
            if (!free && from !== null) {
                lines.push(foot.clone().addScaledVector(along, from), foot.clone().addScaledVector(along, cuts[i]));
                from = null;
            }
        }
    }
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.Float32BufferAttribute(lines.flatMap((v) => [v.x, v.y, v.z]), 3));
    return result;
}

// Ein Vieleck [[s, t], …], zugeschnitten auf das Rechteck s0..s1, t0..t1
// (Sutherland-Hodgman: nacheinander an jeder der vier Seiten)
function clipRectangle(polygon, s0, s1, t0, t1) {
    let result = polygon;
    for (const [axis, limit, keepAbove] of [[0, s0, true], [0, s1, false], [1, t0, true], [1, t1, false]]) {
        const keep = (q) => (keepAbove ? q[axis] >= limit - 1e-9 : q[axis] <= limit + 1e-9);
        const input = result;
        result = [];
        input.forEach((a, i) => {
            const b = input[(i + 1) % input.length];
            if (keep(a)) result.push(a);
            if (keep(a) !== keep(b)) {
                const t = (limit - a[axis]) / (b[axis] - a[axis]);
                result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            }
        });
        if (result.length < 3) return [];
    }
    return result;
}

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
                ...piece, detailOnly: true, density: factor, normals: undefined, chart: undefined, polygon: undefined,
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
        if (normal.every((v) => v === 0)) return null;
        const face = { kind, room, corners, normal, w, h, subdivide };
        faces.push(face);
        return face;
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

    // Runde Ecken (level.js): der Viertelkreis einer Ecke, so herum, wie die
    // Wände laufen (wallEnds: von a nach b, der Raum auf der Seite von INWARD,
    // also in Richtung (-d.z, d.x)). a0: der Winkel am Anfang, delta: wie weit (±90°).
    const ROUND_STEPS = Math.ceil(90 / (EDGE_ANGLE - 0.5));   // Stücke je Viertelkreis, je unter EDGE_ANGLE Knick
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    const arcOf = (c) => {
        let a0 = Math.atan2(c.vertex[1] - c.centre[1], 0);
        let delta = Math.atan2(0, c.vertex[0] - c.centre[0]) - a0;
        delta -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));
        const middle = a0 + delta / 2, sign = c.concave ? -1 : 1;
        const n = [sign * Math.cos(middle), sign * Math.sin(middle)], run = [-Math.sin(middle) * delta, Math.cos(middle) * delta];
        if (run[0] * n[1] - run[1] * n[0] < 0) { a0 += delta; delta = -delta; }
        return { a0, delta };
    };
    // die Stelle bei f (0 bis 1, auch darüber hinaus) auf dem Bogen, off Meter vor der Wand (in den Raum), in Feldern
    const arcPoint = (c, { a0, delta }, f, off = 0) => {
        const angle = a0 + delta * f, radius = c.r + (c.concave ? -off : off) / cell;
        return [c.centre[0] + Math.cos(angle) * radius, c.centre[1] + Math.sin(angle) * radius];
    };
    // die Richtung in den Raum: innen zur Mitte hin, außen von ihr weg
    const arcInward = (c, { a0, delta }, f) => {
        const angle = a0 + delta * f, sign = c.concave ? -1 : 1;
        return [sign * Math.cos(angle), sign * Math.sin(angle)];
    };
    // Ein Vieleck (in Feldern) ohne den Zwickel der inneren runden Ecke c:
    // Wo sein Rand in den Zwickel geht, läuft er den Kreis entlang, über
    // dieselben Punkte wie die Wand dort, bis er wieder herauskommt.
    const withoutSliver = (polygon, c) => {
        const arc = arcOf(c), [bx0, bx1, bz0, bz1] = c.box;
        const inside = (q) => q[0] > bx0 - 1e-9 && q[0] < bx1 + 1e-9 && q[1] > bz0 - 1e-9 && q[1] < bz1 + 1e-9
            && (q[0] - c.centre[0]) ** 2 + (q[1] - c.centre[1]) ** 2 > c.r * c.r + 1e-9;
        const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        // jede Kante in Stücke: geteilt, wo sie den Kreis oder eine Seite des Quadrats kreuzt
        const pieces = [];
        polygon.forEach((a, i) => {
            const b = polygon[(i + 1) % polygon.length], d = [b[0] - a[0], b[1] - a[1]];
            const o = [a[0] - c.centre[0], a[1] - c.centre[1]];
            const A = d[0] ** 2 + d[1] ** 2, B = 2 * (o[0] * d[0] + o[1] * d[1]), C = o[0] ** 2 + o[1] ** 2 - c.r * c.r;
            const ts = [0, 1];
            if (A > 1e-12 && B * B - 4 * A * C >= 0) ts.push((-B - Math.sqrt(B * B - 4 * A * C)) / (2 * A), (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A));
            for (const [k, v] of [[0, bx0], [0, bx1], [1, bz0], [1, bz1]]) if (Math.abs(d[k]) > 1e-12) ts.push((v - a[k]) / d[k]);
            const cuts = [...new Set(ts.filter((t) => t >= 0 && t <= 1))].sort((x, y) => x - y);
            for (let j = 0; j + 1 < cuts.length; j++) {
                if (cuts[j + 1] - cuts[j] < 1e-9) continue;
                pieces.push({ a: mix(a, b, cuts[j]), b: mix(a, b, cuts[j + 1]), inside: inside(mix(a, b, (cuts[j] + cuts[j + 1]) / 2)) });
            }
        });
        const first = pieces.findIndex((piece) => !piece.inside);
        if (first < 0) return [];
        const order = [...pieces.slice(first), ...pieces.slice(0, first)];
        const fraction = (q) => {
            let angle = Math.atan2(q[1] - c.centre[1], q[0] - c.centre[0]) - arc.a0;
            angle -= 2 * Math.PI * Math.round(angle / (2 * Math.PI));
            return angle / arc.delta;
        };
        // die Punkte des Bogens zwischen zwei Stellen auf ihm
        const between = (from, to) => {
            const f0 = fraction(from), f1 = fraction(to), list = [];
            for (let k = 1; k < ROUND_STEPS; k++) if ((k / ROUND_STEPS - f0) * (k / ROUND_STEPS - f1) < -1e-12) list.push(k / ROUND_STEPS);
            if (f1 < f0) list.reverse();
            return list.map((f) => arcPoint(c, arc, f));
        };
        const result = [];
        let entered = null;
        for (const piece of order) {
            if (piece.inside) { entered = entered ?? piece.a; continue; }
            if (entered) { result.push(entered, ...between(entered, piece.a)); entered = null; }
            result.push(piece.a);
        }
        if (entered) result.push(entered, ...between(entered, order[0].a));
        return result.filter((q, i) => {
            const next = result[(i + 1) % result.length];
            return Math.hypot(q[0] - next[0], q[1] - next[1]) > 1e-9;
        });
    };
    // Der Umriss eines Rechtecks aus Boden oder Decke (in Feldern) ohne die
    // Zwickel der inneren runden Ecken des Raums; null: keine berührt es
    const roundOutline = (room, [x0, x1, z0, z1]) => {
        const touching = level.corners.filter((c) => c.room === room && c.concave
            && c.box[0] < x1 - 1e-9 && c.box[1] > x0 + 1e-9 && c.box[2] < z1 - 1e-9 && c.box[3] > z0 + 1e-9);
        if (!touching.length) return null;
        return touching.reduce((polygon, c) => (polygon.length ? withoutSliver(polygon, c) : polygon), [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]);
    };

    level.rooms.forEach((room) => {
        const r = room.index;
        const h = (cx, cz) => ceiling(cx, cz, r);
        const f = (cx, cz) => floorAt(cx, cz, r);
        const gable = room.settings.slope === 'gable' ? (room.width >= room.depth ? 'x' : 'z') : null;
        // eine Rampe nach Osten oder Westen ändert sich entlang x: Streifen entlang z
        const ramp = room.settings.ramp ? (['east', 'west'].includes(room.settings.ramp.direction) ? 'z' : 'x') : null;
        const both = gable && ramp && gable !== ramp ? 'cell' : gable ?? ramp;
        // ohne die Zwickel innerer runder Ecken (polygon); Boden und Decke des
        // Raums teilen sich je ein Stück Lichtkarte (chart, unten)
        const piece = (kind, rect, corners) => {
            const { x, z, w, d, door } = rect;
            const outline = door ? null : roundOutline(r, [x, x + w, z, z + d]);
            if (outline && outline.length < 3) return;
            const face = add(kind, r, corners, texels(w * cell), texels(d * cell), door ? DOOR_GRID : 1);
            if (!face || door) return;
            face.chart = kind;
            if (outline) face.polygon = outline;
        };
        for (const rect of rectangles(r, ramp)) {
            const { x, z, w, d } = rect, x0 = x * cell, x1 = (x + w) * cell, z0 = z * cell, z1 = (z + d) * cell;
            piece('floor', rect, [[x0, f(x, z + d), z1], [x1, f(x + w, z + d), z1], [x1, f(x + w, z), z0], [x0, f(x, z), z0]]);
        }
        for (const rect of rectangles(r, both, true)) {
            const { x, z, w, d } = rect, x0 = x * cell, x1 = (x + w) * cell, z0 = z * cell, z1 = (z + d) * cell;
            piece('ceiling', rect, [[x0, h(x, z), z0], [x1, h(x + w, z), z0], [x1, h(x + w, z + d), z1], [x0, h(x, z + d), z1]]);
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
    // extra.cuts: die Stellen der Stücke in s, wenn sie nicht gleich lang
    // sind (ein Weg aus Geraden und Bögen), extra.normal: die Richtung der
    // Fläche, wenn ihr Anfang und ihr Ende zusammenfallen (ein Weg ringsum)
    const curved = (kind, room, shape, steps, metersS, metersT, uvAt = null, extra = {}) => {
        const cuts = extra.cuts ?? [...Array(steps + 1).keys()].map((i) => i / steps);
        const samples = cuts.flatMap((s) => [shape(s, 0), shape(s, 1)]);
        const corners = [shape(0, 0), shape(1, 0), shape(1, 1), shape(0, 1)];
        const normal = extra.normal ?? faceNormal([shape(0.45, 0), shape(0.55, 0), shape(0.55, 1), shape(0.45, 1)]);
        if (normal.every((v) => v === 0)) return;
        faces.push({ kind, room, corners, normal, w: texels(metersS), h: texels(metersT), shape, uvAt, samples, ...extra, steps: cuts.length - 1, cuts });
    };
    // Wie eine Leiste an einem Ende ihrer Wand weitergeht: p das Ende (in
    // Feldern), out die Richtung über das Ende hinaus, n die in den Raum, y
    // die Höhe der Leiste (Meter). inner: Vor ihr steht eine Wand (eine
    // innere Ecke). outer: Die Wand biegt weg, und um die Ecke geht dieselbe
    // Leiste weiter (eine äußere Ecke, eine Tür des Raums ohne Rahmen).
    // open: Die Wand biegt weg, aber um die Ecke ist ein anderer Raum (seine
    // Tür): Die Leiste endet mit einer Stirnseite. straight: Die Wand geht
    // weiter, oder die Leiste endet unter der Bekleidung einer Tür mit Rahmen.
    const endOf = (room, p, out, n, y) => {
        const layer = level.rooms[room].layer;
        // gleich hinter dem Ende: vor der Wandlinie (side 1) und hinter ihr (-1)
        const air = (side) => level.openAt((p[0] + out[0] * 0.05 + n[0] * 0.05 * side) * cell, y, (p[1] + out[1] * 0.05 + n[2] * 0.05 * side) * cell, -0.002);
        if (!air(1)) return 'inner';
        if (!air(-1)) return 'straight';
        const behind = [Math.floor(p[0] + out[0] * 0.5 - n[0] * 0.5), Math.floor(p[1] + out[1] * 0.5 - n[2] * 0.5)];
        if (level.framedDoorAt(...behind, layer) && passage(...behind, layer)) return 'straight';
        return roomOf(...behind, layer) === room ? 'outer' : 'open';
    };
    const facing = (corners, want) => (faceNormal(corners).reduce((sum, v, k) => sum + v * want[k], 0) < 0 ? [corners[0], corners[3], corners[2], corners[1]] : corners);
    const strip = (room, color, corners, w, h) => {
        const normal = faceNormal(corners);
        if (normal.some((v) => v !== 0)) faces.push({ kind: 'baseboard', color, room, corners, normal, w: texels(w), h: texels(h) });
    };
    // Eine Leiste mit rechteckigem Querschnitt vor der Wand von p nach q (in
    // Feldern, so herum wie wallEnds), n die Richtung in den Raum: unten bei
    // y0 (an p und an q), height hoch, depth vor der Wand, ends wie bei
    // endOf, bottom: auch unten eine Fläche. An einer äußeren Ecke laufen
    // beide Leisten um ihre Tiefe weiter, bis ihre Vorderseiten sich treffen;
    // an einer inneren hört die entlang z vor der Vorderseite der anderen auf.
    // Das Quadrat in der Ecke deckt oben und unten nur die Leiste entlang x,
    // sonst lägen zwei Flächen aufeinander.
    const boxStrip = (room, color, p, q, n, y0, height, depth, ends, bottom = false) => {
        const lengthCells = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (lengthCells < 1e-9) return;
        const d = [(q[0] - p[0]) / lengthCells, (q[1] - p[1]) / lengthCells];
        const alongX = Math.abs(d[0]) > 0.5;
        const reach = (kind) => ({ outer: [depth, alongX ? depth : 0], inner: [alongX ? 0 : -depth, alongX ? 0 : -depth] })[kind] ?? [0, 0];
        const [frontP, sideP] = reach(ends[0]), [frontQ, sideQ] = reach(ends[1]);
        // das Ende e (p oder q), um extra Meter nach außen verlängert (sign), offset vor der Wand, auf Höhe y
        const at = (e, extra, sign, offset, y) => [e[0] * cell + sign * d[0] * extra + n[0] * offset, y, e[1] * cell + sign * d[1] * extra + n[2] * offset];
        const [yp, yq] = y0, length = lengthCells * cell;
        strip(room, color, facing([at(p, frontP, -1, depth, yp), at(q, frontQ, 1, depth, yq), at(q, frontQ, 1, depth, yq + height), at(p, frontP, -1, depth, yp + height)], n), length + frontP + frontQ, height);
        const flat = (dy, want) => strip(room, color, facing([at(p, sideP, -1, 0, yp + dy), at(q, sideQ, 1, 0, yq + dy), at(q, sideQ, 1, depth, yq + dy), at(p, sideP, -1, depth, yp + dy)], want),
            length + sideP + sideQ, Math.max(depth, 0.2));
        flat(height, [0, 1, 0]);
        if (bottom) flat(0, [0, -1, 0]);
        ends.forEach((kind, i) => {
            if (kind !== 'open') return;
            const [e, y, sign] = i ? [q, yq, 1] : [p, yp, -1];
            strip(room, color, facing([at(e, 0, sign, 0, y), at(e, 0, sign, depth, y), at(e, 0, sign, depth, y + height), at(e, 0, sign, 0, y + height)], [sign * d[0], 0, sign * d[1]]), depth, height);
        });
    };
    // Eine Sockelleiste vor einem Stück Wand von p nach q (in Feldern), auf
    // dem Boden bei y0 (an p und an q): vorne und oben, 1,5 cm vor der Wand
    const skirting = (room, direction, p, q, y0, ends = ['straight', 'straight']) => {
        const board = level.rooms[room].settings.baseboard;
        if (!board) return;
        boxStrip(room, board.color, p, q, INWARD[direction], [y0, y0].flat().slice(0, 2), board.height, 0.015, ends);
    };
    // Eine Leiste oben (cornice), wo die Wand von p nach q (in Feldern) an die
    // Decke stößt (bei topP und topQ): ein Streifen schräg, 45° zwischen Wand
    // und Decke, seine obere Kante dort, wo die Decke ist. ends wie bei
    // endOf: An einer äußeren Ecke läuft die obere Kante um die Breite der
    // Leiste weiter, an einer inneren hört sie um sie früher auf: Zwei
    // Leisten treffen sich auf der Diagonalen der Ecke (auf Gehrung).
    const crown = (room, direction, p, q, topP, topQ, ends = null) => {
        const cornice = level.rooms[room].settings.cornice;
        if (!cornice) return;
        const n = INWARD[direction], hgt = cornice.height;
        const lengthCells = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (lengthCells < 1e-9) return;
        const d = [(q[0] - p[0]) / lengthCells, (q[1] - p[1]) / lengthCells];
        // ohne Angabe sieht sie selbst nach, wie die Wand an ihren Enden weitergeht
        ends = ends ?? [endOf(room, p, [-d[0], -d[1]], n, topP - hgt / 2), endOf(room, q, d, n, topQ - hgt / 2)];
        const ext = (kind) => (kind === 'outer' ? hgt : kind === 'inner' ? -hgt : 0);
        const upper = (e, extra, sign) => {
            const x = e[0] * cell + sign * d[0] * extra + n[0] * hgt, z = e[1] * cell + sign * d[1] * extra + n[2] * hgt;
            return [x, ceiling(x / cell, z / cell, room), z];
        };
        const want = [n[0], -1, n[2]];   // schräg nach unten in den Raum
        const wallP = [p[0] * cell, topP - hgt, p[1] * cell], wallQ = [q[0] * cell, topQ - hgt, q[1] * cell];
        strip(room, cornice.color, facing([wallP, wallQ, upper(q, ext(ends[1]), 1), upper(p, ext(ends[0]), -1)], want), lengthCells * cell, hgt * 1.42);
        ends.forEach((kind, i) => {
            if (kind !== 'open') return;
            const [e, wall, top, sign] = i ? [q, wallQ, topQ, 1] : [p, wallP, topP, -1];
            const tip = upper(e, 0, sign);
            strip(room, cornice.color, facing([wall, tip, tip, [e[0] * cell, top, e[1] * cell]], [sign * d[0], 0, sign * d[1]]), hgt, hgt);
        });
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
                    // am Rand eines Lochs: über der eigenen Decke ist es die Decke
                    // zwischen den beiden Räumen, auch wo dahinter Wand ist (an den Seiten)
                    const own = [ceiling(a[0], a[1], room), ceiling(b[0], b[1], room)];
                    const bands = gaps(bottom, top, open).flatMap(([low, high, between]) => {
                        const inside = capped && !between && (own[0] > low[0] + 0.01 || own[1] > low[1] + 0.01) && (own[0] < high[0] - 0.01 || own[1] < high[1] - 0.01);
                        return inside ? [[low, own, false], [own, high, true]] : [[low, high, between]];
                    });
                    for (const [low, high, between] of bands) {
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
                    // stößt das Loch an eine Wand des Raums darüber: dort steht seine
                    // Wand, vom Boden bis an die Decke (die Wand von unten endet am
                    // Boden), ohne Sockelleiste, denn darunter ist kein Boden
                    const upper = capped && level.rooms[above].layer;
                    if (capped && at(nx, nz, upper) !== 'floor') {
                        const low = top, high = [h(a[0], a[1]), h(b[0], b[1])];
                        if (high[0] > low[0] + 0.01 || high[1] > low[1] + 0.01) {
                            const corners = [[a[0] * cell, low[0], a[1] * cell], [b[0] * cell, low[1], b[1] * cell],
                                [b[0] * cell, high[1], b[1] * cell], [a[0] * cell, high[0], a[1] * cell]];
                            add('wall', above, corners, texels(cell), texels(Math.max(high[0] - low[0], high[1] - low[1])));
                            crown(above, direction, a, b, high[0], high[1]);
                        }
                    }
                }
            }
        }
    }
    // Die Seiten des Quadrats einer runden Ecke (level.js) auf einer
    // Wandlinie: Dort ist die Wand ein Viertelkreis (cornerFaces), keine
    // gerade Wand. [von, bis] entlang der Linie, in Feldern.
    const roundGaps = (room, direction, line) => {
        const n = INWARD[direction], alongX = direction === 'north' || direction === 'south';
        return level.corners.filter((c) => c.room === room).flatMap((c) => {
            // innen liegt das Quadrat vor der Wand (im Raum), außen hinter ihr (in der Wand)
            const ahead = alongX ? n[2] * c.q[1] : n[0] * c.q[0];
            if ((c.concave ? ahead : -ahead) <= 0 || (alongX ? c.vertex[1] : c.vertex[0]) !== line) return [];
            return [alongX ? [c.box[0], c.box[1]] : [c.box[2], c.box[3]]];
        });
    };
    // die Berührpunkte der runden Ecken mit den geraden Wänden, und die
    // Stücke Wand, die dort anschließen
    const pointKey = (q) => `${Math.round(q[0] * 1e6)},${Math.round(q[1] * 1e6)}`;
    const tangents = new Set(level.corners.flatMap((c) => [[c.centre[0], c.vertex[1]], [c.vertex[0], c.centre[1]]].map((q) => `${c.room}:${pointKey(q)}`)));
    const pathParts = [];
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
        const gapsHere = roundGaps(room, direction, line);
        const n = INWARD[direction];
        let start = 0;
        while (start < list.length) {
            let end = start;
            while (end + 1 < list.length && list[end + 1] === list[end] + 1 && straight(list[start], list[end + 1] + 1)) end += 1;
            // ohne die Stücke, an denen eine runde Ecke anschließt
            let spans = [[list[start], list[end] + 1]];
            for (const [g0, g1] of gapsHere) {
                spans = spans.flatMap(([s0, s1]) => [[s0, Math.min(s1, g0)], [Math.max(s0, g1), s1]].filter(([u0, u1]) => u1 - u0 > 1e-9));
            }
            for (const [s0, s1] of spans) {
                const [a, b] = wallEnds(direction, line, s0, s1);
                // an einer runden Ecke: ein Stück ihres Wegs (unten)
                if (tangents.has(`${room}:${pointKey(a)}`) || tangents.has(`${room}:${pointKey(b)}`)) {
                    pathParts.push({ room, a, b });
                    continue;
                }
                const ha = h(a[0], a[1]), hb = h(b[0], b[1]);
                const fa0 = f(a[0], a[1]), fb0 = f(b[0], b[1]);
                const length = (s1 - s0) * cell;
                add('wall', room, [[a[0] * cell, fa0, a[1] * cell], [b[0] * cell, fb0, b[1] * cell],
                    [b[0] * cell, hb, b[1] * cell], [a[0] * cell, ha, a[1] * cell]],
                    texels(length), texels(Math.max(ha - fa0, hb - fb0)));
                // wie die Leisten an den Enden weitergehen, auf ihrer Höhe
                const d = [(b[0] - a[0]) / (s1 - s0), (b[1] - a[1]) / (s1 - s0)];
                const ends = (y) => [endOf(room, a, [-d[0], -d[1]], n, y(a)), endOf(room, b, d, n, y(b))];
                const cornice = level.rooms[room].settings.cornice;
                if (cornice) crown(room, direction, a, b, ha, hb, ends((e) => h(...e) - cornice.height / 2));
                // Sockelleiste: auch an einer Rampe, dort läuft sie schräg mit dem Boden
                const board = pool ? null : level.rooms[room].settings.baseboard;
                if (board) skirting(room, direction, a, b, [fa0, fb0], ends((e) => f(...e) + board.height / 2));
            }
            start = end + 1;
        }
    }
    // Runde Ecken, die Wände: Eine Wand, die gerade auf eine runde Ecke
    // zuläuft, um sie herum und gerade weiter, ist ein Weg aus geraden
    // Stücken und Viertelkreisen ohne Knick, und darauf eine einzige Fläche
    // mit einem Stück Lichtkarte: So ist keine Naht, wo die Gerade in den
    // Kreis übergeht. Ebenso Lambris, Leisten und Gesims. Läuft der Weg ganz
    // herum, schließt er sich: Dann sieht sein Anfang beim Backen über sein
    // Ende hinaus und umgekehrt.
    const elements = pathParts.map(({ room, a, b }) => {
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        return { room, from: a, to: b, length: length * cell, d: [(b[0] - a[0]) / length, (b[1] - a[1]) / length] };
    });
    for (const c of level.corners) {
        const arc = arcOf(c);
        elements.push({ room: c.room, from: arcPoint(c, arc, 0), to: arcPoint(c, arc, 1), length: Math.abs(arc.delta) * c.r * cell, corner: c, arc });
    }
    const startsAt = new Map(elements.map((e) => [`${e.room}:${pointKey(e.from)}`, e]));
    const endsAt = new Set(elements.map((e) => `${e.room}:${pointKey(e.to)}`));
    const used = new Set(), chains = [];
    const follow = (first) => {
        const list = [];
        for (let e = first; e && !used.has(e) && list.length < 100000; e = startsAt.get(`${e.room}:${pointKey(e.to)}`)) {
            used.add(e);
            list.push(e);
        }
        chains.push({ room: first.room, list, closed: pointKey(list[list.length - 1].to) === pointKey(list[0].from) });
    };
    for (const e of elements) if (!endsAt.has(`${e.room}:${pointKey(e.from)}`)) follow(e);
    for (const e of elements) if (!used.has(e)) follow(e);

    for (const { room, list, closed } of chains) {
        const roomSettings = level.rooms[room].settings;
        const total = list.reduce((sum, e) => sum + e.length, 0);
        const starts = [];
        list.reduce((sum, e) => { starts.push(sum); return sum + e.length; }, 0);
        // welches Stück bei s (0 bis 1 über den ganzen Weg; geschlossen: ringsum), und wie weit darin
        const locate = (s) => {
            const u = (closed ? s - Math.floor(s) : clamp01(s)) * total;
            let i = list.length - 1;
            while (i > 0 && starts[i] > u) i -= 1;
            return [list[i], (u - starts[i]) / list[i].length];
        };
        // die Stelle bei s, off Meter vor der Wand, in Feldern; die Richtung in den Raum; die Richtung des Wegs
        const pointAt = (s, off = 0) => {
            const [e, f] = locate(s);
            if (e.corner) return arcPoint(e.corner, e.arc, f, off);
            return [e.from[0] + e.d[0] * f * e.length / cell - e.d[1] * off / cell, e.from[1] + e.d[1] * f * e.length / cell + e.d[0] * off / cell];
        };
        const inwardAt = (s) => {
            const [e, f] = locate(s);
            return e.corner ? arcInward(e.corner, e.arc, f) : [-e.d[1], e.d[0]];
        };
        const runAt = (s) => {
            const n = inwardAt(s);
            return [n[1], -n[0]];
        };
        const cuts = [...list.flatMap((e, i) => (e.corner ? [...Array(ROUND_STEPS).keys()].map((k) => (starts[i] + e.length * k / ROUND_STEPS) / total) : [starts[i] / total])), 1];
        const floorY = (q) => floorAt(q[0], q[1], room), ceilY = (q) => ceiling(q[0], q[1], room);
        const world = (q, y) => [q[0] * cell, y, q[1] * cell];
        const flat3 = (n) => [n[0], 0, n[1]];
        // die beiden Enden eines offenen Wegs, und wie die Leisten dort weitergehen (endOf)
        const ends = closed ? null : [0, 1].map((s) => ({ q: pointAt(s), run: runAt(s), n: flat3(inwardAt(s)) }));
        const kinds = (y) => (closed ? null : ends.map((e, i) => endOf(room, e.q, i ? e.run : [-e.run[0], -e.run[1]], e.n, y(e.q))));
        // eine Stelle bei s, off Meter vor der Wand; an den Enden eines offenen Wegs um ext(i) Meter darüber hinaus
        const place = (s, off, ext) => {
            const q = pointAt(s, off);
            if (closed || !ext) return q;
            const i = s <= 0 ? 0 : s >= 1 ? 1 : null;
            if (i === null) return q;
            const e = ext(i), sign = i ? 1 : -1;
            return [q[0] + sign * ends[i].run[0] * e / cell, q[1] + sign * ends[i].run[1] * e / cell];
        };
        // eine Fläche auf dem Weg, so herum, dass sie zu want zeigt
        const pathFace = (kind, extra, shape, want, metersT, uvAt = null, normalAt = null) => {
            const m = cuts[1] / 2, e = Math.min(0.002, m / 2);
            const normal = faceNormal([shape(m - e, 0), shape(m + e, 0), shape(m + e, 1), shape(m - e, 1)]), w = want(m);
            const turn = normal[0] * w[0] + normal[1] * w[1] + normal[2] * w[2] < 0;
            const flip = (fn) => fn && (turn ? (s, t) => fn(1 - s, t) : fn);
            curved(kind, room, flip(shape), 0, total, Math.max(metersT, 0.05), flip(uvAt),
                { ...extra, normalAt: flip(normalAt), normal: w, cuts: turn ? cuts.map((c) => 1 - c).reverse() : cuts });
        };
        // ein senkrechtes Band off Meter vor der Wand, von y0(q) bis y1(q)
        const band = (kind, extra, off, y0, y1, textured, ext = null) => {
            const shape = (s, t) => {
                const q = place(s, off, ext), lo = y0(q), hi = y1(q);
                return world(q, lo + (hi - lo) * t);
            };
            const tall = Math.max(...cuts.map((s) => y1(pointAt(s)) - y0(pointAt(s))));
            pathFace(kind, extra, shape, (s) => flat3(inwardAt(s)), tall, textured ? (s, t) => [s * total, shape(s, t)[1]] : null, (s) => flat3(inwardAt(s)));
        };
        // ein waagerechter Streifen zwischen o0 und o1 Metern vor der Wand, auf Höhe y(q)
        const ring = (kind, extra, o0, o1, y, want, ext = null) => pathFace(kind, extra, (s, t) => {
            const q = place(s, o0 + (o1 - o0) * t, ext);
            return world(q, y(q));
        }, () => want, Math.abs(o1 - o0));
        // eine Stirnseite am offenen Ende i: von der Wand bis depth davor, von y0 bis y0 + height
        const cap = (color, i, y0, height, depth) => {
            const { q, n, run } = ends[i], sign = i ? 1 : -1, y = y0(q);
            const at = (off, h) => world([q[0] + n[0] * off / cell, q[1] + n[2] * off / cell], h);
            strip(room, color, facing([at(0, y), at(depth, y), at(depth, y + height), at(0, y + height)], [sign * run[0], 0, sign * run[1]]), depth, height);
        };
        // wie weit eine Leiste mit rechteckigem Querschnitt an einem Ende weiterläuft (wie boxStrip): vorn, oben/unten
        const reach = (kind, i, depth) => {
            const alongX = Math.abs(ends[i].run[0]) > 0.5;
            return ({ outer: [depth, alongX ? depth : 0], inner: [alongX ? 0 : -depth, alongX ? 0 : -depth] })[kind] ?? [0, 0];
        };
        const boxAlong = (color, y0, height, depth, endKinds, bottom) => {
            const front = endKinds && ((i) => reach(endKinds[i], i, depth)[0]), side = endKinds && ((i) => reach(endKinds[i], i, depth)[1]);
            band('baseboard', { color }, depth, y0, (q) => y0(q) + height, false, front);
            ring('baseboard', { color }, 0, depth, (q) => y0(q) + height, [0, 1, 0], side);
            if (bottom) ring('baseboard', { color }, 0, depth, y0, [0, -1, 0], side);
            endKinds?.forEach((kind, i) => { if (kind === 'open') cap(color, i, y0, height, depth); });
        };

        const lowest = Math.min(...cuts.map((s) => ceilY(pointAt(s)) - floorY(pointAt(s))));
        const dado = roomSettings.dado;
        if (dado && lowest > dado.height + 0.02) {
            band('block', { color: dado.color, material: dado.material }, 0, floorY, (q) => floorY(q) + dado.height, true);
            band('wall', {}, 0, (q) => floorY(q) + dado.height, ceilY, true);
        } else {
            band('wall', {}, 0, floorY, ceilY, true);
        }
        const board = roomSettings.baseboard;
        if (board) boxAlong(board.color, floorY, board.height, 0.015, kinds((q) => floorY(q) + board.height / 2), false);
        const rail = dado && roomSettings.dado_rail;
        if (rail && lowest > dado.height + 0.02) {
            const y0 = (q) => floorY(q) + dado.height - rail.height / 2;
            boxAlong(rail.color, y0, rail.height, 0.02, kinds((q) => floorY(q) + dado.height), true);
        }
        const cornice = roomSettings.cornice;
        if (cornice) {
            const hgt = cornice.height, endKinds = kinds((q) => ceilY(q) - hgt / 2);
            const ext = endKinds && ((i) => ({ outer: hgt, inner: -hgt })[endKinds[i]] ?? 0);
            // schräg nach unten in den Raum, 45°
            const slant = (s) => {
                const n = inwardAt(s);
                return [n[0] * Math.SQRT1_2, -Math.SQRT1_2, n[1] * Math.SQRT1_2];
            };
            pathFace('baseboard', { color: cornice.color }, (s, t) => {
                const low = ceilY(place(s, 0, null)) - hgt, top = place(s, hgt, ext), high = ceilY(top);
                const q = place(s, hgt * t, ext && ((i) => ext(i) * t));
                return world(q, low + (high - low) * t);
            }, slant, hgt * 1.42, null, slant);
            endKinds?.forEach((kind, i) => {
                if (kind !== 'open') return;
                const { q, n, run } = ends[i], sign = i ? 1 : -1, top = ceilY(q);
                const tip = [q[0] + n[0] * hgt / cell, q[1] + n[2] * hgt / cell];
                strip(room, cornice.color, facing([world(q, top - hgt), world(tip, ceilY(tip)), world(tip, ceilY(tip)), world(q, top)], [sign * run[0], 0, sign * run[1]]), hgt, hgt);
            });
        }
    }
    // Boden und Decke an einer äußeren runden Ecke: der Zwickel zwischen Kreis
    // und Ecke, von jeder Stelle des Kreises gerade zur Ecke; im selben Stück
    // Lichtkarte wie der übrige Boden des Raums (chart). Über die Ecke hinaus
    // (beim Backen) bleibt er auf ihr, in den Kreis hinein geht er weiter: Dort
    // rückt ihn das Backen auf den Kreis (outOfCorners in bake.js).
    for (const c of level.corners) {
        if (c.concave) continue;
        const arc = arcOf(c), length = Math.abs(arc.delta) * c.r * cell;
        for (const [kind, height, want] of [['floor', floorAt, [0, 1, 0]], ['ceiling', ceiling, [0, -1, 0]]]) {
            const shape0 = (s, t) => {
                const q = arcPoint(c, arc, clamp01(s)), p = [q[0] + (c.vertex[0] - q[0]) * t, q[1] + (c.vertex[1] - q[1]) * t];
                return [p[0] * cell, height(p[0], p[1], c.room), p[1] * cell];
            };
            const normal = faceNormal([shape0(0.45, 0), shape0(0.55, 0), shape0(0.55, 1), shape0(0.45, 1)]);
            const turn = normal[0] * want[0] + normal[1] * want[1] + normal[2] * want[2] < 0;
            curved(kind, c.room, turn ? (s, t) => shape0(1 - s, t) : shape0, ROUND_STEPS, length, c.r * cell, null, { chart: kind });
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
    const rails = [];
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
        // die Leiste auf der Kante: vorn, oben und unten, 2 cm vor der Wand (unten, boxStrip)
        if (rail) rails.push({ room: face.room, c0, c1, n: face.normal, y: [c0[1] + dado.height, c1[1] + dado.height], rail });
        return [lower, upper];
    });
    for (const { room, c0, c1, n, y, rail } of rails) {
        const p = [c0[0] / cell, c0[2] / cell], q = [c1[0] / cell, c1[2] / cell];
        const length = Math.hypot(q[0] - p[0], q[1] - p[1]), d = [(q[0] - p[0]) / length, (q[1] - p[1]) / length];
        const ends = [endOf(room, p, [-d[0], -d[1]], n, y[0]), endOf(room, q, d, n, y[1])];
        boxStrip(room, rail.color, p, q, n, [y[0] - rail.height / 2, y[1] - rail.height / 2], rail.height, 0.02, ends, true);
    }
    faces = addDetail(faces, [...modelBoxes, ...blockBoxes]);
    // Boden und Decke eines Raums teilen sich je ein Stück Lichtkarte (chart),
    // im Grundriss gerade aufgelegt, so dicht wie jede Fläche: Wo zwei ihrer
    // Flächen aneinanderstoßen (Rechtecke, Stücke um ein Modell, der Zwickel
    // einer runden Ecke), liegen dieselben Punkte, und es gibt keine Naht.
    // Je Ebene eins (ein Satteldach hat zwei), und nur, solange die Flächen
    // ihr Stück gut füllen: Ein Raum wie ein L bekommt zwei.
    const charts = [];
    {
        const byKey = new Map();
        for (const face of faces) {
            if (!face.chart) continue;
            const key = `${face.chart}:${face.room}:${face.normal.map((v) => v.toFixed(3)).join(',')}`;
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(face);
        }
        const boxOf = (face) => {
            const points = face.samples ?? face.corners;
            return [Math.min(...points.map((q) => q[0])), Math.max(...points.map((q) => q[0])), Math.min(...points.map((q) => q[2])), Math.max(...points.map((q) => q[2]))];
        };
        const areaOf = (box) => Math.max(box[1] - box[0], 1e-6) * Math.max(box[3] - box[2], 1e-6);
        for (const list of byKey.values()) {
            let groups = list.map((face) => ({ faces: [face], box: boxOf(face), area: areaOf(boxOf(face)) }));
            for (let merged = true; merged && groups.length > 1;) {
                merged = false;
                for (let i = 0; i < groups.length && !merged; i++) {
                    for (let j = i + 1; j < groups.length && !merged; j++) {
                        const a = groups[i].box, b = groups[j].box;
                        if (a[0] > b[1] + 1e-6 || b[0] > a[1] + 1e-6 || a[2] > b[3] + 1e-6 || b[2] > a[3] + 1e-6) continue;
                        const box = [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3])];
                        if (areaOf(box) > (groups[i].area + groups[j].area) * 1.3) continue;
                        groups[i] = { faces: [...groups[i].faces, ...groups[j].faces], box, area: groups[i].area + groups[j].area };
                        groups.splice(j, 1);
                        merged = true;
                    }
                }
            }
            for (const { faces: members, box: loose } of groups) {
                // auf das Raster der Lichtkarte gerundet, so liegen die Kanten der Felder auf Grenzen zwischen ihren Punkten
                const step = 1 / settings.detail;
                const box = [Math.floor(loose[0] / step + 1e-6) * step, Math.ceil(loose[1] / step - 1e-6) * step, Math.floor(loose[2] / step + 1e-6) * step, Math.ceil(loose[3] / step - 1e-6) * step];
                const chart = { box, w: Math.max(2, Math.round((box[1] - box[0]) / step)), h: Math.max(2, Math.round((box[3] - box[2]) / step)), faces: members };
                charts.push(chart);
                for (const face of members) face.chartRect = chart;
            }
        }
        // Beim Backen zeichnet jede Fläche eines gemeinsamen Stücks nur ihre
        // eigenen Punkte (ein Punkt, den zwei zeichneten, zählte doppelt).
        // Um alles, was sie zusammen bedecken, kommt ein Punkt breit Rand, der
        // das Licht seines Nachbarn bekommt: Beim Zeichnen mischt sich der
        // Rand einer Fläche mit ihm, und dort soll nicht Schwarz sein.
        const inside = (polygon, x, z) => {
            let odd = false;
            for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
                const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
                if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) odd = !odd;
            }
            return odd;
        };
        for (const chart of charts) {
            const { box, w, h } = chart, sx = (box[1] - box[0]) / w, sz = (box[3] - box[2]) / h;
            const owner = new Array((w + 2) * (h + 2)).fill(null), at = (i, j) => (i + 1) + (j + 1) * (w + 2);
            for (const face of chart.faces) {
                // was die Fläche beim Backen bedeckt: ein Rechteck ganz (auch ein Zwickel darin), ein Zwickel außen sein Umriss
                const outline = face.shape ? [...face.cuts.map((c) => face.shape(c, 0)), face.shape(0, 1)].map((q) => [q[0], q[2]]) : face.corners.map((q) => [q[0], q[2]]);
                const xs = outline.map((q) => q[0]), zs = outline.map((q) => q[1]);
                const i0 = Math.max(0, Math.floor((Math.min(...xs) - box[0]) / sx)), i1 = Math.min(w - 1, Math.ceil((Math.max(...xs) - box[0]) / sx));
                const j0 = Math.max(0, Math.floor((Math.min(...zs) - box[2]) / sz)), j1 = Math.min(h - 1, Math.ceil((Math.max(...zs) - box[2]) / sz));
                for (let j = j0; j <= j1; j++) {
                    for (let i = i0; i <= i1; i++) {
                        if (!owner[at(i, j)] && inside(outline, box[0] + (i + 0.5) * sx, box[2] + (j + 0.5) * sz)) owner[at(i, j)] = face;
                    }
                }
            }
            chart.rim = [];
            for (let j = -1; j <= h; j++) {
                for (let i = -1; i <= w; i++) {
                    if (owner[at(i, j)]) continue;
                    const next = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
                        .map(([di, dj]) => [i + di, j + dj]).find(([a, b]) => a >= 0 && b >= 0 && a < w && b < h && owner[at(a, b)]);
                    if (!next) continue;
                    chart.rim.push({ i, j, face: owner[at(...next)], x: box[0] + (next[0] + 0.5) * sx, z: box[2] + (next[1] + 0.5) * sz });
                }
            }
        }
    }
    const atlasSize = packRectangles([...faces.filter((f) => !f.chartRect), ...charts]);

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
            // die Stelle auf der Fläche, bilinear zwischen den vier Ecken
            // eine gebogene Fläche (curved) hat ihre eigene Form
            const world = face.shape ?? ((s, t) => lerp(lerp(c0, c1, s), lerp(c3, c2, s), t));
            // In einem gemeinsamen Stück (chart) liegt jede Stelle dort, wo sie
            // im Grundriss ist; der Rand beim Backen ist auch dort einen Punkt breit
            const chart = face.chartRect;
            const inChart = chart && ((q) => [
                (chart.ax + (q[0] - chart.box[0]) / Math.max(chart.box[1] - chart.box[0], 1e-6) * chart.w) / atlasSize,
                (chart.ay + (q[2] - chart.box[2]) / Math.max(chart.box[3] - chart.box[2], 1e-6) * chart.h) / atlasSize]);
            if (chart) {
                const extent = (a, b) => Math.hypot(b[0] - a[0], b[2] - a[2]);
                const [px, pz] = [chart.w / Math.max(chart.box[1] - chart.box[0], 1e-6), chart.h / Math.max(chart.box[3] - chart.box[2], 1e-6)];
                face.ax = 0; face.ay = 0;
                face.w = Math.max(extent(world(0, 0), world(1, 0)) * Math.max(px, pz), 1e-3);
                face.h = Math.max(extent(world(0, 0), world(0, 1)) * Math.max(px, pz), 1e-3);
            }
            const u0 = face.ax / atlasSize, u1 = (face.ax + face.w) / atlasSize;
            const v0 = face.ay / atlasSize, v1 = (face.ay + face.h) / atlasSize;
            const du = u1 - u0, dv = v1 - v0;
            const points = face.samples ?? [c0, c1, c2, c3];
            const min = [0, 1, 2].map((i) => Math.min(...points.map((c) => c[i])));
            const max = [0, 1, 2].map((i) => Math.max(...points.map((c) => c[i])));
            const n = face.subdivide ?? 1;
            const nS = face.steps ?? n, nT = face.shape ? 1 : n;   // gebogen: Stücke nur entlang s
            const S = face.cuts ?? [...Array(nS + 1).keys()].map((k) => k / nS);   // wo die Stücke entlang s anfangen

            // Backen: die Fläche in ihr Rechteck der Lichtkarte, um einen Texel
            // größer (der Rand); die Stelle in der Welt wird dabei über die
            // Fläche hinaus verlängert und im Shader wieder auf sie geklemmt.
            // Ein Detailstück wirft kein Licht zurück (Albedo -1): Das tut die
            // Fläche darunter schon.
            const tu = -(GUTTER / atlasSize) / du, tv = -(GUTTER / atlasSize) / dv;
            const edge = (value, outside) => (value === 0 ? outside : value === 1 ? 1 - outside : value);
            for (let i = 0; i < nS; i++) {
                for (let j = 0; j < nT; j++) {
                    const quad = [[S[i], j / nT], [S[i + 1], j / nT], [S[i + 1], (j + 1) / nT], [S[i], (j + 1) / nT]];
                    const normal = nS > 1 || nT > 1 ? faceNormal(quad.map(([s, t]) => world(s, t))) : face.normal;
                    quad.forEach(([s, t], corner) => {
                        const bs = chart ? s : edge(s, tu), bt = chart ? t : edge(t, tv);
                        // texelAt: wo die Stelle s in ihrem Stück Lichtkarte liegt (ohne: dort, wo s sagt)
                        if (chart) bakePositions.push(...inChart(world(bs, bt)), 0);
                        else bakePositions.push(u0 + (face.texelAt && s > 0 && s < 1 ? face.texelAt(s) : bs) * du, v0 + bt * dv, 0);
                        bakeWorld.push(...world(bs, bt));
                        // eine runde Säule: die Richtung an jeder Ecke, dazwischen gemischt
                        bakeNormal.push(...(face.normalAt ? face.normalAt(bs, bt) : face.normals && n === 1 ? face.normals[corner] : normal));
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
            // der Rand des gemeinsamen Stücks neben dieser Fläche: je ein Punkt
            // mit dem Licht ihres Punkts daneben (wirft selbst kein Licht zurück)
            if (chart) {
                for (const { i, j, x, z } of chart.rim.filter((r) => r.face === face)) {
                    const y = face.kind === 'floor' ? floorAt(x / cell, z / cell, face.room) : ceiling(x / cell, z / cell, face.room);
                    const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
                    for (const [ci, cj] of corners) {
                        bakePositions.push((chart.ax + ci) / atlasSize, (chart.ay + cj) / atlasSize, 0);
                        bakeWorld.push(x, y, z);
                        bakeNormal.push(...face.normal);
                        bakeMin.push(x, y, z);
                        bakeMax.push(x, y, z);
                        bakeAmbient.push(ambient);
                        bakeAlbedo.push(-1, -1, -1);
                        bakeDensity.push(1);
                    }
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
            if (face.shape) cutsS = S;
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
            // Ein Boden oder eine Decke ohne die Zwickel runder Ecken (polygon,
            // in Feldern): in s und t der Fläche, in jedem Stück auf dieses
            // zugeschnitten und in Dreiecke geteilt
            const along2 = (q, a, b) => ((q[0] - a[0]) * (b[0] - a[0]) + (q[2] - a[2]) * (b[2] - a[2])) / Math.max((b[0] - a[0]) ** 2 + (b[2] - a[2]) ** 2, 1e-12);
            const outline = face.polygon?.map(([x, z]) => [along2([x * cell, 0, z * cell], c0, c1), along2([x * cell, 0, z * cell], c0, c3)]);
            for (let i = 0; i + 1 < cutsS.length; i++) {
                for (let j = 0; j + 1 < cutsT.length; j++) {
                    if (outline) {
                        const piece = clipRectangle(outline, cutsS[i], cutsS[i + 1], cutsT[j], cutsT[j + 1]);
                        if (piece.length < 3) continue;
                        for (const triangle of THREE.ShapeUtils.triangulateShape(piece.map(([s, t]) => new THREE.Vector2(s, t)), [])) {
                            let three = triangle.map((k) => piece[k]);
                            const normal = faceNormal(three.map(([s, t]) => world(s, t)));
                            if (normal[0] * face.normal[0] + normal[1] * face.normal[1] + normal[2] * face.normal[2] < 0) three = [three[0], three[2], three[1]];
                            three.forEach(([s, t]) => emit(s, t, world(s, t), face.normal));
                            indices.push(base, base + 1, base + 2);
                            base += 3;
                        }
                        continue;
                    }
                    const quad = [[cutsS[i], cutsT[j]], [cutsS[i + 1], cutsT[j]], [cutsS[i + 1], cutsT[j + 1]], [cutsS[i], cutsT[j + 1]]];
                    const points = quad.map(([s, t]) => world(s, t));
                    const normal = n > 1 || face.shape ? faceNormal(points) : face.normal;
                    quad.forEach(([s, t], k) => emit(s, t, points[k], normal));
                    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
                    base += 4;
                }
            }
            // eine Ecke im Mesh: Stelle, Richtung, Textur, Lichtkarte und Detailstück
            function emit(s, t, point, normal) {
                positions.push(...point);
                // eine gebogene Fläche einer runden Ecke: ihre Richtung an jeder Stelle, dazwischen gemischt
                normals.push(...(face.normalAt ? face.normalAt(s, t) : normal));
                // eigene Texturkoordinaten an den vier Ecken (ein Bogen): dazwischen gemischt
                const uv4 = face.uv4 && ((a, b) => a.map((v, i) => v + (b[i] - v) * t))(
                    face.uv4[0].map((v, i) => v + (face.uv4[1][i] - v) * s), face.uv4[3].map((v, i) => v + (face.uv4[2][i] - v) * s));
                uvs.push(...(face.uvAt ? face.uvAt(s, t) : uv4 ?? (face.arc ? [face.arc[0] + (face.arc[1] - face.arc[0]) * s, point[1]] : along(point))));
                if (chart) uv1s.push(...inChart(point));
                else uv1s.push(u0 + (face.texelAt ? face.texelAt(s) : s) * du, v0 + t * dv);
                if (target) {
                    const ds = Math.min(1, Math.max(0, (s - detail.s0) / (detail.s1 - detail.s0)));
                    const dt = Math.min(1, Math.max(0, (t - detail.t0) / (detail.t1 - detail.t0)));
                    detailUvs.push((target.ax + ds * target.w) / atlasSize, (target.ay + dt * target.h) / atlasSize);
                    detailWeights.push(ramp(s, detail.s0, detail.s1, detail.fadeS) * ramp(t, detail.t0, detail.t1, detail.fadeT));
                } else {
                    detailUvs.push(0, 0);
                    detailWeights.push(0);
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
        kind: f.kind, room: f.room, x: f.chartRect ? f.chartRect.ax : f.ax, y: f.chartRect ? f.chartRect.ay : f.ay, w: f.chartRect ? f.chartRect.w : f.w, h: f.chartRect ? f.chartRect.h : f.h,
        fine: f.detail ? { x: f.detail.target.ax, y: f.detail.target.ay, w: f.detail.target.w, h: f.detail.target.h } : null,
    }));
    return { meshes, atlasSize, faceCount: faces.length, maxHeight, minHeight, rects };
}
