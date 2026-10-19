// Lädt ein Level, baut es, backt das Licht und lässt dich hindurchgehen:
// am Rechner, mit Rot-Cyan-Brille (Taste 3) oder mit einer VR-Brille.
// M oder Tab zeigt das ganze Bauwerk von oben, als Drahtgitter (Automap).
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { AnaglyphEffect } from 'three/addons/effects/AnaglyphEffect.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadLevel } from './level.js';
import { buildGeometry } from './geometry.js';
import { buildGrid, LightBaker, lightRange } from './bake.js';
import { wallpaperTexture, carpetTexture, ceilingTexture, lampTexture, plainTexture, marbleTexture } from './textures.js';
import { Walker } from './controls.js';
import { Automap } from './automap.js';
import { fingerprint, encodeLight, findLight, writeCache, download, lightFileName } from './lightstore.js';

const params = new URLSearchParams(location.search);
const PASSES_PER_FRAME = 4;    // pro Bild, solange gebacken wird
const DARK_SECONDS = 1.2;      // erst nur die Linien im Dunkeln
const SWITCH_SECONDS = 2.0;    // dann gehen die Leuchten nacheinander an
const FLICKER_CHANNELS = 4;    // so viele Gruppen flackern unabhängig voneinander

const levelFile = params.get('level') ?? 'level.ini';
// Was zu sehen ist: Jede Taste schaltet einen Teil an oder aus, ein Klick
// auf seinen Schalter auch. ?show=light, direct oder bounce wählt den Anfang.
const PARTS = [
    { name: 'textures', key: 'KeyT', label: 'Textures' },
    { name: 'direct', key: 'KeyL', label: 'Direct light' },
    { name: 'bounce', key: 'KeyB', label: 'Bounce light' },
    { name: 'occlusion', key: 'KeyO', label: 'Occlusion' },
    { name: 'flicker', key: 'KeyF', label: 'Flicker' },
    { name: 'wireframe', key: 'KeyE', label: 'Edges', on: false },
];
const status = document.getElementById('status');
const title = document.getElementById('title');
const bar = document.getElementById('progress');
const controls = document.getElementById('controls');
const help = document.getElementById('help');
// was die Maus und die Tasten gerade tun, unten im Kasten oben links
const WALK_HELP = 'Click into the picture to look around with the mouse · WASD to walk, Shift to run';
const AUTOMAP_HELP = 'Automap: drag to turn it, Shift+drag to move it, mouse wheel to zoom · WASD still walks · M or Esc closes it';

// Ein Schalter mit Lämpchen (grün, wenn an) und seiner Taste. Ohne state
// ist es ein Knopf, der etwas tut. Er nimmt keinen Fokus, damit die Tasten
// weiter beim Spiel ankommen.
function addControl(label, key, onClick, state = null) {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.className = state ? 'flag' : 'flag action';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const text = document.createElement('span');
    text.textContent = label;
    button.append(dot, text);
    if (key) {
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        button.append(kbd);
    }
    button.addEventListener('click', onClick);
    controls.appendChild(button);
    return () => { if (state) button.classList.toggle('on', state()); };
}

function report(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('error', isError);
}

