// Lädt ein Level, baut es, backt das Licht und lässt dich hindurchgehen:
// am Rechner, mit Rot-Cyan-Brille (Taste 3) oder mit einer VR-Brille.
// M oder Tab zeigt das ganze Bauwerk von oben, als Drahtgitter (Automap).
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { AnaglyphEffect } from 'three/addons/effects/AnaglyphEffect.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadLevel } from './level.js';
import { buildGeometry, EDGE_ANGLE } from './geometry.js';
import { buildGrid, LightBaker, lightRange, channelColors } from './bake.js';
import { wallpaperTexture, carpetTexture, ceilingTexture, lampTexture, plainTexture, marbleTexture, woodTexture, tileTexture, velvetTexture, glowTexture } from './textures.js';
import { Walker } from './controls.js';
import { Automap } from './automap.js';
import { fingerprint, encodeLight, findLight, writeCache, download, lightFileName } from './lightstore.js';
import { VHSPass } from './vhs.js';

const params = new URLSearchParams(location.search);
const PASSES_PER_FRAME = 4;    // pro Bild, solange gebacken wird
const DARK_SECONDS = 1.2;      // erst nur die Linien im Dunkeln
const SWITCH_SECONDS = 2.0;    // dann gehen die Leuchten nacheinander an
const FLICKER_CHANNELS = 4;    // so viele Gruppen flackern unabhängig voneinander
// Bloom: Was heller ist als BLOOM_THRESHOLD, strahlt in die Umgebung aus, wie
// helles Licht in einer Kamera oder im Auge. Die Leuchten sind dafür
// PANEL_HDR-mal so hell wie Weiß.
const BLOOM_STRENGTH = 0.3;
const BLOOM_RADIUS = 0.4;
const BLOOM_THRESHOLD = 2.5;   // so leuchten vor allem die Leuchten, nicht schon helle Wände
const PANEL_HDR = 5;
const GLOW = 0.85;               // wie stark der Schein um eine Leuchte ist (auf Dunklem; auf Hellem weniger)

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
    { name: 'points', key: 'KeyG', label: 'Light points', on: false },
    { name: 'bloom', key: 'KeyH', label: 'Bloom' },
    { name: 'vhs', key: 'KeyC', label: 'VHS', on: false },
];
const status = document.getElementById('status');
const title = document.getElementById('title');
const bar = document.getElementById('progress');
const controls = document.getElementById('controls');
const help = document.getElementById('help');
// was die Maus und die Tasten gerade tun, unten im Kasten oben links
const WALK_HELP = 'Click into the picture to look around with the mouse · WASD to walk, Shift to run';
const AUTOMAP_HELP = 'Automap: drag to turn it, Shift+drag to move it, mouse wheel to zoom · V: rooms or wireframe · WASD still walks · M or Esc closes it';
// auf dem Handy und Tablet (body.touch, sobald ein Finger das Bild berührt)
const TOUCH_HELP = 'Left thumb: walk (push it all the way to run) · right thumb: look around · ☰ hides this panel';
const TOUCH_AUTOMAP_HELP = 'Automap: one finger turns it, two fingers zoom and move it · Automap closes it';
// Handy oder Tablet schon beim Laden: Kein Finger muss erst das Bild berühren
if (window.matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');

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
    // eine Taste je Kappe: 'Shift+R' wird zu Shift und R
    for (const part of key ? key.split('+') : []) {
        const kbd = document.createElement('kbd');
        kbd.textContent = part;
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
    // auf dem Boden ihres Felds oder auf ihrem Sockel (pedestal)
    const [dx, dy, dz] = thing.offset ?? [0, 0, 0];   // offset = x, y, z: aus der Mitte des Felds geschoben
    object.position.set((thing.x + 0.5) * settings.cell + dx - center.x, (thing.floor ?? 0) + (thing.base ?? 0) + dy - placed.min.y, (thing.z + 0.5) * settings.cell + dz - center.z);
    object.updateMatrixWorld(true);
    return object;
}

// Eine Lampe aus einem Modell gibt so viel Licht wie eine Leuchte von
// BULB_SIZE mal BULB_SIZE Metern unter der Decke, aber nach allen Seiten
const BULB_SIZE = 0.5;

// Leuchtende Teile eines Modells (emissive, etwa eine Glühbirne) bleiben hell:
// zu ihrem Licht kommt das Leuchten aus ihrer Textur dazu
function addGlow(material, map, strength) {
    material.userData.glow = { value: strength };
    material.userData.glowBase = strength;
    material.onBeforeCompile = (shader) => {
        shader.uniforms.glowMap = { value: map };
        shader.uniforms.glowStrength = material.userData.glow;
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform sampler2D glowMap;\nuniform float glowStrength;')
            .replace('#include <opaque_fragment>', 'outgoingLight += texture2D(glowMap, vMapUv).rgb * glowStrength;\n#include <opaque_fragment>');
    };
}

// Wie stark eine Stelle eines Modells spiegelt: Metall ganz, glattes Glas
// oder Lack ein wenig, Raues gar nicht. Aus metalness und roughness des
// Modells und ihren Texturen (Poly Haven packt beide in eine: g rau, b Metall).
// Liefert { strength, map, most } oder null, wenn nichts spiegelt; most: wie
// stark die am stärksten spiegelnde Stelle spiegelt.
function reflectivity(material) {
    if (!material?.isMeshStandardMaterial) return null;
    const metal = material.metalness ?? 0, rough = material.roughness ?? 1;
    const strength = (m, r) => (0.08 + 0.92 * m) * Math.min(1, Math.max(0, (0.55 - r) / 0.45));
    const map = material.roughnessMap ?? material.metalnessMap;
    if (!map?.image) {
        const s = strength(metal, rough);
        return s > 0.02 ? { strength: s, map: null, most: s } : null;
    }
    const { width, height } = map.image;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(map.image, 0, 0);
    const pixels = context.getImageData(0, 0, width, height);
    const p = pixels.data;
    let most = 0;
    for (let i = 0; i < p.length; i += 4) {
        const r = (material.roughnessMap ? p[i + 1] / 255 : 1) * rough;
        const m = (material.metalnessMap ? p[i + 2] / 255 : 1) * metal;
        const s = strength(m, r);
        p[i] = p[i + 1] = p[i + 2] = Math.round(s * 255);
        p[i + 3] = 255;
        most = Math.max(most, s);
    }
    if (most < 0.02) return null;
    context.putImageData(pixels, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = map.flipY;
    texture.channel = map.channel;
    texture.colorSpace = THREE.NoColorSpace;
    return { strength: 1, map: texture, most };
}

// Wie fein das Rundumbild ist, je Seite: Ein Spiegel braucht es scharf, für
// etwas Glanz genügt ein grobes (ein feines kostet etwa 48 MB auf der Grafikkarte)
const REFLECTION_SHARP = 1024;
const REFLECTION_SOFT = 256;

// Spiegelungen: Ist das Licht fertig, nimmt eine Kamera aus der Mitte jedes
// spiegelnden Modells einmal ein Rundumbild des Raums auf (eine Cube Map).
// Das Modell zeigt es dort, wo es spiegelt. Es ist ein Bild: Was sich danach
// bewegt (du), ist nicht darin, aber es kostet beim Laufen nichts.
function captureReflections(renderer, scene, statues, hide) {
    for (const statue of statues) {
        const meshes = [];
        statue.traverse((mesh) => { if (mesh.isMesh && mesh.userData.reflect) meshes.push(mesh); });
        if (meshes.length === 0) continue;
        const mirror = meshes.some((mesh) => mesh.userData.reflect.most > 0.7);
        const target = statue.userData.reflection ?? new THREE.WebGLCubeRenderTarget(mirror ? REFLECTION_SHARP : REFLECTION_SOFT, { type: THREE.HalfFloatType });
        statue.userData.reflection = target;
        const camera = new THREE.CubeCamera(0.05, 80, target);
        new THREE.Box3().setFromObject(statue).getCenter(camera.position);
        statue.visible = false;
        const shown = hide.filter((object) => object.visible);
        for (const object of shown) object.visible = false;
        camera.update(renderer, scene);
        statue.visible = true;
        for (const object of shown) object.visible = true;
        for (const mesh of meshes) {
            const { strength, map } = mesh.userData.reflect;
            mesh.material.envMap = target.texture;
            mesh.material.combine = THREE.MixOperation;
            mesh.material.reflectivity = strength;
            mesh.material.specularMap = map;
            mesh.material.needsUpdate = true;
        }
    }
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
                if (light.model === object) continue;   // eine Lampe beleuchtet sich nicht selbst
                l.copy(light.position).sub(p);
                const d2 = l.lengthSq();
                const range = lightRange(light), distance = Math.sqrt(d2);
                if (distance > range) continue;
                const fade = 1 - THREE.MathUtils.smoothstep(distance, 0.7 * range, range);
                l.normalize();
                const facing = light.kind === 'bulb' ? bulbFacing(light, l) : Math.max(-l.dot(down.get(light)), 0);
                const amount = Math.max(n.dot(l), 0) * facing * 30 * light.power
                    * light.size[0] * light.size[1] / (Math.PI * d2 + 0.05) * fade;
                color.set(light.color);
                r += color.r * amount; g += color.g * amount; b += color.b * amount;
            }
            colors.set([r, g, b], i * 3);
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        mesh.userData.direct = colors.slice();   // ohne Bounce-Licht, das kommt nach dem Backen dazu
        const old = mesh.material;
        const reflect = reflectivity(old);
        if (reflect) mesh.userData.reflect = reflect;
        mesh.material = new THREE.MeshBasicMaterial({
            map: old.map ?? null,
            color: old.map ? 0xffffff : (old.color ?? new THREE.Color(0xb8b0a0)),
            vertexColors: true,
        });
        // Glas, durch das Licht fällt (der Schirm einer Lampe): durchsichtig
        if (old.transmission > 0 || old.transparent) {
            mesh.material.transparent = true;
            mesh.material.opacity = old.transmission > 0 ? 0.25 : old.opacity;
            mesh.material.depthWrite = false;
        }
        if (old.emissiveMap && old.map) addGlow(mesh.material, old.emissiveMap, (old.emissiveIntensity ?? 1) * Math.max(old.emissive?.r ?? 1, old.emissive?.g ?? 1, old.emissive?.b ?? 1));
        // eine Glühbirne ohne Leuchten im Modell (glowsByName): leuchtet in ihrer eigenen Farbe
        else if (glowsByName(old) && old.map) addGlow(mesh.material, old.map, 1.2);
        mesh.userData.baseColor = mesh.material.color.clone();
        mesh.userData.map = mesh.material.map;
    });
}

