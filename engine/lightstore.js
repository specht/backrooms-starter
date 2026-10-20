// Gebackenes Licht aufheben: im Browser (IndexedDB), damit ein Neuladen
// ohne Änderung nicht noch einmal backt, und als Datei (»Save light«), die
// neben level.ini liegt und mit dem Level veröffentlicht wird, etwa für eine
// VR-Brille.
//
// Ein Fingerabdruck aus level.ini, allen Räumen, den Modellen, bake.js und
// dem, was daraus gebaut wird (die Flächen und die Leuchten, main.js), sagt,
// ob gespeichertes Licht noch zum Level passt. Ändert sich ein Zeichen in
// einem Raum, passt es nicht mehr, und das Licht wird neu gebacken.
//
// Gespeichert wird jede Lightmap mit 8 Bit pro Kanal, als Wurzel des Werts
// (so bleiben dunkle Stellen genau), und alles zusammen mit gzip gepackt.
// Der Maßstab ist nicht der hellste Punkt, sondern der, über dem nur noch
// 0,05 % der Punkte liegen: Eine Lampe direkt an der Wand macht dort einen
// winzigen, sehr hellen Fleck, und am hellsten Punkt gemessen blieben für
// alles andere nur wenige Stufen, die man als Streifen sähe. Ein wenig
// Rauschen beim Runden (Dithering) macht übrige Stufen unsichtbar.

const FORMAT = 'backrooms-light 2';
const CLIP = 0.9995;
const DATABASE = 'backrooms';
const STORE = 'light';

// FNV-1a über alle Teile, zweimal mit verschiedenem Anfang: 64 Bit als Text
export function fingerprint(parts) {
    let a = 0x811c9dc5, b = 0x01000193 ^ 0x9e3779b9;
    const feed = (byte) => {
        a = Math.imul(a ^ byte, 16777619);
        b = Math.imul(b ^ byte, 16777619) ^ (b >>> 13);
    };
    const encoder = new TextEncoder();
    for (const part of [FORMAT, ...parts]) {
        const bytes = typeof part === 'string' ? encoder.encode(part) : part instanceof Uint8Array ? part : new Uint8Array(part);
        for (let i = 0; i < bytes.length; i++) feed(bytes[i]);
        feed(0);   // Grenze zwischen zwei Teilen
    }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

// Der Name der Datei neben dem Level: level.ini -> level.light
export function lightFileName(levelFile) {
    return levelFile.replace(/\.[^./]*$/, '') + '.light';
}

// Half Float (16 Bit, wie die Grafikkarte rechnet) als Zahl: einmal für
// alle 65536 Werte, danach ist jeder Wert ein Griff in die Tabelle
let halfTable = null;
function halves() {
    if (halfTable) return halfTable;
    halfTable = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
        const sign = h & 0x8000 ? -1 : 1, exponent = (h >> 10) & 0x1f, fraction = h & 0x3ff;
        const value = exponent === 0 ? sign * 2 ** -14 * (fraction / 1024)
            : exponent === 31 ? 0   // unendlich oder keine Zahl: nichts
            : sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
        halfTable[h] = value;
    }
    return halfTable;
}

// alle so viele Werte darf der Browser zwischendurch Maus und Bild bedienen
const CHUNK = 1 << 20;
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

// Werte (map: { half, scale }) von 0 bis max als Wurzel in 0 bis 255, mit Rauschen gerundet
async function quantize(map, out, offset, stride, max) {
    const table = halves(), { half } = map;
    const scale = max > 0 ? map.scale / max : 0;
    for (let start = 0; start < half.length; start += CHUNK) {
        const end = Math.min(half.length, start + CHUNK);
        for (let i = start; i < end; i += 4) {
            for (let k = 0; k < stride; k++) {
                const v = Math.min(1, Math.max(0, table[half[i + k]] * scale));
                const dither = Math.random() + Math.random() - 1;   // -1 bis 1, meist nahe 0
                out[offset + i + k] = Math.min(255, Math.max(0, Math.round(Math.sqrt(v) * 255 + dither * 0.5)));
            }
        }
        await breathe();
    }
}

// Der Wert, über dem nur noch der Anteil 1 - CLIP aller Werte liegt (über
// mehrere Lightmaps zusammen); gesucht über ein Histogramm
async function maximum(lists) {
    const table = halves();
    let max = 0, count = 0;
    for (const [map, channels] of lists) {
        const { half, scale } = map;
        for (let start = 0; start < half.length; start += CHUNK) {
            const end = Math.min(half.length, start + CHUNK);
            for (let i = start; i < end; i += 4) {
                for (let k = 0; k < channels; k++) { const v = table[half[i + k]] * scale; if (v > max) max = v; }
            }
            await breathe();
        }
    }
    if (max <= 0) return 0;
    const BINS = 4096;
    const histogram = new Uint32Array(BINS);
    for (const [map, channels] of lists) {
        const { half, scale } = map;
        for (let start = 0; start < half.length; start += CHUNK) {
            const end = Math.min(half.length, start + CHUNK);
            for (let i = start; i < end; i += 4) {
                for (let k = 0; k < channels; k++) {
                    const v = table[half[i + k]] * scale;
                    if (v <= 0) continue;
                    histogram[Math.min(BINS - 1, Math.floor(v / max * BINS))] += 1;
                    count += 1;
                }
            }
            await breathe();
        }
    }
    let seen = 0;
    for (let bin = 0; bin < BINS; bin++) {
        seen += histogram[bin];
        if (seen >= count * CLIP) return max * (bin + 1) / BINS;
    }
    return max;
}

