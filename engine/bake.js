// Backt das Licht in eine Lichtkarte, im Browser auf der Grafikkarte.
//
// Das Level wird ein 3D-Raster aus kleinen Würfeln (Voxeln): voll, wo eine
// Wand, eine Decke, ein Block oder ein Modell ist. Gebacken wird in Stufen:
//
// 1. Direktes Licht: Für jeden Punkt der Lichtkarte schickt ein Shader
//    Strahlen zu zufälligen Punkten auf den Leuchten und läuft das Raster
//    entlang. Ist ein Voxel im Weg, liegt der Punkt im Schatten.
// 2. Reflexion: Jeder Punkt gibt Licht wieder ab, so hell wie er beleuchtet
//    ist, in der Farbe seiner Fläche. Diese Werte kommen in ein grobes
//    Raster aus 25-cm-Zellen, jeweils in die Zelle vor der Fläche.
// 3. Sammeln: Jeder Punkt schickt Strahlen in zufällige Richtungen über
//    seiner Fläche; wo einer auftrifft, nimmt er das Licht der Zelle davor.
//    Das ist das Licht, das einmal abgeprallt ist.
// 2. und 3. wiederholt: Mit dem neuen Licht prallt es ein zweites, drittes
// Mal ab. So werden auch Decken hell, die keine Leuchte direkt sieht.
import * as THREE from 'three';

// Modelle kommen in Raster aus Voxeln, jedes in sein eigenes: so fein, wie es
// der Speicher erlaubt, damit ihre Schatten an Wand und Boden glatt werden
// (ein Voxel gilt als voll, sobald das Modell es berührt: Grobe Voxel machen
// es dicker und stufig). Nie feiner als VOXEL_MIN, je Modell höchstens
// VOXELS_PER_MODEL, alle zusammen höchstens VOXELS_TOTAL (je ein Byte).
const VOXEL_MIN = 0.01;
const VOXELS_PER_MODEL = 6e6;
const VOXELS_TOTAL = 24e6;
const CELL = 0.25;                    // Zellen für das abprallende Licht
const DIRECT_PASSES = 64;             // Durchgänge für das direkte Licht
const BOUNCE_PASSES = 64;             // Durchgänge für jede Reflexion, je vier Strahlen
const INJECT_CHUNK = 1 << 18;         // Punkte der Lightmap je Schritt, die ihr Licht in die Zellen geben
const RAYS = 4;
// Ein Durchgang wird Stück für Stück gezeichnet, ein Quadrat der Lightmap
// auf einmal: Ein Handy oder Tablet gibt sonst auf (der GL-Kontext geht
// verloren), wenn die Grafikkarte zu lange an einem Bild rechnet. Wird
// schon eins zu langsam, werden die Stücke kleiner (smallerTiles).
const TILE = 512;
const SMALLEST_TILE = 32;
const LIGHT_SCALE = 30;               // macht power = 1 zu »hell unter der Lampe«

// Das Raster für die Strahlen: für jedes Feld, was es ist, wie hoch seine
// Decke an den vier Ecken ist und welcher Block darauf steht, alles genau.
// Nur Modelle kommen in ein feines Raster aus Voxeln.
// maxTextureSize: wie viele Voxel eine 3D-Textur je Richtung haben darf
// Async: Zwischendurch (alle 20 ms) kommt der Browser dran, sonst stünde
// die Seite still, solange viele Modelle in Voxel zerlegt werden.
export async function buildGrid(level, models, maxHeight, maxTextureSize = 2048) {
    let rested = performance.now();
    const breathe = async () => {
        if (performance.now() - rested < 20) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
        rested = performance.now();
    };
    const { width, depth, layers, settings } = level;
    const cell = settings.cell;
    // Jede Schicht (Räume übereinander, level.js) ist ein ganzer Grundriss:
    // in den Texturen untereinander, Schicht k ab Zeile k * depth
    const count = width * depth * layers;
    const info = new Float32Array(count * 4);      // Art, Modell, Block
    const ceilings = new Float32Array(count * 4);  // Deckenhöhe an den vier Ecken
    const floors = new Float32Array(count * 4);    // Bodenhöhe an den vier Ecken
    const blockMin = new Float32Array(count * 4);
    const blockMax = new Float32Array(count * 4);
    // runde Türen: welche Achse (1: x, 2: z), Mitte des Bogens (Meter), Radius, Höhe, wo er ansetzt
    const archInfo = new Float32Array(count * 4);
    // Treppen: Richtung (1 Osten, -1 Westen, 2 Süden, -2 Norden), wo sie beginnt (Meter), Tiefe und Höhe einer Stufe
    const stairInfo = new Float32Array(count * 4);
    for (let k = 0; k < layers; k++) {
        for (let z = 0; z < depth; z++) {
            for (let x = 0; x < width; x++) {
                const i = level.index(x, z, k) * 4;
                const kind = level.kindAt(x, z, k);
                info[i] = kind === 'floor' ? 1 : kind === 'wall' ? 2 : 0;
                if (kind !== 'floor') continue;
                const room = level.roomAt(x, z, k);
                const top = level.ceilingOfCell(x, z, k);   // unter einem Loch: die Decke des Raums darüber
                ceilings.set([top(x, z), top(x + 1, z), top(x, z + 1), top(x + 1, z + 1)], i);
                const arch = level.archAt(x, z, k);
                if (arch) archInfo.set([arch.alongX ? 1 : 2, arch.start + arch.center, arch.radius, arch.spring], i);
                // ein Podest: der Boden höher, im ganzen Feld gleich; eine Treppe: ihre Stufen prüft trace
                const lift = level.liftAt(x, z, k);
                if (lift?.stairs) {
                    const { direction } = lift.stairs, cell = level.settings.cell;
                    const axis = { east: 1, west: -1, south: 2, north: -2 }[direction];
                    const start = direction === 'east' ? lift.x0 * cell : direction === 'west' ? (lift.x1 + 1) * cell
                        : direction === 'south' ? lift.z0 * cell : (lift.z1 + 1) * cell;
                    stairInfo.set([axis, start, lift.tread, lift.stepHeight], i);
                    floors.set([0, 1, 2, 3].map(() => lift.floor + lift.base), i);   // die Stufen beginnen auf dem Absatz
                }
                // ein Becken: der Boden tief unten, im ganzen Feld gleich
                const pool = level.poolAt(x, z, k);
                if (pool) floors.set([pool.bottom, pool.bottom, pool.bottom, pool.bottom], i);
                else if (lift?.raise) floors.set([0, 1, 2, 3].map(() => lift.floor + lift.raise), i);
                else if (!lift?.stairs) floors.set([level.floorAt(x, z, room), level.floorAt(x + 1, z, room),
                    level.floorAt(x, z + 1, room), level.floorAt(x + 1, z + 1, room)], i);
            }
        }
    }
    // Runde Ecken (level.js): je Feld bis zu zwei, die Mitte (Meter), der
    // Radius und die Art: innen positiv, außen negativ, der Betrag sagt, in
    // welche Richtung von der Ecke aus das Quadrat liegt (1 + x nach Westen +
    // 2 · z nach Norden). Ein Wandfeld mit einer äußeren hat Luft im Zwickel:
    // Für die Strahlen ist es ein Feld mit Boden und Decke des Raums, in dem
    // nur der Zwickel frei ist.
    const roundInfo = [new Float32Array(count * 4), new Float32Array(count * 4)];
    for (const c of level.corners) {
        const code = (c.concave ? 1 : -1) * (1 + (c.q[0] > 0 ? 0 : 1) + (c.q[1] > 0 ? 0 : 2));
        for (let x = Math.floor(c.box[0] + 1e-9); x < Math.ceil(c.box[1] - 1e-9); x++) {
            for (let z = Math.floor(c.box[2] + 1e-9); z < Math.ceil(c.box[3] - 1e-9); z++) {
                const i = level.index(x, z, c.layer) * 4;
                const slot = roundInfo[0][i + 3] === 0 ? roundInfo[0] : roundInfo[1];
                slot.set([c.centre[0] * cell, c.centre[1] * cell, c.r * cell, code], i);
                if (c.concave) continue;
                info[i] = 1;
                ceilings.set([level.ceilingAt(x, z, c.room), level.ceilingAt(x + 1, z, c.room), level.ceilingAt(x, z + 1, c.room), level.ceilingAt(x + 1, z + 1, c.room)], i);
                floors.set([level.floorAt(x, z, c.room), level.floorAt(x + 1, z, c.room), level.floorAt(x, z + 1, c.room), level.floorAt(x + 1, z + 1, c.room)], i);
            }
        }
    }
    // Ein Block gilt in jedem Feld, das er bedeckt (pro Feld einer), in der Schicht seines Raums
    for (const block of level.things.filter((t) => t.type === 'block')) {
        const k = level.rooms[block.room].layer;
        const [w, h, d] = block.size;
        const cx = (block.x + 0.5) * cell + block.offset[0], cz = (block.z + 0.5) * cell + block.offset[2];
        const y0 = block.floor + block.base + block.offset[1];   // auf dem Boden seines Felds (oder höher)
        const min = [cx - w / 2, y0, cz - d / 2], max = [cx + w / 2, y0 + h, cz + d / 2];
        // gedreht: in allen Feldern, die er gedreht berührt; der Kasten bleibt
        // gerade, der Shader dreht Strahl und Stelle zurück (blockMin.w)
        const yaw = block.yaw ?? 0, c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
        const reachX = (w * c + d * s) / 2, reachZ = (w * s + d * c) / 2;
        for (let z = Math.floor((cz - reachZ) / cell); z < Math.ceil((cz + reachZ) / cell); z++) {
            for (let x = Math.floor((cx - reachX) / cell); x < Math.ceil((cx + reachX) / cell); x++) {
                if (x < 0 || z < 0 || x >= width || z >= depth) continue;
                const i = level.index(x, z, k) * 4;
                if (info[i + 2] > 0) continue;
                info[i + 2] = 1;
                blockMin.set([...min, yaw], i);
                blockMax.set([...max, block.shape === 'round' ? 2 : 1], i);   // 2: eine runde Säule in diesem Kasten
            }
        }
    }

    // Modelle: ihre Oberfläche in feine Voxel, so dicht abgetastet, dass kein
    // Strahl durchschlüpft. Jedes Modell hat sein eigenes Raster über seinem
    // Kasten; alle liegen nebeneinander in einer 3D-Textur (Regalbretter in
    // x und y), modelGrids sagt, wo.
    const boxes = models.map((object) => new THREE.Box3().setFromObject(object));
    const sizes = boxes.map((box) => box.getSize(new THREE.Vector3()));
    const voxelSize = sizes.map((size) => Math.max(VOXEL_MIN, Math.cbrt(Math.max(size.x * size.y * size.z, 1e-6) / VOXELS_PER_MODEL),
        Math.max(size.x, size.y, size.z) / (maxTextureSize - 2)));
    const countOf = (i, v) => sizes[i].toArray().map((extent) => Math.ceil(extent / v) + 2);   // ein Voxel Rand ringsum
    const total = voxelSize.reduce((sum, v, i) => sum + countOf(i, v).reduce((a, b) => a * b, 1), 0);
    if (total > VOXELS_TOTAL) voxelSize.forEach((v, i) => { voxelSize[i] = v * Math.cbrt(total / VOXELS_TOTAL); });
    let grids, atlas;
    for (let attempt = 0; ; attempt++) {
        grids = models.map((_, i) => ({ voxel: voxelSize[i], count: countOf(i, voxelSize[i]), origin: boxes[i].min.clone().subScalar(voxelSize[i]) }));
        // Regalbretter: nebeneinander in x, Reihen übereinander in y
        let x = 0, y = 0, row = 0, depthMax = 1, widthMax = 1;
        for (const grid of grids) {
            const [nx, ny, nz] = grid.count;
            if (x + nx > maxTextureSize) { x = 0; y += row; row = 0; }
            grid.offset = [x, y, 0];
            x += nx; row = Math.max(row, ny);
            widthMax = Math.max(widthMax, x); depthMax = Math.max(depthMax, nz);
        }
        atlas = [widthMax, Math.max(1, y + row), depthMax];
        if (atlas[1] <= maxTextureSize || attempt > 8) break;
        voxelSize.forEach((v, i) => { voxelSize[i] = v * 1.25; });   // passt nicht: alle etwas gröber
    }
    const [ax, ay, az] = atlas;
    const data = new Uint8Array(ax * ay * az);
    const gridInfo = new Float32Array(Math.max(1, grids.length) * 3 * 4);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3();
    for (const [index, object] of models.entries()) {
        const { voxel, count: [nx, ny, nz], origin, offset: [ox, oy] } = grids[index];
        gridInfo.set([origin.x, origin.y, origin.z, voxel, ox, oy, 0, 0, nx, ny, nz, 0], index * 12);
        const set = (vx, vy, vz) => {
            if (vx < 0 || vy < 0 || vz < 0 || vx >= nx || vy >= ny || vz >= nz) return;
            data[(vz * ay + oy + vy) * ax + ox + vx] = 255;
            const fx = Math.floor((origin.x + (vx + 0.5) * voxel) / cell), fz = Math.floor((origin.z + (vz + 0.5) * voxel) / cell);
            // ein Modell: in jeder Schicht vermerkt (geprüft wird ohnehin nur sein Kasten)
            if (fx >= 0 && fz >= 0 && fx < width && fz < depth) for (let k = 0; k < layers; k++) info[level.index(fx, fz, k) * 4 + 1] = 1;
        };
        object.updateMatrixWorld(true);
        const meshes = [];
        object.traverse((mesh) => { if (mesh.isMesh && !mesh.userData.noShadow) meshes.push(mesh); });   // ohne Glas und leuchtende Teile (main.js)
        for (const mesh of meshes) {
            const position = mesh.geometry.attributes.position;
            const index = mesh.geometry.index;
            const count = index ? index.count : position.count;
            for (let i = 0; i < count; i += 3) {
                if (i % 3000 === 0) await breathe();
                const ia = index ? index.getX(i) : i, ib = index ? index.getX(i + 1) : i + 1, ic = index ? index.getX(i + 2) : i + 2;
                a.fromBufferAttribute(position, ia).applyMatrix4(mesh.matrixWorld);
                b.fromBufferAttribute(position, ib).applyMatrix4(mesh.matrixWorld);
                c.fromBufferAttribute(position, ic).applyMatrix4(mesh.matrixWorld);
                const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
                const steps = Math.max(1, Math.ceil(longest / (voxel * 0.5)));
                for (let s = 0; s <= steps; s++) {
                    for (let t = 0; t <= steps - s; t++) {
                        const u = s / steps, v = t / steps;
                        p.copy(a).multiplyScalar(1 - u - v).addScaledVector(b, u).addScaledVector(c, v);
                        set(Math.floor((p.x - origin.x) / voxel), Math.floor((p.y - origin.y) / voxel), Math.floor((p.z - origin.z) / voxel));
                    }
                }
            }
        }
    }
    const voxels = new THREE.Data3DTexture(data, ax, ay, az);
    voxels.format = THREE.RedFormat;
    voxels.type = THREE.UnsignedByteType;
    voxels.minFilter = voxels.magFilter = THREE.NearestFilter;
    voxels.unpackAlignment = 1;
    voxels.needsUpdate = true;
    const modelGrids = new THREE.DataTexture(gridInfo, Math.max(1, grids.length) * 3, 1, THREE.RGBAFormat, THREE.FloatType);
    modelGrids.needsUpdate = true;

    const texture = (array) => {
        const t = new THREE.DataTexture(array, width, depth * layers, THREE.RGBAFormat, THREE.FloatType);
        t.needsUpdate = true;
        return t;
    };
    return {
        info: texture(info), ceilings: texture(ceilings), floors: texture(floors), blockMin: texture(blockMin), blockMax: texture(blockMax), arches: texture(archInfo), stairs: texture(stairInfo),
        rounds: roundInfo.map(texture),
        voxels, modelGrids, modelCount: grids.length, cells: new THREE.Vector2(width, depth), layers, cell,
    };
}

