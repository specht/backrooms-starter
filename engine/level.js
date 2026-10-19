// Liest ein Level: level.ini sagt, wie es heißt und in welchem Raum du
// anfängst. Jeder Raum steht in einer eigenen Datei rooms/NAME.room, mit
// seinem Grundriss in [map] und für jeden Buchstaben und jede Ziffer darin
// einem Abschnitt, der sagt, was sie sind.
//
//   #  Wand          .  Boden          @  hier startest du (nur einmal im Level)
//   Leerzeichen: nichts, außerhalb des Raums
//   ein Buchstabe: eine Leuchte, ein Block oder eine Statue, erklärt in [Buchstabe]
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

const SLOPES = ['flat', 'north', 'east', 'south', 'west', 'gable'];
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
    const doors = {};      // Ziffer -> Feld
    const links = [];      // door = raum ziffer
    let start = null;
    rows.forEach((row, z) => {
        for (let x = 0; x < width; x++) {
            const char = row.text[x] ?? ' ';
            let kind = 'floor';
            if (char === '#') kind = 'wall';
            else if (char === ' ') kind = 'void';
            else if (char === '@') start = { x, z, line: row.line };
            else if (/[0-9]/.test(char)) {
                if (doors[char]) throw new LevelError(file, row.line, `door ${char} appears twice. Every digit is a door of its own.`);
                doors[char] = { x, z, line: row.line };
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
                throw new LevelError(file, row.line, `the character »${char}« can't be used in a floor plan. Allowed: # . @ space, letters and digits.`);
            }
            cells.push(kind);
        }
    });
    for (const [char, section] of Object.entries(legend)) {
        if (!/[0-9]/.test(char)) continue;
        const door = values(section).door;
        if (door === undefined) throw new LevelError(file, section.line, `[${char}] is a door and needs door = room digit.`);
        const match = String(door).match(/^([a-z0-9_-]+)\s+([0-9])$/i);
        if (!match) throw new LevelError(file, section.line, `door = ${door}: expected the name of a room and a digit, for example door = flur 2.`);
        if (!doors[char]) throw new LevelError(file, section.line, `[${char}] describes a door, but there is no ${char} in the floor plan.`);
        links.push({ from: char, room: match[1], to: match[2], line: section.line });
    }
    return { id, file, settings, heights, width, depth, cells, things, doors, links, start };
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
            model.glow = { color: String(entries.light), power: entries.power ?? 1, flicker: entries.flicker ?? 0 };
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
    throw new LevelError(file, section.line, `[${char}] needs light = ... (a lamp), block = ... (a block) or model = ... (a statue).`);
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
            if (!other.doors[link.to]) throw new LevelError(room.file, link.line, `room ${link.room} has no door ${link.to}.`);
            edges.push({ a: room, da: room.doors[link.from], b: other, db: other.doors[link.to], line: link.line });
            edges.push({ a: other, da: other.doors[link.to], b: room, db: room.doors[link.from], line: link.line, back: room });
        }
    }

    // Jede Tür braucht ein Gegenstück: sonst führte sie ins Nichts
    for (const room of rooms.values()) {
        for (const [char, door] of Object.entries(room.doors)) {
            if (!edges.some((e) => e.a === room && e.da === door)) {
                throw new LevelError(room.file, door.line, `door ${char} leads nowhere. Describe it with [${char}] and door = room digit, or let another room point to it.`);
            }
        }
    }

    // Räume aneinanderlegen, vom Startraum aus: Tür auf Tür
    const startRoom = rooms.get(String(settings.start));
    startRoom.offset = { x: 0, z: 0 };
    // Die Höhe jedes Raums: Auf einer Tür liegen beide Böden gleich hoch. Der
    // Startraum liegt bei 0, jeder andere Raum so, dass es an seiner Tür passt.
    for (const room of rooms.values()) room.floorRelative = floorFunction(room);
    startRoom.elevation = 0;
    const doorFloor = (room, door) => room.elevation + room.floorRelative(door.x + 0.5, door.z + 0.5);
    const placed = [startRoom];
    for (let i = 0; i < placed.length; i++) {
        const room = placed[i];
        for (const edge of edges.filter((e) => e.a === room)) {
            const x = room.offset.x + edge.da.x - edge.db.x;
            const z = room.offset.z + edge.da.z - edge.db.z;
            if (!edge.b.offset) {
                edge.b.offset = { x, z };
                edge.b.elevation = doorFloor(edge.a, edge.da) - edge.b.floorRelative(edge.db.x + 0.5, edge.db.z + 0.5);
                placed.push(edge.b);
            } else if (Math.abs(doorFloor(edge.a, edge.da) - doorFloor(edge.b, edge.db)) > 0.01) {
                const source = edge.back ?? edge.a;
                throw new LevelError(source.file, edge.line, `this door doesn't fit: the floors of ${edge.a.id} and ${edge.b.id} are at different heights there (${doorFloor(edge.a, edge.da).toFixed(2)} m and ${doorFloor(edge.b, edge.db).toFixed(2)} m). Other doors or ramps already set them.`);
            } else if (edge.b.offset.x !== x || edge.b.offset.z !== z) {
                const source = edge.back ?? edge.a;
                throw new LevelError(source.file, edge.line, `this door doesn't fit: other doors already place the rooms ${edge.a.id} and ${edge.b.id} differently.`);
            }
        }
    }

    // Ein gemeinsames Raster für alle Räume, mit einem Feld Rand
    const minX = Math.min(...placed.map((r) => r.offset.x)) - 1;
    const minZ = Math.min(...placed.map((r) => r.offset.z)) - 1;
    const maxX = Math.max(...placed.map((r) => r.offset.x + r.width)) + 1;
    const maxZ = Math.max(...placed.map((r) => r.offset.z + r.depth)) + 1;
    const width = maxX - minX, depth = maxZ - minZ;
    const cells = new Array(width * depth).fill('void');
    const owner = new Array(width * depth).fill(-1);    // welcher Raum
    const roomList = [...placed];
    const doorCells = new Set();
    roomList.forEach((room, index) => {
        room.index = index;
        // Boden und Decke, in Metern über dem Boden des Startraums: Die Decke
        // liegt height über dem Boden, so steigt sie mit einer Rampe mit.
        const above = ceilingFunction(room);
        room.floorAt = (x, z) => room.elevation + room.floorRelative(x, z);
        room.ceilingAt = (x, z) => room.floorAt(x, z) + above(x, z);
        room.ceilingRelative = above;
        room.ox = room.offset.x - minX;
        room.oz = room.offset.z - minZ;
        for (const door of Object.values(room.doors)) doorCells.add((room.oz + door.z) * width + room.ox + door.x);
    });
    roomList.forEach((room) => {
        for (let z = 0; z < room.depth; z++) {
            for (let x = 0; x < room.width; x++) {
                const kind = room.cells[z * room.width + x];
                if (kind === 'void') continue;
                const at = (room.oz + z) * width + room.ox + x;
                const here = cells[at];
                if (here === 'void') { cells[at] = kind; owner[at] = room.index; continue; }
                if (here === 'wall' && kind === 'wall') continue;
                if (doorCells.has(at) && here === 'floor' && kind === 'floor') continue;
                const other = roomList[owner[at]];
                throw new LevelError(room.file, null, `room ${room.id} overlaps room ${other.id} (column ${x + 1}, row ${z + 1} of the floor plan of ${room.id}).`);
            }
        }
    });

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
            start = { x: room.start.x + room.ox, z: room.start.z + room.oz, heading };
        }
    }
    if (!start) throw new LevelError(`rooms/${settings.start}.room`, null, 'the level has no @: where do you start?');

    // Eine Tür verbindet zwei Böden, die verschieden schräg sein können (ein
    // Raum mit Rampe quer zur Tür). Ihr Feld hat darum keine eigene Höhe:
    // An jeder Kante liegt es so hoch wie der Boden dahinter, dazwischen
    // läuft es gerade (bilinear). So bleibt keine Lücke und keine Stufe.
    const doorCorners = new Map();   // Feld -> Höhe an den Ecken (x0z0, x1z0, x0z1, x1z1)
    for (const at of doorCells) {
        const gx = at % width, gz = Math.floor(at / width);
        const own = roomList[owner[at]];
        const corners = [[gx, gz], [gx + 1, gz], [gx, gz + 1], [gx + 1, gz + 1]];
        const heights = corners.map(([cx, cz]) => own.floorAt(cx - own.ox, cz - own.oz));
        // [Nachbar, die beiden Ecken an der Kante zu ihm]
        for (const [dx, dz, edge] of [[-1, 0, [0, 2]], [1, 0, [1, 3]], [0, -1, [0, 1]], [0, 1, [2, 3]]]) {
            const n = (gz + dz) * width + gx + dx;
            if (cells[n] !== 'floor' || doorCells.has(n)) continue;
            const room = roomList[owner[n]];
            for (const k of edge) heights[k] = room.floorAt(corners[k][0] - room.ox, corners[k][1] - room.oz);
        }
        // Nur wo es nötig ist: Liegen beide Böden so, dass der Raum der Tür
        // sie ohnehin trifft, bleibt sie ein Teil seines Bodens (ohne Naht)
        const mine = corners.map(([cx, cz]) => own.floorAt(cx - own.ox, cz - own.oz));
        if (heights.some((h, k) => Math.abs(h - mine[k]) > 1e-3)) doorCorners.set(at, heights);
    }
    // Türen mit eigenem, verdrehtem Boden
    const twistedDoors = new Set(doorCorners.keys());
    // Der Boden einer Tür an (x, z) in Feldern, wenn dort eine Tür dieses Raums ist, sonst null
    const doorPatch = (x, z, roomIndex) => {
        for (const cx of Number.isInteger(x) ? [x - 1, x] : [Math.floor(x)]) {
            for (const cz of Number.isInteger(z) ? [z - 1, z] : [Math.floor(z)]) {
                if (cx < 0 || cz < 0 || cx >= width || cz >= depth) continue;
                const heights = doorCorners.get(cz * width + cx);
                if (!heights || owner[cz * width + cx] !== roomIndex) continue;
                const fx = x - cx, fz = z - cz;
                return (heights[0] * (1 - fx) + heights[1] * fx) * (1 - fz) + (heights[2] * (1 - fx) + heights[3] * fx) * fz;
            }
        }
        return null;
    };

    const level = {
        settings, width, depth, cells, owner, rooms: roomList, things, start, twistedDoors,
        // Bodenhöhe an einer Stelle der Welt (in Feldern), im Raum dieses Feldes
        floorAt(x, z, roomIndex) {
            const door = doorPatch(x, z, roomIndex);
            if (door !== null) return door;
            const room = roomList[roomIndex];
            return room.floorAt(x - room.ox, z - room.oz);
        },
        // der Boden an einer Stelle der Welt in Metern, im Raum, dem das Feld gehört
        floorAtPoint(x, z) {
            const cx = Math.floor(x / settings.cell), cz = Math.floor(z / settings.cell);
            const index = owner[cz * width + cx];
            if (index === undefined || index < 0) return 0;
            return level.floorAt(x / settings.cell, z / settings.cell, index);
        },
        // Deckenhöhe: so hoch über dem Boden, wie der Raum es dort will
        ceilingAt(x, z, roomIndex) {
            const room = roomList[roomIndex];
            const door = doorPatch(x, z, roomIndex);
            if (door !== null) return door + room.ceilingRelative(x - room.ox, z - room.oz);
            return room.ceilingAt(x - room.ox, z - room.oz);
        },
    };
    checkClosed(level);
    if (start.heading === null) {
        // ohne look: dorthin, wo man am weitesten sieht
        let best = -1;
        for (const [heading, dx, dz] of [[0, 0, -1], [90, 1, 0], [180, 0, 1], [270, -1, 0]]) {
            let free = 0;
            while (cells[(start.z + dz * (free + 1)) * width + start.x + dx * (free + 1)] === 'floor') free += 1;
            if (free > best) { best = free; start.heading = heading; }
        }
    }
    return level;
}

// Ein Feld mit Boden darf nicht an »nichts« grenzen, sonst fiele man hinaus.
// (Wer das doch will: noclip ist eine andere Geschichte.)
function checkClosed(level) {
    const { width, depth, cells, owner, rooms } = level;
    const at = (x, z) => (x < 0 || z < 0 || x >= width || z >= depth ? 'void' : cells[z * width + x]);
    for (let z = 0; z < depth; z++) {
        for (let x = 0; x < width; x++) {
            if (at(x, z) !== 'floor') continue;
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                if (at(x + dx, z + dz) !== 'void') continue;
                const room = rooms[owner[z * width + x]];
                throw new LevelError(room.file, null, `at column ${x - room.ox + 1}, row ${z - room.oz + 1} of the floor plan the floor has no wall next to it. Close the room with #.`);
            }
        }
    }
}