async function gzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// light: { size, steady, flicker, indirect }, jede { half: Half Float, RGBA
// je Punkt, scale: womit malnehmen, wie in baker.readLight }; models: { direct, bounced }
// als Float32-Werte, drei pro Ecke. Liefert die gepackte Datei.
export async function encodeLight(print, light, models) {
    const { size } = light;
    const texels = size * size * 4;
    // direktes Licht und Flackern teilen sich einen Maßstab, die Kontaktschatten
    // (Alphakanal) liegen ohnehin zwischen 0 und 1
    const directMax = await maximum([[light.steady, 3], [light.flicker, 4]]);
    const indirectMax = await maximum([[light.indirect, 3]]);
    const header = {
        format: FORMAT, fingerprint: print, size, directMax, indirectMax,
        modelVertices: models ? models.direct.length / 3 : 0,
    };
    // mit Leerzeichen auf ein Vielfaches von 4 Bytes, damit die Zahlen der
    // Modelle auf einer Grenze für Float32 beginnen
    let text = JSON.stringify(header);
    while (text.length % 4) text += ' ';
    const head = new TextEncoder().encode(text);
    const modelBytes = models ? models.direct.length * 4 * 2 : 0;
    const bytes = new Uint8Array(4 + head.length + texels * 3 + modelBytes);
    new DataView(bytes.buffer).setUint32(0, head.length, true);
    bytes.set(head, 4);
    let offset = 4 + head.length;
    await quantize(light.steady, bytes, offset, 3, directMax);
    const table = halves(), { half, scale } = light.steady;
    for (let i = 0; i < texels; i += 4) {
        bytes[offset + i + 3] = Math.round(Math.sqrt(Math.min(1, Math.max(0, table[half[i + 3]] * scale))) * 255);
        if (i % CHUNK === 0) await breathe();
    }
    offset += texels;
    await quantize(light.flicker, bytes, offset, 4, directMax);
    offset += texels;
    await quantize(light.indirect, bytes, offset, 3, indirectMax);
    offset += texels;
    if (models) {
        // Modelle: wenige Werte, darum genau (Float32)
        const floats = new Float32Array(bytes.buffer, offset, models.direct.length * 2);
        floats.set(models.direct, 0);
        floats.set(models.bounced, models.direct.length);
    }
    return gzip(bytes);
}

// Liefert { header, steady, flicker, indirect (Uint8Array, RGBA je Punkt),
// models }, oder null, wenn die Datei nicht zu diesem Fingerabdruck passt.
export async function decodeLight(packed, print) {
    const bytes = await gunzip(packed);
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
    if (header.format !== FORMAT || header.fingerprint !== print) return null;
    const texels = header.size * header.size * 4;
    let offset = 4 + length;
    const take = (n) => { const part = bytes.slice(offset, offset + n); offset += n; return part; };
    const steady = take(texels), flicker = take(texels), indirect = take(texels);
    let models = null;
    if (header.modelVertices > 0) {
        const floats = new Float32Array(take(header.modelVertices * 3 * 4 * 2).buffer);
        models = {
            direct: floats.subarray(0, header.modelVertices * 3),
            bounced: floats.subarray(header.modelVertices * 3),
        };
    }
    return { header, steady, flicker, indirect, models };
}

// IndexedDB: je Level-Datei das zuletzt gebackene Licht, mit Fingerabdruck
function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function readCache(levelFile) {
    try {
        const db = await openDatabase();
        return await new Promise((resolve) => {
            const request = db.transaction(STORE).objectStore(STORE).get(levelFile);
            request.onsuccess = () => resolve(request.result ?? null);
            request.onerror = () => resolve(null);
        });
    } catch {
        return null;   // kein IndexedDB (privates Fenster): dann wird gebacken
    }
}

export async function writeCache(levelFile, print, packed) {
    try {
        const db = await openDatabase();
        await new Promise((resolve) => {
            const transaction = db.transaction(STORE, 'readwrite');
            transaction.objectStore(STORE).put({ fingerprint: print, packed }, levelFile);
            transaction.oncomplete = resolve;
            transaction.onerror = resolve;
        });
        return true;
    } catch {
        return false;
    }
}

// Gespeichertes Licht zu diesem Fingerabdruck: zuerst aus dem Browser, dann
// aus der Datei neben dem Level. Liefert { light, source } oder null.
export async function findLight(levelFile, print) {
    const cached = await readCache(levelFile);
    if (cached && cached.fingerprint === print) {
        const light = await decodeLight(cached.packed, print).catch(() => null);
        if (light) return { light, source: 'browser', packed: cached.packed };
    }
    const file = lightFileName(levelFile);
    try {
        const response = await fetch(file, { cache: 'no-store' });
        if (!response.ok) return null;
        const packed = new Uint8Array(await response.arrayBuffer());
        const light = await decodeLight(packed, print);
        if (light) return { light, source: file, packed };
        return { light: null, source: file, stale: true };
    } catch {
        return null;
    }
}

// Die gepackte Datei herunterladen, unter dem Namen, unter dem das Level sie sucht
export function download(levelFile, packed) {
    const url = URL.createObjectURL(new Blob([packed], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = lightFileName(levelFile).split('/').pop();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