// Wie weit eine Leuchte reicht: bis ihr Licht kaum noch zu sehen ist
// (0,004 auf einer Fläche direkt darunter), zwischen 4 und 40 Metern. Über
// das letzte Drittel blendet es weich aus, damit keine Kante entsteht.
export function lightRange(light) {
    const strength = light.power * LIGHT_SCALE * light.size[0] * light.size[1] / Math.PI;
    return Math.min(40, Math.max(4, Math.sqrt(strength / 0.004)));
}

// Drei Texel pro Leuchte: Mitte und Breite, Farbe mal Stärke und Länge,
// Flacker-Kanal (-1: ruhig) und Reichweite. Leuchten, die (noch) aus sind (on[i] === false),
// haben die Stärke 0.
// Die Farbe jedes Flacker-Kanals, auf die Helligkeit 1 gebracht: Die
// Lightmap eines Kanals trägt nur, wie hell es ist; die Fläche färbt es mit
// dieser Farbe. Teilen sich Leuchten verschiedener Farbe einen Kanal, gilt
// die Farbe der letzten.
const LUMA = [0.2126, 0.7152, 0.0722];
// Die Farbe jedes Kanals: die seiner Leuchten, nach ihrer Stärke gemittelt
// (teilen sich Leuchten verschiedener Farbe einen Kanal, weil es mehr als
// vier Farben gibt, flackern sie in einer Farbe dazwischen)
export function channelColors(lights, count) {
    const sums = Array.from({ length: count }, () => new THREE.Vector3());
    for (const light of lights) {
        if (light.channel < 0) continue;
        const c = new THREE.Color(light.color);
        sums[light.channel].add(new THREE.Vector3(c.r, c.g, c.b).multiplyScalar(light.power ?? 1));
    }
    return sums.map((sum) => {
        if (sum.lengthSq() === 0) return new THREE.Vector3(1, 1, 1);
        const luma = sum.x * LUMA[0] + sum.y * LUMA[1] + sum.z * LUMA[2];
        return sum.divideScalar(Math.max(luma, 1e-6));
    });
}

export function lightTexture(lights, on = null, texture = null) {
    const count = Math.max(1, lights.length);
    const data = texture ? texture.image.data : new Float32Array(count * 3 * 4);
    lights.forEach((light, i) => {
        const color = new THREE.Color(light.color);
        const power = on && !on[i] ? 0 : light.power * LIGHT_SCALE;
        // eine Lampe aus einem Modell: Radius negativ, dann die Fläche, der sie gleichkommt
        const bulb = light.kind === 'bulb';
        data.set([light.position.x, light.position.y, light.position.z, bulb ? -light.radius : light.size[0]], i * 12);
        data.set([color.r * power, color.g * power, color.b * power, bulb ? light.size[0] * light.size[1] : light.size[1]], i * 12 + 4);
        // wie steil die Decke über der Leuchte in x und z ansteigt: Sie liegt darin.
        // Bei einer Lampe aus einem Modell stattdessen ihr Kegel (beam): wohin
        // (-1 nach unten, 1 nach oben, 0 ringsum) und wie weit (cos des Winkels)
        const beam = bulb ? light.beam : null;
        data.set([light.channel, lightRange(light),
            bulb ? (beam ? (beam.up ? 1 : -1) : 0) : light.tilt?.[0] ?? 0,
            bulb ? (beam ? Math.cos(THREE.MathUtils.degToRad(beam.angle)) : 0) : light.tilt?.[1] ?? 0], i * 12 + 8);
    });
    texture ??= new THREE.DataTexture(data, count * 3, 1, THREE.RGBAFormat, THREE.FloatType);
    texture.needsUpdate = true;
    return texture;
}

// Für das Backen wird jede Fläche in ihr Rechteck der Lichtkarte gezeichnet:
// gl_Position ist die Stelle in der Lichtkarte, world die Stelle im Raum.
const bakeVertexShader = /* glsl */ `
in vec3 position;
in vec3 world;
in vec3 normal;
in vec3 faceMin;
in vec3 faceMax;
in float ambient;
in vec3 albedo;
in float density;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vMin;
out vec3 vMax;
out float vAmbient;
out vec3 vAlbedo;
out float vDensity;
void main() {
    vWorld = world; vNormal = normal; vMin = faceMin; vMax = faceMax; vAmbient = ambient; vAlbedo = albedo; vDensity = density;
    gl_Position = vec4(position.xy * 2.0 - 1.0, 0.0, 1.0);
}`;

// Was alle Back-Shader brauchen: Zufall, das Raster, der Weg hindurch
const common = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
in vec3 vWorld;
in vec3 vNormal;
in vec3 vMin;
in vec3 vMax;
in float vAmbient;
in vec3 vAlbedo;
in float vDensity;             // wie viel feiner als sonst die Lichtkarte hier ist (bei Modellen)

uniform sampler3D voxels;      // die Raster aller Modelle nebeneinander
uniform sampler2D modelGrids; // je Modell drei Texel: Ecke und Voxelgröße, Stelle in voxels, Voxel in x, y, z
uniform int modelCount;
uniform sampler2D cellInfo;    // r: 0 nichts, 1 Boden, 2 Wand; g: Modell; b: Block
uniform sampler2D cellCeiling; // Deckenhöhe an den Ecken (x0z0, x1z0, x0z1, x1z1)
uniform sampler2D cellFloor;   // Bodenhöhe an den Ecken, ebenso
uniform float bottom;          // der tiefste Boden
uniform sampler2D blockMin;
uniform sampler2D blockMax;
uniform sampler2D cellArch;    // runde Türen (buildGrid)
uniform sampler2D cellStairs;  // Treppen (buildGrid)
uniform sampler2D cellRound0;  // runde Ecken (buildGrid), bis zu zwei je Feld
uniform sampler2D cellRound1;
uniform vec2 cellCount;
uniform int layerCount;        // Räume übereinander: so viele Grundrisse untereinander in den Texturen
uniform float cellMeters;
uniform float top;
uniform uint pass;
uniform bool withModels;   // die Lichtproben für Modelle sehen durch die Modelle hindurch
// Modell-Voxel so nah am Anfang eines Strahls zählen nicht (gegen Schatten
// einer Fläche auf sich selbst); nur für die Ecken der Modelle gesetzt.
float modelSkip = 0.0;

uint state;
uint pcg() {
    state = state * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}
float random() { return float(pcg()) / 4294967296.0; }

// Wo auf einer Leuchte ein Strahl des direkten Lichts endet (lampSample,
// < 0: zufällig): Die Leuchte ist in 8 × 8 Felder geteilt, und jeder Punkt
// der Lichtkarte kommt in den 64 Durchgängen in jedes Feld genau einmal,
// darin an eine zufällige Stelle (directShader). So wird der Halbschatten mit
// derselben Zahl an Strahlen glatter als mit Zufall allein.
vec2 lampSample = vec2(-1.0);
vec2 lampRandom() { return lampSample.x >= 0.0 ? lampSample : vec2(random(), random()); }