async function fetchText(file) {
    const response = await fetch(file, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

// Eine Statue: auf die gewünschte Höhe gebracht, mitten aufs Feld gestellt.
// bytes bekommt die Datei, für den Fingerabdruck des gespeicherten Lichts.
async function loadStatue(thing, settings, bytes) {
    const response = await fetch(thing.model);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    bytes.push(thing.model, buffer);
    const gltf = await new GLTFLoader().parseAsync(buffer, thing.model.replace(/[^/]*$/, ''));
    const object = gltf.scene;
    // Unsichtbare Kollisionskörper, die manche Modelle mitbringen, gehören nicht ins Bild
    const colliders = [];
    object.traverse((node) => { if (/collider/i.test(node.name)) colliders.push(node); });
    for (const node of colliders) node.removeFromParent();
    // Manche Modelle liegen auf dem Rücken (z nach oben statt y): aufstellen.
    // tilt = Grad dreht um die x-Achse, falls die Figur dann noch falsch steht.
    const lying = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
    const tilt = thing.tilt !== undefined ? THREE.MathUtils.degToRad(thing.tilt)
        : lying.z > 1.5 * lying.y && lying.z > lying.x ? Math.PI / 2 : 0;
    if (tilt) {
        const upright = new THREE.Group();
        upright.add(object);
        object.rotation.x = tilt;
        return placeStatue(upright, thing, settings);
    }
    return placeStatue(object, thing, settings);
}

function placeStatue(object, thing, settings) {
    // material = marble: Marmor statt der eigenen Textur des Modells
    if (thing.material === 'marble') {
        const marble = marbleTexture();
        object.traverse((mesh) => {
            if (mesh.isMesh) mesh.material = new THREE.MeshBasicMaterial({ map: marble });
        });
    }
    const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
    object.scale.setScalar(thing.height / Math.max(size.y, 1e-6));
    object.rotation.y = THREE.MathUtils.degToRad(thing.rotation);
    object.updateMatrixWorld(true);
    const placed = new THREE.Box3().setFromObject(object);
    const center = placed.getCenter(new THREE.Vector3());
    // auf dem Boden oder auf ihrem Sockel (pedestal)
    object.position.set((thing.x + 0.5) * settings.cell - center.x, (thing.base ?? 0) - placed.min.y, (thing.z + 0.5) * settings.cell - center.z);
    object.updateMatrixWorld(true);
    return object;
}

// Wohin eine Leuchte strahlt: senkrecht aus der Ebene der Decke über ihr
function lampNormal(light) {
    return new THREE.Vector3(light.tilt?.[0] ?? 0, -1, light.tilt?.[1] ?? 0).normalize();
}

// Statuen bekommen ihr Licht nicht aus der Lichtkarte, sondern einmal
// ausgerechnet für jede Ecke: Leuchten in der Nähe plus Umgebungslicht.
function lightStatue(object, lights, ambient) {
    const down = new Map(lights.map((light) => [light, lampNormal(light)]));
    const color = new THREE.Color();
    const p = new THREE.Vector3(), n = new THREE.Vector3(), l = new THREE.Vector3();
    object.traverse((mesh) => {
        if (!mesh.isMesh) return;
        const geometry = mesh.geometry;
        if (!geometry.attributes.normal) geometry.computeVertexNormals();
        const position = geometry.attributes.position, normal = geometry.attributes.normal;
        const colors = new Float32Array(position.count * 3);
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
        for (let i = 0; i < position.count; i++) {
            p.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
            n.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
            let r = ambient, g = ambient, b = ambient;
            for (const light of lights) {
                l.copy(light.position).sub(p);
                const d2 = l.lengthSq();
                const range = lightRange(light), distance = Math.sqrt(d2);
                if (distance > range) continue;
                const fade = 1 - THREE.MathUtils.smoothstep(distance, 0.7 * range, range);
                l.normalize();
                const amount = Math.max(n.dot(l), 0) * Math.max(-l.dot(down.get(light)), 0) * 30 * light.power
                    * light.size[0] * light.size[1] / (Math.PI * d2 + 0.05) * fade;
                color.set(light.color);
                r += color.r * amount; g += color.g * amount; b += color.b * amount;
            }
            colors.set([r, g, b], i * 3);
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        mesh.userData.direct = colors.slice();   // ohne Bounce-Licht, das kommt nach dem Backen dazu
        const old = mesh.material;
        mesh.material = new THREE.MeshBasicMaterial({
            map: old.map ?? null,
            color: old.map ? 0xffffff : (old.color ?? new THREE.Color(0xb8b0a0)),
            vertexColors: true,
        });
        mesh.userData.baseColor = mesh.material.color.clone();
        mesh.userData.map = mesh.material.map;
    });
}

// Das Licht einer Statue aus seinen Teilen, je nachdem, welche an sind
function showStatueLight(statues, parts) {
    for (const statue of statues) statue.traverse((mesh) => {
        if (!mesh.isMesh || !mesh.userData.direct) return;
        const { direct, bounced } = mesh.userData;
        const color = mesh.geometry.attributes.color;
        for (let i = 0; i < color.array.length; i++) {
            color.array[i] = (parts.direct ? direct[i] : 0) + (parts.bounce && bounced ? bounced[i] : 0);
        }
        color.needsUpdate = true;
        mesh.material.map = parts.textures ? mesh.userData.map : null;
        mesh.material.needsUpdate = true;
    });
}

// Die Ecken aller Statuen in fester Reihenfolge, für das gespeicherte Licht
function statueLightMeshes(statues) {
    const meshes = [];
    for (const statue of statues) statue.traverse((mesh) => { if (mesh.isMesh && mesh.userData.direct) meshes.push(mesh); });
    return meshes;
}

// Das gebackene Licht aller Statuen hintereinander, oder null, wenn es noch fehlt
function collectStatueLight(statues) {
    const meshes = statueLightMeshes(statues);
    if (meshes.length === 0 || meshes.some((mesh) => !mesh.userData.bounced)) return null;
    const total = meshes.reduce((sum, mesh) => sum + mesh.userData.direct.length, 0);
    const direct = new Float32Array(total), bounced = new Float32Array(total);
    let offset = 0;
    for (const mesh of meshes) {
        direct.set(mesh.userData.direct, offset);
        bounced.set(mesh.userData.bounced, offset);
        offset += mesh.userData.direct.length;
    }
    return { direct, bounced };
}

// Gespeichertes Licht wieder auf die Statuen verteilen; false, wenn es nicht passt
function restoreStatueLight(statues, saved) {
    const meshes = statueLightMeshes(statues);
    const total = meshes.reduce((sum, mesh) => sum + mesh.userData.direct.length, 0);
    if (total !== saved.direct.length) return false;
    let offset = 0;
    for (const mesh of meshes) {
        const length = mesh.userData.direct.length;
        mesh.userData.direct = saved.direct.slice(offset, offset + length);
        mesh.userData.bounced = saved.bounced.slice(offset, offset + length);
        offset += length;
    }
    return true;
}

// Nach dem Backen: das Licht für jede Ecke jeder Statue auf der Grafikkarte,
// mit Schatten der Statue auf sich selbst, direktes und Bounce-Licht getrennt.
function bounceStatues(statues, baker, parts) {
    const meshes = [];
    for (const statue of statues) statue.traverse((mesh) => { if (mesh.isMesh && mesh.userData.direct) meshes.push(mesh); });
    const total = meshes.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);
    if (total === 0) return;
    const positions = new Float32Array(total * 3), normals = new Float32Array(total * 3);
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    let offset = 0;
    for (const mesh of meshes) {
        const position = mesh.geometry.attributes.position, normal = mesh.geometry.attributes.normal;
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
        for (let i = 0; i < position.count; i++, offset++) {
            p.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
            n.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
            positions.set([p.x, p.y, p.z], offset * 3);
            normals.set([n.x, n.y, n.z], offset * 3);
        }
    }
    const direct = baker.vertexLight(positions, normals, true);
    const bounced = baker.vertexLight(positions, normals, false);
    offset = 0;
    for (const mesh of meshes) {
        const length = mesh.geometry.attributes.color.array.length;
        mesh.userData.direct = direct.slice(offset, offset + length);
        mesh.userData.bounced = bounced.slice(offset, offset + length);
        offset += length;
    }
    showStatueLight(statues, parts);
}

// Wand, Boden und Decke: Textur mal Licht aus den beiden Lichtkarten
function surfaceMaterial(map, baker, uniforms) {
    return new THREE.ShaderMaterial({
        uniforms: {
            map: { value: map },
            mapScale: { value: map.repeat.x },   // der Teppich wiederholt sich erst nach zwei Metern
            steadyMap: { value: baker.steady },
            flickerMap: { value: baker.flicker },
            indirectMap: { value: baker.indirect },
            ...uniforms,
        },
        vertexShader: /* glsl */ `
            attribute vec2 uv1;
            varying vec2 vUv;
            varying vec2 vLightUv;
            void main() {
                vUv = uv;
                vLightUv = uv1;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: /* glsl */ `
            uniform sampler2D map;
            uniform float mapScale;
            uniform sampler2D steadyMap;
            uniform sampler2D flickerMap;
            uniform sampler2D indirectMap;     // Bounce-Licht: Licht, das von Flächen zurückgeworfen wurde
            uniform float intensity;
            uniform float indirectIntensity;
            uniform float occlusionScale;
            uniform bool squared;              // gespeichertes Licht steht als Wurzel in den Lightmaps
            uniform bool useTexture;           // die Tasten T, I, B und O
            uniform bool useDirect;
            uniform bool useBounce;
            uniform bool useOcclusion;
            uniform vec4 flicker;              // wie hell jeder Kanal gerade ist
            uniform vec3 channelColor[${FLICKER_CHANNELS}];
            varying vec2 vUv;
            varying vec2 vLightUv;
            void main() {
                vec3 base = useTexture ? texture2D(map, vUv * mapScale).rgb : vec3(0.8);
                vec4 steady = texture2D(steadyMap, vLightUv);
                vec4 flickering = texture2D(flickerMap, vLightUv);
                vec3 indirect = texture2D(indirectMap, vLightUv).rgb;
                if (squared) {
                    steady *= steady;
                    flickering *= flickering;
                    indirect *= indirect;
                }
                vec4 f = flickering * flicker;
                vec3 light = steady.rgb
                    + f.x * channelColor[0] + f.y * channelColor[1] + f.z * channelColor[2] + f.w * channelColor[3];
                vec3 direct = light * intensity;
                // Bounce-Licht, in Ecken dunkler: wie offen die Stelle ist, steht im Alphakanal
                float open = steady.a * occlusionScale;
                float occlusion = useOcclusion ? mix(1.0, open, 0.85) : 1.0;
                vec3 bounced = indirect * indirectIntensity * occlusion;
                light = (useDirect ? direct : vec3(0.0)) + (useBounce ? bounced : vec3(0.0));
                gl_FragColor = vec4(base * light, 1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }`,
    });
}

// Wie hell ein flackernder Kanal gerade ist: meistens ganz, manchmal ein
// paar Sekunden lang unruhig, dann kurz fast aus.
function flickerValue(t, seed) {
    const noise = (x) => {
        const s = Math.sin(x * 12.9898 + seed * 78.233) * 43758.5453;
        return s - Math.floor(s);
    };
    if (noise(Math.floor(t / 3)) <= 0.55) return 1;
    const step = Math.floor(t * 14);
    return noise(step) > 0.7 ? 0.08 + 0.3 * noise(step + 0.5) : 1;
}

// Ein kurzer Fingerabdruck des Grundrisses (Größe und Felder)
function layoutPrint(level) {
    let hash = 2166136261;
    for (const char of `${level.width}x${level.depth}:${level.cells.join('')}`) {
        hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    }
    return (hash >>> 0).toString(36);
}

async function start() {
    let level;
    // Was gelesen wurde, kommt in den Fingerabdruck des gespeicherten Lichts
    const sources = [];
    const readSource = async (file) => {
        const text = await fetchText(file);
        sources.push(file, text);
        return text;
    };
    try {
        level = await loadLevel(levelFile, readSource);
    } catch (error) {
        report(error.message, true);
        return;
    }
    const { settings } = level;
    title.textContent = settings.name;
    document.title = settings.name;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    document.body.appendChild(renderer.domElement);
    // »ENTER VR« nur, wenn der Browser VR kann; sonst stünde dort »VR NOT SUPPORTED«
    navigator.xr?.isSessionSupported('immersive-vr')
        .then((supported) => { if (supported) document.body.appendChild(VRButton.createButton(renderer)); })
        .catch(() => {});

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b0a06');
    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
    const player = new THREE.Group();
    player.add(camera);
    scene.add(player);

    // Leuchten: in der Mitte ihres Feldes, knapp unter der Decke. Flackernde
    // bekommen reihum einen von vier Kanälen.
    let nextChannel = 0;
    const channelColors = Array.from({ length: FLICKER_CHANNELS }, () => new THREE.Color(0, 0, 0));
    const lights = level.things.filter((t) => t.type === 'light').map((t) => {
        const channel = t.flicker > 0 ? nextChannel++ % FLICKER_CHANNELS : -1;
        if (channel >= 0) channelColors[channel].set(t.color).multiplyScalar(t.power);
        // Die Leuchte liegt in der Ebene der Decke über ihr: Wie steil die in
        // x und z ansteigt, ergibt sich aus ihrer Höhe an den Rändern der
        // Leuchte (unter einem First steigt sie zu beiden Seiten gleich, dort
        // bleibt die Leuchte waagerecht). Dann hängt sie so tief, dass jeder
        // ihrer Punkte unter der Decke liegt, gemessen an 25 Punkten der
        // Leuchte und an den Ecken ihres Feldes (dazwischen verläuft die
        // gezeichnete Decke gerade).
        const [w, d] = t.size;
        const cell = settings.cell;
        // mx, mz: Meter von der Mitte des Feldes
        const ceiling = (mx, mz) => level.ceilingAt(t.x + 0.5 + mx / cell, t.z + 0.5 + mz / cell, t.room);
        const tilt = [(ceiling(w / 2, 0) - ceiling(-w / 2, 0)) / w, (ceiling(0, d / 2) - ceiling(0, -d / 2)) / d];
        const points = [];
        for (const fx of [-0.5, -0.25, 0, 0.25, 0.5]) for (const fz of [-0.5, -0.25, 0, 0.25, 0.5]) points.push([fx * w, fz * d]);
        for (const fx of [-0.5, 0.5]) for (const fz of [-0.5, 0.5]) points.push([fx * cell, fz * cell]);
        let y = ceiling(0, 0) - 0.03;
        for (const [mx, mz] of points) {
            const lamp = y + tilt[0] * mx + tilt[1] * mz;
            y -= Math.max(0, lamp - (ceiling(mx, mz) - 0.03));
        }
        return { ...t, channel, tilt, position: new THREE.Vector3((t.x + 0.5) * cell, y, (t.z + 0.5) * cell) };
    });

    // Statuen laden; eine, die fehlt, wird gemeldet, das Level geht trotzdem
    const statues = [];
    const statueThings = [];
    const missing = [];
    for (const thing of level.things.filter((t) => t.type === 'model')) {
        try {
            const object = await loadStatue(thing, settings, sources);
            statues.push(object);
            statueThings.push(thing);
            scene.add(object);
        } catch (error) {
            missing.push(`${thing.model} (${thing.char})`);
            sources.push(`missing ${thing.model}`);
        }
    }

    const geometry = buildGeometry(level);
    const voxels = buildGrid(level, statues, geometry.maxHeight);
    // ?bounces=0 zum Ausprobieren, sonst aus level.ini
    const bounces = params.has('bounces') ? Number(params.get('bounces')) : settings.bounces;
    const baker = new LightBaker(renderer, level, geometry, voxels, lights, bounces);

    // Gespeichertes Licht, wenn es zu genau diesem Level passt: Der
    // Fingerabdruck nimmt alles, was gelesen wurde, dazu bounces und die
    // Teile des Programms, die das Licht ausrechnen.
    const engineFiles = ['level.js', 'geometry.js', 'bake.js'];
    const engine = await Promise.all(engineFiles.map((file) => fetchText(new URL(`./${file}`, import.meta.url)).catch(() => file)));
    const print = fingerprint([...sources, `bounces ${bounces}`, ...engine]);
    const found = params.has('rebake') ? null : await findLight(levelFile, print);
    let lightSource = null;      // woher das Licht kommt, wenn es nicht gebacken wird
    let packedLight = null;      // das Licht zum Herunterladen (Save light)
    if (found?.light && baker.useSaved(found.light)) {
        lightSource = found.source;
        packedLight = found.packed;
    }

    // Für alle Flächen dieselben Werte: Helligkeit und Flackern
    const shared = {
        intensity: { value: 0 },
        indirectIntensity: { value: 0 },
        occlusionScale: { value: 0 },
        squared: { value: false },
        useTexture: { value: true },
        useDirect: { value: true },
        useBounce: { value: true },
        useOcclusion: { value: true },
        flicker: { value: new THREE.Vector4(1, 1, 1, 1) },
        channelColor: { value: channelColors.map((c) => new THREE.Vector3(c.r, c.g, c.b)) },
    };
    // Welche Teile an sind. ?show=light, direct oder bounce: nur das Licht,
    // ohne Tapete und Teppich, und davon wahlweise nur ein Teil.
    const parts = Object.fromEntries(PARTS.map((part) => [part.name, part.on ?? true]));
    const show = params.get('show');
    if (['light', 'direct', 'bounce'].includes(show)) parts.textures = false;
    if (show === 'direct') parts.bounce = false;
    if (show === 'bounce') parts.direct = false;
    const showParts = () => {
        shared.useTexture.value = parts.textures;
        shared.useDirect.value = parts.direct;
        shared.useBounce.value = parts.bounce;
        shared.useOcclusion.value = parts.occlusion;
        showStatueLight(statues, parts);
    };
    const textures = new Map();
    const textureFor = (kind, room, blockColor) => {
        const r = level.rooms[room].settings;
        // ein Block ohne eigene Farbe sieht aus wie die Wände seines Raums
        let style, color;
        if ((kind === 'block' || kind === 'baseboard') && blockColor) [style, color] = ['plain', blockColor];
        else if (kind === 'floor') [style, color] = [r.floor, r.carpet];
        else if (kind === 'ceiling') [style, color] = ['ceiling', r.ceiling];
        else [style, color] = [r.walls, r.wallpaper];
        const key = `${style}:${color}`;
        if (!textures.has(key)) {
            const make = { wallpaper: wallpaperTexture, carpet: carpetTexture, ceiling: ceilingTexture, plain: plainTexture,
                marble: () => marbleTexture(1024, 2) }[style];
            textures.set(key, make(color));
        }
        return textures.get(key);
    };
    const surfaceMaterials = [];
    for (const { kind, room, color, geometry: mesh } of geometry.meshes) {
        const material = surfaceMaterial(textureFor(kind, room, color), baker, shared);
        surfaceMaterials.push(material);
        scene.add(new THREE.Mesh(mesh, material));
    }

    // Am Anfang ist es dunkel: feine Linien an allen Kanten zeigen den Raum,
    // bis das Licht da ist, dann verblassen sie.
    const blueprint = new THREE.LineBasicMaterial({ color: '#fff4c4', transparent: true, opacity: 0.85, toneMapped: false });
    for (const { geometry: mesh } of geometry.meshes) scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh), blueprint));

    // Die Leuchten selbst: helle Felder unter der Decke, so schräg wie sie
    const panels = lights.map((light) => {
        const material = new THREE.MeshBasicMaterial({ map: lampTexture(light.color), toneMapped: false });
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(light.size[0], light.size[1]), material);
        const down = lampNormal(light);
        panel.rotation.x = Math.PI / 2;   // waagerecht, nach unten gewandt
        panel.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), down));
        panel.position.copy(light.position).addScaledVector(down, -0.012);
        scene.add(panel);
        return { light, material };
    });

    const statueMeshes = [];
    statues.forEach((statue, i) => {
        // das Umgebungslicht des Raums, in dem die Statue steht
        const room = level.rooms[statueThings[i].room].settings;
        lightStatue(statue, lights, (room.ambient ?? settings.ambient) * 1.2);
        statue.traverse((mesh) => { if (mesh.isMesh) statueMeshes.push(mesh); });
    });
    // Mit gespeichertem Licht haben die Statuen ihres schon
    let statuesBounced = false;
    if (lightSource) {
        statuesBounced = found.light.statues ? restoreStatueLight(statues, found.light.statues) : statues.length === 0;
    }
    showParts();

    const walker = new Walker(level, player, camera, renderer);
    for (const thing of level.things.filter((t) => t.type === 'model')) walker.blocked.add(`${thing.x},${thing.z}`);
    // ?view=x,z,blick,neigung,grundriss: an diese Stelle (in Feldern des
    // Bauwerks) und in diese Richtung (in Grad). Der Grundriss ist ein kurzer
    // Fingerabdruck: Hat sich das Level geändert, gilt die Stelle nicht mehr.
    const layout = layoutPrint(level);
    const place = params.get('view')?.split(',') ?? [];
    const view = place.slice(0, 4).map(Number);
    const sameLevel = place.length < 5 || place[4] === layout;
    if (sameLevel && view.length >= 2 && view.every(Number.isFinite)) {
        player.position.set((view[0] + 0.5) * settings.cell, 0, (view[1] + 0.5) * settings.cell);
        walker.yaw = THREE.MathUtils.degToRad(view[2] ?? 0);
        walker.pitch = THREE.MathUtils.degToRad(view[3] ?? 0);
    }

    const automap = new Automap(level, geometry, lights, statues, player, renderer, () => walker.pitch);
    if (params.has('automap')) automap.toggle();
    // Auch mit der Automap läuft und schaut man weiter; ein Klick fängt dort
    // aber nicht die Maus, damit man die Karte ziehen kann. In VR schaltet die
    // Grifftaste sie um.
    walker.mayCapture = () => !automap.active;
    walker.mayLook = (event) => !(automap.active && (event.shiftKey || automap.dragging));
    for (let i = 0; i < 2; i++) renderer.xr.getController(i).addEventListener('squeezestart', () => automap.toggle());

    // AnaglyphEffect rechnet mit camera.position, nicht mit der Lage in der
    // Welt. Unsere Kamera hängt am Spieler: Eine freie Kamera übernimmt jedes
    // Bild ihre Lage in der Welt.
    const anaglyph = new AnaglyphEffect(renderer);
    anaglyph.setSize(window.innerWidth, window.innerHeight);
    anaglyph.planeDistance = 1.5;   // in dieser Entfernung liegt die Bildebene
    const eyes = camera.clone();
    let useAnaglyph = params.has('anaglyph');

    // Die Schalter oben links, in derselben Reihenfolge wie ihre Tasten
    const togglePart = (part) => { parts[part.name] = !parts[part.name]; showParts(); };
    const toggleAnaglyph = () => { useAnaglyph = !useAnaglyph; };
    const toggleAutomap = () => automap.toggle(camera);
    const rebake = () => { restart = true; };
    // Save light: das Licht als Datei, die neben level.ini gehört
    const saveLight = async () => {
        if (!baker.done || !statuesBounced) {
            report('The light is not baked yet.');
            return;
        }
        if (!packedLight) await keepLight();
        if (!packedLight) {
            report('The light could not be packed (see the console).', true);
            return;
        }
        download(levelFile, packedLight);
        report(`Saved ${lightFileName(levelFile)}: put it next to ${levelFile}, then the level loads it instead of baking.`);
    };
    const refreshers = [
        ...PARTS.map((part) => addControl(part.label, part.key.slice(3), () => togglePart(part), () => parts[part.name])),
        addControl('Anaglyph', '3', toggleAnaglyph, () => useAnaglyph),
        addControl('Automap', 'M', toggleAutomap, () => automap.active),
        addControl('Rebake light', '⇧L', rebake),
        addControl('Save light', '', saveLight),
        addControl('Back to start', 'R', () => walker.toStart()),
    ];
    const refreshControls = () => {
        for (const refresh of refreshers) refresh();
        help.textContent = automap.active ? AUTOMAP_HELP : WALK_HELP;
    };
    refreshControls();

    document.addEventListener('keydown', (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
        const part = PARTS.find((p) => p.key === event.code);
        // Shift+L backt das Licht neu, L allein schaltet das direkte Licht
        if (event.code === 'KeyL' && event.shiftKey) rebake();
        else if (part) togglePart(part);
        if (event.code === 'Digit3') toggleAnaglyph();
        if (event.code === 'KeyR') walker.toStart();
        if (event.code === 'KeyM' || event.code === 'Tab') {
            event.preventDefault();
            toggleAutomap();
        }
        if (event.code === 'Escape' && automap.active) automap.toggle();
        refreshControls();
    });
    // die Grifftaste in VR schaltet die Automap auch um
    for (let i = 0; i < 2; i++) renderer.xr.getController(i).addEventListener('squeezestart', refreshControls);
    controls.addEventListener('click', refreshControls);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        anaglyph.setSize(window.innerWidth, window.innerHeight);
        automap.resize();
    });

    // Die Leuchten gehen nacheinander an, die nächsten zuerst
    const order = lights.map((light, i) => ({ i, d: light.position.distanceTo(player.position) })).sort((a, b) => a.d - b.d);
    const switchAt = new Array(lights.length);
    order.forEach(({ i }, rank) => {
        switchAt[i] = DARK_SECONDS + (SWITCH_SECONDS * rank) / Math.max(1, order.length - 1);
    });
    const on = lights.map(() => false);
    baker.switchLights(on);
    let sequenceStart = 0;   // Shift+L fängt mit dem Licht von vorn an
    let restart = false;
    let reported = false;    // ob gemeldet ist, woher das gespeicherte Licht kommt

    // Fertig gebackenes Licht im Browser aufheben (lightstore.js): Beim
    // nächsten Laden desselben Levels braucht es kein Backen.
    let packing = null;
    const keepLight = () => {
        packing ??= (async () => {
            try {
                packedLight = await encodeLight(print, baker.readLight(), collectStatueLight(statues));
                await writeCache(levelFile, print, packedLight);
            } catch (error) {
                console.warn('The baked light could not be kept:', error);
            }
            packing = null;
        })();
        return packing;
    };

    // Wo du stehst und wohin du schaust, steht in der Adresse (?view=...):
    // Nach dem Neuladen geht es dort weiter. Erst eine halbe Sekunde, nachdem
    // du stehen geblieben bist, damit der Browser nicht bei jedem Schritt schreibt.
    let lastPlace = '';
    let placeTimer = 0;
    const rememberPlace = () => {
        const x = (player.position.x / settings.cell - 0.5).toFixed(2);
        const z = (player.position.z / settings.cell - 0.5).toFixed(2);
        const place = `${x},${z},${Math.round(THREE.MathUtils.radToDeg(walker.yaw))},${Math.round(THREE.MathUtils.radToDeg(walker.pitch))},${layout}`;
        if (place === lastPlace) return;
        lastPlace = place;
        clearTimeout(placeTimer);
        placeTimer = setTimeout(() => {
            const url = new URL(location.href);
            url.searchParams.set('view', place);
            history.replaceState(null, '', url);
        }, 500);
    };

    const clock = new THREE.Timer();
    let startedAt = performance.now();
    renderer.setAnimationLoop(() => {
        clock.update();
        const dt = Math.min(clock.getDelta(), 0.05);
        const now = clock.getElapsed();
        if (restart) {
            restart = false;
            baker.dropSaved();
            lightSource = null;
            packedLight = null;
            sequenceStart = now;
            on.fill(false);
            baker.switchLights(on);
            bar.parentElement.classList.remove('done');
            startedAt = performance.now();
            statuesBounced = false;
        }
        const t = now - sequenceStart;   // Zeit seit dem Anfang des Lichts

        // Leuchten anschalten, wenn ihre Zeit gekommen ist
        let switched = false;
        lights.forEach((light, i) => {
            if (!on[i] && t >= switchAt[i]) { on[i] = true; switched = true; }
        });
        if (switched) baker.switchLights(on);
        const allOn = on.every(Boolean);

        // Linien weg, Statuen hell: beides, während die Leuchten angehen
        const shown = THREE.MathUtils.clamp((t - DARK_SECONDS) / (SWITCH_SECONDS + 0.5), 0, 1);
        blueprint.opacity = parts.wireframe ? 0.85 : 0.85 * (1 - shown);
        for (const mesh of statueMeshes) {
            if (parts.textures) mesh.material.color.copy(mesh.userData.baseColor);
            else mesh.material.color.setScalar(0.8);
            mesh.material.color.multiplyScalar(shown);
        }

        if (t < DARK_SECONDS) {
            report('Darkness. Something is humming.');
        } else if (lightSource) {
            // gespeichertes Licht: Es wird hell, während die Leuchten angehen
            bar.parentElement.classList.add('done');
            if (!allOn) report(`The lamps are coming on: ${on.filter(Boolean).length} of ${lights.length}`);
            else if (!reported) {
                reported = true;
                report(`Light loaded from ${lightSource === 'browser' ? 'this browser' : lightSource} · Shift+L bakes it again` +
                    (missing.length ? ` · missing: ${missing.join(', ')}` : ''));
            }
        } else if (!baker.done) {
            // Solange Leuchten angehen, nur direktes Licht: Abprallen lohnt erst, wenn alle an sind
            for (let i = 0; i < PASSES_PER_FRAME && !baker.done; i++) {
                if (!allOn && baker.bouncing) break;
                baker.step();
            }
            bar.style.width = `${baker.progress * 100}%`;
            report(!allOn
                ? `The lamps are coming on: ${on.filter(Boolean).length} of ${lights.length}`
                : !baker.done
                    ? `Baking light: ${baker.stage}`
                    : `Light baked in ${((performance.now() - startedAt) / 1000).toFixed(1)} s` +
                      (found?.stale ? ` · ${found.source} belongs to an older version of the level` : '') +
                      (missing.length ? ` · missing: ${missing.join(', ')}` : ''));
            if (baker.done) bar.parentElement.classList.add('done');
        }
        // gespeichertes Licht wird mit den Leuchten hell, gebackenes ist es von selbst
        const fade = lightSource ? shown : 1;
        shared.intensity.value = baker.intensity * fade;
        shared.indirectIntensity.value = baker.indirectIntensity * fade;
        shared.occlusionScale.value = baker.occlusionScale;
        shared.squared.value = baker.squared;
        // fertig gebacken: die Statuen bekommen das Bounce-Licht vor ihren
        // Flächen, und das Licht kommt in den Browser
        if (baker.done && !statuesBounced) {
            statuesBounced = true;
            bounceStatues(statues, baker, parts);
            setTimeout(keepLight, 200);
        }
        // die Lightmaps: die letzte fertige Reflexion wechselt mit jeder,
        // gespeichertes Licht ersetzt alle drei
        for (const material of surfaceMaterials) {
            material.uniforms.steadyMap.value = baker.steady;
            material.uniforms.flickerMap.value = baker.flicker;
            material.uniforms.indirectMap.value = baker.indirect;
        }

        // Flackern: Licht und Leuchte eines Kanals im selben Takt
        const values = Array.from({ length: FLICKER_CHANNELS }, (_, k) => parts.flicker ? flickerValue(now, k + 1) : 1);
        shared.flicker.value.set(...values);
        panels.forEach(({ light, material }, i) => {
            material.color.setScalar(!on[i] ? 0.08 : light.channel >= 0 ? values[light.channel] : 1);
        });

        walker.update(dt);
        rememberPlace();
        if (automap.active) {
            automap.render({
                anaglyph: useAnaglyph && !renderer.xr.isPresenting ? anaglyph : null,
                vrCamera: renderer.xr.isPresenting ? camera : null,
            });
        }
        else if (useAnaglyph && !renderer.xr.isPresenting) {
            player.updateMatrixWorld(true);
            camera.matrixWorld.decompose(eyes.position, eyes.quaternion, eyes.scale);
            eyes.aspect = camera.aspect;
            eyes.updateProjectionMatrix();
            eyes.updateMatrixWorld(true);
            anaglyph.render(scene, eyes);
        }
        else renderer.render(scene, camera);
    });
}

start();
