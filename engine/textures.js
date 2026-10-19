// Tapete, Teppich und Deckenplatten, im Browser gemalt: keine Bilddateien.
// Jede Textur ist ein Quadrat von einem Meter und wiederholt sich.
import * as THREE from 'three';

// Ein Zufall, der bei jedem Start gleich ist: dieselben Flecken an denselben Stellen.
function random(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

function canvasTexture(size, draw, repeat = true) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    draw(canvas.getContext('2d'), size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    return texture;
}

function shade(hex, factor) {
    const color = new THREE.Color(hex);
    color.multiplyScalar(factor);
    return `#${color.getHexString()}`;
}

// Fleckige Stellen: viele weiche, halb durchsichtige Kreise. Ein Fleck am
// Rand wird auch auf der anderen Seite gemalt, jede Kopie mit ihrem eigenen
// Verlauf um ihre eigene Mitte: So geht die Textur nahtlos weiter.
function blotches(context, size, rng, color, count, radius, alpha) {
    const inner = color.replace(')', `, ${alpha})`).replace('rgb', 'rgba');
    const outer = color.replace(')', ', 0)').replace('rgb', 'rgba');
    for (let i = 0; i < count; i++) {
        const x = rng() * size, y = rng() * size, r = radius * (0.4 + rng());
        for (const dx of [-size, 0, size]) {
            for (const dy of [-size, 0, size]) {
                const cx = x + dx, cy = y + dy;
                if (cx + r < 0 || cy + r < 0 || cx - r > size || cy - r > size) continue;
                const gradient = context.createRadialGradient(cx, cy, 0, cx, cy, r);
                gradient.addColorStop(0, inner);
                gradient.addColorStop(1, outer);
                context.fillStyle = gradient;
                context.beginPath();
                context.arc(cx, cy, r, 0, Math.PI * 2);
                context.fill();
            }
        }
    }
}

export function wallpaperTexture(base) {
    return canvasTexture(512, (context, size) => {
        const rng = random(7);
        context.fillStyle = base;
        context.fillRect(0, 0, size, size);
        // feine senkrechte Streifen
        for (let x = 0; x < size; x += 16) {
            context.fillStyle = shade(base, x % 32 === 0 ? 0.93 : 1.04);
            context.fillRect(x, 0, 6, size);
        }
        // ein blasses Rautenmuster, wie es alte Tapeten haben
        context.strokeStyle = shade(base, 0.86);
        context.lineWidth = 2;
        for (let y = 0; y < size; y += 64) {
            for (let x = 0; x < size; x += 64) {
                context.beginPath();
                context.moveTo(x + 32, y + 8);
                context.lineTo(x + 56, y + 32);
                context.lineTo(x + 32, y + 56);
                context.lineTo(x + 8, y + 32);
                context.closePath();
                context.stroke();
            }
        }
        // vergilbte und feuchte Stellen
        blotches(context, size, rng, 'rgb(120, 96, 30)', 10, 70, 0.10);
        blotches(context, size, rng, 'rgb(255, 245, 190)', 6, 50, 0.08);
    });
}

// Der Teppich wiederholt sich erst nach zwei Metern, damit seine Flecken
// kein Muster bilden (repeat 0.5 bei Texturkoordinaten in Metern).
export function carpetTexture(base) {
    const texture = canvasTexture(1024, (context, size) => {
        const rng = random(11);
        context.fillStyle = base;
        context.fillRect(0, 0, size, size);
        // Fasern: viele kleine Punkte, etwas heller oder dunkler
        const image = context.getImageData(0, 0, size, size);
        for (let i = 0; i < image.data.length; i += 4) {
            const n = 0.85 + rng() * 0.3;
            image.data[i] *= n;
            image.data[i + 1] *= n;
            image.data[i + 2] *= n;
        }
        context.putImageData(image, 0, 0);
        // feuchte, dunkle Flecken
        blotches(context, size, rng, 'rgb(50, 40, 15)', 7, 160, 0.07);
    });
    texture.repeat.set(0.5, 0.5);
    return texture;
}

export function ceilingTexture(base) {
    return canvasTexture(512, (context, size) => {
        const rng = random(23);
        context.fillStyle = base;
        context.fillRect(0, 0, size, size);
        // Deckenplatten: Löcher im Mineralfaser-Muster
        context.fillStyle = shade(base, 0.82);
        for (let i = 0; i < 900; i++) {
            context.fillRect(rng() * size, rng() * size, 2, 2);
        }
        // die Schienen zwischen den Platten, alle 60 cm (zwei pro Meter, ungefähr)
        context.fillStyle = shade(base, 0.7);
        context.fillRect(0, 0, size, 6);
        context.fillRect(0, 0, 6, size);
        context.fillRect(0, size / 2 - 3, size, 6);
        blotches(context, size, rng, 'rgb(130, 105, 50)', 3, 60, 0.12);
    });
}

// Die Leuchte selbst: helles Feld mit Raster
// Eine Leuchte von unten: Sie ist viel heller als alles um sie her, darum
// sieht ihre Mitte fast weiß aus, auch bei farbigem Licht; nur Raster und Rand
// haben ihre Farbe. Sonst verschwände eine rote Leuchte an ihrer roten Decke.
export function lampTexture(color) {
    const core = `#${new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.65).getHexString()}`;
    return canvasTexture(128, (context, size) => {
        context.fillStyle = core;
        context.fillRect(0, 0, size, size);
        context.fillStyle = shade(color, 0.82);
        for (let i = 1; i < 4; i++) {
            context.fillRect(0, (size * i) / 4 - 1, size, 2);
            context.fillRect((size * i) / 4 - 1, 0, 2, size);
        }
        context.strokeStyle = shade(color, 0.55);
        context.lineWidth = 6;
        context.strokeRect(3, 3, size - 6, size - 6);
    }, false);
}

// Der Schein um eine Leuchte: in der Mitte hell, nach außen weich auslaufend
// (so fällt Licht aus einer hellen Fläche ins Auge), in der Farbe der Leuchte
export function glowTexture(color) {
    return canvasTexture(128, (context, size) => {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(String(color).slice(i, i + 2), 16));
        const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        for (const [stop, alpha] of [[0, 0.9], [0.12, 0.55], [0.3, 0.2], [0.6, 0.05], [1, 0]]) {
            gradient.addColorStop(stop, `rgba(${r}, ${g}, ${b}, ${alpha})`);
        }
        context.fillStyle = gradient;
        context.fillRect(0, 0, size, size);
    }, false);
}