// Eine Leuchte liegt in der Ebene der Decke über ihr. Der dritte Texel der
// Leuchte (e) trägt in .b und .a, wie steil diese Decke in x und in z
// ansteigt (0 und 0: waagerecht). lampPoint ist ein zufälliger Punkt auf der
// Leuchte, lampNormal zeigt von ihr in den Raum.
vec3 lampPoint(vec4 a, vec4 b, vec4 e) {
    vec3 u = normalize(vec3(1.0, e.b, 0.0)), v = normalize(vec3(0.0, e.a, 1.0));
    vec2 r = lampRandom();
    return a.xyz + u * ((r.x - 0.5) * a.w) + v * ((r.y - 0.5) * b.w);
}
vec3 lampNormal(vec4 e) { return normalize(vec3(e.b, -1.0, e.a)); }

// Wie viel vom Licht eines Kegels in Richtung along (cos zur Achse) ankommt,
// bei einem Kegel bis zum Winkel mit dem cos edge
float beamFacing(float along, float edge) {
    return smoothstep(edge - 0.12, edge + 0.12, along);
}

// Eine Lampe aus einem Modell (a.w < 0, etwa eine Wandlampe) ist eine kleine
// Kugel mit dem Radius -a.w, die nach allen Seiten gleich strahlt; b.w sagt,
// wie viel Fläche einer Leuchte unter der Decke sie gleichkommt.
vec3 lightPoint(vec4 a, vec4 b, vec4 e) {
    if (a.w >= 0.0) return lampPoint(a, b, e);
    vec2 q = lampRandom();
    float z = 2.0 * q.x - 1.0, phi = 6.2831853 * q.y, r = sqrt(1.0 - z * z);
    return a.xyz + vec3(r * cos(phi), z, r * sin(phi)) * (-a.w);
}
// wie viel die Leuchte zur Fläche hin abgibt (l zeigt von der Fläche zur Leuchte)
// Eine Lampe aus einem Modell mit Kegel (e.b: nach unten -1, nach oben 1):
// innen ganz, zum Rand des Kegels weich auslaufend
float lightFacing(vec4 a, vec4 e, vec3 l) {
    if (a.w >= 0.0) return -dot(l, lampNormal(e));
    if (e.b == 0.0) return 1.0;
    return beamFacing(-l.y * e.b, e.a);
}
float lightArea(vec4 a, vec4 b) { return a.w < 0.0 ? b.w : a.w * b.w; }
// Wo der Strahl zur Leuchte endet: bei einer Lampe aus einem Modell knapp
// vor ihrem Licht. Ihr Schirm wirft Schatten, nur ihr Inneres um die
// Glühbirne nicht (sonst wäre sie sofort verdeckt).
vec3 shadowEnd(vec4 a, vec3 s, vec3 l) { return a.w < 0.0 ? s - l * (-a.w * 1.5 + 0.02) : s; }

vec3 safeDirection(vec3 d) {
    return vec3(abs(d.x) < 1e-6 ? 1e-6 : d.x, abs(d.y) < 1e-6 ? 1e-6 : d.y, abs(d.z) < 1e-6 ? 1e-6 : d.z);
}

bool modelVoxel(ivec3 v, ivec3 offset, ivec3 size) {
    if (any(lessThan(v, ivec3(0))) || any(greaterThanEqual(v, size))) return false;
    return texelFetch(voxels, offset + v, 0).r > 0.5;
}

// Durch das Raster eines Modells, von t0 bis t1 entlang des Strahls (3D-DDA).
// Für Punkte auf Wänden und Böden liegt das Raster bei jedem Strahl um bis
// zu einen halben Voxel anders: Über alle Durchgänge gemittelt werden die
// Stufen der Voxel im Schatten eines Modells zu einer glatten Kante.
float gridTrace(vec3 a, vec3 dir, float t0, float t1, vec3 origin, float voxel, ivec3 offset, ivec3 size) {
    vec3 shift = modelSkip > 0.0 ? vec3(0.0) : vec3(random(), random(), random()) - 0.5;
    vec3 p = (a + dir * t0 - origin) / voxel + shift;
    float len = (t1 - t0) / voxel;
    ivec3 cell = ivec3(floor(p));
    ivec3 stepDir = ivec3(sign(dir));
    vec3 safe = safeDirection(dir);
    vec3 tDelta = abs(1.0 / safe);
    vec3 tMax = (vec3(cell) + max(sign(dir), 0.0) - p) / safe;
    float t = 0.0;
    for (int i = 0; i < 2048; i++) {
        if (modelVoxel(cell, offset, size) && t0 + t * voxel >= modelSkip) return t0 + t * voxel;
        if (tMax.x < tMax.y && tMax.x < tMax.z) { t = tMax.x; tMax.x += tDelta.x; cell.x += stepDir.x; }
        else if (tMax.y < tMax.z) { t = tMax.y; tMax.y += tDelta.y; cell.y += stepDir.y; }
        else { t = tMax.z; tMax.z += tDelta.z; cell.z += stepDir.z; }
        if (t > len) return -1.0;
    }
    return -1.0;
}

// Durch alle Modelle, deren Kasten der Strahl zwischen t0 und t1 kreuzt:
// das nächste Voxel, -1: keins
float modelTrace(vec3 a, vec3 dir, float t0, float t1) {
    float best = -1.0;
    vec3 inv = 1.0 / safeDirection(dir);
    for (int i = 0; i < 256; i++) {
        if (i >= modelCount) break;
        vec4 g0 = texelFetch(modelGrids, ivec2(3 * i, 0), 0);
        ivec3 offset = ivec3(texelFetch(modelGrids, ivec2(3 * i + 1, 0), 0).xyz);
        ivec3 size = ivec3(texelFetch(modelGrids, ivec2(3 * i + 2, 0), 0).xyz);
        vec3 lo = g0.xyz, hi = g0.xyz + vec3(size) * g0.w;
        vec3 ta = (lo - a) * inv, tb = (hi - a) * inv;
        vec3 near = min(ta, tb), far = max(ta, tb);
        float s0 = max(t0, max(max(near.x, near.y), near.z));
        float s1 = min(best >= 0.0 ? best : t1, min(min(far.x, far.y), far.z));
        if (s1 <= s0) continue;
        float t = gridTrace(a, dir, s0, s1, g0.xyz, g0.w, offset, size);
        if (t >= 0.0) best = t;
    }
    return best;
}

// Liegt q in einem vollen Voxel eines Modells?
bool insideModel(vec3 q) {
    for (int i = 0; i < 256; i++) {
        if (i >= modelCount) break;
        vec4 g0 = texelFetch(modelGrids, ivec2(3 * i, 0), 0);
        ivec3 offset = ivec3(texelFetch(modelGrids, ivec2(3 * i + 1, 0), 0).xyz);
        ivec3 size = ivec3(texelFetch(modelGrids, ivec2(3 * i + 2, 0), 0).xyz);
        if (modelVoxel(ivec3(floor((q - g0.xyz) / g0.w)), offset, size)) return true;
    }
    return false;
}

// Wo trifft ein Strahl auf eine runde (oder ovale) Säule im Kasten lo bis hi?
// Im Grundriss ein Kreis: Wo ist der Strahl genau einen Radius von der Mitte
// entfernt (eine quadratische Gleichung)? Dazu oben und unten der Kasten.
float roundHit(vec3 a, vec3 dir, vec3 lo, vec3 hi) {
    vec2 center = (lo.xz + hi.xz) * 0.5, radius = (hi.xz - lo.xz) * 0.5;
    vec2 o = (a.xz - center) / radius, d = dir.xz / radius;   // als wäre sie ein Kreis mit Radius 1
    float A = dot(d, d), B = 2.0 * dot(o, d), C = dot(o, o) - 1.0;
    float t0 = -1e9, t1 = 1e9;
    if (A > 1e-10) {
        float disc = B * B - 4.0 * A * C;
        if (disc < 0.0) return -1.0;
        float root = sqrt(disc);
        t0 = (-B - root) / (2.0 * A);
        t1 = (-B + root) / (2.0 * A);
    } else if (C > 0.0) return -1.0;   // senkrecht, neben der Säule
    float y0 = -1e9, y1 = 1e9;
    if (abs(dir.y) > 1e-10) {
        float u0 = (lo.y - a.y) / dir.y, u1 = (hi.y - a.y) / dir.y;
        y0 = min(u0, u1);
        y1 = max(u0, u1);
    } else if (a.y < lo.y || a.y > hi.y) return -1.0;
    float tNear = max(t0, y0), tFar = min(t1, y1);
    return tFar < max(tNear, 0.0) ? -1.0 : max(tNear, 0.0);
}

// Wo ist ein Strahl im Zwickel einer runden Ecke c (im Quadrat zwischen Ecke
// und Mitte, weiter als der Radius von der Mitte)? Zwei Stücke von t, (x, y)
// und (z, w), leer, wo das erste größer ist als das zweite.
vec4 sliverSpans(vec3 a, vec3 dir, vec4 c) {
    float code = abs(c.w) - 1.0;
    vec2 q = vec2(mod(code, 2.0) < 0.5 ? 1.0 : -1.0, code < 1.5 ? 1.0 : -1.0);
    vec2 corner = c.xy - c.z * q;
    vec2 lo = min(corner, c.xy), hi = max(corner, c.xy);
    // im Quadrat: von b0 bis b1
    vec2 inv = 1.0 / vec2(abs(dir.x) < 1e-9 ? 1e-9 : dir.x, abs(dir.z) < 1e-9 ? 1e-9 : dir.z);
    vec2 s0 = (lo - a.xz) * inv, s1 = (hi - a.xz) * inv;
    float b0 = max(min(s0.x, s1.x), min(s0.y, s1.y)), b1 = min(max(s0.x, s1.x), max(s0.y, s1.y));
    // im Kreis: von k0 bis k1 (eine quadratische Gleichung wie bei roundHit)
    vec2 o = a.xz - c.xy, d = dir.xz;
    float A = dot(d, d), B = 2.0 * dot(o, d), C = dot(o, o) - c.z * c.z;
    float disc = B * B - 4.0 * A * C;
    if (A < 1e-12) return C < 0.0 ? vec4(1.0, 0.0, 1.0, 0.0) : vec4(b0, b1, 1.0, 0.0);   // senkrecht: ganz im Kreis oder ganz draußen
    if (disc <= 0.0) return vec4(b0, b1, 1.0, 0.0);
    float root = sqrt(disc);
    return vec4(b0, min(b1, (-B - root) / (2.0 * A)), max(b0, (-B + root) / (2.0 * A)), b1);
}

