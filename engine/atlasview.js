// Shift+G oder ?show=atlas: die Lightmap selbst, so wie die Grafikkarte sie
// hat. Mit &face=raum,art (etwa face=saal,floor; dazu eine Zahl: die
// zweitgrößte, drittgrößte …; dazu fine: ihr feineres Stück) nur das Rechteck
// einer Fläche, Punkt für Punkt, ohne Mischen: So sieht man die Punkte. Jede Fläche des Levels ist ein Rechteck darin (geometry.js,
// packRectangles), die großen oben, die kleinen darunter dicht an dicht; die feineren
// Stücke um Modelle und Blöcke sind eigene Rechtecke. Gezeigt wird das Licht
// darin, direkt, flackernd und abgeprallt zusammen, wie die Flächen es zeigen.
import * as THREE from 'three';

const vertexShader = /* glsl */ `
varying vec2 vUv;
uniform vec2 fit;
uniform bool flip;
void main() {
    vUv = flip ? vec2(uv.x, 1.0 - uv.y) : uv;   // die ganze Lightmap: die erste Reihe (die größten Flächen) oben, wie gelesen
    gl_Position = vec4(position.xy * fit, 0.0, 1.0);
}`;

const fragmentShader = /* glsl */ `
uniform sampler2D steadyMap;
uniform sampler2D flickerMap;
uniform sampler2D indirectMap;
uniform float intensity;
uniform float indirectIntensity;
uniform bool squared;
uniform vec3 bakeTiles;
uniform float atlasSize;
uniform vec4 rect;      // was gezeigt wird: Ecke und Größe, in Punkten
uniform bool nearest;   // jeden Punkt als Quadrat statt gemischt
varying vec2 vUv;
// wie in den Flächen (main.js): beim Backen zählt jedes Stück seine Durchgänge selbst
float passScale(vec2 uv) {
    if (bakeTiles.x < 0.0) return 1.0;
    float n = ceil(atlasSize / bakeTiles.z);
    vec2 t = min(floor(uv * atlasSize / bakeTiles.z), vec2(n - 1.0));
    float count = bakeTiles.x + (t.y * n + t.x < bakeTiles.y ? 1.0 : 0.0);
    return count > 0.0 ? 1.0 / count : 0.0;
}
void main() {
    vec2 texel = rect.xy + vUv * rect.zw;
    vec2 uv = (nearest ? floor(texel) + 0.5 : texel) / atlasSize;
    float scale = passScale(uv);
    vec4 steady = texture2D(steadyMap, uv) * scale;
    vec4 flickering = texture2D(flickerMap, uv) * scale;
    vec3 indirect = texture2D(indirectMap, uv).rgb;
    if (squared) {
        steady *= steady;
        flickering *= flickering;
        indirect *= indirect;
    }
    vec3 light = (steady.rgb + vec3(flickering.x + flickering.y + flickering.z + flickering.w)) * intensity + indirect * indirectIntensity;
    light = light / (1.0 + light);   // sehr Helles nicht ganz weiß
    gl_FragColor = vec4(pow(light, vec3(1.0 / 2.2)), 1.0);
}`;

// shared: die Werte, mit denen auch die Flächen das Licht zeigen (main.js);
// face: 'raum,art[,nummer][,fine]' oder null für die ganze Lightmap
export function atlasView(renderer, baker, shared, geometry, level, face = null) {
    const size = geometry.atlasSize;
    let shown = [0, 0, size, size];
    if (face) {
        const parts = face.split(',').map((part) => part.trim());
        const [roomId, kind] = parts;
        const number = Number(parts.find((part) => /^\d+$/.test(part)) ?? 0);
        const room = level.rooms.findIndex((r) => r.id === roomId);
        const found = geometry.rects.filter((r) => r.room === room && r.kind === kind).sort((a, b) => b.w * b.h - a.w * a.h)[number];
        const pick = parts.includes('fine') ? found?.fine : found;
        if (pick) shown = [pick.x, pick.y, pick.w, pick.h];
        else console.warn(`?face=${face}: there is no such face`);
    }
    const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
            steadyMap: { value: null },
            flickerMap: { value: null },
            indirectMap: { value: null },
            intensity: shared.intensity,
            indirectIntensity: shared.indirectIntensity,
            squared: shared.squared,
            bakeTiles: shared.bakeTiles,
            atlasSize: { value: size },
            rect: { value: new THREE.Vector4(...shown) },
            nearest: { value: Boolean(face) },
            flip: { value: !face },
            fit: { value: new THREE.Vector2(1, 1) },
        },
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
    });
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b0b0d');
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    scene.add(quad);
    const camera = new THREE.Camera();
    let active = false;
    return {
        get active() { return active; },
        toggle() { active = !active; },
        render() {
            const u = material.uniforms;
            u.steadyMap.value = baker.steady;
            u.flickerMap.value = baker.flicker;
            u.indirectMap.value = baker.indirect;
            // so groß es passt, mit etwas Rand, Punkte quadratisch
            const screen = window.innerWidth / window.innerHeight, shape = shown[2] / shown[3];
            if (shape > screen) u.fit.value.set(0.96, 0.96 * screen / shape);
            else u.fit.value.set(0.96 * shape / screen, 0.96);
            renderer.setRenderTarget(null);
            renderer.render(scene, camera);
        },
    };
}