// Wie viel Licht eine Lampe aus einem Modell in Richtung -l abgibt (l zeigt
// zur Lampe): ringsum gleich, mit beam nur in ihrem Kegel, weich am Rand
// (wie beamFacing in bake.js)
function bulbFacing(light, l) {
    if (!light.beam) return 1;
    const edge = Math.cos(THREE.MathUtils.degToRad(light.beam.angle));
    const along = light.beam.up ? -l.y : l.y;
    const t = THREE.MathUtils.clamp((along - (edge - 0.12)) / 0.24, 0, 1);
    return t * t * (3 - 2 * t);
}

// Manche Lampen-Modelle haben keine leuchtenden Teile (emissive), nur eine
// Glühbirne, die so heißt: Ihr Material nennt »bulb« oder »flame«.
function glowsByName(material) {
    return /bulb|flame/i.test(material?.name ?? '') && !(material.emissiveMap || (material.emissive && material.emissive.getHex() !== 0));
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
            attribute vec2 detailUv;           // ein feineres Stück Lichtkarte, nahe bei Statuen
            attribute float detailWeight;      // wie viel davon gilt: am Rand des Stücks 0
            varying vec2 vUv;
            varying vec2 vLightUv;
            varying vec2 vDetailUv;
            varying float vDetailWeight;
            void main() {
                vUv = uv;
                vLightUv = uv1;
                vDetailUv = detailUv;
                vDetailWeight = detailWeight;
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
            uniform bool usePoints;            // die Taste G: die Punkte der Lichtkarte zeigen
            uniform float atlasSize;
            uniform vec3 channelColor[${FLICKER_CHANNELS}];
            varying vec2 vUv;
            varying vec2 vLightUv;
            varying vec2 vDetailUv;
            varying float vDetailWeight;
            void main() {
                vec3 base = useTexture ? texture2D(map, vUv * mapScale).rgb : vec3(0.8);
                vec4 steady = texture2D(steadyMap, vLightUv);
                vec4 flickering = texture2D(flickerMap, vLightUv);
                vec3 indirect = texture2D(indirectMap, vLightUv).rgb;
                // nahe bei Statuen das feinere Stück darüber, zum Rand hin weich ausgeblendet
                if (vDetailWeight > 0.0) {
                    steady = mix(steady, texture2D(steadyMap, vDetailUv), vDetailWeight);
                    flickering = mix(flickering, texture2D(flickerMap, vDetailUv), vDetailWeight);
                    indirect = mix(indirect, texture2D(indirectMap, vDetailUv).rgb, vDetailWeight);
                }
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
                float occlusion = useOcclusion ? mix(1.0, open, 0.7) : 1.0;
                vec3 bounced = indirect * indirectIntensity * occlusion;
                light = (useDirect ? direct : vec3(0.0)) + (useBounce ? bounced : vec3(0.0));
                gl_FragColor = vec4(base * light, 1.0);
                // G: ein Punkt für jeden Punkt der Lichtkarte, an dem das Licht
                // ausgerechnet wurde (nahe bei Statuen die feineren); zu kleine
                // (weit weg) blenden aus, damit keine graue Fläche entsteht
                if (usePoints) {
                    vec2 texel = (vDetailWeight > 0.5 ? vDetailUv : vLightUv) * atlasSize;
                    vec2 pixels = fwidth(texel);
                    float size = 1.0 / max(pixels.x, pixels.y);   // Bildpunkte je Punkt der Lichtkarte
                    float d = length(fract(texel) - 0.5);
                    float dot = 1.0 - smoothstep(0.17, 0.17 + 1.5 / size, d);
                    float shown = smoothstep(3.0, 7.0, size);
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.05, 0.04, 0.02), dot * shown * 0.85);
                }
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

// Welcher Kanal eine flackernde Leuchte bekommt. Ein Kanal speichert nur,
// wie hell sein Licht ist, und hat eine Farbe: Leuchten verschiedener Farbe
// brauchen verschiedene Kanäle (sonst färbte eine rote Leuchte alle weißen
// ihres Kanals rot). Jede Farbe bekommt einen Kanal, übrige Kanäle die
// Farben mit den meisten Leuchten; innerhalb einer Farbe geht es reihum, so
// flackern nicht alle im selben Takt. Mehr als vier Farben: Eine Farbe
// teilt sich die Kanäle der ähnlichsten.
function flickerChannels(level) {
    const hex = (color) => new THREE.Color(color).getHexString();
    const counts = new Map();
    for (const t of level.things) {
        const color = t.type === 'light' ? (t.flicker > 0 ? t.color ?? '#fff3cf' : null) : t.glow?.flicker > 0 ? t.glow.color : null;
        if (color) counts.set(hex(color), (counts.get(hex(color)) ?? 0) + 1);
    }
    const colors = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    const kept = colors.slice(0, FLICKER_CHANNELS);
    const channels = new Map(kept.map((c, i) => [c, [i]]));
    // übrige Kanäle reihum an die häufigsten Farben
    for (let i = kept.length, k = 0; i < FLICKER_CHANNELS && kept.length; i++, k = (k + 1) % kept.length) channels.get(kept[k]).push(i);
    const nearest = (c) => {
        const a = new THREE.Color(`#${c}`);
        let best = kept[0], distance = Infinity;
        for (const k of kept) {
            const b = new THREE.Color(`#${k}`);
            const d = (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
            if (d < distance) { distance = d; best = k; }
        }
        return best;
    };
    const next = new Map();
    return (color) => {
        const group = channels.get(hex(color)) ?? channels.get(nearest(hex(color)));
        const key = group.join(',');
        const n = next.get(key) ?? 0;
        next.set(key, n + 1);
        return group[n % group.length];
    };
}

// Ein kurzer Fingerabdruck des Grundrisses (Größe und Felder)
function layoutPrint(level) {
    let hash = 2166136261;
    // (mit Schichten nur, wenn Räume übereinander liegen: alte Adressen bleiben gültig)
    for (const char of `${level.width}x${level.depth}${level.layers > 1 ? `x${level.layers}` : ''}:${level.cells.join('')}`) {
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
    // höchstens doppelt so fein wie der Bildschirm, sonst wird es langsam;
    // ?sharp: so fein, wie der Bildschirm ist (für Bilder in hoher Auflösung)
    renderer.setPixelRatio(params.has('sharp') ? window.devicePixelRatio : Math.min(window.devicePixelRatio, 2));
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
    // bekommen einen von vier Kanälen (flickerChannel).
    const flickerChannel = flickerChannels(level);
    const lights = level.things.filter((t) => t.type === 'light').map((t) => {
        const channel = t.flicker > 0 ? flickerChannel(t.color ?? '#fff3cf') : -1;
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

    // Lampen aus Modellen (light = Farbe beim Modell): Ihr Licht sitzt in der
    // Mitte ihrer leuchtenden Teile, sonst in ihrer Mitte, und strahlt nach
    // allen Seiten. Das Modell selbst hält sein Licht nicht auf.
    const lampModels = new Set();
    statues.forEach((object, i) => {
        const thing = statueThings[i];
        if (!thing.glow) return;
        lampModels.add(object);
        const box = new THREE.Box3();
        object.traverse((mesh) => {
            const material = mesh.material;
            if (mesh.isMesh && (material?.emissiveMap || (material?.emissive && material.emissive.getHex() !== 0) || glowsByName(material))) box.expandByObject(mesh);
        });
        if (box.isEmpty()) box.setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const channel = thing.glow.flicker > 0 ? flickerChannel(thing.glow.color) : -1;
        lights.push({
            type: 'light', kind: 'bulb', char: thing.char, x: thing.x, z: thing.z, room: thing.room,
            color: thing.glow.color, power: thing.glow.power, flicker: thing.glow.flicker, channel,
            size: [BULB_SIZE, BULB_SIZE], radius: Math.min(0.08, Math.max(0.02, Math.min(size.x, size.y, size.z) / 3)),
            tilt: null, beam: thing.glow.beam, position: box.getCenter(new THREE.Vector3()), model: object,
        });
    });

    const geometry = buildGeometry(level, statues.map((object) => new THREE.Box3().setFromObject(object)));
    const voxels = buildGrid(level, statues.filter((object) => !lampModels.has(object)), geometry.maxHeight, renderer.getContext().getParameter(WebGL2RenderingContext.MAX_3D_TEXTURE_SIZE));
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
        usePoints: { value: false },
        atlasSize: { value: geometry.atlasSize },
        channelColor: { value: channelColors(lights, FLICKER_CHANNELS) },
    };
    // Welche Teile an sind. ?show=light, direct oder bounce: nur das Licht,
    // ohne Tapete und Teppich, und davon wahlweise nur ein Teil.
    const parts = Object.fromEntries(PARTS.map((part) => [part.name, part.on ?? true]));
    const show = params.get('show');
    if (['light', 'direct', 'bounce'].includes(show)) parts.textures = false;
    if (show === 'direct') parts.bounce = false;
    if (show === 'bounce') parts.direct = false;
    // ?vhs oder vhs = on in level.ini: wie von einer alten Videokassette
    if (params.has('vhs') || String(settings.vhs) === 'on') parts.vhs = true;
    const showParts = () => {
        shared.useTexture.value = parts.textures;
        shared.useDirect.value = parts.direct;
        shared.useBounce.value = parts.bounce;
        shared.useOcclusion.value = parts.occlusion;
        shared.usePoints.value = parts.points;
        showStatueLight(statues, parts);
    };
    const textures = new Map();
    const textureFor = (kind, room, blockColor, blockMaterial) => {
        const r = level.rooms[room].settings;
        // ein Block ohne eigene Farbe sieht aus wie die Wände seines Raums;
        // mit material aus diesem, in seiner Farbe oder der Tapete des Raums
        let style, color;
        if (kind === 'block' && blockMaterial) [style, color] = [blockMaterial, blockColor ?? r.wallpaper];
        else if ((kind === 'block' || kind === 'baseboard') && blockColor) [style, color] = ['plain', blockColor];
        else if (kind === 'floor') [style, color] = [r.floor, r.carpet];
        else if (kind === 'ceiling') [style, color] = ['ceiling', r.ceiling];
        else [style, color] = [r.walls, r.wallpaper];
        const key = `${style}:${color}`;
        if (!textures.has(key)) {
            const make = { wallpaper: wallpaperTexture, carpet: carpetTexture, ceiling: ceilingTexture, plain: plainTexture,
                marble: () => marbleTexture(1024, 2), wood: woodTexture, tiles: tileTexture, velvet: velvetTexture }[style];
            textures.set(key, make(color));
        }
        return textures.get(key);
    };
    const surfaceMaterials = [];
    // was die Automap mit Räumen (V) ausblendet, damit man von oben hineinsieht
    const aboveRooms = [];
    for (const { kind, room, color, material: blockMaterial, geometry: mesh } of geometry.meshes) {
        const material = surfaceMaterial(textureFor(kind, room, color, blockMaterial), baker, shared);
        surfaceMaterials.push(material);
        const surface = new THREE.Mesh(mesh, material);
        scene.add(surface);
        if (kind === 'ceiling') aboveRooms.push(surface);
    }

    // Am Anfang ist es dunkel: feine Linien an allen Kanten zeigen den Raum,
    // bis das Licht da ist, dann verblassen sie.
    const blueprint = new THREE.LineBasicMaterial({ color: '#fff4c4', transparent: true, opacity: 0.85, toneMapped: false });
    for (const { kind, geometry: mesh } of geometry.meshes) {
        const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh, EDGE_ANGLE), blueprint);
        scene.add(lines);
        if (kind === 'ceiling') aboveRooms.push(lines);
    }

    // Die Leuchten selbst: helle Felder unter der Decke, so schräg wie sie
    const panels = lights.map((light) => {
        const material = new THREE.MeshBasicMaterial({ map: lampTexture(light.color), toneMapped: false });
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(light.size[0], light.size[1]), material);
        panel.visible = light.kind !== 'bulb';   // eine Lampe aus einem Modell zeigt das Modell
        const down = lampNormal(light);
        panel.rotation.x = Math.PI / 2;   // waagerecht, nach unten gewandt
        panel.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), down));
        panel.position.copy(light.position).addScaledVector(down, -0.012);
        scene.add(panel);
        aboveRooms.push(panel);
        // ein weicher Schein, knapp unter der Leuchte, immer zu dir gewandt:
        // So blendet sie ein wenig, wie eine helle Fläche im Dunkeln. Eine
        // durchsichtige Fläche pro Leuchte, kein Nachbearbeiten des Bildes,
        // darum auch mit Rot-Cyan-Brille und in VR. Er liegt über allem (sonst
        // schnitte ihn die Decke ab, mit harten Kanten); wie viel von der
        // Leuchte zu sehen ist, hinter Wänden, Säulen und Statuen, sagt glowVisible.
        // Gemischt wie »Negativ multiplizieren« (screen): 1 - (1 - Schein) * (1 - Bild).
        // Auf Dunklem leuchtet er, auf schon Hellem kaum noch, auf Weiß gar
        // nicht: Eine weiße Decke wird nicht von einem Verlauf überzogen.
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
            map: glowTexture(light.color), transparent: true, color: 0x000000,
            blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
            blendSrc: THREE.OneMinusDstColorFactor, blendDst: THREE.OneFactor,
            depthWrite: false, depthTest: false, toneMapped: false,
        }));
        glow.renderOrder = 4;
        glow.userData.seen = 0;
        glow.position.copy(light.position).addScaledVector(down, light.kind === 'bulb' ? 0 : 0.06);
        const span = light.kind === 'bulb' ? 0.7 : Math.max(...light.size) * 2.8;
        glow.scale.set(span, span, 1);
        scene.add(glow);
        aboveRooms.push(glow);
        return { light, material, glow };
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
    let reflectionsTaken = false;   // die Rundumbilder für spiegelnde Modelle
    if (lightSource) {
        statuesBounced = found.light.statues ? restoreStatueLight(statues, found.light.statues) : statues.length === 0;
    }
    showParts();

    // Sieht man von den Augen aus die Leuchte? Feld für Feld durch den
    // Grundriss: Ist eines davon eine Wand, verdeckt sie den Schein. Türen sind
    // Boden, durch sie hindurch bleibt er zu sehen.
    // Auch Blöcke (Säulen) und Statuen verdecken ihn, als Kästen genommen.
    // Geprüft an fünf Punkten der Leuchte (der Mitte und vier zum Rand hin):
    // Was davon zu sehen ist, so stark ist der Schein, so verschwindet er
    // hinter einer Säule allmählich statt auf einmal.
    const glowBlockers = [
        ...level.things.filter((t) => t.type === 'block').map((t) => {
            const [w, h, d] = t.size;
            const cx = (t.x + 0.5) * settings.cell + t.offset[0], cz = (t.z + 0.5) * settings.cell + t.offset[2];
            const y0 = t.floor + t.base + t.offset[1];
            return new THREE.Box3(new THREE.Vector3(cx - w / 2, y0, cz - d / 2), new THREE.Vector3(cx + w / 2, y0 + h, cz + d / 2));
        }),
        ...statues.filter((object) => !lampModels.has(object)).map((object) => new THREE.Box3().setFromObject(object)),
    ];
    const ray = new THREE.Ray();
    const hitPoint = new THREE.Vector3();
    const lineFree = (from, to) => {
        const cell = settings.cell;
        const x0 = from.x / cell, z0 = from.z / cell, x1 = to.x / cell, z1 = to.z / cell;
        // dicht genug, auch senkrecht: sonst sähe man durch die Decke in den Raum darüber
        const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0), Math.abs(to.y - from.y) * 2) * 2) + 1;
        for (let k = 1; k < steps; k++) {
            const t = k / steps;
            // Luft in irgendeinem Raum, auch übereinander liegenden
            if (!level.openAt(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t, -0.002)) return false;
        }
        ray.origin.copy(from);
        ray.direction.subVectors(to, from);
        const length = ray.direction.length();
        ray.direction.divideScalar(length);
        for (const box of glowBlockers) {
            if (ray.intersectBox(box, hitPoint) && hitPoint.distanceTo(from) < length - 0.05) return false;
        }
        return true;
    };
    const glowPoint = new THREE.Vector3();
    const glowVisible = (from, light) => {
        if (light.kind === 'bulb') return lineFree(from, light.position) ? 1 : 0;
        const u = new THREE.Vector3(1, light.tilt?.[0] ?? 0, 0).normalize().multiplyScalar(light.size[0] * 0.35);
        const v = new THREE.Vector3(0, light.tilt?.[1] ?? 0, 1).normalize().multiplyScalar(light.size[1] * 0.35);
        let seen = 0;
        for (const [a, b] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            glowPoint.copy(light.position).addScaledVector(u, a).addScaledVector(v, b);
            if (lineFree(from, glowPoint)) seen += 0.2;
        }
        return seen * seen;   // halb verdeckt: nur noch ein Viertel des Scheins
    };

    const walker = new Walker(level, player, camera, renderer);
    // Um Statuen geht man herum: um ihren Grundriss, ein paar Zentimeter
    // knapper; unter dem, was über Kopfhöhe hängt (eine Wandlampe), hindurch
    for (const object of statues) {
        const box = new THREE.Box3().setFromObject(object);
        const floor = level.floorAtPoint((box.min.x + box.max.x) / 2, (box.min.z + box.max.z) / 2, box.min.y);
        if (box.min.y - floor > 1.7) continue;
        walker.addObstacle({ x0: box.min.x + 0.05, x1: box.max.x - 0.05, z0: box.min.z + 0.05, z1: box.max.z - 0.05, y0: box.min.y, y1: box.max.y });
    }
    // ?view=x,z,blick,neigung,grundriss: an diese Stelle (in Feldern des
    // Bauwerks) und in diese Richtung (in Grad). Der Grundriss ist ein kurzer
    // Fingerabdruck: Hat sich das Level geändert, gilt die Stelle nicht mehr.
    const layout = layoutPrint(level);
    const place = params.get('view')?.split(',') ?? [];
    const view = place.slice(0, 4).map(Number);
    const sameLevel = place.length < 5 || place[4] === '' || place[4] === layout;   // leer: gilt immer
    if (sameLevel && view.length >= 2 && view.every(Number.isFinite)) {
        // die Höhe der Füße (sechste Zahl): Liegen Räume übereinander, sagt sie, in welchem
        const feet = Number(place[5]);
        player.position.set((view[0] + 0.5) * settings.cell, Number.isFinite(feet) ? feet : -1e6, (view[1] + 0.5) * settings.cell);
        walker.yaw = THREE.MathUtils.degToRad(view[2] ?? 0);
        walker.pitch = THREE.MathUtils.degToRad(view[3] ?? 0);
        walker.stand();   // auf den Boden dort, auch auf einer Rampe
    }

    const automap = new Automap(level, geometry, lights, statues, player, renderer, () => walker.pitch);
    // ?automap öffnet die Karte, ?automap=... genau so, wie sie lag (rememberPlace)
    if (params.get('automap')) automap.restore(params.get('automap'));
    else if (params.has('automap')) automap.toggle();
    // Auch mit der Automap läuft und schaut man weiter; ein Klick fängt dort
    // aber nicht die Maus, damit man die Karte ziehen kann. In VR schaltet die
    // Grifftaste sie um.
    walker.mayCapture = () => !automap.active;
    walker.mayTouch = () => !automap.active;
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

    // Bloom (H), am Rechner: Das Bild entsteht erst in HDR (Werte über 1),
    // dann strahlt, was sehr hell ist, weich aus (UnrealBloomPass: halbiert,
    // verwischt, wieder vergrößert und dazugezählt), und zum Schluss bringt das
    // Tone Mapping alles auf den Bildschirm (OutputPass). Mit der Rot-Cyan-
    // Brille, in VR und in der Automap wäre das zu teuer oder doppelt: Dort
    // bleibt der Schein der einzelnen Leuchten.
    // mit eigener Kantenglättung (MSAA): Das Bild entsteht hier nicht mehr
    // direkt auf dem Bildschirm, dessen antialias gälte dann nicht
    const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(window.innerWidth, window.innerHeight);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
    // VHS (C) als letzter Durchgang, über das fertige Bild (vhs.js)
    const vhsPass = new VHSPass();
    composer.addPass(vhsPass);
    const composing = () => (parts.bloom || parts.vhs) && !useAnaglyph && !renderer.xr.isPresenting && !automap.active;
    const bloomActive = () => parts.bloom && composing();

    // Die Schalter oben links, in derselben Reihenfolge wie ihre Tasten
    const togglePart = (part) => { parts[part.name] = !parts[part.name]; showParts(); };
    const toggleAnaglyph = () => { useAnaglyph = !useAnaglyph; };
    const toggleAutomap = () => automap.toggle(camera);
    // P: der Kasten oben links weg und wieder da
    const togglePanel = () => document.body.classList.toggle('panel-hidden');
    // ☰ oben rechts bringt den Kasten wieder (auf dem Handy gibt es kein P)
    document.getElementById('panel-button').addEventListener('click', togglePanel);
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
        addControl('Rebake light', 'Shift+L', rebake),
        addControl('Save light', '', saveLight),
        addControl('Hide panel', 'P', () => togglePanel()),
        addControl('Back to start', 'Shift+R', () => walker.toStart()),
    ];
    const refreshControls = () => {
        for (const refresh of refreshers) refresh();
        const touch = document.body.classList.contains('touch');
        help.textContent = automap.active ? (touch ? TOUCH_AUTOMAP_HELP : AUTOMAP_HELP) : (touch ? TOUCH_HELP : WALK_HELP);
    };
    refreshControls();

    document.addEventListener('keydown', (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
        const part = PARTS.find((p) => p.key === event.code);
        // Shift+L backt das Licht neu, L allein schaltet das direkte Licht
        if (event.code === 'KeyL' && event.shiftKey) rebake();
        else if (part) togglePart(part);
        if (event.code === 'Digit3') toggleAnaglyph();
        if (event.code === 'KeyP') togglePanel();
        // mit Shift, damit man nicht aus Versehen den Weg verliert
        if (event.code === 'KeyR' && event.shiftKey) walker.toStart();
        // V: in der Automap die Räume statt des Drahtgitters, und zurück
        if (event.code === 'KeyV' && automap.active) automap.roomsView = !automap.roomsView;
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
        composer.setSize(window.innerWidth, window.innerHeight);
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
        const place = `${x},${z},${Math.round(THREE.MathUtils.radToDeg(walker.yaw))},${Math.round(THREE.MathUtils.radToDeg(walker.pitch))},${layout},${player.position.y.toFixed(2)}`;
        // die Automap auch: offen, gedreht, verschoben, gezoomt
        const map = automap.state();
        if (`${place}|${map}` === lastPlace) return;
        lastPlace = `${place}|${map}`;
        clearTimeout(placeTimer);
        placeTimer = setTimeout(() => {
            const url = new URL(location.href);
            url.searchParams.set('view', place);
            if (map) url.searchParams.set('automap', map);
            else url.searchParams.delete('automap');
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
            reflectionsTaken = false;
        }
        const t = now - sequenceStart;   // Zeit seit dem Anfang des Lichts

        // Leuchten anschalten, wenn ihre Zeit gekommen ist
        let switched = false;
        lights.forEach((light, i) => {
            if (!on[i] && t >= switchAt[i]) { on[i] = true; switched = true; }
        });
        if (switched) baker.switchLights(on);
        const allOn = on.every(Boolean);

        // Statuen hell, während die Leuchten angehen. Die Linien verschwinden,
        // so wie das Backen vorankommt; mit gespeichertem Licht, während die
        // Leuchten angehen.
        const shown = THREE.MathUtils.clamp((t - DARK_SECONDS) / (SWITCH_SECONDS + 0.5), 0, 1);
        const baked = lightSource ? shown : baker.done ? 1 : baker.progress;
        blueprint.opacity = parts.wireframe ? 0.85 : 0.85 * (1 - baked);
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
        player.updateMatrixWorld(true);
        const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
        const blooming = bloomActive();
        panels.forEach(({ light, material, glow }, i) => {
            const brightness = !on[i] ? 0.08 : light.channel >= 0 ? values[light.channel] : 1;
            material.color.setScalar(brightness * (blooming ? PANEL_HDR : 1));
            // die leuchtenden Teile einer Lampe aus einem Modell im selben Takt
            if (light.model) {
                light.glowMaterials ??= [];
                if (!light.glowCollected) {
                    light.glowCollected = true;
                    light.model.traverse((mesh) => { if (mesh.isMesh && mesh.material.userData.glow) light.glowMaterials.push(mesh.material); });
                }
                for (const glowing of light.glowMaterials) glowing.userData.glow.value = glowing.userData.glowBase * brightness;
            }
            // der Schein blendet weich ein und aus, wenn eine Wand dazwischenkommt
            const seen = glowVisible(eye, light);
            glow.userData.seen += (seen - glow.userData.seen) * Math.min(1, dt * 10);
            // die Stärke steckt in der Farbe; mit Bloom strahlt die Leuchte selbst
            glow.material.color.setScalar(on[i] && !blooming ? GLOW * brightness * glow.userData.seen : 0);
        });

        // Spiegelungen, wenn alles fertig ist und alle Leuchten an sind (ohne den Schein der Leuchten)
        if (!reflectionsTaken && baker.done && statuesBounced && allOn && shown >= 1) {
            reflectionsTaken = true;
            captureReflections(renderer, scene, statues, panels.map(({ glow }) => glow));
        }

        walker.update(dt);
        rememberPlace();
        if (automap.active) {
            automap.render({
                rooms: { scene, hide: aboveRooms },
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
        else if (composing()) {
            bloomPass.enabled = parts.bloom;
            vhsPass.enabled = parts.vhs;
            composer.render(dt);
        }
        else renderer.render(scene, camera);
    });
}

start();