// Eine schlichte Fläche in einer Farbe, leicht fleckig: für farbige Blöcke
export function plainTexture(base) {
    return canvasTexture(256, (context, size) => {
        const rng = random(31);
        context.fillStyle = base;
        context.fillRect(0, 0, size, size);
        const image = context.getImageData(0, 0, size, size);
        for (let i = 0; i < image.data.length; i += 4) {
            const n = 0.94 + rng() * 0.12;
            image.data[i] *= n;
            image.data[i + 1] *= n;
            image.data[i + 2] *= n;
        }
        context.putImageData(image, 0, 0);
        blotches(context, size, rng, 'rgb(40, 35, 20)', 3, 50, 0.08);
    });
}

// Marmor: cremeweiß mit feinen grauen Adern. Die Adern sind Sinuswellen,
// deren Verlauf ein Rauschen in mehreren Größen verbiegt (Turbulenz). Jede
// Größe wiederholt sich genau über die Breite der Textur: nahtlos.
// size: 512 für Statuen; meters: auf Wänden und Böden so viele Meter pro Wiederholung
export function marbleTexture(size = 512, meters = 1) {
    const texture = canvasTexture(size, (context, size) => {
        const rng = random(41);
        const values = Array.from({ length: 64 * 64 }, () => rng());
        // Rauschen mit Periode period: an der Kante dieselben Werte wie am Anfang
        const noise = (x, y, period) => {
            const x0 = Math.floor(x), y0 = Math.floor(y);
            const fx = x - x0, fy = y - y0;
            const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
            const at = (i, j) => values[(((j % period) + period) % period) * 64 + (((i % period) + period) % period)];
            const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
            const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
            return top + (bottom - top) * sy;
        };
        const image = context.createImageData(size, size);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                let turbulence = 0;
                for (let octave = 1, scale = 4; octave <= 4; octave++, scale *= 2) {
                    turbulence += noise((x / size) * scale, (y / size) * scale, scale) / octave;
                }
                // eine Ader ist dort, wo der Sinus nahe null ist: schmal und hellgrau
                const vein = Math.abs(Math.sin(((x + y) / size) * Math.PI * 3 + turbulence * 5));
                const line = 1 - Math.min(1, vein / 0.08);
                const cloud = 0.94 + 0.06 * noise((x / size) * 8, (y / size) * 8, 8);
                const shade = cloud * (1 - 0.32 * line);
                const i = (y * size + x) * 4;
                image.data[i] = 240 * shade;
                image.data[i + 1] = 236 * shade;
                image.data[i + 2] = 228 * shade;
                image.data[i + 3] = 255;
            }
        }
        context.putImageData(image, 0, 0);
    });
    texture.repeat.set(1 / meters, 1 / meters);
    return texture;
}