// um die senkrechte Achse gedreht, wie rotation.y in three.js
vec3 turnY(vec3 v, float angle) {
    float c = cos(angle), s = sin(angle);
    return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

// Wo trifft ein Strahl auf einen Quader? -1: gar nicht
float boxHit(vec3 a, vec3 dir, vec3 lo, vec3 hi) {
    vec3 inv = 1.0 / safeDirection(dir);
    vec3 t0 = (lo - a) * inv, t1 = (hi - a) * inv;
    vec3 near = min(t0, t1), far = max(t0, t1);
    float tNear = max(max(near.x, near.y), near.z), tFar = min(min(far.x, far.y), far.z);
    return tFar < max(tNear, 0.0) ? -1.0 : max(tNear, 0.0);
}

// Höhe einer Fläche (vier Ecken h) an der Stelle q im Feld (0 bis 1)
float cornerHeight(vec4 h, vec2 q) { return mix(mix(h.x, h.y, q.x), mix(h.z, h.w, q.x), q.y); }

// In welcher Schicht ist an der Stelle q des Felds cell auf Höhe y Luft?
// -1: in keiner, dort ist Wand, Boden oder Decke dazwischen
int layerAt(ivec2 cell, vec2 q, float y) {
    for (int k = 0; k < 8; k++) {
        if (k >= layerCount) break;
        ivec2 c = ivec2(cell.x, cell.y + k * int(cellCount.y));
        if (texelFetch(cellInfo, c, 0).r != 1.0) continue;
        if (y >= cornerHeight(texelFetch(cellFloor, c, 0), q) - 0.005 && y <= cornerHeight(texelFetch(cellCeiling, c, 0), q) + 0.005) return k;
    }
    return -1;
}

// Wie weit kommt ein Strahl von a in Richtung dir, bevor er auf etwas trifft?
// Feld für Feld durch den Grundriss (2D-DDA); in jedem Feld genau: Wand,
// Decke (auch schräg), Boden, Block, und in Feldern mit Modellen deren Voxel.
// Liegen Räume übereinander, gilt in jedem Feld der, in dessen Luft der
// Strahl hineinkommt. -1: bis maxLength nichts im Weg.
float trace(vec3 a, vec3 dir, float maxLength) {
    vec2 p = a.xz / cellMeters;
    vec2 d = dir.xz / cellMeters;
    ivec2 cell = ivec2(floor(p));
    ivec2 stepDir = ivec2(sign(d));
    vec2 safe = vec2(abs(d.x) < 1e-7 ? 1e-7 : d.x, abs(d.y) < 1e-7 ? 1e-7 : d.y);
    vec2 tDelta = abs(1.0 / safe);
    vec2 tMax = (vec2(cell) + max(sign(d), 0.0) - p) / safe;
    float tEnter = 0.0;
    for (int i = 0; i < 256; i++) {
        if (any(lessThan(cell, ivec2(0))) || any(greaterThanEqual(cell, ivec2(cellCount)))) return tEnter;
        float tExit = min(min(tMax.x, tMax.y), maxLength);
        vec2 q0 = clamp(p + d * tEnter - vec2(cell), 0.0, 1.0), q1 = clamp(p + d * tExit - vec2(cell), 0.0, 1.0);
        // nur eine Schicht (nichts übereinander): wie früher, ohne Suche
        int k = layerCount == 1 ? (texelFetch(cellInfo, cell, 0).r == 1.0 ? 0 : -1) : layerAt(cell, q0, a.y + dir.y * tEnter);
        if (k < 0) return tEnter;                               // Wand oder nichts
        ivec2 at = ivec2(cell.x, cell.y + k * int(cellCount.y));
        vec4 info = texelFetch(cellInfo, at, 0);
        float hit = 1e9;
        // die Decke: Abstand darunter am Anfang und am Ende des Stücks, dazwischen gerade
        vec4 h = texelFetch(cellCeiling, at, 0);
        float f0 = a.y + dir.y * tEnter - mix(mix(h.x, h.y, q0.x), mix(h.z, h.w, q0.x), q0.y);
        float f1 = a.y + dir.y * tExit - mix(mix(h.x, h.y, q1.x), mix(h.z, h.w, q1.x), q1.y);
        if (f0 >= 0.0) hit = tEnter;
        else if (f1 > 0.0) hit = tEnter + (tExit - tEnter) * (-f0) / (f1 - f0);
        // der Boden, auch schräg: Höhe über ihm am Anfang und am Ende des Stücks
        vec4 g = texelFetch(cellFloor, at, 0);
        float g0 = a.y + dir.y * tEnter - mix(mix(g.x, g.y, q0.x), mix(g.z, g.w, q0.x), q0.y);
        float g1 = a.y + dir.y * tExit - mix(mix(g.x, g.y, q1.x), mix(g.z, g.w, q1.x), q1.y);
        if (g0 <= 0.0) hit = min(hit, tEnter);
        else if (g1 < 0.0) hit = min(hit, tEnter + (tExit - tEnter) * g0 / (g0 - g1));
        // runde Ecken: innen ist der Zwickel Wand, außen ist nur er Luft
        vec4 round0 = texelFetch(cellRound0, at, 0);
        if (round0.w != 0.0) {
            float end = min(tExit, hit);
            vec4 round1 = texelFetch(cellRound1, at, 0);
            vec4 p0 = sliverSpans(a, dir, round0), p1 = round1.w != 0.0 ? sliverSpans(a, dir, round1) : vec4(1.0, 0.0, 1.0, 0.0);
            vec4 starts = vec4(p0.x, p0.z, p1.x, p1.z), ends = vec4(p0.y, p0.w, p1.y, p1.w);
            if (round0.w > 0.0) {
                // innen: der erste Zwickel auf dem Weg
                for (int i = 0; i < 4; i++) {
                    float s = max(starts[i], tEnter);
                    if (s <= ends[i] && s <= end) hit = min(hit, s);
                }
            } else {
                // außen: die erste Stelle, die in keinem Zwickel liegt; wer im
                // Zwickel das Feld verlässt, trifft hier nichts
                float t = tEnter;
                for (int n = 0; n < 4; n++) {
                    for (int i = 0; i < 4; i++) if (t >= starts[i] - 1e-5 && t < ends[i]) t = ends[i];
                }
                if (t < end - 1e-5) hit = min(hit, t);
            }
        }
        // eine runde Tür: Luft nur in ihrer Öffnung (gerade Seiten, oben ein
        // Halbkreis). Am Stück entlang in kleinen Schritten nachgesehen.
        vec4 arch = texelFetch(cellArch, at, 0);
        if (arch.x > 0.5) {
            float end = min(tExit, hit);
            for (int s = 0; s <= 8; s++) {
                float t = tEnter + (end - tEnter) * float(s) / 8.0;
                vec3 q = a + dir * t;
                float u = (arch.x < 1.5 ? q.x : q.z) - arch.y;
                if (abs(u) > arch.z || q.y > arch.w + sqrt(max(arch.z * arch.z - u * u, 0.0))) { hit = min(hit, t); break; }
            }
        }
        // eine Treppe: unter ihren Stufen ist kein Platz, am Stück entlang nachgesehen
        vec4 stairs = texelFetch(cellStairs, at, 0);
        if (stairs.x != 0.0) {
            float end = min(tExit, hit);
            float base = texelFetch(cellFloor, at, 0).x;
            for (int s = 0; s <= 8; s++) {
                float t = tEnter + (end - tEnter) * float(s) / 8.0;
                vec3 q = a + dir * t;
                float u = (abs(stairs.x) < 1.5 ? q.x : q.z) - stairs.y;
                if (stairs.x < 0.0) u = -u;
                if (q.y < base + (floor(max(u, 0.0) / stairs.z + 1e-4) + 1.0) * stairs.w) { hit = min(hit, t); break; }
            }
        }
        // ein Block
        if (info.b > 0.5) {
            vec4 top = texelFetch(blockMax, at, 0), low = texelFetch(blockMin, at, 0);
            // gedreht: der Strahl in die Richtung des geraden Blocks; t bleibt dasselbe
            vec3 middle = (low.xyz + top.xyz) * 0.5;
            vec3 la = middle + turnY(a - middle, -low.w), ld = turnY(dir, -low.w);
            float tBox = top.w > 1.5 ? roundHit(la, ld, low.xyz, top.xyz) : boxHit(la, ld, low.xyz, top.xyz);
            if (tBox >= 0.0 && tBox <= tExit) hit = min(hit, max(tBox, tEnter));
        }
        // ein Modell
        if (withModels && info.g > 0.5) {
            float tModel = modelTrace(a, dir, tEnter, min(tExit, hit));
            if (tModel >= 0.0) hit = min(hit, tModel);
        }
        if (hit <= tExit) return hit;
        if (tExit >= maxLength) return -1.0;
        if (tMax.x < tMax.y) { tEnter = tMax.x; tMax.x += tDelta.x; cell.x += stepDir.x; }
        else { tEnter = tMax.y; tMax.y += tDelta.y; cell.y += stepDir.y; }
    }
    return -1.0;
}

bool blocked(vec3 a, vec3 b) {
    float len = length(b - a);
    return len > 1e-4 && trace(a, (b - a) / len, len) >= 0.0;
}

// Eine zufällige Richtung über der Fläche, öfter steil als flach (so, wie
// Licht von einer matten Fläche ankommt)
vec3 hemisphere(vec3 n) {
    float r1 = random(), r2 = random();
    float phi = 6.2831853 * r1;
    vec3 tangent = normalize(abs(n.y) < 0.9 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
    vec3 bitangent = cross(n, tangent);
    return normalize(tangent * cos(phi) * sqrt(r2) + bitangent * sin(phi) * sqrt(r2) + n * sqrt(1.0 - r2));
}

// Liegt ein Punkt der Lightmap in einem Block (eine Säule, die in Boden
// und Decke steckt), rückt er auf der Fläche an den Rand des Blocks. Sonst
// wäre er schwarz, und beim Zeichnen, das benachbarte Punkte mischt, färbte
// das Schwarz rund um die Säule herum ab wie Schimmel.
vec3 outOfBox(vec3 p, vec3 n, vec3 lo, vec3 hi, bool isRound);
vec3 outOfBlocks(vec3 p, vec3 n) {
    ivec2 cell = ivec2(floor(p.xz / cellMeters));
    if (any(lessThan(cell, ivec2(0))) || any(greaterThanEqual(cell, ivec2(cellCount)))) return p;
    int k = layerAt(cell, p.xz / cellMeters - vec2(cell), p.y);
    if (k < 0) return p;
    ivec2 at = ivec2(cell.x, cell.y + k * int(cellCount.y));
    if (texelFetch(cellInfo, at, 0).b < 0.5) return p;
    vec4 low = texelFetch(blockMin, at, 0), top = texelFetch(blockMax, at, 0);
    if (low.w == 0.0) return outOfBox(p, n, low.xyz, top.xyz, top.w > 1.5);
    // gedreht: Stelle und Richtung zurückgedreht, das Ergebnis wieder hin
    vec3 middle = (low.xyz + top.xyz) * 0.5;
    vec3 q = outOfBox(middle + turnY(p - middle, -low.w), turnY(n, -low.w), low.xyz, top.xyz, top.w > 1.5);
    return middle + turnY(q - middle, low.w);
}
vec3 outOfBox(vec3 p, vec3 n, vec3 lo, vec3 hi, bool isRound) {
    if (any(lessThan(p, lo - 0.001)) || any(greaterThan(p, hi + 0.001))) return p;
    // eine runde Säule: im Kasten, aber neben dem Kreis ist nichts zu tun
    if (isRound) {
        // ihre eigene Fläche oben oder unten bleibt
        if ((p.y > hi.y - 0.002 && n.y > 0.5) || (p.y < lo.y + 0.002 && n.y < -0.5)) return p;
        vec2 q = (p.xz - (lo.xz + hi.xz) * 0.5) / ((hi.xz - lo.xz) * 0.5);
        if (dot(q, q) > 1.0 - 0.002) return p;
        // drinnen (ein Boden unter ihr): auf den Rand, in Richtung von der Mitte weg
        vec2 out2 = normalize(q + vec2(1e-4, 0.0)) * (1.0 + 0.02 / max(hi.x - lo.x, 0.01));
        return vec3((lo.xz + hi.xz).x * 0.5 + out2.x * (hi.x - lo.x) * 0.5, p.y, (lo.xz + hi.xz).y * 0.5 + out2.y * (hi.z - lo.z) * 0.5);
    }
    // Die Flächen des Blocks selbst liegen auf seinem Rand und zeigen aus ihm
    // heraus: die bleiben. Ein Boden unter einer Säule zeigt in sie hinein.
    for (int i = 0; i < 3; i++) {
        if (abs(n[i]) < 0.5) continue;
        if (p[i] < lo[i] + 0.002 && n[i] < 0.0) return p;
        if (p[i] > hi[i] - 0.002 && n[i] > 0.0) return p;
    }
    float best = 1e9;
    vec3 q = p;
    for (int i = 0; i < 3; i++) {
        if (abs(n[i]) > 0.5) continue;   // nur auf der Fläche, nicht von ihr weg
        float below = p[i] - lo[i], above = hi[i] - p[i];
        if (below < best) { best = below; q = p; q[i] = lo[i] - 0.01; }
        if (above < best) { best = above; q = p; q[i] = hi[i] + 0.01; }
    }
    return q;
}

// Ein Punkt der Lightmap von Boden oder Decke hinter dem Kreis einer runden
// Ecke (im Zwickel einer inneren, im Kreis einer äußeren) rückt auf den
// Kreis, knapp davor. Solche Punkte liegen am Rand: Ein Rechteck aus Boden
// wird ganz gebacken, auch wo es der Zwickel abschneidet, und beim Zeichnen
// mischen sich die Punkte am Kreis mit ihnen. Schwarz färbten sie ab wie bei
// einem Block (outOfBlocks).
vec3 outOfCorners(vec3 p, vec3 n) {
    if (abs(n.y) < 0.5) return p;
    ivec2 cell = ivec2(floor(p.xz / cellMeters));
    if (any(lessThan(cell, ivec2(0))) || any(greaterThanEqual(cell, ivec2(cellCount)))) return p;
    int k = layerAt(cell, p.xz / cellMeters - vec2(cell), p.y);
    if (k < 0) return p;
    ivec2 at = ivec2(cell.x, cell.y + k * int(cellCount.y));
    for (int i = 0; i < 2; i++) {
        vec4 c = i == 0 ? texelFetch(cellRound0, at, 0) : texelFetch(cellRound1, at, 0);
        if (c.w == 0.0) continue;
        float code = abs(c.w) - 1.0;
        vec2 q = vec2(mod(code, 2.0) < 0.5 ? 1.0 : -1.0, code < 1.5 ? 1.0 : -1.0);
        vec2 corner = c.xy - c.z * q;
        if (any(lessThan(p.xz, min(corner, c.xy) - 1e-4)) || any(greaterThan(p.xz, max(corner, c.xy) + 1e-4))) continue;
        vec2 o = p.xz - c.xy;
        float d = max(length(o), 1e-6);
        if (c.w > 0.0 && d > c.z - 0.01) { vec2 xz = c.xy + o / d * (c.z - 0.02); return vec3(xz.x, p.y, xz.y); }
        if (c.w < 0.0 && d < c.z + 0.01) { vec2 xz = c.xy + o / d * (c.z + 0.02); return vec3(xz.x, p.y, xz.y); }
    }
    return p;
}

// Die Stelle, von der die Strahlen ausgehen: auf der Fläche, etwas davor.
// Wände, Decken und Blöcke sind genau: 2 cm genügen.
vec3 surfacePoint(out vec3 n) {
    n = normalize(vNormal);
    vec3 inset = 0.01 * (1.0 - abs(n));
    vec3 p = outOfCorners(outOfBlocks(clamp(vWorld, vMin + inset, vMax - inset), n), n);
    return p + n * 0.02;
}
`;

// 1. Direktes Licht
const directShader = common + /* glsl */ `
layout(location = 0) out vec4 steady;    // Licht der ruhigen Leuchten und Umgebungslicht
layout(location = 1) out vec4 flicker;   // Licht der flackernden, ein Kanal für bis zu drei Gruppen

uniform sampler2D lights;
uniform int lightCount;
uniform vec3 ambientColor;

void main() {
    state = uint(gl_FragCoord.x) * 1973u + uint(gl_FragCoord.y) * 9277u + pass * 26699u;
    vec3 n;
    vec3 start = surfacePoint(n);
    vec3 light = vec3(0.0);
    vec4 flickering = vec4(0.0);
    // Ein Strahl je Leuchte und Durchgang, auch wo die Lichtkarte feiner ist
    // (bei Modellen): Mehr Proben dort kosteten die meiste Zeit beim Backen,
    // und mit den Feldern auf der Leuchte braucht es sie nicht. Die Schleife
    // bleibt so gebaut (k bis 8, i bis 1024): Anders gebaut, wurde der
    // Shader auf der Grafikkarte so langsam, dass sie aufgab.
    int samples = 1;

    for (int k = 0; k < 8; k++) {
    if (k >= samples) break;
    for (int i = 0; i < 1024; i++) {
        if (i >= lightCount) break;
        vec4 a = texelFetch(lights, ivec2(3 * i, 0), 0);
        vec4 b = texelFetch(lights, ivec2(3 * i + 1, 0), 0);
        vec4 c = texelFetch(lights, ivec2(3 * i + 2, 0), 0);
        int channel = int(c.r);
        float range = c.g;
        vec3 toCenter = a.xyz - start;
        float distance = length(toCenter);
        if (distance > range) continue;
        float fade = 1.0 - smoothstep(0.7 * range, range, distance);
        // ein Punkt auf der Leuchte: im Feld cell, das dieser Punkt der
        // Lichtkarte in diesem Durchgang dran hat (pass · 37 trifft in 64
        // Durchgängen jedes Feld einmal; der Versatz je Punkt und Leuchte, damit
        // Nachbarn nicht gleichzeitig dasselbe Feld nehmen). Nur mit float:
        // Mit uint und Bit-Operationen hier wurde der Shader viel zu langsam.
        float cell = mod(float(pass) * 37.0 + mod(floor(gl_FragCoord.x) * 13.0 + floor(gl_FragCoord.y) * 29.0 + float(i) * 7.0, 64.0), 64.0);
        lampSample = (vec2(mod(cell, 8.0), floor(cell / 8.0)) + vec2(random(), random())) / 8.0;
        vec3 s = lightPoint(a, b, c);
        vec3 l = s - start;
        float d2 = dot(l, l);
        l /= sqrt(d2);
        float atSurface = dot(n, l);      // wie schräg das Licht auf die Fläche fällt
        float atLamp = lightFacing(a, c, l);     // am meisten senkrecht vor der Leuchte
        if (atSurface <= 0.0 || atLamp <= 0.0) continue;
        if (blocked(start, shadowEnd(a, s, l))) continue;
        vec3 amount = b.rgb * atSurface * atLamp * lightArea(a, b) / (3.14159 * d2 + 0.05) * fade;
        if (channel < 0) light += amount;
        else flickering[channel] += dot(amount, vec3(0.2126, 0.7152, 0.0722));   // nur wie hell, die Farbe hat der Kanal
    }
    }
    light /= float(samples);
    flickering /= float(samples);

    // Wie offen die Stelle ist: zwei kurze Strahlen (80 cm) in die Halbkugel.
    // In Ecken treffen sie oft etwas; das dunkelt das Bounce-Licht dort ab
    // (Ambient Occlusion, im Alphakanal), und das Licht von überall auch.
    // Was nah ist, dunkelt mehr ab, was weiter weg ist, weniger, und zwar
    // sanft: So läuft der Schatten weich und breit aus, ohne schwarze Linie
    // dort, wo zwei Flächen sich treffen, und ohne Kante bei 80 cm.
    float open = 0.0;
    for (int r = 0; r < 16; r++) {
        if (r >= 2 * samples) break;
        vec3 dir = hemisphere(n);
        float t = trace(start, dir, 0.8);
        float near = t < 0.0 ? 0.0 : 1.0 - smoothstep(0.0, 0.8, t);
        open += 1.0 - near;
    }
    open /= float(2 * samples);
    light += ambientColor * vAmbient * open;

    steady = vec4(light, open);
    flicker = flickering;
}`;

// Das Licht in den Zellen: Schichten nebeneinander in einer Textur
const cellUniforms = /* glsl */ `
uniform sampler2D cells;      // das abgegebene Licht, Schicht für Schicht nebeneinander
uniform vec3 bounceCells;
uniform float cellSize;
uniform int perRow;           // so viele Schichten liegen in einer Reihe
uniform float cellBottom;     // die unterste Schicht beginnt am tiefsten Boden
`;

const cellLightCode = /* glsl */ `
vec4 cellSum(ivec3 c) {
    if (any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, ivec3(bounceCells)))) return vec4(0.0);
    ivec2 slot = ivec2(c.x + (c.z % perRow) * int(bounceCells.x), c.y + (c.z / perRow) * int(bounceCells.y));
    return texelFetch(cells, slot, 0);
}

