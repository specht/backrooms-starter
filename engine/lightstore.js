// Gebackenes Licht aufheben: im Browser (IndexedDB), damit ein Neuladen
// ohne Änderung nicht noch einmal backt, und als Datei (»Save light«), die
// neben level.ini liegt und mit dem Level veröffentlicht wird, etwa für eine
// VR-Brille.
//
// Ein Fingerabdruck aus level.ini, allen Räumen, den Statuen und dem
// Programm, das backt, sagt, ob gespeichertes Licht noch zum Level passt.
// Ändert sich ein Zeichen, passt es nicht mehr, und das Licht wird neu
// gebacken.
//
// Gespeichert wird jede Lightmap mit 8 Bit pro Kanal, als Wurzel des Werts
// (so bleiben dunkle Stellen genau), und alles zusammen mit gzip gepackt.

const FORMAT = 'backrooms-light 1';
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
        const bytes = typeof part === 'string' ? encoder.encode(part) : new Uint8Array(part);
        for (let i = 0; i < bytes.length; i++) feed(bytes[i]);
        feed(0);   // Grenze zwischen zwei Teilen
    }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

// Der Name der Datei neben dem Level: level.ini -> level.light
export function lightFileName(levelFile) {
    return levelFile.replace(/\.[^./]*$/, '') + '.light';
}

// Werte von 0 bis max als Wurzel in 0 bis 255
function quantize(values, out, offset, stride, max) {
    const scale = max > 0 ? 1 / max : 0;
    for (let i = 0; i < values.length; i += 4) {
        for (let k = 0; k < stride; k++) {
            const v = Math.min(1, Math.max(0, values[i + k] * scale));
            out[offset + i + k] = Math.round(Math.sqrt(v) * 255);
        }
    }
}

function maximum(values, channels) {
    let max = 0;
    for (let i = 0; i < values.length; i += 4) {
        for (let k = 0; k < channels; k++) if (values[i + k] > max) max = values[i + k];
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

// light: { size, steady, flicker, indirect } als Float32-Werte (RGBA je
// Punkt), schon mit ihrer Helligkeit verrechnet; statues: { direct, bounced }
// als Float32-Werte, drei pro Ecke. Liefert die gepackte Datei.
export async function encodeLight(print, light, statues) {
    const { size } = light;
    const texels = size * size * 4;
    // direktes Licht und Flackern teilen sich einen Maßstab, die Kontaktschatten
    // (Alphakanal) liegen ohnehin zwischen 0 und 1
    const directMax = Math.max(maximum(light.steady, 3), maximum(light.flicker, 4));
    const indirectMax = maximum(light.indirect, 3);
    const header = {
        format: FORMAT, fingerprint: print, size, directMax, indirectMax,
        statueVertices: statues ? statues.direct.length / 3 : 0,
    };
    // mit Leerzeichen auf ein Vielfaches von 4 Bytes, damit die Zahlen der
    // Statuen auf einer Grenze für Float32 beginnen
    let text = JSON.stringify(header);
    while (text.length % 4) text += ' ';
    const head = new TextEncoder().encode(text);
    const statueBytes = statues ? statues.direct.length * 4 * 2 : 0;
    const bytes = new Uint8Array(4 + head.length + texels * 3 + statueBytes);
    new DataView(bytes.buffer).setUint32(0, head.length, true);
    bytes.set(head, 4);
    let offset = 4 + head.length;
    quantize(light.steady, bytes, offset, 3, directMax);
    for (let i = 0; i < texels; i += 4) {
        bytes[offset + i + 3] = Math.round(Math.sqrt(Math.min(1, Math.max(0, light.steady[i + 3]))) * 255);
    }
    offset += texels;
    quantize(light.flicker, bytes, offset, 4, directMax);
    offset += texels;
    quantize(light.indirect, bytes, offset, 3, indirectMax);
    offset += texels;
    if (statues) {
        // Statuen: wenige Werte, darum genau (Float32)
        const floats = new Float32Array(bytes.buffer, offset, statues.direct.length * 2);
        floats.set(statues.direct, 0);
        floats.set(statues.bounced, statues.direct.length);
    }
    return gzip(bytes);
}

// Liefert { header, steady, flicker, indirect (Uint8Array, RGBA je Punkt),
// statues }, oder null, wenn die Datei nicht zu diesem Fingerabdruck passt.
export async function decodeLight(packed, print) {
    const bytes = await gunzip(packed);
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
    if (header.format !== FORMAT || header.fingerprint !== print) return null;
    const texels = header.size * header.size * 4;
    let offset = 4 + length;
    const take = (n) => { const part = bytes.slice(offset, offset + n); offset += n; return part; };
    const steady = take(texels), flicker = take(texels), indirect = take(texels);
    let statues = null;
    if (header.statueVertices > 0) {
        const floats = new Float32Array(take(header.statueVertices * 3 * 4 * 2).buffer);
        statues = {
            direct: floats.subarray(0, header.statueVertices * 3),
            bounced: floats.subarray(header.statueVertices * 3),
        };
    }
    return { header, steady, flicker, indirect, statues };
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
