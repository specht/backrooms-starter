// Liest ein Level: level.ini sagt, wie es heißt und in welchem Raum du
// anfängst. Jeder Raum steht in einer eigenen Datei rooms/NAME.room, mit
// seinem Grundriss in [map] und für jeden Buchstaben und jede Ziffer darin
// einem Abschnitt, der sagt, was sie sind.
//
//   #  Wand          .  Boden          @  hier startest du (nur einmal im Level)
//   Leerzeichen: nichts, außerhalb des Raums
//   ein Buchstabe: eine Leuchte, ein Block, eine Statue oder Wasser, erklärt in [Buchstabe]
//   eine Ziffer: eine Tür zu einem anderen Raum, erklärt in [Ziffer]
//
// Eine Tür ist ein Feld, das zwei Räumen gehört: [1] mit door = flur 2
// heißt »dieses Feld 1 ist dasselbe Feld wie die 2 im Raum flur«. Es reicht,
// wenn einer der beiden Räume die Tür beschreibt. So werden die Räume
// aneinandergelegt, und alle zusammen sind ein Bauwerk.

const LEVEL_DEFAULTS = {
    name: 'Level 0',
    start: 'start',
    cell: 1.0,            // Meter pro Zeichen
    detail: 16,           // Lichtkarte: Punkte pro Meter (mehr: schärfere Schatten, mehr Speicher)
    bounces: 3,           // wie oft das Licht von Flächen zurückgeworfen wird (0 bis 5)
    ambient: 0,           // Licht von überall (0 bis 1); meist unnötig, das Bounce-Licht macht es echt
    vhs: 'off',           // on: wie von einer alten Videokassette, mit Datum und Uhrzeit (Taste C)
    aberration: 'off',    // on: farbige Säume zum Rand hin, wie durch eine einfache Linse (Taste X)
};

const ROOM_DEFAULTS = {
    height: 2.7,          // Deckenhöhe über dem Boden in Metern; zwei Zahlen für eine schräge Decke
    slope: 'flat',        // flat, north, east, south, west oder gable (Satteldach)
    ramp: null,           // ein schräger Boden: Richtung und wie viele Meter er ansteigt, zum Beispiel east, 3
    wallpaper: '#c9b458', // Tapete
    carpet: '#8c7a45',    // Teppich
    ceiling: '#d8d0a8',   // Deckenplatten
    walls: 'wallpaper',   // Wände: wallpaper, marble, wood (Holz), tiles (Fliesen), velvet (Samt) oder plain (einfarbig), in der Farbe von wallpaper
    floor: 'carpet',      // Boden: carpet, marble, wood, tiles oder plain, in der Farbe von carpet
    baseboard: 'auto',    // Sockelleiste: höhe, farbe, zum Beispiel 0.08, #5a4626; ohne: 8 cm, dunkler als die Wand; none: keine
    ambient: null,        // Umgebungslicht nur in diesem Raum, sonst das aus level.ini
    look: null,           // wohin du am @ schaust: north, east, south, west oder Grad (0 = Norden, 90 = Osten)
};

const HEADINGS = { north: 0, east: 90, south: 180, west: 270 };

// Die Farbe einer Sockelleiste ohne eigene Farbe: etwas dunkler als die
// Tapete (65 %), an Marmor ein dunkler Stein
function darker(settings) {
    if (settings.walls === 'marble') return '#6e675b';
    const hex = /^#([0-9a-f]{6})$/i.exec(String(settings.wallpaper));
    if (!hex) return '#86763c';
    const value = parseInt(hex[1], 16);
    const half = [16, 8, 0].map((shift) => Math.round(((value >> shift) & 255) * 0.65));
    return '#' + half.map((c) => c.toString(16).padStart(2, '0')).join('');
}

const LIGHT_DEFAULTS = {
    color: '#fff3cf',
    power: 1.0,
    size: [0.85, 0.85],   // Breite und Länge der Leuchte in Metern; eine Zahl: quadratisch
    flicker: 0,           // 0: ruhig, 1: flackert
};

// Woraus ein Block sein kann (material = …): dieselben Arten wie Wände
const BLOCK_MATERIALS = ['wallpaper', 'marble', 'wood', 'tiles', 'velvet', 'plain'];

const BLOCK_DEFAULTS = {
    base: 0,              // Unterkante über dem Boden, in Metern
    color: null,          // ohne Farbe: mit der Tapete des Raums
    material: null,       // ohne: wie die Wände des Raums, mit color einfarbig
};

const MODEL_DEFAULTS = {
    height: 2.0,
    rotation: 0,
};

const POOL_DEFAULTS = {
    water: 0.15,          // so tief unter dem Boden liegt das Wasser, in Metern; off: ein leeres Becken
    railing: 'off',       // on: ein Geländer aus Metall rundherum, wo man am Rand steht
    color: '#bcd8da',     // die Fliesen des Beckens
    tint: '#bff0f3',      // die Farbe des Wassers: So sieht Weiß hinter 2 m Wasser aus
};

const SLOPES = ['flat', 'north', 'east', 'south', 'west', 'gable'];
const MAX_LAYERS = 8;     // so viele Räume dürfen übereinander liegen
const STEP = 0.45;        // so hoch reicht ein Schritt: ein Boden bis hier über den Füßen trägt noch
const RAMPS = ['north', 'east', 'south', 'west'];

export class LevelError extends Error {
    constructor(file, line, message) {
        super(`${file}${line ? `, line ${line}` : ''}: ${message}`);
    }
}

function parseValue(text) {
    // Kommentar am Zeilenende: Leerzeichen, # und noch ein Leerzeichen. Eine
    // Farbe wie #5a4626 hat keins dahinter: 0.08, #5a4626 bleibt ganz.
    const value = text.replace(/\s+#(?=\s|$).*$/, '').trim();
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if (/^-?\d+(\.\d+)?(\s*,\s*-?\d+(\.\d+)?)+$/.test(value)) return value.split(',').map(Number);
    return value;
}

// Zerlegt eine Datei in Abschnitte. Im Abschnitt [map] zählt jedes Zeichen.
export function parseSections(source, file) {
    const sections = [];
    let current = null;
    source.replace(/\r/g, '').split('\n').forEach((raw, index) => {
        const line = index + 1;
        const header = raw.match(/^\s*\[([^\]]+)\]\s*$/);
        if (header) {
            current = { name: header[1].trim(), line, entries: {}, rows: [] };
            sections.push(current);
            return;
        }
        const text = raw.trim();
        if (!current) {
            if (text === '' || text.startsWith('#') || text.startsWith(';')) return;
            throw new LevelError(file, line, 'nothing may come before the first section in square brackets.');
        }
        if (current.name === 'map') {
            current.rows.push({ text: raw.replace(/\s+$/, ''), line });
            return;
        }
        if (text === '' || text.startsWith('#') || text.startsWith(';')) return;
        const pair = text.match(/^([a-z_]+)\s*=\s*(.*)$/);
        if (!pair) throw new LevelError(file, line, `I don't understand »${text}«. Expected: name = value`);
        current.entries[pair[1]] = { value: parseValue(pair[2]), line };
    });
    return sections;
}