// Das Licht an einer Stelle, zwischen den acht nächsten Zellen gemischt;
// Zellen, in die nichts abgegeben wurde, zählen nicht mit.
vec3 cellLight(vec3 q) {
    vec3 g = (q - vec3(0.0, cellBottom, 0.0)) / cellSize - 0.5;
    ivec3 base = ivec3(floor(g));
    vec3 f = g - vec3(base);
    vec3 sum = vec3(0.0);
    float weight = 0.0;
    for (int i = 0; i < 8; i++) {
        ivec3 o = ivec3(i & 1, (i >> 1) & 1, (i >> 2) & 1);
        vec4 c = cellSum(base + o);
        if (c.a <= 0.0) continue;
        vec3 t = mix(1.0 - f, f, vec3(o));
        float w = t.x * t.y * t.z;
        sum += c.rgb / c.a * w;
        weight += w;
    }
    return weight > 0.0 ? sum / weight : vec3(0.0);
}

`;

// 3. Sammeln: ein Strahl pro Punkt und Durchgang, das Licht der Zelle vor
// der Stelle, wo er auftrifft
const gatherShader = common + cellUniforms + /* glsl */ `
layout(location = 0) out vec4 bounced;


${cellLightCode}
void main() {
    state = uint(gl_FragCoord.x) * 7907u + uint(gl_FragCoord.y) * 4723u + pass * 15671u + 977u;
    vec3 n;
    vec3 start = surfacePoint(n);
    vec3 light = vec3(0.0);
    for (int r = 0; r < ${RAYS}; r++) {
        vec3 dir = hemisphere(n);
        // Boden und oberste Decke begrenzen jeden Strahl
        float bound = dir.y < -1e-4 ? (bottom - start.y) / dir.y : dir.y > 1e-4 ? (top - start.y) / dir.y : 1e4;
        float t = trace(start, dir, min(bound, 24.0));
        if (t < 0.0) t = bound <= 24.0 ? bound : -1.0;
        if (t >= 0.0) light += cellLight(start + dir * max(t - 0.06, 0.0));
    }
    bounced = vec4(light / float(${RAYS}), 1.0);
}`;

// Lichtproben für Modelle: für jede Probe sechs Richtungen (±x, ±y, ±z),
// in jede viele Strahlen; was sie treffen, bringt sein Licht mit.
const probeVertexShader = /* glsl */ `
in vec3 position;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vMin;
out vec3 vMax;
out float vAmbient;
out vec3 vAlbedo;
out float vDensity;
void main() {
    vWorld = vec3(0.0); vNormal = vec3(0.0, 1.0, 0.0); vMin = vec3(0.0); vMax = vec3(0.0); vAmbient = 0.0; vAlbedo = vec3(0.0); vDensity = 1.0;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const probeShader = common + cellUniforms + /* glsl */ `
${cellLightCode}
layout(location = 0) out vec4 outColor;
uniform sampler2D probes;
void main() {
    int index = int(gl_FragCoord.x);
    int axis = index % 6;
    vec3 p = texelFetch(probes, ivec2(index / 6, 0), 0).xyz;
    vec3 n = axis == 0 ? vec3(1, 0, 0) : axis == 1 ? vec3(-1, 0, 0) : axis == 2 ? vec3(0, 1, 0)
        : axis == 3 ? vec3(0, -1, 0) : axis == 4 ? vec3(0, 0, 1) : vec3(0, 0, -1);
    state = uint(index) * 7919u + pass * 104729u + 31u;
    vec3 light = vec3(0.0);
    for (int r = 0; r < 16; r++) {
        vec3 dir = hemisphere(n);
        float bound = dir.y < -1e-4 ? -p.y / dir.y : dir.y > 1e-4 ? (top - p.y) / dir.y : 1e4;
        float t = trace(p, dir, min(bound, 24.0));
        if (t < 0.0) t = bound <= 24.0 ? bound : -1.0;
        if (t >= 0.0) light += cellLight(p + dir * max(t - 0.06, 0.0));
    }
    outColor = vec4(light / 16.0, 1.0);
}`;

// Entrauschen: Jeder Punkt mischt sich mit seinen Nachbarn in der
// Lichtkarte, aber nur mit solchen, die im Raum nah liegen und in dieselbe
// Richtung zeigen. So verwischt nichts über Kanten und nichts mit einem
// Nachbarrechteck, das zu einer ganz anderen Wand gehört.
const denoiseShader = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D source;
uniform sampler2D surfacePosition;
uniform sampler2D surfaceNormal;
uniform int spacing;
uniform int atlasSize;
out vec4 outColor;
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    vec4 p0 = texelFetch(surfacePosition, c, 0);
    vec4 own = texelFetch(source, c, 0);
    if (p0.w < 0.5) { outColor = own; return; }
    vec3 n0 = texelFetch(surfaceNormal, c, 0).xyz;
    float kernel[3] = float[3](0.375, 0.25, 0.0625);
    vec3 sum = vec3(0.0);
    float weight = 0.0;
    for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
            ivec2 q = clamp(c + ivec2(dx, dy) * spacing, ivec2(0), ivec2(atlasSize - 1));
            vec4 p = texelFetch(surfacePosition, q, 0);
            if (p.w < 0.5) continue;
            if (dot(texelFetch(surfaceNormal, q, 0).xyz, n0) < 0.9) continue;
            float d = distance(p.xyz, p0.xyz);
            float reach = 0.15 * float(spacing);
            if (d > reach * 2.0) continue;
            float w = kernel[abs(dx)] * kernel[abs(dy)] * exp(-d * d / (reach * reach));
            sum += texelFetch(source, q, 0).rgb * w;
            weight += w;
        }
    }
    outColor = vec4(weight > 0.0 ? sum / weight : own.rgb, own.a);
}`;

// Licht für die Ecken von Modellen, wie die Lichtkarte, aber mit den Modellen
// selbst im Raster: Falten werfen Schatten aufeinander und bekommen weniger
// Bounce-Licht. Jeder Bildpunkt ist eine Ecke; Stelle und Richtung kommen aus
// zwei Texturen.
const vertexLightShader = common + cellUniforms + /* glsl */ `
${cellLightCode}
layout(location = 0) out vec4 outColor;
uniform sampler2D vertexPositions;
uniform sampler2D vertexNormals;
uniform int vertexCount;
uniform int rowLength;
uniform sampler2D lights;
uniform int lightCount;
uniform bool wantDirect;     // direktes Licht oder Bounce-Licht: einzeln, damit man beide getrennt an- und ausschalten kann
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    int index = c.y * rowLength + c.x;
    if (index >= vertexCount) { outColor = vec4(0.0); return; }
    vec3 n = normalize(texelFetch(vertexNormals, c, 0).xyz);
    // Der Strahl beginnt im ersten freien Voxel vor der Fläche: Schritt für
    // Schritt entlang der Richtung der Fläche nach außen. Fest 10 cm landeten
    // in engen Falten schon in der gegenüberliegenden Falte.
    vec3 surface = texelFetch(vertexPositions, c, 0).xyz;
    vec3 start = surface + n * 0.1;
    for (int k = 1; k <= 15; k++) {
        vec3 q = surface + n * (0.01 * float(k));
        if (!insideModel(q)) { start = q + n * 0.005; break; }
    }
    state = uint(index) * 9781u + pass * 6271u + 13u;
    modelSkip = 0.08;
    vec3 light = vec3(0.0);
    for (int i = 0; i < 1024; i++) {
        if (i >= lightCount || !wantDirect) break;
        vec4 a = texelFetch(lights, ivec2(3 * i, 0), 0);
        vec4 b = texelFetch(lights, ivec2(3 * i + 1, 0), 0);
        vec4 e = texelFetch(lights, ivec2(3 * i + 2, 0), 0);
        float range = e.g;
        float distance = length(a.xyz - start);
        if (distance > range) continue;
        float fade = 1.0 - smoothstep(0.7 * range, range, distance);
        vec3 s = lightPoint(a, b, e);
        vec3 l = s - start;
        float d2 = dot(l, l);
        l /= sqrt(d2);
        float atSurface = dot(n, l), atLamp = lightFacing(a, e, l);
        if (atSurface <= 0.0 || atLamp <= 0.0) continue;
        if (blocked(start, shadowEnd(a, s, l))) continue;
        vec3 amount = b.rgb * atSurface * atLamp * lightArea(a, b) / (3.14159 * d2 + 0.05) * fade;
        light += e.r < 0.0 ? amount : amount;   // flackernde Leuchten zählen hier ruhig
    }
    // Bounce-Licht: Strahlen in die Halbkugel über der Fläche
    for (int r = 0; r < 4; r++) {
        if (wantDirect) break;
        vec3 dir = hemisphere(n);
        float bound = dir.y < -1e-4 ? (bottom - start.y) / dir.y : dir.y > 1e-4 ? (top - start.y) / dir.y : 1e4;
        float t = trace(start, dir, min(bound, 24.0));
        if (t < 0.0) t = bound <= 24.0 ? bound : -1.0;
        if (t >= 0.0) light += cellLight(start + dir * max(t - 0.06, 0.0)) * 0.25;
    }
    outColor = vec4(light, 1.0);
}`;

const surfaceShader = /* glsl */ `
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec3 vMin;
in vec3 vMax;
in float vAmbient;
in vec3 vAlbedo;
layout(location = 0) out vec4 position;
layout(location = 1) out vec4 normal;
layout(location = 2) out vec4 albedo;
void main() {
    vec3 n = normalize(vNormal);
    vec3 inset = 0.01 * (1.0 - abs(n));
    position = vec4(clamp(vWorld, vMin + inset, vMax - inset), 1.0);
    normal = vec4(n, 0.0);
    albedo = vec4(vAlbedo, 0.0);
}`;

// 2. Abgeben: jeder Punkt der Lichtkarte ein Pixel, in der Zelle vor seiner
// Fläche, mit seinem Licht mal der Farbe der Fläche. Die Zelle zählt mit
// (alpha), am Ende zählt der Mittelwert.
const injectVertexShader = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D surfacePosition;
uniform sampler2D surfaceNormal;
uniform sampler2D surfaceAlbedo;
uniform sampler2D direct;
uniform sampler2D flicker;           // das Licht der flackernden Leuchten, je Kanal wie hell
uniform vec3 channelColor[4];
uniform sampler2D indirect;
uniform float directScale;
uniform float indirectScale;
uniform int atlasSize;
uniform vec3 bounceCells;
uniform float cellSize;
uniform int perRow;
uniform float cellBottom;
uniform vec2 flatSize;
out vec3 vLight;
void main() {
    ivec2 t = ivec2(gl_VertexID % atlasSize, gl_VertexID / atlasSize);
    vec4 p = texelFetch(surfacePosition, t, 0);
    if (p.w < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec3 n = texelFetch(surfaceNormal, t, 0).xyz;
    vec3 albedo = texelFetch(surfaceAlbedo, t, 0).rgb;
    // ein Detailstück (Albedo -1): Seine Fläche gibt das Licht schon ab
    if (albedo.r < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    // auch flackernde Leuchten werfen Licht zurück, so hell, als brennten sie ruhig
    vec4 f = texelFetch(flicker, t, 0);
    vec3 flickering = f.x * channelColor[0] + f.y * channelColor[1] + f.z * channelColor[2] + f.w * channelColor[3];
    vec3 light = (texelFetch(direct, t, 0).rgb + flickering) * directScale + texelFetch(indirect, t, 0).rgb * indirectScale;
    vLight = albedo * light;
    ivec3 c = clamp(ivec3(floor((p.xyz + n * cellSize * 0.5 - vec3(0.0, cellBottom, 0.0)) / cellSize)), ivec3(0), ivec3(bounceCells) - 1);
    vec2 slot = vec2(c.x + (c.z % perRow) * int(bounceCells.x), c.y + (c.z / perRow) * int(bounceCells.y)) + 0.5;
    gl_Position = vec4(slot / flatSize * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = 1.0;
}`;

