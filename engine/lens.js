// Chromatische Aberration (Taste X): Eine einfache Linse bricht jede Farbe
// ein wenig anders, Blau stärker als Rot. Zur Mitte des Bilds hin fällt das
// nicht auf, zum Rand hin immer mehr: Helle Kanten bekommen dort farbige
// Säume, rot nach außen, blau nach innen. Ein Durchgang über das fertige
// Bild, nach dem Tone Mapping: Für jeden Punkt wird an mehreren Stellen auf
// der Linie zur Mitte nachgesehen, jede mit ihrer eigenen Farbe des
// Spektrums, so verlaufen die Säume weich statt in drei Streifen.
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const STRENGTH = 0.014;   // so weit (Anteil der Bildbreite) liegen Rot und Blau in den Ecken auseinander
const SAMPLES = 7;

const LensShader = {
    uniforms: {
        tDiffuse: { value: null },
        aspect: { value: 1 },
    },
    vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
    fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float aspect;
        varying vec2 vUv;
        // eine Farbe des Spektrums, von Rot (t = 0) über Grün nach Blau (t = 1)
        vec3 spectrum(float t) {
            return clamp(vec3(1.5 - 3.0 * t, 1.0 - abs(2.0 * t - 1.0) * 1.5, 3.0 * t - 1.5), 0.0, 1.0);
        }
        void main() {
            vec2 fromCenter = vUv - 0.5;
            // zum Rand hin quadratisch stärker, in beiden Richtungen gleich (mit dem Seitenverhältnis)
            float reach = dot(fromCenter * vec2(aspect, 1.0), fromCenter * vec2(aspect, 1.0)) / (0.25 * (aspect * aspect + 1.0));
            vec2 shift = fromCenter * ${STRENGTH} * 2.0 * reach;
            vec3 sum = vec3(0.0), weight = vec3(0.0);
            for (int i = 0; i < ${SAMPLES}; i++) {
                float t = float(i) / ${SAMPLES - 1}.0;
                vec3 w = spectrum(t);
                // Rot weiter außen, Blau weiter innen
                sum += texture2D(tDiffuse, vUv + shift * (0.5 - t)).rgb * w;
                weight += w;
            }
            gl_FragColor = vec4(sum / weight, 1.0);
        }`,
};

export class LensPass extends ShaderPass {
    constructor() {
        super(LensShader);
    }

    setSize(width, height) {
        super.setSize?.(width, height);
        this.uniforms.aspect.value = width / Math.max(1, height);
    }
}