function values(section) {
    return Object.fromEntries(Object.entries(section?.entries ?? {}).map(([key, { value }]) => [key, value]));
}

// Ein Raum: sein Grundriss, seine Leuchten, Statuen und Türen, noch ohne Lage
function parseRoom(id, source) {
    const file = `rooms/${id}.room`;
    const sections = parseSections(source, file);
    const settings = { ...ROOM_DEFAULTS, ...values(sections.find((s) => s.name === 'room')) };
    const heights = [settings.height].flat();
    if (heights.some((h) => !(h > 0.5 && h < 50))) throw new LevelError(file, null, `height = ${settings.height}: a ceiling is between 0.5 and 50 metres high.`);
    if (!['wallpaper', 'marble', 'wood', 'tiles', 'velvet', 'plain'].includes(settings.walls)) throw new LevelError(file, null, `walls = ${settings.walls} does not exist. Possible: wallpaper, marble, wood, tiles, velvet, plain.`);
    if (!['carpet', 'marble', 'wood', 'tiles', 'plain'].includes(settings.floor)) throw new LevelError(file, null, `floor = ${settings.floor} does not exist. Possible: carpet, marble, wood, tiles, plain.`);
    if (settings.baseboard === 'none') {
        settings.baseboard = null;
    } else {
        const given = settings.baseboard === 'auto' ? [] : String(settings.baseboard).split(',').map((part) => part.trim());
        const [height = 0.08, color = darker(settings)] = given;
        const h = Number(height);
        if (!(h > 0.01 && h < 1)) throw new LevelError(file, null, `baseboard = ${settings.baseboard}: expected a height in metres (0.01 to 1) and a colour, for example baseboard = 0.08, #b29a52.`);
        settings.baseboard = { height: h, color };
    }
    if (!SLOPES.includes(settings.slope)) throw new LevelError(file, null, `slope = ${settings.slope} does not exist. Possible: ${SLOPES.join(', ')}.`);
    if (settings.slope !== 'flat' && heights.length !== 2) throw new LevelError(file, null, 'a sloped ceiling needs two heights: height = low, high');
    if (settings.ramp !== null && settings.ramp !== undefined) {
        const [direction, rise] = String(settings.ramp).split(',').map((part) => part.trim());
        if (!RAMPS.includes(direction) || !(Math.abs(Number(rise)) <= 50)) {
            throw new LevelError(file, null, `ramp = ${settings.ramp}: expected a direction (${RAMPS.join(', ')}) and how many metres the floor rises that way, for example ramp = east, 3.`);
        }
        settings.ramp = { direction, rise: Number(rise) };
    }

    const map = sections.find((s) => s.name === 'map');
    if (!map) throw new LevelError(file, null, 'the floor plan is missing: a section [map].');
    const rows = map.rows.slice();
    while (rows.length && rows[0].text.trim() === '') rows.shift();
    while (rows.length && rows[rows.length - 1].text.trim() === '') rows.pop();
    if (rows.length === 0) throw new LevelError(file, map.line, 'the floor plan in [map] is empty.');

    const legend = {};
    for (const section of sections) if (/^[A-Za-z0-9]$/.test(section.name)) legend[section.name] = section;

    const width = Math.max(...rows.map((row) => row.text.length));
    const depth = rows.length;
    const cells = [];
    const things = [];
    const doors = {};      // Ziffer -> Tür: ihr erstes Feld (x, z) und alle Felder (cells)
    const links = [];      // door = raum ziffer
    // Löcher: _ im Boden (darunter liegt ein anderer Raum), ^ in der Decke
    // (darüber einer). Beide dürfen viele Felder groß sein.
    const holes = { down: [], up: [] };
    let start = null;
    rows.forEach((row, z) => {
        for (let x = 0; x < width; x++) {
            const char = row.text[x] ?? ' ';
            let kind = 'floor';
            if (char === '#') kind = 'wall';
            else if (char === ' ') kind = 'void';
            else if (char === '_') { kind = 'hole'; holes.down.push({ x, z }); }
            else if (char === '^') holes.up.push({ x, z });
            else if (char === '@') start = { x, z, line: row.line };
            else if (/[0-9]/.test(char)) {
                // Dieselbe Ziffer mehrmals in einer Reihe: eine breitere Tür
                const door = doors[char];
                if (!door) {
                    doors[char] = { x, z, line: row.line, cells: [{ x, z }] };
                } else {
                    const last = door.cells[door.cells.length - 1];
                    const across = last.z === z && x === last.x + 1 && door.cells.every((c) => c.z === z);
                    const down = last.x === x && z === last.z + 1 && door.cells.every((c) => c.x === x);
                    if (!across && !down) throw new LevelError(file, row.line, `door ${char} appears twice, apart. A wide door is the same digit side by side (111) or one below the other; every other door gets its own digit.`);
                    door.cells.push({ x, z });
                }
            } else if (/[A-Za-z]/.test(char)) {
                const entry = legend[char];
                if (!entry) throw new LevelError(file, row.line, `${char} is in the floor plan, but there is no section [${char}] saying what it is.`);
                const thing = makeThing(file, char, entry, x, z);
                things.push(thing);
                // pedestal = breite, höhe, tiefe: ein Sockel unter der Statue, im selben Feld
                if (thing.type === 'model' && thing.pedestal !== undefined) {
                    const size = [thing.pedestal].flat();
                    if (size.length !== 3) throw new LevelError(file, entry.line, `pedestal = ${thing.pedestal}: expected width, height, depth in metres.`);
                    const material = thing.pedestal_material ?? null;
                    if (material !== null && !BLOCK_MATERIALS.includes(material)) throw new LevelError(file, entry.line, `pedestal_material = ${material} does not exist. Possible: ${BLOCK_MATERIALS.join(', ')}.`);
                    things.push({ type: 'block', char, x, z, base: 0, color: thing.pedestal_color ?? null, material, size, offset: thing.offset });
                    thing.base = size[1];
                }
            } else if (char !== '.') {
                throw new LevelError(file, row.line, `the character »${char}« can't be used in a floor plan. Allowed: # . @ _ ^ space, letters and digits.`);
            }
            cells.push(kind);
        }
    });
    for (const [char, section] of Object.entries(legend)) {
        if (!/[0-9]/.test(char)) continue;
        const door = values(section).door;
        if (door === undefined) throw new LevelError(file, section.line, `[${char}] is a door and needs door = room digit.`);
        // door = flur 2, -4: der Boden dort liegt 4 m tiefer (eine Tür hoch in der Wand)
        const match = String(door).match(/^([a-z0-9_-]+)\s+([0-9])(?:\s*,\s*(-?\d+(?:\.\d+)?))?$/i);
        if (!match) throw new LevelError(file, section.line, `door = ${door}: expected the name of a room and a digit, for example door = flur 2 (or door = halle 1, -4 when the floor there lies 4 m lower).`);
        if (!doors[char]) throw new LevelError(file, section.line, `[${char}] describes a door, but there is no ${char} in the floor plan.`);
        links.push({ from: char, room: match[1], to: match[2], rise: Number(match[3] ?? 0), line: section.line });
    }
    // [_] below = raum: der Raum unter dem Loch im Boden; sein ^ liegt genau
    // darunter, seine Decke um slab (Meter, die Dicke der Decke) unter
    // diesem Boden
    let below = null;
    const holeSection = sections.find((section) => section.name === '_');
    if (holes.down.length) {
        const entries = values(holeSection);
        if (!holeSection || entries.below === undefined) throw new LevelError(file, holeSection?.line ?? null, 'the floor plan has a hole in the floor (_): say in [_] which room lies below it, for example below = keller.');
        const slab = entries.slab ?? 0.3;
        if (!(slab >= 0 && slab <= 20)) throw new LevelError(file, holeSection.line, `slab = ${entries.slab}: the floor between the two rooms is 0 to 20 metres thick.`);
        below = { room: String(entries.below), slab, line: holeSection.line };
        links.push({ hole: true, room: below.room, line: holeSection.line });
    } else if (holeSection) {
        throw new LevelError(file, holeSection.line, '[_] describes a hole in the floor, but there is no _ in the floor plan.');
    }
    const pool = things.find((thing) => thing.type === 'pool');
    if (pool && settings.ramp) throw new LevelError(file, legend[pool.char].line, 'a pool needs a level floor: a room with a pool can\'t have a ramp.');
    return { id, file, settings, heights, width, depth, cells, things, doors, links, start, holes, below };
}

