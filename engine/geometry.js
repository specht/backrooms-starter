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

// Wo eine Statue nah an einer Fläche steht, wirft sie feine Schatten, die
// das normale Raster der Lichtkarte nicht fassen kann. Dort bekommt die
// Fläche zusätzlich ein Detailstück Lichtkarte mit bis zu FINE-mal so vielen
// Punkten, über den Umriss der Statue (plus MARGIN). Die Fläche bleibt ganz;
// das Detailstück wird darüber gemischt und blendet am Rand über FADE Meter
// aus: kein Sprung, keine Naht. Mehrere Statuen an einer Fläche teilen sich
// ein Stück, höchstens DETAIL_BUDGET Punkte groß (sonst gröber). Gezeichnet
// wird so schnell wie vorher, nur das Backen hat ein paar Punkte mehr.
const FINE = 4;
const MARGIN = 0.6;   // Meter um die Statue: so weit reichen ihre weichen Schatten
const FADE = 0.3;
const DETAIL_BUDGET = 400000;

function addDetail(faces, boxes) {
    if (boxes.length === 0) return faces;
    const sub = (a, b) => a.map((v, i) => v - b[i]);
    const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
    const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    const extra = [];
    for (const face of faces) {
        if ((face.subdivide ?? 1) > 1) continue;
        const [c0, c1, c2, c3] = face.corners;
        const e1 = sub(c1, c0), e3 = sub(c3, c0);
        let s0 = 1, s1 = 0, t0 = 1, t1 = 0;
        for (const box of boxes) {
            const lo = [box.min.x - MARGIN, box.min.y - MARGIN, box.min.z - MARGIN];
            const hi = [box.max.x + MARGIN, box.max.y + MARGIN, box.max.z + MARGIN];
            const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]]);
            // liegt die Ebene der Fläche im erweiterten Kasten der Statue?
            const sides = corners.map((p) => dot(sub(p, c0), face.normal));
            if (Math.min(...sides) > 0 || Math.max(...sides) < 0) continue;
            // der Kasten in Koordinaten der Fläche: s entlang c0 -> c1, t entlang c0 -> c3
            const ss = corners.map((p) => dot(sub(p, c0), e1) / dot(e1, e1));
            const ts = corners.map((p) => dot(sub(p, c0), e3) / dot(e3, e3));
            const a = Math.max(0, Math.min(...ss)), b = Math.min(1, Math.max(...ss));
            const c = Math.max(0, Math.min(...ts)), d = Math.min(1, Math.max(...ts));
            if (b - a < 1e-3 || d - c < 1e-3) continue;
            s0 = Math.min(s0, a); s1 = Math.max(s1, b); t0 = Math.min(t0, c); t1 = Math.max(t1, d);
        }
        if (s1 <= s0 || t1 <= t0) continue;
        const coarse = face.w * (s1 - s0) * face.h * (t1 - t0);
        const factor = Math.min(FINE, Math.sqrt(DETAIL_BUDGET / Math.max(coarse, 1)));
        if (factor < 1.5) continue;
        const at = (s, t) => lerp(lerp(c0, c1, s), lerp(c3, c2, s), t);
        const detail = {
            ...face, detailOnly: true, density: factor,
            corners: [at(s0, t0), at(s1, t0), at(s1, t1), at(s0, t1)],
            w: Math.max(2, Math.round(face.w * (s1 - s0) * factor)), h: Math.max(2, Math.round(face.h * (t1 - t0) * factor)),
        };
        // wie weit das Ausblenden in Koordinaten der Fläche reicht; wo das
        // Stück an den Rand der Fläche stößt, blendet es nicht aus
        const lengthS = Math.sqrt(dot(e1, e1)), lengthT = Math.sqrt(dot(e3, e3));
        const fade = (length, from, to) => Math.min(FADE / Math.max(length, 1e-6), (to - from) / 2);
        face.detail = {
            target: detail, s0, s1, t0, t1,
            fadeS: [s0 > 1e-3 ? fade(lengthS, s0, s1) : 0, s1 < 1 - 1e-3 ? fade(lengthS, s0, s1) : 0],
            fadeT: [t0 > 1e-3 ? fade(lengthT, t0, t1) : 0, t1 < 1 - 1e-3 ? fade(lengthT, t0, t1) : 0],
        };
        extra.push(detail);
    }
    return faces.concat(extra);
}

