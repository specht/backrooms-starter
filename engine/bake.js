// Backt das Licht in eine Lichtkarte, im Browser auf der Grafikkarte.
//
// Das Level wird ein 3D-Raster aus kleinen Würfeln (Voxeln): voll, wo eine
// Wand, eine Decke, ein Block oder eine Statue ist. Gebacken wird in Stufen:
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

export const VOXEL = 0.05;            // Kantenlänge eines Voxels (nur für Statuen) in Metern
const CELL = 0.25;                    // Zellen für das abprallende Licht
const DIRECT_PASSES = 64;             // Durchgänge für das direkte Licht
const BOUNCE_PASSES = 64;             // Durchgänge für jede Reflexion, je vier Strahlen
const RAYS = 4;
const LIGHT_SCALE = 30;               // macht power = 1 zu »hell unter der Lampe«

// Das Raster für die Strahlen: für jedes Feld, was es ist, wie hoch seine
// Decke an den vier Ecken ist und welcher Block darauf steht, alles genau.
// Nur Statuen kommen in ein feines Raster aus Voxeln.
export function buildGrid(level, statues, maxHeight) {
    const { width, depth, cells, owner, settings } = level;
    const cell = settings.cell;
    const info = new Float32Array(width * depth * 4);      // Art, Statue, Block
    const ceilings = new Float32Array(width * depth * 4);  // Deckenhöhe an den vier Ecken
    const blockMin = new Float32Array(width * depth * 4);
    const blockMax = new Float32Array(width * depth * 4);
    for (let z = 0; z < depth; z++) {
        for (let x = 0; x < width; x++) {
            const i = (z * width + x) * 4;
            const kind = cells[z * width + x];
            info[i] = kind === 'floor' ? 1 : kind === 'wall' ? 2 : 0;
            if (kind !== 'floor') continue;
            const room = owner[z * width + x];
            ceilings.set([level.ceilingAt(x, z, room), level.ceilingAt(x + 1, z, room),
                level.ceilingAt(x, z + 1, room), level.ceilingAt(x + 1, z + 1, room)], i);
        }
    }
    // Ein Block gilt in jedem Feld, das er bedeckt (pro Feld einer)
    for (const block of level.things.filter((t) => t.type === 'block')) {
        const [w, h, d] = block.size;
        const cx = (block.x + 0.5) * cell, cz = (block.z + 0.5) * cell;
        const min = [cx - w / 2, block.base, cz - d / 2], max = [cx + w / 2, block.base + h, cz + d / 2];
        for (let z = Math.floor(min[2] / cell); z < Math.ceil(max[2] / cell); z++) {
            for (let x = Math.floor(min[0] / cell); x < Math.ceil(max[0] / cell); x++) {
                if (x < 0 || z < 0 || x >= width || z >= depth) continue;
                const i = (z * width + x) * 4;
                if (info[i + 2] > 0) continue;
                info[i + 2] = 1;
                blockMin.set([...min, 1], i);
                blockMax.set([...max, 1], i);
            }
        }
    }

    // Statuen: ihre Oberfläche in feine Voxel, so dicht abgetastet, dass kein
    // Strahl durchschlüpft. Das Raster reicht nur über den Kasten um alle Statuen.
    const box = new THREE.Box3();
    for (const object of statues) box.expandByObject(object);
    if (box.isEmpty()) box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(VOXEL, VOXEL, VOXEL));
    box.expandByScalar(VOXEL);
    const origin = box.min.clone();
    const extent = box.getSize(new THREE.Vector3());
    const nx = Math.ceil(extent.x / VOXEL), ny = Math.ceil(extent.y / VOXEL), nz = Math.ceil(extent.z / VOXEL);
    const data = new Uint8Array(nx * ny * nz);
    const set = (vx, vy, vz) => {
        if (vx < 0 || vy < 0 || vz < 0 || vx >= nx || vy >= ny || vz >= nz) return;
        data[(vz * ny + vy) * nx + vx] = 255;
        const fx = Math.floor((origin.x + (vx + 0.5) * VOXEL) / cell), fz = Math.floor((origin.z + (vz + 0.5) * VOXEL) / cell);
        if (fx >= 0 && fz >= 0 && fx < width && fz < depth) info[(fz * width + fx) * 4 + 1] = 1;
    };
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3();
    for (const object of statues) {
        object.updateMatrixWorld(true);
        object.traverse((mesh) => {
            if (!mesh.isMesh) return;
            const position = mesh.geometry.attributes.position;
            const index = mesh.geometry.index;
            const count = index ? index.count : position.count;
            for (let i = 0; i < count; i += 3) {
                const ia = index ? index.getX(i) : i, ib = index ? index.getX(i + 1) : i + 1, ic = index ? index.getX(i + 2) : i + 2;
                a.fromBufferAttribute(position, ia).applyMatrix4(mesh.matrixWorld);
                b.fromBufferAttribute(position, ib).applyMatrix4(mesh.matrixWorld);
                c.fromBufferAttribute(position, ic).applyMatrix4(mesh.matrixWorld);
                const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
                const steps = Math.max(1, Math.ceil(longest / (VOXEL * 0.5)));
                for (let s = 0; s <= steps; s++) {
                    for (let t = 0; t <= steps - s; t++) {
                        const u = s / steps, v = t / steps;
                        p.copy(a).multiplyScalar(1 - u - v).addScaledVector(b, u).addScaledVector(c, v);
                        set(Math.floor((p.x - origin.x) / VOXEL), Math.floor((p.y - origin.y) / VOXEL), Math.floor((p.z - origin.z) / VOXEL));
                    }
                }
            }
        });
    }
    const voxels = new THREE.Data3DTexture(data, nx, ny, nz);
    voxels.format = THREE.RedFormat;
    voxels.type = THREE.UnsignedByteType;
    voxels.minFilter = voxels.magFilter = THREE.NearestFilter;
    voxels.unpackAlignment = 1;
    voxels.needsUpdate = true;

    const texture = (array) => {
        const t = new THREE.DataTexture(array, width, depth, THREE.RGBAFormat, THREE.FloatType);
        t.needsUpdate = true;
        return t;
    };
    return {
        info: texture(info), ceilings: texture(ceilings), blockMin: texture(blockMin), blockMax: texture(blockMax),
        voxels, voxelCount: new THREE.Vector3(nx, ny, nz), voxelOrigin: origin, cells: new THREE.Vector2(width, depth), cell,
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
export function lightTexture(lights, on = null, texture = null) {
    const count = Math.max(1, lights.length);
    const data = texture ? texture.image.data : new Float32Array(count * 3 * 4);
    lights.forEach((light, i) => {
        const color = light.channel >= 0 ? new THREE.Color(1, 1, 1) : new THREE.Color(light.color);
        const power = on && !on[i] ? 0 : light.power * LIGHT_SCALE;
        data.set([light.position.x, light.position.y, light.position.z, light.size[0]], i * 12);
        data.set([color.r * power, color.g * power, color.b * power, light.size[1]], i * 12 + 4);
        // wie steil die Decke über der Leuchte in x und z ansteigt: Sie liegt darin
        data.set([light.channel, lightRange(light), light.tilt?.[0] ?? 0, light.tilt?.[1] ?? 0], i * 12 + 8);
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
out vec3 vWorld;
out vec3 vNormal;
out vec3 vMin;
out vec3 vMax;
out float vAmbient;
out vec3 vAlbedo;
void main() {
    vWorld = world; vNormal = normal; vMin = faceMin; vMax = faceMax; vAmbient = ambient; vAlbedo = albedo;
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

uniform sampler3D voxels;      // nur Statuen
uniform vec3 gridSize;         // Voxel in x, y, z
uniform vec3 gridOrigin;       // Ecke des Kastens um die Statuen
uniform float voxel;
uniform sampler2D cellInfo;    // r: 0 nichts, 1 Boden, 2 Wand; g: Statue; b: Block
uniform sampler2D cellCeiling; // Deckenhöhe an den Ecken (x0z0, x1z0, x0z1, x1z1)
uniform sampler2D blockMin;
uniform sampler2D blockMax;
uniform vec2 cellCount;
uniform float cellMeters;
uniform float top;
uniform uint pass;
uniform bool withStatues;   // die Lichtproben für Statuen sehen durch die Statuen hindurch
// Statuen-Voxel so nah am Anfang eines Strahls zählen nicht (gegen Schatten
// einer Fläche auf sich selbst); nur für die Ecken der Statuen gesetzt.
float statueSkip = 0.0;

uint state;
uint pcg() {
    state = state * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}
float random() { return float(pcg()) / 4294967296.0; }

// Eine Leuchte liegt in der Ebene der Decke über ihr. Der dritte Texel der
// Leuchte (e) trägt in .b und .a, wie steil diese Decke in x und in z
// ansteigt (0 und 0: waagerecht). lampPoint ist ein zufälliger Punkt auf der
// Leuchte, lampNormal zeigt von ihr in den Raum.
vec3 lampPoint(vec4 a, vec4 b, vec4 e) {
    vec3 u = normalize(vec3(1.0, e.b, 0.0)), v = normalize(vec3(0.0, e.a, 1.0));
    return a.xyz + u * ((random() - 0.5) * a.w) + v * ((random() - 0.5) * b.w);
}
vec3 lampNormal(vec4 e) { return normalize(vec3(e.b, -1.0, e.a)); }

vec3 safeDirection(vec3 d) {
    return vec3(abs(d.x) < 1e-6 ? 1e-6 : d.x, abs(d.y) < 1e-6 ? 1e-6 : d.y, abs(d.z) < 1e-6 ? 1e-6 : d.z);
}

bool statueVoxel(ivec3 v) {
    if (any(lessThan(v, ivec3(0))) || any(greaterThanEqual(v, ivec3(gridSize)))) return false;
    return texelFetch(voxels, v, 0).r > 0.5;
}

// Durch die Voxel der Statuen, von t0 bis t1 entlang des Strahls (3D-DDA)
float statueTrace(vec3 a, vec3 dir, float t0, float t1) {
    vec3 p = (a + dir * t0 - gridOrigin) / voxel;
    float len = (t1 - t0) / voxel;
    ivec3 cell = ivec3(floor(p));
    ivec3 stepDir = ivec3(sign(dir));
    vec3 safe = safeDirection(dir);
    vec3 tDelta = abs(1.0 / safe);
    vec3 tMax = (vec3(cell) + max(sign(dir), 0.0) - p) / safe;
    float t = 0.0;
    for (int i = 0; i < 256; i++) {
        if (statueVoxel(cell) && t0 + t * voxel >= statueSkip) return t0 + t * voxel;
        if (tMax.x < tMax.y && tMax.x < tMax.z) { t = tMax.x; tMax.x += tDelta.x; cell.x += stepDir.x; }
        else if (tMax.y < tMax.z) { t = tMax.y; tMax.y += tDelta.y; cell.y += stepDir.y; }
        else { t = tMax.z; tMax.z += tDelta.z; cell.z += stepDir.z; }
        if (t > len) return -1.0;
    }
    return -1.0;
}

// Wo trifft ein Strahl auf einen Quader? -1: gar nicht
float boxHit(vec3 a, vec3 dir, vec3 lo, vec3 hi) {
    vec3 inv = 1.0 / safeDirection(dir);
    vec3 t0 = (lo - a) * inv, t1 = (hi - a) * inv;
    vec3 near = min(t0, t1), far = max(t0, t1);
    float tNear = max(max(near.x, near.y), near.z), tFar = min(min(far.x, far.y), far.z);
    return tFar < max(tNear, 0.0) ? -1.0 : max(tNear, 0.0);
}

// Wie weit kommt ein Strahl von a in Richtung dir, bevor er auf etwas trifft?
// Feld für Feld durch den Grundriss (2D-DDA); in jedem Feld genau: Wand,
// Decke (auch schräg), Boden, Block, und in Feldern mit Statuen deren Voxel.
// -1: bis maxLength nichts im Weg.
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
        vec4 info = texelFetch(cellInfo, cell, 0);
        if (info.r != 1.0) return tEnter;                       // Wand oder nichts
        float tExit = min(min(tMax.x, tMax.y), maxLength);
        float hit = 1e9;
        // die Decke: Abstand darunter am Anfang und am Ende des Stücks, dazwischen gerade
        vec4 h = texelFetch(cellCeiling, cell, 0);
        vec2 q0 = clamp(p + d * tEnter - vec2(cell), 0.0, 1.0), q1 = clamp(p + d * tExit - vec2(cell), 0.0, 1.0);
        float f0 = a.y + dir.y * tEnter - mix(mix(h.x, h.y, q0.x), mix(h.z, h.w, q0.x), q0.y);
        float f1 = a.y + dir.y * tExit - mix(mix(h.x, h.y, q1.x), mix(h.z, h.w, q1.x), q1.y);
        if (f0 >= 0.0) hit = tEnter;
        else if (f1 > 0.0) hit = tEnter + (tExit - tEnter) * (-f0) / (f1 - f0);
        // der Boden
        if (dir.y < 0.0) {
            float tFloor = -a.y / dir.y;
            if (tFloor >= tEnter && tFloor <= tExit) hit = min(hit, tFloor);
        }
        // ein Block
        if (info.b > 0.5) {
            float tBox = boxHit(a, dir, texelFetch(blockMin, cell, 0).xyz, texelFetch(blockMax, cell, 0).xyz);
            if (tBox >= 0.0 && tBox <= tExit) hit = min(hit, max(tBox, tEnter));
        }
        // eine Statue
        if (withStatues && info.g > 0.5) {
            float tStatue = statueTrace(a, dir, tEnter, min(tExit, hit));
            if (tStatue >= 0.0) hit = min(hit, tStatue);
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

// Die Stelle, von der die Strahlen ausgehen: auf der Fläche, etwas davor.
// Wände, Decken und Blöcke sind genau: 2 cm genügen.
vec3 surfacePoint(out vec3 n) {
    n = normalize(vNormal);
    vec3 inset = 0.01 * (1.0 - abs(n));
    vec3 p = clamp(vWorld, vMin + inset, vMax - inset);
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
        // ein zufälliger Punkt auf der Leuchte
        vec3 s = lampPoint(a, b, c);
        vec3 l = s - start;
        float d2 = dot(l, l);
        l /= sqrt(d2);
        float atSurface = dot(n, l);      // wie schräg das Licht auf die Fläche fällt
        float atLamp = -dot(l, lampNormal(c));   // am meisten senkrecht vor der Leuchte
        if (atSurface <= 0.0 || atLamp <= 0.0) continue;
        if (blocked(start, s)) continue;
        vec3 amount = b.rgb * atSurface * atLamp * (a.w * b.w) / (3.14159 * d2 + 0.05) * fade;
        if (channel < 0) light += amount;
        else flickering[channel] += amount.r;
    }

    // Wie offen die Stelle ist: zwei kurze Strahlen (50 cm) in die Halbkugel.
    // In Ecken treffen sie oft etwas; das dunkelt das Bounce-Licht dort ab
    // (Ambient Occlusion, im Alphakanal), und das Licht von überall auch.
    float open = 0.0;
    for (int r = 0; r < 2; r++) {
        vec3 dir = hemisphere(n);
        vec3 end = start + dir * 0.5;
        if (end.y > 0.0 && !blocked(start, end)) open += 0.5;
    }
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
    vec3 g = q / cellSize - 0.5;
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
        float bound = dir.y < -1e-4 ? -start.y / dir.y : dir.y > 1e-4 ? (top - start.y) / dir.y : 1e4;
        float t = trace(start, dir, min(bound, 24.0));
        if (t < 0.0) t = bound <= 24.0 ? bound : -1.0;
        if (t >= 0.0) light += cellLight(start + dir * max(t - 0.06, 0.0));
    }
    bounced = vec4(light / float(${RAYS}), 1.0);
}`;

// Lichtproben für Statuen: für jede Probe sechs Richtungen (±x, ±y, ±z),
// in jede viele Strahlen; was sie treffen, bringt sein Licht mit.
const probeVertexShader = /* glsl */ `
in vec3 position;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vMin;
out vec3 vMax;
out float vAmbient;
out vec3 vAlbedo;
void main() {
    vWorld = vec3(0.0); vNormal = vec3(0.0, 1.0, 0.0); vMin = vec3(0.0); vMax = vec3(0.0); vAmbient = 0.0; vAlbedo = vec3(0.0);
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

// Licht für die Ecken von Statuen, wie die Lichtkarte, aber mit den Statuen
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
        if (!statueVoxel(ivec3(floor((q - gridOrigin) / voxel)))) { start = q + n * 0.005; break; }
    }
    state = uint(index) * 9781u + pass * 6271u + 13u;
    statueSkip = 0.08;
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
        vec3 s = lampPoint(a, b, e);
        vec3 l = s - start;
        float d2 = dot(l, l);
        l /= sqrt(d2);
        float atSurface = dot(n, l), atLamp = -dot(l, lampNormal(e));
        if (atSurface <= 0.0 || atLamp <= 0.0) continue;
        if (blocked(start, s)) continue;
        vec3 amount = b.rgb * atSurface * atLamp * (a.w * b.w) / (3.14159 * d2 + 0.05) * fade;
        light += e.r < 0.0 ? amount : amount;   // flackernde Leuchten zählen hier ruhig
    }
    // Bounce-Licht: Strahlen in die Halbkugel über der Fläche
    for (int r = 0; r < 4; r++) {
        if (wantDirect) break;
        vec3 dir = hemisphere(n);
        float bound = dir.y < -1e-4 ? -start.y / dir.y : dir.y > 1e-4 ? (top - start.y) / dir.y : 1e4;
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
uniform sampler2D indirect;
uniform float directScale;
uniform float indirectScale;
uniform int atlasSize;
uniform vec3 bounceCells;
uniform float cellSize;
uniform int perRow;
uniform vec2 flatSize;
out vec3 vLight;
void main() {
    ivec2 t = ivec2(gl_VertexID % atlasSize, gl_VertexID / atlasSize);
    vec4 p = texelFetch(surfacePosition, t, 0);
    if (p.w < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec3 n = texelFetch(surfaceNormal, t, 0).xyz;
    vec3 albedo = texelFetch(surfaceAlbedo, t, 0).rgb;
    vec3 light = texelFetch(direct, t, 0).rgb * directScale + texelFetch(indirect, t, 0).rgb * indirectScale;
    vLight = albedo * light;
    ivec3 c = clamp(ivec3(floor((p.xyz + n * cellSize * 0.5) / cellSize)), ivec3(0), ivec3(bounceCells) - 1);
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

export class LightBaker {
    constructor(renderer, level, geometry, voxels, lights, bounces = 3) {
        this.bounces = bounces;   // wie oft das Licht zurückgeworfen wird (bounces in level.ini)
        this.renderer = renderer;
        this.lights = lights;
        const size = geometry.atlasSize;
        this.atlasSize = size;
        // direktes Licht: ruhig und flackernd; abgeprallt: zwei, eines wird
        // gesammelt, das andere ist die letzte fertige Reflexion
        this.directTarget = target(size, { count: 2 });
        this.indirectTargets = [target(size), target(size)];
        this.denoiseTarget = target(size);
        this.surfaceTarget = target(size, { count: 3, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });

        // das grobe Raster für das abgegebene Licht, Schicht für Schicht nebeneinander
        const cellCount = new THREE.Vector3(
            Math.ceil(voxels.cells.x * voxels.cell / CELL), Math.ceil((geometry.maxHeight + 0.5) / CELL), Math.ceil(voxels.cells.y * voxels.cell / CELL));
        const perRow = Math.max(1, Math.min(cellCount.z, Math.floor(8192 / cellCount.x)));
        const flatSize = new THREE.Vector2(cellCount.x * perRow, cellCount.y * Math.ceil(cellCount.z / perRow));
        this.cellTarget = target([flatSize.x, flatSize.y], { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });

        const ambient = new THREE.Color('#d8c890');
        const grid = {
            voxels: { value: voxels.voxels },
            gridSize: { value: voxels.voxelCount },
            gridOrigin: { value: voxels.voxelOrigin },
            voxel: { value: VOXEL },
            cellInfo: { value: voxels.info },
            cellCeiling: { value: voxels.ceilings },
            blockMin: { value: voxels.blockMin },
            blockMax: { value: voxels.blockMax },
            cellCount: { value: voxels.cells },
            cellMeters: { value: voxels.cell },
            top: { value: geometry.maxHeight + 0.01 },
            pass: { value: 0 },
            withStatues: { value: true },
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
        this.injectScene = new THREE.Scene();
        const cloud = new THREE.Points(points, this.injectMaterial);
        cloud.frustumCulled = false;
        this.injectScene.add(cloud);

        // Stelle, Richtung und Farbe jedes Punkts: einmal, sie ändern sich nicht
        this.draw(this.surfaceTarget, this.surfaceMaterial, true);
        this.reset();
    }

    // Zeichnet alle Flächen mit diesem Shader in dieses Ziel
    draw(renderTarget, material, clear = false) {
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
        renderer.render(scene, this.camera);
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
        this.clear(this.directTarget);
        for (const t of this.indirectTargets) this.clear(t);
        this.directPasses = 0;
        this.bounce = 0;           // die wievielte Reflexion gerade gesammelt wird (0: noch keine)
        this.gatherPasses = 0;
        this.finishedPasses = 0;   // Durchgänge der letzten fertigen Reflexion
    }

    // Welche Leuchten an sind; danach fängt das Backen von vorn an.
    switchLights(on) {
        lightTexture(this.lights, on, this.directMaterial.uniforms.lights.value);
        this.reset();
    }

    // ob das direkte Licht fertig ist und schon Bounce-Licht gesammelt wird
    get bouncing() {
        return this.saved ? true : this.directPasses >= DIRECT_PASSES;
    }

    get done() {
        return this.saved ? true : this.bounce > this.bounces;
    }

    // ein Schritt Arbeit: ein Durchgang direktes Licht oder ein Durchgang Sammeln
    step() {
        if (this.done) return;
        if (this.directPasses < DIRECT_PASSES) {
            this.directMaterial.uniforms.pass.value = this.directPasses;
            this.draw(this.directTarget, this.directMaterial);
            this.directPasses += 1;
            if (this.directPasses === DIRECT_PASSES) this.startBounce();
            return;
        }
        this.gatherMaterial.uniforms.pass.value = this.bounce * 1000 + this.gatherPasses;
        this.draw(this.indirectTargets[0], this.gatherMaterial);
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

    startBounce() {
        this.bounce += 1;
        this.gatherPasses = 0;
        if (this.done) return;
        // abgeben: direktes Licht plus die letzte fertige Reflexion
        const u = this.injectMaterial.uniforms;
        u.directScale.value = 1 / this.directPasses;
        u.indirect.value = this.indirectTargets[1].texture;
        u.indirectScale.value = this.finishedPasses ? 1 / this.finishedPasses : 0;
        this.clear(this.cellTarget);
        this.draw(this.cellTarget, this.injectMaterial);
        this.clear(this.indirectTargets[0]);
    }

    // Wie weit, von 0 bis 1, und was gerade passiert
    get progress() {
        if (this.saved) return 1;
        return Math.min(1, (this.directPasses + (this.bounce - 1) * BOUNCE_PASSES + this.gatherPasses) / (DIRECT_PASSES + this.bounces * BOUNCE_PASSES));
    }

    get stage() {
        if (this.directPasses < DIRECT_PASSES) return `direct light, pass ${this.directPasses} of ${DIRECT_PASSES}`;
        if (this.done) return null;
        return `bounce ${this.bounce} of ${this.bounces}, pass ${this.gatherPasses} of ${BOUNCE_PASSES}`;
    }

    // Licht für die Ecken der Statuen (positions, normals: je drei Zahlen pro
    // Ecke, in der Welt); 64 Durchgänge. Liefert drei Zahlen pro Ecke:
    // direktes Licht (direct = true) oder Bounce-Licht.
    vertexLight(positions, normals, direct) {
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
                withStatues: { value: true },
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
        const half = new Uint16Array(rowLength * rows * 4);
        renderer.readRenderTargetPixels(result, 0, 0, rowLength, rows, half);
        renderer.setRenderTarget(previous);
        renderer.xr.enabled = xr;
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
                withStatues: { value: false },
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

    get steady() { return this.saved?.steady ?? this.directTarget.textures[0]; }
    get flicker() { return this.saved?.flicker ?? this.directTarget.textures[1]; }
    // die letzte fertige Reflexion
    get indirect() { return this.saved?.indirect ?? this.indirectTargets[1].texture; }
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

    // Das fertige Licht als Zahlen, zum Speichern (lightstore.js): je Punkt
    // RGBA, schon mit seiner Helligkeit verrechnet, wie die Flächen es zeigen.
    readLight() {
        const size = this.atlasSize;
        const read = (renderTarget, index, scale) => {
            const half = new Uint16Array(size * size * 4);
            this.renderer.readRenderTargetPixels(renderTarget, 0, 0, size, size, half, undefined, index);
            const values = new Float32Array(half.length);
            for (let i = 0; i < half.length; i++) values[i] = THREE.DataUtils.fromHalfFloat(half[i]) * scale;
            return values;
        };
        return {
            size,
            steady: read(this.directTarget, 0, this.intensity),
            flicker: read(this.directTarget, 1, this.intensity),
            indirect: read(this.indirectTargets[1], 0, this.indirectIntensity),
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
