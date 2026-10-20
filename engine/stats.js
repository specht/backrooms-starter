// Zahlen zur Leistung (Taste I, ?stats oder »Stats« im Kasten): Bilder pro
// Sekunde, wie lange ein Bild dauert, was gezeichnet wird und ungefähr wie
// viel Speicher Texturen brauchen. Zum Ausprobieren auf einem Handy, einem
// Tablet oder einer VR-Brille: Was ist dort zu viel? In der Brille selbst
// ist die Anzeige nicht zu sehen: Sie liegt auf der Seite.
import * as THREE from 'three';

const STYLE = `
#stats { position: fixed; right: 8px; bottom: 8px; z-index: 20; padding: 8px 10px; border-radius: 6px;
  max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: hidden; box-sizing: border-box;
  background: rgba(0, 0, 0, 0.72); color: #e8e8e8; font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace;
  white-space: pre-wrap; overflow-wrap: anywhere; pointer-events: none; display: none; }
@media (max-width: 640px) { #stats { font-size: 10px; } }
#stats.on { display: block; }
#stats b { color: #ffd479; font-weight: normal; }
`;

// Bytes einer Textur auf der Grafikkarte, geschätzt: Breite mal Höhe mal
// Bytes pro Punkt, mit Mipmaps ein Drittel mehr
function textureBytes(texture) {
    const image = texture.image;
    const width = image?.width ?? 0, height = image?.height ?? 0;
    if (!width || !height) return 0;
    const perTexel = texture.type === THREE.FloatType ? 16 : texture.type === THREE.HalfFloatType ? 8 : 4;
    const depth = image.depth ?? 1;
    const mipmaps = [THREE.LinearMipmapLinearFilter, THREE.LinearMipmapNearestFilter, THREE.NearestMipmapLinearFilter, THREE.NearestMipmapNearestFilter].includes(texture.minFilter);
    return width * height * depth * perTexel * (mipmaps ? 4 / 3 : 1);
}

const megabytes = (bytes) => `${(bytes / 1048576).toFixed(0)} MB`;

export function createStats(renderer, { models, geometry, baker, level }) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.append(style);
    const box = document.createElement('div');
    box.id = 'stats';
    document.body.append(box);

    const gl = renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);

    // die Texturen der Modelle, jede einmal (Modelle teilen sich Texturen)
    let modelBytes = null;
    const countModels = () => {
        const seen = new Set();
        let bytes = 0, triangles = 0, instances = 0;
        for (const object of models) {
            instances += 1;
            object.traverse((mesh) => {
                if (!mesh.isMesh) return;
                const index = mesh.geometry.index;
                triangles += (index ? index.count : mesh.geometry.attributes.position.count) / 3;
                for (const material of [mesh.material].flat()) {
                    for (const value of Object.values(material ?? {})) {
                        if (value?.isTexture && !seen.has(value)) { seen.add(value); bytes += textureBytes(value); }
                    }
                }
            });
        }
        return { bytes, textures: seen.size, triangles, instances };
    };

    let active = false;
    let frames = 0, windowStart = performance.now(), last = performance.now();
    let fps = 0, average = 0, worst = 0, slowest = 0, sum = 0;
    let firstFrame = null;
    let bakeSeconds = null, bakeStart = null;

    const toggle = () => {
        active = !active;
        box.classList.toggle('on', active);
    };

    // jedes Bild: einmal am Anfang (beginFrame), einmal am Ende (endFrame, mit dem, was zu sehen ist)
    const beginFrame = () => {
        renderer.info.reset();
        const now = performance.now();
        firstFrame ??= now;
        const dt = now - last;
        last = now;
        frames += 1;
        sum += dt;
        slowest = Math.max(slowest, dt);
        if (now - windowStart >= 1000) {
            fps = (frames * 1000) / (now - windowStart);
            average = sum / frames;
            worst = slowest;
            frames = 0; sum = 0; slowest = 0;
            windowStart = now;
        }
        if (!baker.done) bakeStart ??= now;
        else if (bakeStart !== null && bakeSeconds === null) bakeSeconds = (now - bakeStart) / 1000;
    };

    // nur zweimal je Sekunde neu: Jedes Bild neues HTML ließ den Speicher des
    // Tabs wachsen (gut 1 MB je Sekunde), bis ein Tablet ihn schloss
    let shownAt = 0, shownText = '';
    const endFrame = ({ rooms, lightSource }) => {
        if (!active) return;
        const now = performance.now();
        if (now - shownAt < 500) return;
        shownAt = now;
        modelBytes ??= models.length ? countModels() : { bytes: 0, textures: 0, triangles: 0, instances: 0 };
        const info = renderer.info;
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        const atlas = geometry.atlasSize;
        // Lightmaps: drei, gespeichert 8 Bit (RGBA); beim Backen acht Render-Targets mit Half Float
        const lightBytes = baker.saved ? 3 * atlas * atlas * 4 : (baker.prepared ? 8 * atlas * atlas * 8 : 0);
        const heap = performance.memory ? megabytes(performance.memory.usedJSHeapSize) : 'unknown';
        const light = lightSource ? `loaded (${lightSource})` : baker.done ? `baked in ${bakeSeconds?.toFixed(1) ?? '?'} s` : 'baking';
        const text = [
            `<b>${fps.toFixed(0)} fps</b>  ${average.toFixed(1)} ms per frame, slowest ${worst.toFixed(0)} ms`,
            `drawn       ${info.render.calls} draw calls, ${(info.render.triangles / 1000).toFixed(0)}k triangles`,
            `rooms       ${rooms ?? level.rooms.length} of ${level.rooms.length} drawn`,
            `screen      ${size.x} × ${size.y} pixels (pixel ratio ${renderer.getPixelRatio().toFixed(2)}, lower when it gets slow)`,
            `light       ${light}, light map ${atlas} × ${atlas}`,
            `models      ${modelBytes.instances} in the level, ${(modelBytes.triangles / 1000).toFixed(0)}k triangles, ${modelBytes.textures} textures`,
            `memory      textures of models ${megabytes(modelBytes.bytes)}, light ${megabytes(lightBytes)} (estimated)`,
            `            ${info.memory.textures} textures, ${info.memory.geometries} geometries, ${info.programs?.length ?? '?'} shaders, JS heap ${heap}`,
            `loaded in   ${firstFrame ? (firstFrame / 1000).toFixed(1) : '?'} s`,
            `GPU         ${gpu}, textures up to ${renderer.capabilities.maxTextureSize} pixels`,
        ].join('\n');
        if (text !== shownText) box.innerHTML = shownText = text;
    };

    renderer.info.autoReset = false;   // mehrere Durchgänge pro Bild (Wasser, Bloom): alle zählen
    return { toggle, beginFrame, endFrame, get active() { return active; } };
}
