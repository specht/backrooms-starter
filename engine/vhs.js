// VHS (Taste C): das Bild wie von einer alten Videokassette. Ein letzter
// Durchgang über das fertige Bild, nach dem Tone Mapping:
//
// - Datum und Uhrzeit (die echten, von deinem Rechner) und »● REC« stehen
//   im Bild, bevor es verwaschen wird: Ein Camcorder schreibt sie mit auf
//   das Band, deshalb laufen sie mit aus wie alles andere.
// - Farbe ist auf dem Band viel unschärfer als Helligkeit: Das Bild wird in
//   Helligkeit und Farbe zerlegt (YIQ, wie im Fernsehen), die Helligkeit nur
//   wenig, die Farbe stark verwischt und ein Stück nach rechts verschoben.
// - Jede Zeile wackelt ein wenig zur Seite, ab und zu läuft ein Streifen
//   Bandsalat durchs Bild, und ganz unten zuckt der Rand, wo der Videokopf
//   umschaltet.
// - dazu Zeilen, Rauschen, flaue Farben, dunkle Ecken
//
// Die Schrift ist VCR OSD Mono von Riciery Leal (fonts/, frei).
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const LINES = 288;            // so viele Zeilen hat ein Halbbild auf dem Band (PAL)
const MONTHS = ['JAN.', 'FEB.', 'MAR.', 'APR.', 'MAY', 'JUN.', 'JUL.', 'AUG.', 'SEP.', 'OCT.', 'NOV.', 'DEC.'];