// offset = x, y, z: ein Ding um so viele Meter aus der Mitte seines Felds
// geschoben, wie in three.js: x nach Osten (im Grundriss nach rechts),
// y nach oben, z nach Süden (im Grundriss nach unten)
function offsetOf(file, section, entries) {
    if (entries.offset === undefined) return [0, 0, 0];
    const offset = [entries.offset].flat();
    if (offset.length !== 3 || offset.some((v) => typeof v !== 'number' || Math.abs(v) > 50)) {
        throw new LevelError(file, section.line, `offset = ${entries.offset}: expected x, y, z in metres: x east, y up, z south (negative: west, down, north), for example offset = 0, 1.8, -0.4.`);
    }
    return offset;
}

function makeThing(file, char, section, x, z) {
    const entries = values(section);
    if (entries.model !== undefined) {
        const model = { type: 'model', char, x, z, ...MODEL_DEFAULTS, ...entries, offset: offsetOf(file, section, entries) };
        // light = Farbe beim Modell: Es ist eine Lampe (eine Wandlampe, eine
        // Stehlampe). Ihr Licht kommt aus ihren leuchtenden Teilen.
        if (entries.light !== undefined) {
            if (!/^#[0-9a-f]{6}$/i.test(String(entries.light))) throw new LevelError(file, section.line, `light = ${entries.light}: expected a colour such as #ffd9a0.`);
            model.glow = { color: String(entries.light), power: entries.power ?? 1, flicker: entries.flicker ?? 0, beam: null };
            // beam = 70: unter einem Schirm, das Licht fällt in einem Kegel nach
            // unten, so weit (Grad, von senkrecht gemessen); beam = up, 60 nach oben
            if (entries.beam !== undefined) {
                const parts = String(entries.beam).split(',').map((part) => part.trim());
                const [direction, angle] = parts.length === 2 ? parts : ['down', parts[0]];
                const degrees = Number(angle);
                if (!['down', 'up'].includes(direction) || !(degrees > 0 && degrees <= 90)) {
                    throw new LevelError(file, section.line, `beam = ${entries.beam}: expected an angle from 1 to 90 degrees, for example beam = 70 (downwards) or beam = up, 60.`);
                }
                model.glow.beam = { up: direction === 'up', angle: degrees };
            }
        }
        return model;
    }
    if (entries.light !== undefined) {
        const light = { ...LIGHT_DEFAULTS, ...entries };
        if (typeof light.light === 'string' && light.light.startsWith('#')) light.color = light.light;
        const size = [light.size].flat();
        if (size.length === 1) size.push(size[0]);
        if (size.length !== 2 || size.some((v) => !(v > 0) || v > 20)) throw new LevelError(file, section.line, `size = ${light.size}: expected one number (a square lamp) or width, length in metres.`);
        light.size = size;
        return { type: 'light', char, x, z, ...light };
    }
    if (entries.block !== undefined) {
        // block = höhe (ein ganzes Feld) oder block = breite, höhe, tiefe
        const size = [entries.block].flat();
        const [w, h, d] = size.length === 1 ? [1, size[0], 1] : size;
        if (size.length !== 1 && size.length !== 3) throw new LevelError(file, section.line, `block = ${entries.block}: expected a height, or width, height, depth in metres.`);
        if ([w, h, d].some((v) => !(v > 0) || v > 50)) throw new LevelError(file, section.line, `block = ${entries.block}: every size is between 0 and 50 metres.`);
        const block = { type: 'block', char, x, z, ...BLOCK_DEFAULTS, ...entries, size: [w, h, d], offset: offsetOf(file, section, entries) };
        if (block.material !== null && !BLOCK_MATERIALS.includes(block.material)) throw new LevelError(file, section.line, `material = ${block.material} does not exist. Possible: ${BLOCK_MATERIALS.join(', ')}.`);
        return block;
    }
    if (entries.pool !== undefined) {
        // pool = tiefe: ein Becken, so tief unter dem Boden (in Metern);
        // water = so tief unter dem Boden steht das Wasser darin. Jedes Feld
        // mit diesem Buchstaben gehört dazu.
        const pool = { type: 'pool', char, x, z, ...POOL_DEFAULTS, ...entries, depth: entries.pool };
        if (!(typeof pool.depth === 'number' && pool.depth >= 0.2 && pool.depth <= 20)) throw new LevelError(file, section.line, `pool = ${entries.pool}: expected how deep the pool goes below the floor, 0.2 to 20 metres, for example pool = 2.`);
        if (String(pool.water) === 'off') pool.water = null;
        else if (!(typeof pool.water === 'number' && pool.water >= 0 && pool.water < pool.depth - 0.05)) {
            throw new LevelError(file, section.line, `water = ${pool.water}: expected how far below the floor the water lies, from 0 to less than the depth of the pool (${pool.depth} m), or off for an empty pool.`);
        }
        if (!['on', 'off'].includes(String(pool.railing))) throw new LevelError(file, section.line, `railing = ${pool.railing}: expected on or off.`);
        if (!/^#[0-9a-f]{6}$/i.test(String(pool.color))) throw new LevelError(file, section.line, `color = ${pool.color}: expected a colour for the tiles of the pool, such as #bcd8da.`);
        if (!/^#[0-9a-f]{6}$/i.test(String(pool.tint))) throw new LevelError(file, section.line, `tint = ${pool.tint}: expected the colour of the water, such as #bff0f3 (clear) or #6f8f5a (murky).`);
        pool.railing = String(pool.railing) === 'on';
        return pool;
    }
    throw new LevelError(file, section.line, `[${char}] needs light = ... (a lamp), block = ... (a block), model = ... (a statue) or pool = ... (a pool).`);
}

// Wie hoch die Decke eines Raums an einer Stelle ist (x, z in Feldern des Raums)
// Wie hoch der Boden eines Raums an einer Stelle liegt, über seiner tiefsten
// Stelle (x, z in Feldern des Raums). Eine Rampe steigt vom ersten Feld hinter
// der Wand bis zum letzten vor der gegenüberliegenden; die Felder in den
// Wänden (Türen) bleiben eben, damit der Boden dort genau auf den des
// Nachbarraums trifft.
function floorFunction(room) {
    const ramp = room.settings.ramp;
    if (!ramp) return () => 0;
    const { width, depth } = room;
    const along = (t, n) => ramp.rise * Math.min(1, Math.max(0, (t - 1) / Math.max(1, n - 2)));
    switch (ramp.direction) {
    case 'east': return (x) => along(x, width);
    case 'west': return (x) => along(width - x, width);
    case 'south': return (x, z) => along(z, depth);
    default: return (x, z) => along(depth - z, depth);
    }
}

function ceilingFunction(room) {
    const [low, high = low] = room.heights;
    const { width, depth } = room;
    switch (room.settings.slope) {
    case 'east': return (x) => low + (high - low) * (x / width);
    case 'west': return (x) => low + (high - low) * (1 - x / width);
    case 'south': return (x, z) => low + (high - low) * (z / depth);
    case 'north': return (x, z) => low + (high - low) * (1 - z / depth);
    case 'gable': return width >= depth
        ? (x, z) => low + (high - low) * (1 - Math.abs(z - depth / 2) / (depth / 2))
        : (x) => low + (high - low) * (1 - Math.abs(x - width / 2) / (width / 2));
    default: return () => low;
    }
}

// Lädt level.ini und alle Räume, die über Türen erreichbar sind, und legt
// sie zu einem Bauwerk zusammen.
export async function loadLevel(levelFile, fetchText) {
    const sections = parseSections(await fetchText(levelFile), levelFile);
    const settings = { ...LEVEL_DEFAULTS, ...values(sections.find((s) => s.name === 'level')) };
    const base = levelFile.replace(/[^/]*$/, '');

    const rooms = new Map();
    const queue = [String(settings.start)];
    while (queue.length) {
        const id = queue.shift();
        if (rooms.has(id)) continue;
        let source;
        try {
            source = await fetchText(`${base}rooms/${id}.room`);
        } catch (error) {
            throw new LevelError(`rooms/${id}.room`, null, `this file does not exist (${error.message}). It is needed because a door or start = in level.ini points to ${id}.`);
        }
        const room = parseRoom(id, source);
        rooms.set(id, room);
        for (const link of room.links) queue.push(link.room);
    }

    // Türen in beide Richtungen sammeln: aus jeder Beschreibung zwei Kanten
    const edges = [];
    for (const room of rooms.values()) {
        for (const link of room.links) {
            const other = rooms.get(link.room);
            if (link.hole) {
                // ein Loch: oben das _ dieses Raums, unten das ^ des anderen, gleich geformt
                if (!other.holes.up.length) throw new LevelError(room.file, link.line, `below = ${link.room}: that room has no hole in its ceiling (^) under this one.`);
                const shape = (cells) => cells.map((c) => `${c.x - cells[0].x},${c.z - cells[0].z}`).join(' ');
                if (shape(room.holes.down) !== shape(other.holes.up)) throw new LevelError(room.file, link.line, `the hole in the floor (_) and the hole in the ceiling (^) of ${link.room} have different shapes: they need to be the same fields.`);
                edges.push({ a: room, b: other, hole: 'down', line: link.line });
                edges.push({ a: other, b: room, hole: 'up', line: link.line, back: room });
                continue;
            }
            if (!other.doors[link.to]) throw new LevelError(room.file, link.line, `room ${link.room} has no door ${link.to}.`);
            const [mine, theirs] = [room.doors[link.from], other.doors[link.to]];
            const shape = (door) => `${door.cells.length}${door.cells.length > 1 && door.cells[1].x === door.cells[0].x ? '|' : '-'}`;
            if (shape(mine) !== shape(theirs)) {
                throw new LevelError(room.file, link.line, `door ${link.from} is ${mine.cells.length} field${mine.cells.length > 1 ? 's' : ''} wide, door ${link.to} of ${link.room} ${theirs.cells.length}${theirs.cells.length > 1 && shape(theirs) !== shape(mine) && theirs.cells.length === mine.cells.length ? ' (the other way round)' : ''}: both sides of a door need the same width, in the same direction.`);
            }
            edges.push({ a: room, da: room.doors[link.from], b: other, db: other.doors[link.to], line: link.line, rise: link.rise });
            edges.push({ a: other, da: other.doors[link.to], b: room, db: room.doors[link.from], line: link.line, back: room, rise: -link.rise });
        }
    }

    // Jedes Loch in der Decke braucht einen Raum darüber, der es meint
    for (const room of rooms.values()) {
        if (room.holes.up.length && !edges.some((e) => e.a === room && e.hole === 'up')) {
            throw new LevelError(room.file, null, `the hole in the ceiling (^) leads nowhere: the room above needs _ in its floor plan and [_] below = ${room.id}.`);
        }
    }
    // Jede Tür braucht ein Gegenstück: sonst führte sie ins Nichts
    for (const room of rooms.values()) {
        for (const [char, door] of Object.entries(room.doors)) {
            if (!edges.some((e) => !e.hole && e.a === room && e.da === door)) {
                throw new LevelError(room.file, door.line, `door ${char} leads nowhere. Describe it with [${char}] and door = room digit, or let another room point to it.`);
            }
        }
    }

    // Räume aneinanderlegen, vom Startraum aus: Tür auf Tür
    const startRoom = rooms.get(String(settings.start));
    startRoom.offset = { x: 0, z: 0 };
    // Die Höhe jedes Raums: Auf einer Tür liegen beide Böden gleich hoch. Der
    // Startraum liegt bei 0, jeder andere Raum so, dass es an seiner Tür passt.
    for (const room of rooms.values()) {
        room.floorRelative = floorFunction(room);
        room.ceilingRelative = ceilingFunction(room);
    }
    startRoom.elevation = 0;
    const doorFloor = (room, door) => room.elevation + room.floorRelative(door.x + 0.5, door.z + 0.5);
    const placed = [startRoom];
    for (let i = 0; i < placed.length; i++) {
        const room = placed[i];
        for (const edge of edges.filter((e) => e.a === room)) {
            if (edge.hole) {
                // durch ein Loch: der Raum darunter (oder darüber), Feld auf Feld
                const upper = edge.hole === 'down' ? edge.a : edge.b, lower = edge.hole === 'down' ? edge.b : edge.a;
                const top = upper.holes.down[0], bottom = lower.holes.up[0];
                const slab = upper.below.slab;
                const floorAbove = (r) => r.elevation + r.floorRelative(top.x + 0.5, top.z + 0.5);
                const ceilingBelow = (r) => r.elevation + r.floorRelative(bottom.x + 0.5, bottom.z + 0.5) + r.ceilingRelative(bottom.x + 0.5, bottom.z + 0.5);
                const [mine, theirs] = edge.hole === 'down' ? [top, bottom] : [bottom, top];
                const x = room.offset.x + mine.x - theirs.x, z = room.offset.z + mine.z - theirs.z;
                if (!edge.b.offset) {
                    edge.b.offset = { x, z };
                    edge.b.elevation = edge.hole === 'down'
                        ? floorAbove(upper) - slab - lower.floorRelative(bottom.x + 0.5, bottom.z + 0.5) - lower.ceilingRelative(bottom.x + 0.5, bottom.z + 0.5)
                        : ceilingBelow(lower) + slab - upper.floorRelative(top.x + 0.5, top.z + 0.5);
                    placed.push(edge.b);
                } else if (edge.b.offset.x !== x || edge.b.offset.z !== z || Math.abs(floorAbove(upper) - slab - ceilingBelow(lower)) > 0.01) {
                    throw new LevelError(upper.file, edge.line, `the hole between ${upper.id} and ${lower.id} doesn't fit: doors or other holes already place the two rooms differently.`);
                }
                continue;
            }
            const x = room.offset.x + edge.da.x - edge.db.x;
            const z = room.offset.z + edge.da.z - edge.db.z;
            if (!edge.b.offset) {
                edge.b.offset = { x, z };
                edge.b.elevation = doorFloor(edge.a, edge.da) + edge.rise - edge.b.floorRelative(edge.db.x + 0.5, edge.db.z + 0.5);
                placed.push(edge.b);
            } else if (Math.abs(doorFloor(edge.a, edge.da) + edge.rise - doorFloor(edge.b, edge.db)) > 0.01) {
                const source = edge.back ?? edge.a;
                const wanted = edge.rise ? ` (with ${Math.abs(edge.rise)} m ${edge.rise > 0 ? 'up' : 'down'} to ${edge.b.id})` : '';
                throw new LevelError(source.file, edge.line, `this door doesn't fit: the floors of ${edge.a.id} and ${edge.b.id} are at different heights there (${doorFloor(edge.a, edge.da).toFixed(2)} m and ${doorFloor(edge.b, edge.db).toFixed(2)} m)${wanted}. Other doors or ramps already set them.`);
            } else if (edge.b.offset.x !== x || edge.b.offset.z !== z) {
                const source = edge.back ?? edge.a;
                throw new LevelError(source.file, edge.line, `this door doesn't fit: other doors already place the rooms ${edge.a.id} and ${edge.b.id} differently.`);
            }
        }
    }

    // Ein gemeinsames Raster für alle Räume, mit einem Feld Rand. Räume
    // können übereinander liegen: Das Raster hat dafür Schichten (layers),
    // jede ein ganzer Grundriss. Ein Raum kommt in die unterste Schicht, in
    // der er keinen anderen überdeckt; wo nichts übereinander liegt, gibt es
    // nur Schicht 0. Welcher Raum oben liegt, sagen die Höhen, nicht die
    // Nummer der Schicht.
    const minX = Math.min(...placed.map((r) => r.offset.x)) - 1;
    const minZ = Math.min(...placed.map((r) => r.offset.z)) - 1;
    const maxX = Math.max(...placed.map((r) => r.offset.x + r.width)) + 1;
    const maxZ = Math.max(...placed.map((r) => r.offset.z + r.depth)) + 1;
    const width = maxX - minX, depth = maxZ - minZ;
    const size = width * depth;
    const cells = [];                 // je Schicht width * depth Felder hintereinander
    const owner = [];                 // welcher Raum
    const addLayer = () => {
        for (let i = 0; i < size; i++) { cells.push('void'); owner.push(-1); }
    };
    addLayer();
    const roomList = [...placed];
    const doorPlaces = new Set();     // Felder mit einer Tür, in x und z (jede Schicht)
    roomList.forEach((room, index) => {
        room.index = index;
        // Boden und Decke, in Metern über dem Boden des Startraums: Die Decke
        // liegt height über dem Boden, so steigt sie mit einer Rampe mit.
        const above = room.ceilingRelative;
        room.floorAt = (x, z) => room.elevation + room.floorRelative(x, z);
        room.ceilingAt = (x, z) => room.floorAt(x, z) + above(x, z);
        room.ox = room.offset.x - minX;
        room.oz = room.offset.z - minZ;
        for (const door of Object.values(room.doors)) for (const c of door.cells) doorPlaces.add((room.oz + c.z) * width + room.ox + c.x);
    });
    // Passt der Raum in Schicht k? Wände dürfen sich teilen, Türen auch
    const fits = (room, k) => {
        for (let z = 0; z < room.depth; z++) {
            for (let x = 0; x < room.width; x++) {
                const kind = room.cells[z * room.width + x];
                if (kind === 'void') continue;
                const place = (room.oz + z) * width + room.ox + x;
                const here = cells[k * size + place];
                if (here === 'void') continue;
                if (here === 'wall' && kind === 'wall') continue;
                if (doorPlaces.has(place) && here === 'floor' && kind === 'floor') continue;
                return roomList[owner[k * size + place]];
            }
        }
        return null;
    };
    roomList.forEach((room) => {
        let k = 0;
        let other = fits(room, 0);
        while (other) {
            k += 1;
            if (k >= MAX_LAYERS) throw new LevelError(room.file, null, `room ${room.id} overlaps room ${other.id}, and there are already ${MAX_LAYERS} rooms on top of each other here.`);
            if (cells.length < (k + 1) * size) addLayer();
            other = fits(room, k);
        }
        room.layer = k;
        for (let z = 0; z < room.depth; z++) {
            for (let x = 0; x < room.width; x++) {
                const kind = room.cells[z * room.width + x];
                if (kind === 'void') continue;
                const at = k * size + (room.oz + z) * width + room.ox + x;
                if (cells[at] === 'void') { cells[at] = kind; owner[at] = room.index; }
            }
        }
    });
    const layers = cells.length / size;
    const index = (x, z, k = 0) => k * size + z * width + x;
    const kindAt = (x, z, k = 0) => (x < 0 || z < 0 || x >= width || z >= depth ? 'void' : cells[index(x, z, k)]);
    // Alle Böden an einem Feld, über alle Schichten: [{ layer, room }]
    const slabs = (x, z) => {
        const list = [];
        for (let k = 0; k < layers; k++) if (kindAt(x, z, k) === 'floor') list.push({ layer: k, room: owner[index(x, z, k)] });
        return list;
    };
    // Eine Tür zwischen zwei Räumen in verschiedenen Schichten liegt nur in
    // einer: Die andere sieht durch sie hindurch in den Nachbarraum (nur so
    // gibt es ihren Boden nicht doppelt)
    for (let place = 0; place < size; place++) {
        if (!doorPlaces.has(place)) continue;
        const floors = [];
        for (let k = 0; k < layers; k++) if (cells[k * size + place] === 'floor') floors.push(k);
        for (const k of floors.slice(1)) {
            const a = roomList[owner[floors[0] * size + place]], b = roomList[owner[k * size + place]];
            const gx = place % width, gz = Math.floor(place / width);
            const fa = a.floorAt(gx + 0.5 - a.ox, gz + 0.5 - a.oz), fb = b.floorAt(gx + 0.5 - b.ox, gz + 0.5 - b.oz);
            if (Math.abs(fa - fb) < 0.01) { cells[k * size + place] = 'void'; owner[k * size + place] = -1; }
        }
    }
    // Eine Tür hoch in der Wand (door = …, -4): Ihr Feld gehört dem oberen
    // Raum, sein Boden liegt dort; auf der unteren Seite ist darunter Wand
    const raisedDoorPlaces = new Set();
    for (const edge of edges) {
        if (edge.hole || !(edge.rise < 0)) continue;   // jede Tür einmal: von oben gesehen
        const high = edge.a, low = edge.b;
        for (const c of edge.da.cells) {
            const place = (high.oz + c.z) * width + high.ox + c.x;
            raisedDoorPlaces.add(place);
            if (high.layer === low.layer) owner[high.layer * size + place] = high.index;
            else { cells[low.layer * size + place] = 'void'; owner[low.layer * size + place] = -1; }
        }
    }
    const doorCells = new Set();
    for (let k = 0; k < layers; k++) for (const place of doorPlaces) if (cells[k * size + place] === 'floor') doorCells.add(k * size + place);

    // Unter einem Loch hat der untere Raum keine Decke: Dort reicht seine
    // Luft bis an die Decke des Raums darüber (ein Schacht durch beide)
    const openCeiling = new Map();   // Feld (mit Schicht) des unteren Raums -> Raum darüber
    for (const upper of roomList) {
        if (!upper.below) continue;
        const lower = rooms.get(upper.below.room);
        for (const c of upper.holes.down) {
            const at = index(upper.ox + c.x, upper.oz + c.z, lower.layer);
            if (cells[at] !== 'floor' || owner[at] !== lower.index) throw new LevelError(upper.file, upper.below.line, `under the hole (_) at column ${c.x + 1}, row ${c.z + 1} there is no floor of ${lower.id}.`);
            openCeiling.set(at, upper.index);
        }
        for (const thing of lower.things) {
            if (thing.type !== 'light' || !lower.holes.up.some((c) => c.x === thing.x && c.z === thing.z)) continue;
            throw new LevelError(lower.file, null, `the lamp ${thing.char} hangs under the hole in the ceiling (^): there is no ceiling there to hold it.`);
        }
    }
    // Die Decke über einem Feld der Schicht k, an einer Stelle (cx, cz in
    // Feldern des Bauwerks): unter einem Loch die des Raums darüber
    // (vor dem fertigen Level, beim Prüfen der Höhen, ohne die Böden der Türen)
    let built = null;
    const ceilingOfCell = (x, z, k) => {
        const room = roomList[openCeiling.get(index(x, z, k)) ?? owner[index(x, z, k)]];
        return (cx, cz) => (built ? built.ceilingAt(cx, cz, room.index) : room.ceilingAt(cx - room.ox, cz - room.oz));
    };

    // Becken: Felder, deren Boden um pool tiefer liegt als der ihres Raums;
    // das Wasser darin steht water unter dem Rand (surface: seine Höhe, null
    // ohne Wasser). Zusammenhängende Felder desselben Buchstabens sind ein Becken.
    const water = new Map();          // Feld (mit Schicht) -> Becken
    const pools = [];
    for (const room of roomList) {
        const cellsOf = new Map();
        for (const thing of room.things.filter((t) => t.type === 'pool')) {
            const at = index(room.ox + thing.x, room.oz + thing.z, room.layer);
            if (cells[at] !== 'floor' || owner[at] !== room.index) continue;
            cellsOf.set(at, thing);
        }
        for (const [first, thing] of cellsOf) {
            if (water.has(first)) continue;
            const pool = { room: room.index, layer: room.layer, char: thing.char, depth: thing.depth,
                surface: thing.water === null ? null : room.elevation - thing.water, bottom: room.elevation - thing.depth,
                railing: thing.railing, color: thing.color, tint: thing.tint, cells: [] };
            const todo = [first];
            water.set(first, pool);
            while (todo.length) {
                const at = todo.pop();
                const x = at % width, z = Math.floor((at % size) / width);
                pool.cells.push({ x, z });
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    if (x + dx < 0 || z + dz < 0 || x + dx >= width || z + dz >= depth) continue;
                    const next = index(x + dx, z + dz, room.layer);
                    if (water.has(next) || cellsOf.get(next)?.char !== thing.char) continue;
                    water.set(next, pool);
                    todo.push(next);
                }
            }
            pools.push(pool);
        }
    }
    // Wie tief der Boden eines Felds unter dem seines Raums liegt (ein Becken), sonst 0
    const sunk = (x, z, k) => {
        const pool = water.get(index(x, z, k));
        return pool ? roomList[pool.room].elevation - pool.bottom : 0;
    };

    // Übereinander heißt: Der obere Boden liegt nirgends unter der Decke des
    // unteren Raums (an allen vier Ecken eines Felds), auch nicht der Boden eines Beckens
    for (let z = 0; z < depth; z++) {
        for (let x = 0; x < width; x++) {
            const here = slabs(x, z);
            for (let i = 0; i < here.length; i++) {
                for (let j = i + 1; j < here.length; j++) {
                    const a = roomList[here[i].room], b = roomList[here[j].room];
                    const corners = [[x, z], [x + 1, z], [x, z + 1], [x + 1, z + 1]];
                    const top = (slab) => ceilingOfCell(x, z, slab.layer);
                    const apart = (lower, upper, lowerSlab, upperSlab) => corners.every(([cx, cz]) =>
                        upper.floorAt(cx - upper.ox, cz - upper.oz) - sunk(x, z, upperSlab.layer) >= top(lowerSlab)(cx, cz) - 0.001);
                    if (apart(a, b, here[i], here[j]) || apart(b, a, here[j], here[i])) continue;
                    if (sunk(x, z, here[i].layer) || sunk(x, z, here[j].layer)) {
                        const [upper, lower] = sunk(x, z, here[i].layer) ? [a, b] : [b, a];
                        throw new LevelError(upper.file, null, `the pool in room ${upper.id} reaches down into room ${lower.id} below it (column ${x - upper.ox + 1}, row ${z - upper.oz + 1}). Make the pool shallower or the room below lower.`);
                    }
                    throw new LevelError(b.file, null, `room ${b.id} and room ${a.id} lie in the same place at the same height (column ${x - b.ox + 1}, row ${z - b.oz + 1} of the floor plan of ${b.id}). Rooms on top of each other need the upper floor at or above the lower ceiling.`);
                }
            }
        }
    }

    // Leuchten, Statuen und der Start in Feldern des ganzen Bauwerks
    const things = [];
    let start = null;
    for (const room of roomList) {
        // floor: wie hoch der Boden unter einem Ding liegt, mitten auf seinem Feld
        for (const thing of room.things) {
            const [dx, , dz] = thing.offset ?? [0, 0, 0];
            things.push({ ...thing, x: thing.x + room.ox, z: thing.z + room.oz, room: room.index,
                floor: room.floorAt(thing.x + 0.5 + dx / settings.cell, thing.z + 0.5 + dz / settings.cell) });
        }
        if (room.start) {
            if (start) throw new LevelError(room.file, room.start.line, 'there is more than one @ in the level: you can only start in one place.');
            const look = room.settings.look;
            let heading = null;
            if (look !== null && look !== undefined) {
                heading = typeof look === 'number' ? look : HEADINGS[String(look).toLowerCase()];
                if (heading === undefined) throw new LevelError(room.file, null, `look = ${look}: allowed are north, east, south, west or a number in degrees.`);
            }
            start = { x: room.start.x + room.ox, z: room.start.z + room.oz, heading, layer: room.layer, room: room.index };
        }
    }
    if (!start) throw new LevelError(`rooms/${settings.start}.room`, null, 'the level has no @: where do you start?');

    // Eine Tür verbindet zwei Böden, die verschieden schräg sein können (ein
    // Raum mit Rampe quer zur Tür). Ihr Feld hat darum keine eigene Höhe:
    // An jeder Kante liegt es so hoch wie der Boden dahinter, dazwischen
    // läuft es gerade (bilinear). So bleibt keine Lücke und keine Stufe.
    // Der Boden dahinter: in welcher Schicht auch immer, der, der an der
    // Kante am nächsten an der Tür liegt.
    const doorCorners = new Map();   // Feld (mit Schicht) -> Höhe an den Ecken (x0z0, x1z0, x0z1, x1z1)
    for (const at of doorCells) {
        if (raisedDoorPlaces.has(at % size)) continue;   // eine hohe Tür bleibt eben, auf der Höhe des oberen Bodens
        const k = Math.floor(at / size), gx = at % width, gz = Math.floor((at % size) / width);
        const own = roomList[owner[at]];
        const corners = [[gx, gz], [gx + 1, gz], [gx, gz + 1], [gx + 1, gz + 1]];
        const mine = corners.map(([cx, cz]) => own.floorAt(cx - own.ox, cz - own.oz));
        const heights = [...mine];
        // [Nachbar, die beiden Ecken an der Kante zu ihm]
        for (const [dx, dz, edge] of [[-1, 0, [0, 2]], [1, 0, [1, 3]], [0, -1, [0, 1]], [0, 1, [2, 3]]]) {
            let best = null;
            for (const slab of slabs(gx + dx, gz + dz)) {
                if (doorCells.has(index(gx + dx, gz + dz, slab.layer))) continue;
                const room = roomList[slab.room];
                const gap = Math.max(...edge.map((c) => Math.abs(room.floorAt(corners[c][0] - room.ox, corners[c][1] - room.oz) - mine[c])));
                if (gap < 1.0 && (!best || gap < best.gap)) best = { room, gap };
            }
            if (!best) continue;
            for (const c of edge) heights[c] = best.room.floorAt(corners[c][0] - best.room.ox, corners[c][1] - best.room.oz);
        }
        // Nur wo es nötig ist: Liegen beide Böden so, dass der Raum der Tür
        // sie ohnehin trifft, bleibt sie ein Teil seines Bodens (ohne Naht)
        if (heights.some((h, c) => Math.abs(h - mine[c]) > 1e-3)) doorCorners.set(at, heights);
    }
    // Türen mit eigenem, verdrehtem Boden
    const twistedDoors = new Set(doorCorners.keys());
    // Der Boden einer Tür an (x, z) in Feldern, wenn dort eine Tür dieses Raums ist, sonst null
    const doorPatch = (x, z, roomIndex) => {
        const k = roomList[roomIndex].layer;
        for (const cx of Number.isInteger(x) ? [x - 1, x] : [Math.floor(x)]) {
            for (const cz of Number.isInteger(z) ? [z - 1, z] : [Math.floor(z)]) {
                if (cx < 0 || cz < 0 || cx >= width || cz >= depth) continue;
                const heights = doorCorners.get(index(cx, cz, k));
                if (!heights || owner[index(cx, cz, k)] !== roomIndex) continue;
                const fx = x - cx, fz = z - cz;
                return (heights[0] * (1 - fx) + heights[1] * fx) * (1 - fz) + (heights[2] * (1 - fx) + heights[3] * fx) * fz;
            }
        }
        return null;
    };

    const level = {
        settings, width, depth, layers, cells, owner, rooms: roomList, things, start, twistedDoors,
        index, kindAt, slabs, ceilingOfCell, pools,
        // das Becken an einem Feld in Schicht k, oder null
        poolAt: (x, z, k = 0) => (x < 0 || z < 0 || x >= width || z >= depth ? null : water.get(index(x, z, k)) ?? null),
        // Hat dieses Feld (Schicht k) keine Decke, weil darüber ein Loch ist?
        ceilingOpen: (x, z, k) => openCeiling.has(index(x, z, k)),
        // welcher Raum an einem Feld in Schicht k ist (-1: keiner)
        roomAt(x, z, k = 0) {
            return x < 0 || z < 0 || x >= width || z >= depth ? -1 : owner[index(x, z, k)];
        },
        // Bodenhöhe an einer Stelle der Welt (in Feldern), im Raum dieses Feldes
        floorAt(x, z, roomIndex) {
            const door = doorPatch(x, z, roomIndex);
            if (door !== null) return door;
            const room = roomList[roomIndex];
            return room.floorAt(x - room.ox, z - room.oz);
        },
        // Deckenhöhe: so hoch über dem Boden, wie der Raum es dort will
        ceilingAt(x, z, roomIndex) {
            const room = roomList[roomIndex];
            const door = doorPatch(x, z, roomIndex);
            if (door !== null) return door + room.ceilingRelative(x - room.ox, z - room.oz);
            return room.ceilingAt(x - room.ox, z - room.oz);
        },
        // Auf welchem Boden steht, wer an einer Stelle der Welt (in Metern)
        // mit den Füßen auf Höhe y ist? Der höchste, der nicht mehr als eine
        // Stufe (STEP) über den Füßen liegt; ohne y der unterste. -1: keiner.
        roomAtPoint(x, z, y = null) {
            const cx = Math.floor(x / settings.cell), cz = Math.floor(z / settings.cell);
            let best = -1, bestFloor = -Infinity, lowest = -1, lowestFloor = Infinity;
            for (const slab of slabs(cx, cz)) {
                const floor = level.floorAt(x / settings.cell, z / settings.cell, slab.room) - sunk(cx, cz, slab.layer);
                if (floor < lowestFloor) { lowest = slab.room; lowestFloor = floor; }
                if (y !== null && floor <= y + STEP && floor > bestFloor) { best = slab.room; bestFloor = floor; }
            }
            return y === null || best < 0 ? lowest : best;
        },
        // der Boden an einer Stelle der Welt in Metern (für Füße auf Höhe y)
        floorAtPoint(x, z, y = null) {
            const room = level.roomAtPoint(x, z, y);
            if (room < 0) return 0;
            return level.floorAt(x / settings.cell, z / settings.cell, room) - sunk(Math.floor(x / settings.cell), Math.floor(z / settings.cell), roomList[room].layer);
        },
        // wie tief der Boden eines Felds in Schicht k unter dem seines Raums liegt: in einem Becken dessen Tiefe, sonst 0
        sunk,
        // Ist an einem Punkt der Welt (in Metern) Luft, in irgendeinem Raum?
        // margin < 0: nur wirklich zwischen Boden und Decke
        openAt(x, y, z, margin = 0.01) {
            const cx = Math.floor(x / settings.cell), cz = Math.floor(z / settings.cell);
            return slabs(cx, cz).some(({ room, layer }) =>
                y >= level.floorAt(x / settings.cell, z / settings.cell, room) - sunk(cx, cz, layer) - margin &&
                y <= ceilingOfCell(cx, cz, layer)(x / settings.cell, z / settings.cell) + margin);
        },
    };
    built = level;
    checkClosed(level);
    if (start.heading === null) {
        // ohne look: dorthin, wo man am weitesten sieht
        let best = -1;
        for (const [heading, dx, dz] of [[0, 0, -1], [90, 1, 0], [180, 0, 1], [270, -1, 0]]) {
            let free = 0;
            while (kindAt(start.x + dx * (free + 1), start.z + dz * (free + 1), start.layer) === 'floor') free += 1;
            if (free > best) { best = free; start.heading = heading; }
        }
    }
    return level;
}

// Ein Feld mit Boden darf nicht an »nichts« grenzen, sonst fiele man hinaus.
// Ein Nachbar in einer anderen Schicht zählt, wenn sein Boden dort auf
// gleicher Höhe weitergeht (eine Tür zu einem Raum über oder unter anderen).
// (Wer das doch will: noclip ist eine andere Geschichte.)
function checkClosed(level) {
    const { width, depth, layers, rooms, kindAt, slabs } = level;
    for (let k = 0; k < layers; k++) {
        for (let z = 0; z < depth; z++) {
            for (let x = 0; x < width; x++) {
                if (kindAt(x, z, k) !== 'floor') continue;
                const room = rooms[level.roomAt(x, z, k)];
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    if (kindAt(x + dx, z + dz, k) !== 'void') continue;
                    const here = level.floorAt(x + 0.5, z + 0.5, room.index);
                    const across = slabs(x + dx, z + dz).some((slab) => Math.abs(level.floorAt(x + dx + 0.5, z + dz + 0.5, slab.room) - here) < 1.0);
                    if (across) continue;
                    throw new LevelError(room.file, null, `at column ${x - room.ox + 1}, row ${z - room.oz + 1} of the floor plan the floor has no wall next to it. Close the room with #.`);
                }
            }
        }
    }
}