const injectFragmentShader = /* glsl */ `
precision highp float;
in vec3 vLight;
out vec4 outColor;
void main() { outColor = vec4(vLight, 1.0); }`;

const additive = {
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
};

// eine schwarze Textur, solange es noch keine Lightmap gibt
let black = null;
function nothing() {
    if (!black) {
        black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
        black.needsUpdate = true;
    }
    return black;
}

function target(size, options = {}) {
    const [width, height] = [size].flat().length === 2 ? size : [size, size];
    return new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        generateMipmaps: false,
        ...options,
    });
}

// Ein Zeichen in der Warteschlange der Grafikkarte (WebGL2-Fence): done sagt,
// ob sie alles, was davor geschickt wurde, schon gezeichnet hat, took, wie
// lange das gedauert hat (in ms), at, wann sie damit fertig war. Der Browser schickt Arbeit nur ab; ohne
// dieses Zeichen sammelte sie sich an, bis die Grafikkarte sekundenlang
// nichts anderes tut, auch nicht den Bildschirm. Nachgesehen wird alle
// 2 ms, nicht nur einmal je Bild: Gibt der Browser selten Bilder (ein
// verdeckter Tab, ein Bildgenerator), wäre took sonst immer so lang wie ein
// Bild, und das Backen hielte die Grafikkarte für überlastet.
export function gpuMark(renderer) {
    const gl = renderer.getContext();
    const sync = gl.isContextLost() ? null : gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const started = performance.now();
    let took = sync ? null : 0, at = sync ? null : started;
    const check = () => {
        if (took === null && (gl.isContextLost() || gl.clientWaitSync(sync, 0, 0) !== gl.TIMEOUT_EXPIRED)) {
            at = performance.now();
            took = at - started;
            if (!gl.isContextLost()) gl.deleteSync(sync);
        }
        return took !== null;
    };
    const poll = () => { if (!check()) setTimeout(poll, 2); };
    if (sync) setTimeout(poll, 2);
    return {
        get done() { return check(); },
        get took() { return took ?? performance.now() - started; },
        get at() { check(); return at; },
    };
}

export class LightBaker {
    // voxels: das Raster aus buildGrid, oder eine Funktion, die es baut.
    // Vorbereitet (Raster, Render-Targets, Shader) wird erst, wenn wirklich
    // gebacken wird: Mit gespeichertem Licht braucht es nichts davon, und
    // auf einem Handy oder einer VR-Brille spart das Zeit und Speicher.
    constructor(renderer, level, geometry, voxels, lights, bounces = 3) {
        this.bounces = bounces;   // wie oft das Licht zurückgeworfen wird (bounces in level.ini)
        this.renderer = renderer;
        this.lights = lights;
        this.level = level;
        this.geometry = geometry;
        this.voxelSource = voxels;
        this.atlasSize = geometry.atlasSize;
        this.tileSize = Math.min(TILE, this.atlasSize);
        this.wantedTile = this.tileSize;
        this.prepared = false;
        this.saved = null;
        this.on = null;           // welche Leuchten an sind (switchLights)
        this.resetCounters();
    }