// statueBoxes: der Kasten um jede Statue, für feinere Lichtkarte in ihrer Nähe
const SLAB_COLOR = '#8e8a80';   // die Decke zwischen zwei Räumen übereinander, am Rand eines Lochs

export function buildGeometry(level, statueBoxes = []) {
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
    // Der Boden einer Tür kann verdreht sein (an jeder Kante so schräg wie der
    // Raum dahinter): gezeichnet als feines Gitter, damit er genau auf der
    // Fläche liegt, mit der Strahlen und Füße rechnen
    const DOOR_GRID = 16;   // je Stück unter einem Grad Knick: Für Kanten zählt erst mehr (EDGE_ANGLE)

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
        const mine = (x, z) => kinds.includes(at(x, z, k)) && roomOf(x, z, k) === room && !(forCeiling && level.ceilingOpen(x, z, k));
        const inRoom = (x, z) => mine(x, z) && !used.has(z * width + x) && !door(x, z);
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
    for (let k = 0; k < layers; k++) {
        for (let z = 0; z < depth; z++) {
            for (let x = 0; x < width; x++) {
                if (at(x, z, k) !== 'floor') continue;
                const room = roomOf(x, z, k);
                const h = level.ceilingOfCell(x, z, k);   // unter einem Loch: bis an die Decke darüber
                const f = (cx, cz) => floorAt(cx, cz, room);
                // [Nachbar, Richtung, Linie, Stelle entlang der Linie]
                const edges = [
                    [x, z - 1, 'north', z, x],
                    [x, z + 1, 'south', z + 1, x],
                    [x - 1, z, 'west', x, z],
                    [x + 1, z, 'east', x + 1, z],
                ];
                for (const [nx, nz, direction, line, along] of edges) {
                    // derselbe Raum in derselben Schicht: keine Wand, außer am Rand des
                    // Schachts unter einem Loch (er reicht höher als der Nachbar)
                    if (at(nx, nz, k) === 'floor' && roomOf(nx, nz, k) === room &&
                        level.ceilingOpen(x, z, k) === level.ceilingOpen(nx, nz, k)) continue;
                    const [a, b] = wallEnds(direction, line, along, along + 1);
                    const bottom = [f(a[0], a[1]), f(b[0], b[1])], top = [h(a[0], a[1]), h(b[0], b[1])];
                    // Luft dahinter, die mit der eigenen überlappt
                    const open = level.slabs(nx, nz).map((slab) => {
                        const top = level.ceilingOfCell(nx, nz, slab.layer);
                        return {
                            floor: [floorAt(a[0], a[1], slab.room), floorAt(b[0], b[1], slab.room)],
                            ceiling: [top(a[0], a[1]), top(b[0], b[1])],
                        };
                    }).filter((o) => o.ceiling[0] > bottom[0] + 0.01 || o.ceiling[1] > bottom[1] + 0.01)
                        .filter((o) => o.floor[0] < top[0] - 0.01 || o.floor[1] < top[1] - 0.01);
                    if (!open.length && !level.ceilingOpen(x, z, k)) {
                        // eine ganze Wand: Stücke auf einer Linie werden unten zusammengelegt
                        // (nicht am Schacht unter einem Loch: die reicht bis an die Decke darüber)
                        const key = `${room}:${direction}:${line}`;
                        if (!pieces.has(key)) pieces.set(key, { room, direction, line, list: [] });
                        pieces.get(key).list.push(along);
                        continue;
                    }
                    // Durchgang zu einem Raum mit anderem Boden oder anderer Decke:
                    // eine Stufe darunter, ein Stück Wand darüber, und dazwischen
                    // eine Decke zwischen zwei Räumen übereinander
                    for (const [low, high, slab] of gaps(bottom, top, open)) {
                        const corners = [[a[0] * cell, low[0], a[1] * cell], [b[0] * cell, low[1], b[1] * cell],
                            [b[0] * cell, high[1], b[1] * cell], [a[0] * cell, high[0], a[1] * cell]];
                        const w = texels(cell), h = texels(Math.max(high[0] - low[0], high[1] - low[1], 0.2));
                        // die Decke zwischen zwei Räumen: roher Beton, keine Tapete
                        const normal = faceNormal(corners);
                        if (slab && normal.some((v) => v !== 0)) faces.push({ kind: 'block', color: SLAB_COLOR, material: 'plain', room, corners, normal, w, h });
                        else if (!slab) add('wall', room, corners, w, h);
                    }
                }
            }
        }
    }
    for (const { room, direction, line, list } of pieces.values()) {
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
            const board = level.rooms[room].settings.baseboard;
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
                    const probe = (side) => at(Math.floor(p[0] + out[0] * 0.5 + n[0] * 0.5 * side), Math.floor(p[1] + out[1] * 0.5 + n[2] * 0.5 * side), layer);
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

    // Blöcke: mitten auf ihrem Feld, oben und vier Seiten, unten nur, wenn sie schweben
    for (const block of level.things.filter((t) => t.type === 'block')) {
        const [w, h, d] = block.size;
        const cx = (block.x + 0.5) * cell + block.offset[0], cz = (block.z + 0.5) * cell + block.offset[2];
        const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
        const y0 = block.floor + block.base + block.offset[1], y1 = y0 + h;   // auf dem Boden seines Felds (oder höher)
        const room = block.room;
        const put = (corners, sw, sh) => faces.push({ kind: 'block', color: block.color, material: block.material, room, corners, normal: faceNormal(corners), w: texels(sw), h: texels(sh) });
        put([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], w, d);                 // oben
        if (block.base > 0.001) put([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], w, d); // unten
        put([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], w, h);                 // nach -z
        put([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], w, h);                 // nach +z
        put([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], d, h);                 // nach -x
        put([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], d, h);                 // nach +x
    }

    faces = addDetail(faces, statueBoxes);
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
            const world = (s, t) => lerp(lerp(c0, c1, s), lerp(c3, c2, s), t);
            const min = [0, 1, 2].map((i) => Math.min(c0[i], c1[i], c2[i], c3[i]));
            const max = [0, 1, 2].map((i) => Math.max(c0[i], c1[i], c2[i], c3[i]));
            const n = face.subdivide ?? 1;

            // Backen: die Fläche in ihr Rechteck der Lichtkarte, um einen Texel
            // größer (der Rand); die Stelle in der Welt wird dabei über die
            // Fläche hinaus verlängert und im Shader wieder auf sie geklemmt.
            // Ein Detailstück wirft kein Licht zurück (Albedo -1): Das tut die
            // Fläche darunter schon.
            const tu = -(GUTTER / atlasSize) / du, tv = -(GUTTER / atlasSize) / dv;
            const edge = (value, outside) => (value === 0 ? outside : value === 1 ? 1 - outside : value);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    const quad = [[i / n, j / n], [(i + 1) / n, j / n], [(i + 1) / n, (j + 1) / n], [i / n, (j + 1) / n]];
                    const normal = n > 1 ? faceNormal(quad.map(([s, t]) => world(s, t))) : face.normal;
                    for (const [s, t] of quad) {
                        const bs = edge(s, tu), bt = edge(t, tv);
                        bakePositions.push(u0 + bs * du, v0 + bt * dv, 0);
                        bakeWorld.push(...world(bs, bt));
                        bakeNormal.push(...normal);
                        bakeMin.push(...min);
                        bakeMax.push(...max);
                        bakeAmbient.push(ambient);
                        if (face.detailOnly) bakeAlbedo.push(-1, -1, -1);
                        else bakeAlbedo.push(albedo.r, albedo.g, albedo.b);
                        bakeDensity.push(face.density ?? 1);
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
            if (n > 1) cutsS = cutsT = [...Array(n + 1).keys()].map((k) => k / n);
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
                    const normal = n > 1 ? faceNormal(points) : face.normal;
                    quad.forEach(([s, t], k) => {
                        positions.push(...points[k]);
                        normals.push(...normal);
                        uvs.push(...along(points[k]));
                        uv1s.push(u0 + s * du, v0 + t * dv);
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
    return { meshes, atlasSize, faceCount: faces.length, maxHeight, minHeight };
}