// Eine Farbe wie #c9b458 als drei Zahlen von 0 bis 255
function rgb(hex) {
    const value = parseInt(String(hex).replace('#', ''), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

// Holz: Bretter, 12,5 cm breit, an der Wand senkrecht, auf dem Boden längs.
// Jedes Brett hat seinen eigenen Ton, eine Maserung aus feinen Linien, die
// sich sanft hin und her biegen, und irgendwo eine Fuge quer, wo es endet.
// Alles wiederholt sich genau nach einem Meter: nahtlos.
export function woodTexture(base) {
    return canvasTexture(512, (context, size) => {
        const rng = random(57);
        const [r, g, b] = rgb(base);
        const boards = 8, width = size / boards;
        const tones = Array.from({ length: boards }, () => 0.8 + rng() * 0.32);
        const ends = Array.from({ length: boards }, () => Math.floor(rng() * size));
        const phase = Array.from({ length: boards }, () => rng() * Math.PI * 2);
        const image = context.createImageData(size, size);
        for (let y = 0; y < size; y++) {
            const t = (y / size) * Math.PI * 2;
            for (let x = 0; x < size; x++) {
                const board = Math.floor(x / width), u = x - board * width;
                const bend = Math.sin(2 * t + phase[board]) * 3 + Math.sin(5 * t + 2 * phase[board]) * 1.2;
                const grain = 0.5 + 0.5 * Math.sin((u + bend) * 0.9 + 5 * phase[board]);
                let f = tones[board] * (0.9 + 0.12 * grain);
                if (u < 1.5) f *= 0.55;                                        // Fuge zwischen zwei Brettern
                if (Math.abs((((y - ends[board]) % size) + size) % size) < 1.5) f *= 0.6;   // Fuge quer
                const i = (y * size + x) * 4;
                image.data[i] = Math.min(255, r * f);
                image.data[i + 1] = Math.min(255, g * f);
                image.data[i + 2] = Math.min(255, b * f);
                image.data[i + 3] = 255;
            }
        }
        context.putImageData(image, 0, 0);
    });
}

// Fliesen wie im Schwimmbad: 10 cm groß, jede in einem etwas anderen Ton,
// dazwischen dunklere Fugen. Die Fuge am Rand der Textur ist halb so breit: Zwei Ränder
// nebeneinander ergeben eine ganze, nahtlos.
export function tileTexture(base) {
    return canvasTexture(640, (context, size) => {
        const rng = random(63);
        const [r, g, b] = rgb(base);
        const count = 10, tile = size / count, grout = 4;
        context.fillStyle = `rgb(${r * 0.7}, ${g * 0.7}, ${b * 0.7})`;
        context.fillRect(0, 0, size, size);
        for (let j = 0; j < count; j++) {
            for (let i = 0; i < count; i++) {
                const f = 0.95 + rng() * 0.08;
                context.fillStyle = `rgb(${Math.min(255, r * f)}, ${Math.min(255, g * f)}, ${Math.min(255, b * f)})`;
                context.fillRect(i * tile + grout / 2, j * tile + grout / 2, tile - grout, tile - grout);
            }
        }
        blotches(context, size, rng, 'rgb(40, 35, 20)', 3, 60, 0.05);
    });
}

// Samt wie im Kino: eine glatte Wand, bespannt mit Stoff in senkrechten
// Streifen, 12,5 cm breit, abwechselnd heller und dunkler, mit weichen
// Kanten. Darüber ein feiner Flor mit langen Strichen in Strichrichtung.
// Acht Streifen auf einen Meter: nahtlos.
export function velvetTexture(base) {
    return canvasTexture(512, (context, size) => {
        const rng = random(71);
        const [r, g, b] = rgb(base);
        const stripes = 8, width = size / stripes;
        const streak = Array.from({ length: size }, () => 0.96 + rng() * 0.08);   // je Spalte ein Strich im Flor
        const image = context.createImageData(size, size);
        for (let x = 0; x < size; x++) {
            const u = (x % width) / width;
            // hell oder dunkel, an der Grenze über zwei Pixel weich überblendet
            const edge = Math.min(1, Math.min(u, 1 - u) * width / 2);
            const dark = Math.floor(x / width) % 2 === 1;
            const tone = dark ? 0.8 + 0.2 * (1 - edge) * 0.5 : 1 - 0.2 * (1 - edge) * 0.5;
            for (let y = 0; y < size; y++) {
                const f = tone * streak[x] * (0.95 + rng() * 0.07);
                const i = (y * size + x) * 4;
                image.data[i] = Math.min(255, r * f);
                image.data[i + 1] = Math.min(255, g * f);
                image.data[i + 2] = Math.min(255, b * f);
                image.data[i + 3] = 255;
            }
        }
        context.putImageData(image, 0, 0);
    });
}