    // Bereit zum Backen: erst das Raster (das dauert, aber die Seite bleibt
    // bedienbar), dann alles für die Grafikkarte. Mehrfach gerufen: einmal.
    prepare() {
        this.preparing ??= (async () => {
            const voxels = typeof this.voxelSource === 'function' ? await this.voxelSource() : this.voxelSource;
            this.build(voxels);
            this.prepared = true;
        })();
        return this.preparing;
    }

    build(voxels) {
        const { renderer, level, geometry, lights } = this;
        const size = this.atlasSize;
        // direktes Licht: ruhig und flackernd; abgeprallt: zwei, eines wird
        // gesammelt, das andere ist die letzte fertige Reflexion
        this.directTarget = target(size, { count: 2 });
        this.indirectTargets = [target(size), target(size)];
        this.denoiseTarget = target(size);
        this.surfaceTarget = target(size, { count: 3, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });

        // das grobe Raster für das abgegebene Licht, Schicht für Schicht nebeneinander
        const cellCount = new THREE.Vector3(
            Math.ceil(voxels.cells.x * voxels.cell / CELL), Math.ceil((geometry.maxHeight - geometry.minHeight + 0.5) / CELL), Math.ceil(voxels.cells.y * voxels.cell / CELL));
        // so breit, wie die Grafikkarte Texturen erlaubt: auf Handys und Tablets
        // oft nur 4096 Pixel; mehr ließe das Bounce-Licht stillschweigend weg
        const widest = Math.min(8192, renderer.capabilities.maxTextureSize);
        const perRow = Math.max(1, Math.min(cellCount.z, Math.floor(widest / cellCount.x)));
        const flatSize = new THREE.Vector2(cellCount.x * perRow, cellCount.y * Math.ceil(cellCount.z / perRow));
        if (flatSize.x > widest || flatSize.y > widest) console.warn(`The bounce light needs ${flatSize.x} × ${flatSize.y} pixels, this graphics card allows ${widest}: the level is too big for it.`);
        this.cellTarget = target([flatSize.x, flatSize.y], { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });

        const ambient = new THREE.Color('#d8c890');
        const grid = {
            voxels: { value: voxels.voxels },
            modelGrids: { value: voxels.modelGrids },
            modelCount: { value: voxels.modelCount },
            cellInfo: { value: voxels.info },
            layerCount: { value: voxels.layers },
            cellCeiling: { value: voxels.ceilings },
            cellFloor: { value: voxels.floors },
            bottom: { value: geometry.minHeight - 0.01 },
            blockMin: { value: voxels.blockMin },
            blockMax: { value: voxels.blockMax },
            cellArch: { value: voxels.arches },
            cellStairs: { value: voxels.stairs },
            cellRound0: { value: voxels.rounds[0] },
            cellRound1: { value: voxels.rounds[1] },
            cellCount: { value: voxels.cells },
            cellMeters: { value: voxels.cell },
            top: { value: geometry.maxHeight + 0.01 },
            pass: { value: 0 },
            withModels: { value: true },
        };
        const material = (fragmentShader, uniforms, extra = {}) => new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: bakeVertexShader,
            fragmentShader,
            uniforms: { ...grid, ...uniforms },
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false,
            ...extra,
        });
        this.directMaterial = material(directShader, {
            lights: { value: lightTexture(lights) },
            lightCount: { value: lights.length },
            ambientColor: { value: new THREE.Vector3(ambient.r, ambient.g, ambient.b) },
        }, additive);
        const cells = {
            bounceCells: { value: cellCount },
            cellSize: { value: CELL },
            perRow: { value: perRow },
            cellBottom: { value: geometry.minHeight - 0.25 },
        };
        this.gatherMaterial = material(gatherShader, { cells: { value: this.cellTarget.texture }, ...cells }, additive);
        this.surfaceMaterial = material(surfaceShader, {});

        this.denoiseMaterial = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: /* glsl */ `
                in vec3 position;
                void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
            fragmentShader: denoiseShader,
            uniforms: {
                source: { value: null },
                surfacePosition: { value: this.surfaceTarget.textures[0] },
                surfaceNormal: { value: this.surfaceTarget.textures[1] },
                spacing: { value: 1 },
                atlasSize: { value: size },
            },
            depthTest: false,
            depthWrite: false,
        });
        this.denoiseScene = new THREE.Scene();
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.denoiseMaterial);
        quad.frustumCulled = false;
        this.denoiseScene.add(quad);

        // Für jeden Durchgang dieselben Flächen, nur mit anderem Shader
        this.scene = new THREE.Scene();
        this.faces = [];
        for (const { bake } of geometry.meshes) {
            const mesh = new THREE.Mesh(bake, this.directMaterial);
            mesh.frustumCulled = false;
            this.scene.add(mesh);
            this.faces.push(mesh);
        }
        this.camera = new THREE.Camera();

        // Abgeben: so viele Punkte wie die Lichtkarte Texel hat
        const points = new THREE.BufferGeometry();
        points.setAttribute('position', new THREE.BufferAttribute(new Float32Array(size * size), 1));
        points.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);   // die Punkte liegen erst im Shader fest
        this.injectMaterial = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: injectVertexShader,
            fragmentShader: injectFragmentShader,
            uniforms: {
                surfacePosition: { value: this.surfaceTarget.textures[0] },
                surfaceNormal: { value: this.surfaceTarget.textures[1] },
                surfaceAlbedo: { value: this.surfaceTarget.textures[2] },
                direct: { value: this.directTarget.textures[0] },
                flicker: { value: this.directTarget.textures[1] },
                channelColor: { value: channelColors(lights, 4) },
                indirect: { value: this.indirectTargets[1].texture },
                directScale: { value: 0 },
                indirectScale: { value: 0 },
                atlasSize: { value: size },
                flatSize: { value: flatSize },
                ...cells,
            },
            depthTest: false,
            depthWrite: false,
            ...additive,
        });
        this.injectPoints = points;
        this.injectScene = new THREE.Scene();
        const cloud = new THREE.Points(points, this.injectMaterial);
        cloud.frustumCulled = false;
        this.injectScene.add(cloud);

        // Stelle, Richtung und Farbe jedes Punkts: einmal, sie ändern sich nicht
        this.draw(this.surfaceTarget, this.surfaceMaterial, true);
        if (this.on) lightTexture(this.lights, this.on, this.directMaterial.uniforms.lights.value);
        this.reset();
    }

    // Zeichnet alle Flächen mit diesem Shader in dieses Ziel
    draw(renderTarget, material, clear = false, rect = null) {
        const renderer = this.renderer;
        const xr = renderer.xr.enabled;
        renderer.xr.enabled = false;
        const previous = renderer.getRenderTarget();
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        for (const mesh of this.faces) mesh.material = material;
        renderer.setRenderTarget(renderTarget);
        if (clear) {
            renderer.setClearColor(0x000000, 0);
            renderer.clear();
        }
        const scene = material === this.injectMaterial ? this.injectScene : material === this.denoiseMaterial ? this.denoiseScene : this.scene;
        if (rect) {
            renderTarget.scissor.set(...rect);
            renderTarget.scissorTest = true;
            renderer.setRenderTarget(renderTarget);   // übernimmt den Ausschnitt
        }
        renderer.render(scene, this.camera);
        renderTarget.scissorTest = false;
        renderer.setRenderTarget(previous);
        renderer.autoClear = autoClear;
        renderer.xr.enabled = xr;
    }

    clear(renderTarget) {
        const renderer = this.renderer;
        const previous = renderer.getRenderTarget();
        renderer.setRenderTarget(renderTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.setRenderTarget(previous);
    }

    // Von vorn anfangen
    reset() {
        if (this.prepared) {
            this.clear(this.directTarget);
            for (const t of this.indirectTargets) this.clear(t);
        }
        this.resetCounters();
    }

    resetCounters() {
        this.tile = 0;             // das wievielte Stück des Durchgangs als Nächstes
        this.passStarted = performance.now();   // wann der laufende Durchgang anfing
        this.directPasses = 0;
        this.bounce = 0;           // die wievielte Reflexion gerade gesammelt wird (0: noch keine)
        this.gatherPasses = 0;
        this.finishedPasses = 0;   // Durchgänge der letzten fertigen Reflexion
        this.injected = 0;         // wie viele Punkte ihr Licht schon in die Zellen gegeben haben
    }

    // Welche Leuchten an sind; danach fängt das Backen von vorn an.
    switchLights(on) {
        this.on = [...on];
        if (this.prepared) lightTexture(this.lights, on, this.directMaterial.uniforms.lights.value);
        this.reset();
    }

    // ob das direkte Licht fertig ist und schon Bounce-Licht gesammelt wird
    get bouncing() {
        return this.saved ? true : this.directPasses >= DIRECT_PASSES;
    }

    get done() {
        return this.saved ? true : this.bounce > this.bounces;
    }

    // ein Schritt Arbeit: ein Stück eines Durchgangs direktes Licht oder Sammeln
    step() {
        if (this.done) return;
        if (!this.prepared) { this.prepare(); return; }   // noch nicht bereit: erst das Raster
        const rect = this.tileRect();
        if (this.directPasses < DIRECT_PASSES) {
            this.directMaterial.uniforms.pass.value = this.directPasses;
            this.draw(this.directTarget, this.directMaterial, false, rect);
            if (!this.nextTile()) return;
            this.directPasses += 1;
            if (this.directPasses === DIRECT_PASSES) this.startBounce();
            return;
        }
        // erst geben alle Punkte ihr Licht in die Zellen, in Portionen: auf
        // einmal (bei 2048² über vier Millionen Punkte) dauerte es manchen
        // Grafikkarten zu lange
        if (this.injected < this.atlasSize * this.atlasSize) {
            this.injectPoints.setDrawRange(this.injected, INJECT_CHUNK);
            this.draw(this.cellTarget, this.injectMaterial);
            this.injected += INJECT_CHUNK;
            return;
        }
        this.gatherMaterial.uniforms.pass.value = this.bounce * 1000 + this.gatherPasses;
        this.draw(this.indirectTargets[0], this.gatherMaterial, false, rect);
        if (!this.nextTile()) return;
        this.gatherPasses += 1;
        if (this.gatherPasses === BOUNCE_PASSES) {
            // fertig: entrauschen, in drei Runden mit wachsendem Abstand, in die
            // angezeigte Lichtkarte; von ihr aus prallt es weiter ab
            const [current, finished] = this.indirectTargets;
            const steps = [[current, this.denoiseTarget, 1], [this.denoiseTarget, current, 2], [current, finished, 4]];
            for (const [from, into, spacing] of steps) {
                this.denoiseMaterial.uniforms.source.value = from.texture;
                this.denoiseMaterial.uniforms.spacing.value = spacing;
                this.draw(into, this.denoiseMaterial, true);
            }

            this.finishedPasses = this.gatherPasses;
            this.startBounce();
        }
    }

    // die Stücke eines Durchgangs: Reihe für Reihe über die Lightmap
    get tilesPerPass() {
        const n = Math.ceil(this.atlasSize / this.tileSize);
        return n * n;
    }

    tileRect() {
        const n = Math.ceil(this.atlasSize / this.tileSize), size = this.tileSize;
        return [(this.tile % n) * size, Math.floor(this.tile / n) * size, size, size];
    }

    // weiter zum nächsten Stück; true, wenn damit der Durchgang fertig ist.
    // Kleinere Stücke erst ab dem nächsten Durchgang, damit keins fehlt.
    nextTile() {
        this.tile += 1;
        if (this.tile < this.tilesPerPass) return false;
        this.tile = 0;
        this.passStarted = performance.now();
        this.tileSize = this.wantedTile;
        return true;
    }

    // Ein Stück dauert zu lange: ab dem nächsten Durchgang halb so groß
    smallerTiles() {
        if (this.wantedTile > SMALLEST_TILE) this.wantedTile /= 2;
    }

    startBounce() {
        this.bounce += 1;
        // die Stücke wieder groß: wurden sie beim direkten Licht kleiner (ein
        // Bild dauerte zu lange), müssten sonst alle Reflexionen mit ihnen auskommen
        this.wantedTile = Math.min(TILE, this.atlasSize);
        this.gatherPasses = 0;
        if (this.done) return;
        // abgeben: direktes Licht plus die letzte fertige Reflexion
        const u = this.injectMaterial.uniforms;
        u.directScale.value = 1 / this.directPasses;
        u.indirect.value = this.indirectTargets[1].texture;
        u.indirectScale.value = this.finishedPasses ? 1 / this.finishedPasses : 0;
        this.clear(this.cellTarget);
        this.injected = 0;   // step() gibt das Licht in die Zellen
        this.clear(this.indirectTargets[0]);
    }

    // Wie weit, von 0 bis 1, und was gerade passiert
    get progress() {
        if (this.saved) return 1;
        const passes = this.directPasses + Math.max(0, this.bounce - 1) * BOUNCE_PASSES + this.gatherPasses + this.tile / this.tilesPerPass;
        return Math.min(1, passes / (DIRECT_PASSES + this.bounces * BOUNCE_PASSES));
    }

    get stage() {
        if (!this.prepared) return 'preparing the models';
        if (this.directPasses < DIRECT_PASSES) return `direct light, pass ${this.directPasses} of ${DIRECT_PASSES}`;
        if (this.done) return null;
        if (this.injected < this.atlasSize * this.atlasSize) return `bounce ${this.bounce} of ${this.bounces}, light into the cells (${Math.round(100 * this.injected / this.atlasSize ** 2)} %)`;
        return `bounce ${this.bounce} of ${this.bounces}, pass ${this.gatherPasses} of ${BOUNCE_PASSES}`;
    }

    // Licht für die Ecken der Modelle (positions, normals: je drei Zahlen pro
    // Ecke, in der Welt); 64 Durchgänge, verteilt auf mehrere Bilder, damit
    // die Grafikkarte nie lange an einem rechnet. Liefert (async) drei Zahlen
    // pro Ecke: direktes Licht (direct = true) oder Bounce-Licht.
    // progress: (0 bis 1) => …, wie weit es ist
    async vertexLight(positions, normals, direct, progress = null) {
        const count = positions.length / 3;
        const rowLength = 1024, rows = Math.max(1, Math.ceil(count / rowLength));
        const pack = (values) => {
            const data = new Float32Array(rowLength * rows * 4);
            for (let i = 0; i < count; i++) data.set([values[i * 3], values[i * 3 + 1], values[i * 3 + 2], 1], i * 4);
            const texture = new THREE.DataTexture(data, rowLength, rows, THREE.RGBAFormat, THREE.FloatType);
            texture.needsUpdate = true;
            return texture;
        };
        const positionTexture = pack(positions), normalTexture = pack(normals);
        const result = target([rowLength, rows], { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
        const material = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: probeVertexShader,
            fragmentShader: vertexLightShader,
            uniforms: {
                ...this.gatherMaterial.uniforms,
                lights: this.directMaterial.uniforms.lights,
                lightCount: this.directMaterial.uniforms.lightCount,
                withModels: { value: true },
                wantDirect: { value: direct },
                pass: { value: 0 },
                vertexPositions: { value: positionTexture },
                vertexNormals: { value: normalTexture },
                vertexCount: { value: count },
                rowLength: { value: rowLength },
            },
            depthTest: false,
            depthWrite: false,
            ...additive,
        });
        const scene = new THREE.Scene();
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        quad.frustumCulled = false;
        scene.add(quad);
        const renderer = this.renderer;
        // Arbeit in Stücken: ein Durchgang für ein Band von Zeilen (BAND Ecken
        // mal 1024). Ein paar Stücke, dann wartet es, bis die Grafikkarte
        // fertig ist, und lässt ihr eine Pause für den Bildschirm; dauerten
        // sie zu lange, das nächste Mal weniger.
        const passes = 64, BAND = 16, bands = Math.ceil(rows / BAND), units = passes * bands;
        const run = (from, to, clear) => {
            const previous = renderer.getRenderTarget();
            const xr = renderer.xr.enabled, autoClear = renderer.autoClear;
            renderer.xr.enabled = false;
            renderer.setRenderTarget(result);
            if (clear) {
                renderer.setClearColor(0x000000, 0);
                renderer.clear();
            }
            renderer.autoClear = false;
            result.scissorTest = true;
            for (let unit = from; unit < to; unit++) {
                const band = Math.floor(unit / passes);
                material.uniforms.pass.value = unit % passes;
                result.scissor.set(0, band * BAND, rowLength, BAND);
                renderer.setRenderTarget(result);   // übernimmt den Ausschnitt
                renderer.render(scene, this.camera);
            }
            result.scissorTest = false;
            renderer.autoClear = autoClear;
            renderer.setRenderTarget(previous);
            renderer.xr.enabled = xr;
        };
        let done = 0, batch = 4;
        while (done < units) {
            const to = Math.min(units, done + batch);
            // die Zeit der Grafikkarte für dieses Stück allein: vom Zeichen davor
            // (bis dahin zeichnet sie noch das Bild davor) bis zum Zeichen danach
            const before = gpuMark(renderer);
            run(done, to, done === 0);
            done = to;
            const after = gpuMark(renderer);
            while (!after.done) await new Promise((resolve) => setTimeout(resolve, 2));
            const took = after.at - (before.done ? before.at : after.at - after.took);
            batch = took > 40 ? Math.max(1, batch >> 1) : took < 15 ? Math.min(4096, batch * 2) : batch;
            progress?.(done / units);
            await new Promise((resolve) => setTimeout(resolve, 8));
        }
        const half = new Uint16Array(rowLength * rows * 4);
        renderer.readRenderTargetPixels(result, 0, 0, rowLength, rows, half);
        result.dispose();
        material.dispose();
        positionTexture.dispose();
        normalTexture.dispose();
        const light = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            for (let k = 0; k < 3; k++) light[i * 3 + k] = THREE.DataUtils.fromHalfFloat(half[i * 4 + k]) / passes;
        }
        return light;
    }

    // Lichtproben: für jede Stelle das Bounce-Licht aus sechs Richtungen
    // (+x, -x, +y, -y, +z, -z), je 64 Durchgänge mit 16 Strahlen.
    probeLight(points) {
        const count = points.length * 6;
        const data = new Float32Array(Math.max(1, points.length) * 4);
        points.forEach((point, i) => data.set([point.x, point.y, point.z, 1], i * 4));
        const positions = new THREE.DataTexture(data, Math.max(1, points.length), 1, THREE.RGBAFormat, THREE.FloatType);
        positions.needsUpdate = true;
        const result = target([count, 1], { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
        const material = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: probeVertexShader,
            fragmentShader: probeShader,
            uniforms: {
                ...this.gatherMaterial.uniforms,
                withModels: { value: false },
                pass: { value: 0 },
                probes: { value: positions },
            },
            depthTest: false,
            depthWrite: false,
            ...additive,
        });
        const scene = new THREE.Scene();
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        quad.frustumCulled = false;
        scene.add(quad);
        const renderer = this.renderer;
        const previous = renderer.getRenderTarget();
        const xr = renderer.xr.enabled;
        renderer.xr.enabled = false;
        renderer.setRenderTarget(result);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        const passes = 64;
        for (let i = 0; i < passes; i++) {
            material.uniforms.pass.value = i;
            renderer.render(scene, this.camera);
        }
        renderer.autoClear = autoClear;
        const half = new Uint16Array(count * 4);
        renderer.readRenderTargetPixels(result, 0, 0, count, 1, half);
        renderer.setRenderTarget(previous);
        renderer.xr.enabled = xr;
        result.dispose();
        material.dispose();
        positions.dispose();
        const light = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            for (let k = 0; k < 3; k++) light[i * 3 + k] = THREE.DataUtils.fromHalfFloat(half[i * 4 + k]) / passes;
        }
        return light;
    }

    // solange das Backen vorbereitet wird: schwarz
    get steady() { return this.saved?.steady ?? (this.prepared ? this.directTarget.textures[0] : nothing()); }
    get flicker() { return this.saved?.flicker ?? (this.prepared ? this.directTarget.textures[1] : nothing()); }
    // die letzte fertige Reflexion
    get indirect() { return this.saved?.indirect ?? (this.prepared ? this.indirectTargets[1].texture : nothing()); }
    // womit die Flächen die Werte der Lightmaps malnehmen: beim Backen eins
    // durch die Zahl der Durchgänge, bei gespeichertem Licht dessen Maßstab
    get intensity() {
        if (this.saved) return this.saved.directMax;
        return this.directPasses > 0 ? 1 / this.directPasses : 0;
    }
    get indirectIntensity() {
        if (this.saved) return this.saved.indirectMax;
        return this.finishedPasses > 0 ? 1 / this.finishedPasses : 0;
    }
    get occlusionScale() { return this.saved ? 1 : this.intensity; }
    // gespeichertes Licht steht als Wurzel in den Texturen: die Flächen quadrieren
    get squared() { return Boolean(this.saved); }

    // Das fertige Licht zum Speichern (lightstore.js): je Lightmap die Werte,
    // wie die Grafikkarte sie hat (Half Float, RGBA je Punkt), und womit sie
    // malzunehmen sind, damit sie so hell sind, wie die Flächen sie zeigen.
    // Async: Die Grafikkarte liefert, ohne dass die Seite stehen bleibt.
    async readLight() {
        const size = this.atlasSize;
        const renderer = this.renderer;
        const read = async (renderTarget, index, scale) => {
            const half = new Uint16Array(size * size * 4);
            if (renderer.readRenderTargetPixelsAsync) await renderer.readRenderTargetPixelsAsync(renderTarget, 0, 0, size, size, half, undefined, index);
            else renderer.readRenderTargetPixels(renderTarget, 0, 0, size, size, half, undefined, index);
            return { half, scale };
        };
        return {
            size,
            steady: await read(this.directTarget, 0, this.intensity),
            flicker: await read(this.directTarget, 1, this.intensity),
            indirect: await read(this.indirectTargets[1], 0, this.indirectIntensity),
        };
    }

    // Gespeichertes Licht statt Backen (aus lightstore.js decodeLight)
    useSaved(light) {
        const size = light.header.size;
        if (size !== this.atlasSize) return false;
        const texture = (bytes) => {
            const t = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
            t.minFilter = THREE.LinearFilter;
            t.magFilter = THREE.LinearFilter;
            t.generateMipmaps = false;
            t.needsUpdate = true;
            return t;
        };
        this.dropSaved();
        this.saved = {
            steady: texture(light.steady), flicker: texture(light.flicker), indirect: texture(light.indirect),
            directMax: light.header.directMax, indirectMax: light.header.indirectMax,
        };
        return true;
    }

    // Wieder selbst backen (Shift+L)
    dropSaved() {
        if (!this.saved) return;
        for (const key of ['steady', 'flicker', 'indirect']) this.saved[key].dispose();
        this.saved = null;
        this.reset();
    }
}