const VHSShader = {
    uniforms: {
        tDiffuse: { value: null },
        tOsd: { value: null },
        resolution: { value: new THREE.Vector2(1, 1) },
        time: { value: 0 },
    },
    vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
    fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tOsd;
        uniform vec2 resolution;
        uniform float time;
        varying vec2 vUv;

        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float smoothNoise(float x) {
            float i = floor(x);
            return mix(hash(vec2(i, 0.0)), hash(vec2(i + 1.0, 0.0)), smoothstep(0.0, 1.0, fract(x)));
        }

        // was auf dem Band steht: das Bild und darüber die Schrift
        vec3 tape(vec2 uv) {
            vec3 picture = texture2D(tDiffuse, uv).rgb;
            vec4 osd = texture2D(tOsd, uv);
            return mix(picture, osd.rgb, osd.a);
        }
        vec3 toYIQ(vec3 c) {
            return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312)));
        }
        vec3 toRGB(vec3 c) {
            return vec3(c.x + 0.956 * c.y + 0.621 * c.z, c.x - 0.272 * c.y - 0.647 * c.z, c.x - 1.106 * c.y + 1.703 * c.z);
        }

        void main() {
            vec2 uv = vUv;
            float line = floor(uv.y * ${LINES}.0);

            // jede Zeile ein wenig zur Seite, 25-mal in der Sekunde neu
            float shift = (hash(vec2(line, floor(time * 25.0))) - 0.5) * 0.0015;
            // ein Streifen Bandsalat wandert langsam nach oben
            float band = fract(time * 0.045);
            float inBand = smoothstep(0.04, 0.0, abs(uv.y - band));
            shift += inBand * (smoothNoise(line * 0.8 + time * 40.0) - 0.5) * 0.025;
            // unten, wo der Videokopf umschaltet, reißt das Bild nach rechts
            float bottom = smoothstep(0.03, 0.0, uv.y);
            shift += bottom * (0.012 + (hash(vec2(line, time)) - 0.5) * 0.01);
            uv.x += shift;

            // Helligkeit wenig, Farbe stark verwischt und nach rechts verschoben
            float px = 1.0 / resolution.x * (resolution.y / 720.0);
            float luma = 0.0;
            for (int i = -2; i <= 2; i++) luma += toYIQ(tape(uv + vec2(float(i) * px, 0.0))).x;
            luma /= 5.0;
            vec2 chroma = vec2(0.0);
            for (int i = 0; i < 8; i++) chroma += toYIQ(tape(uv + vec2((float(i) - 1.5) * px * 3.0, 0.0))).yz;
            chroma /= 8.0;
            vec3 color = toRGB(vec3(luma, chroma * 0.8));

            // Zeilen, Rauschen und im Streifen Schnee
            color *= 0.9 + 0.1 * cos(vUv.y * ${LINES * 2}.0 * 3.14159);
            color += (hash(vUv * resolution + fract(time) * 100.0) - 0.5) * 0.07;
            // im Streifen Schnee: kurze helle Striche quer, nicht Punkte
            float streak = floor(vUv.x * 60.0 + hash(vec2(line, floor(time * 25.0))) * 60.0);
            float snow = step(0.86, hash(vec2(streak, line + floor(time * 25.0))));
            color += inBand * inBand * snow * (0.25 + 0.3 * hash(vec2(line, streak)));
            // flau: Schwarz nie ganz schwarz, ein Hauch Grün-Blau
            color = color * 0.9 + vec3(0.035, 0.04, 0.045);
            // dunkle Ecken
            vec2 fromCenter = vUv - 0.5;
            color *= 1.0 - 0.45 * pow(length(fromCenter * vec2(1.1, 1.3)), 2.2);
            gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
        }`,
};

export class VHSPass extends ShaderPass {
    constructor() {
        super(VHSShader);
        this.osd = document.createElement('canvas');
        this.osdTexture = new THREE.CanvasTexture(this.osd);
        this.osdTexture.colorSpace = THREE.NoColorSpace;   // Weiß bleibt Weiß, wie das Bild nach dem Tone Mapping
        this.uniforms.tOsd.value = this.osdTexture;
        this.shownText = '';
        this.fontReady = false;
        const font = new FontFace('VCR OSD Mono', `url(${new URL('./fonts/vcr-osd-mono.ttf', import.meta.url)})`);
        font.load().then((loaded) => {
            document.fonts.add(loaded);
            this.fontReady = true;
            this.shownText = '';
        }).catch((error) => console.warn('VHS: font not loaded', error));
    }

    setSize(width, height) {
        super.setSize?.(width, height);
        this.uniforms.resolution.value.set(width, height);
        this.osd.width = width;
        this.osd.height = height;
        this.shownText = '';
    }

    // die Uhr auf dem Band, wie ein Camcorder sie zeigt: PM 3:42 und OCT. 20 2026
    drawOsd(date) {
        const hours = date.getHours();
        const clock = `${hours < 12 ? 'AM' : 'PM'} ${(hours % 12) || 12}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
        const day = `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2, ' ')} ${date.getFullYear()}`;
        const text = `${clock}|${day}|${this.fontReady}`;   // die Sekunden: auch der Punkt blinkt mit
        if (text === this.shownText) return;
        this.shownText = text;
        const c = this.osd.getContext('2d');
        const { width, height } = this.osd;
        c.clearRect(0, 0, width, height);
        const size = Math.round(height * 0.055);
        c.font = `${size}px "VCR OSD Mono", monospace`;
        c.textBaseline = 'alphabetic';
        const margin = height * 0.07;
        const write = (string, x, y, align = 'left') => {
            c.textAlign = align;
            c.fillStyle = 'rgba(0, 0, 0, 0.6)';   // ein Schatten, damit es auch auf Hellem steht
            c.fillText(string, x + size * 0.08, y + size * 0.08);
            c.fillStyle = '#f4f4f0';
            c.fillText(string, x, y);
        };
        // ● REC, der Punkt blinkt im Sekundentakt, wie beim Aufnehmen
        const dot = { x: margin * 1.3 + size * 0.4, y: margin + size * 0.6, r: size * 0.36 };
        if (date.getSeconds() % 2 === 0) {
            for (const [shift, color] of [[size * 0.08, 'rgba(0, 0, 0, 0.6)'], [0, '#ff2a1f']]) {
                c.beginPath();
                c.arc(dot.x + shift, dot.y + shift, dot.r, 0, Math.PI * 2);
                c.fillStyle = color;
                c.fill();
            }
        }
        write('REC', margin * 1.3 + size * 1.1, margin + size);
        write(clock, margin * 1.3, height - margin - size * 1.35);
        write(day, margin * 1.3, height - margin);
        this.osdTexture.needsUpdate = true;
    }

    render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
        this.uniforms.time.value = performance.now() / 1000;
        this.drawOsd(new Date());
        super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    }
}
