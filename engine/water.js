// Wasser in einem Becken (pool = … in einem Raum): eine ruhige Fläche, die
// spiegelt und durch die man den Boden sieht. Für jedes Bild, in dem das
// Wasser zu sehen ist, entstehen vorher zwei Bilder mehr:
//
// - die Spiegelung: der Raum von einer Kamera aus, die so tief unter dem
//   Wasser steht wie du darüber, nach oben schauend (gespiegelt an der
//   Wasserfläche). Was unter dem Wasser liegt, schneidet ihr Bildausschnitt
//   ab (eine schräge vordere Ebene, »oblique near plane«).
// - der Blick ins Wasser: von deiner Kamera aus, aber nur, was unter der
//   Wasserfläche liegt, mit der Entfernung jedes Punkts (Tiefenbild).
//
// Die Wasserfläche mischt beide. Wie viel gespiegelt wird, hängt davon ab,
// wie flach du auf das Wasser schaust (Fresnel, nach Schlick): von oben
// kaum etwas, flach darüber fast alles. Was man durch das Wasser sieht,
// wird mit dem Weg durch das Wasser blaugrün, denn Wasser schluckt Rot am
// stärksten (Beer-Lambert), und das Licht im Wasser streut zurück. Kleine
// Wellen, aus Rauschen gerechnet, verbiegen beides ein wenig, und auf dem
// Boden darunter tanzen helle Linien: Licht, das die Wellen bündeln (Kaustik).
//
// In VR wären zwei Bilder mehr für jedes Auge zu langsam. Dort zeichnet das
// Programm dieselbe Fläche zweimal (simpleMaterials): erst macht es, was
// darunter liegt, blaugrün, so viel wie der Weg durch das Wasser bis zum
// Boden des Beckens (aus seiner Tiefe und dem Blickwinkel), dann legt es die
// Spiegelung darüber, aus einem Rundumbild über dem Becken (setEnvironment,
// einmal aufgenommen, wenn das Licht fertig ist), von den Wellen verbogen.
import * as THREE from 'three';

const WAVES = 0.16;          // wie stark die Wellen die Fläche neigen: ruhig
const TINT_METRES = 2;       // tint (level.js) ist die Farbe von Weiß hinter so viel Wasser

// Aus der Farbe des Wassers: wie viel es je Meter schluckt (Rot, Grün,
// Blau), und wie viel Licht es in seiner Farbe zurückstreut
function waterColor(tint) {
    const color = new THREE.Color(tint);   // linear, wie das Licht
    const kept = [color.r, color.g, color.b].map((c) => Math.min(0.999, Math.max(0.002, c)));
    return {
        absorption: new THREE.Vector3(...kept.map((c) => -Math.log(c) / TINT_METRES)),
        scatter: new THREE.Vector3(...kept.map((c) => c * c * 0.25)),
    };
}

const noise = /* glsl */ `
    // Gradientenrauschen: an jedem Gitterpunkt eine zufällige Richtung,
    // dazwischen weich (fünfter Grad): ohne die Kästchen, die einfaches
    // Rauschen in einer Spiegelung zeigt
    vec2 gradient(vec2 p) {
        // Zufall ohne sin (nach Dave Hoskins): sin von großen Zahlen ist auf der
        // Grafikkarte ungenau, die Wellen bekämen gerade Kanten
        vec3 q = fract(vec3(p.xyx) * 0.1031);
        q += dot(q, q.yzx + 33.33);
        float a = fract((q.x + q.y) * q.z) * 6.28318;
        return vec2(cos(a), sin(a));
    }
    float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        float a = dot(gradient(i), f), b = dot(gradient(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
        float c = dot(gradient(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), d = dot(gradient(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    // die Höhe der Wellen an einer Stelle (in Metern der Welt): fünf Lagen,
    // von langen zu kurzen Wellen, jede gedreht. In jeder Lage laufen zwei
    // Muster gegeneinander: Wo sie sich überlagern, ändert sich die Form
    // ständig, statt dass ein starres Muster über das Wasser gleitet. Lange
    // Wellen laufen schneller als kurze, wie auf echtem Wasser.
    float waves(vec2 p, float t) {
        const mat2 turn = mat2(0.8, 0.6, -0.6, 0.8);
        float h = 0.0, amplitude = 0.5, scale = 0.6;
        vec2 q = p;
        for (int i = 0; i < 5; i++) {
            float angle = float(i) * 2.4 + 0.3;
            vec2 along = vec2(cos(angle), sin(angle));
            vec2 across = vec2(-along.y, along.x) * 0.7 + along * 0.7;
            float speed = 0.3 / sqrt(scale);   // in Metern je Sekunde
            vec2 a = q * scale + along * (t * speed * scale);
            vec2 b = q * scale * 1.13 - across * (t * speed * scale * 0.8) + 17.0;
            h += amplitude * 0.5 * (noise(a) + noise(b));
            q = turn * q;
            scale *= 2.0;
            amplitude *= 0.42;
        }
        return h;
    }
    // waveSize: wie groß die Wellen sind (waves = … beim Becken), waveStrength: wie steil
    uniform float waveSize;
    uniform float waveStrength;
    vec3 waveNormal(vec2 p, float t) {
        vec2 q = p / waveSize;
        float e = 0.035;
        float h = waves(q, t);
        float dx = (waves(q + vec2(e, 0.0), t) - h) / e;
        float dz = (waves(q + vec2(0.0, e), t) - h) / e;
        return normalize(vec3(-dx * waveStrength / waveSize, 1.0, -dz * waveStrength / waveSize));
    }
    // Licht auf dem Boden (Kaustik): Wo die Wellen nach oben gewölbt sind,
    // bündeln sie das Licht wie eine Lupe, dort wird der Boden hell; wo sie
    // hohl sind, verteilen sie es. Wie stark sie gewölbt sind, sagt die
    // Krümmung der Wellen (die zweite Ableitung, aus fünf Punkten).
    float caustic(vec2 p, float t) {
        float e = 0.07;
        float h = waves(p, t);
        float curve = (waves(p + vec2(e, 0.0), t) + waves(p - vec2(e, 0.0), t)
                     + waves(p + vec2(0.0, e), t) + waves(p - vec2(0.0, e), t) - 4.0 * h) / (e * e);
        float c = clamp(-curve * 0.05, 0.0, 1.0);
        return c * c;
    }
`;

function waterMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: {
            reflection: { value: null },
            refraction: { value: null },
            refractionDepth: { value: null },
            reflectionMatrix: { value: new THREE.Matrix4() },
            refractionMatrix: { value: new THREE.Matrix4() },
            refractionInverse: { value: new THREE.Matrix4() },   // vom Bild der Kamera zurück in die Welt
            time: { value: 0 },
            surface: { value: 0 },
            light: { value: new THREE.Color() },    // wie hell es über dem Wasser ist: so viel Licht streut darin
            waveSize: { value: 1 },
            waveStrength: { value: WAVES },
            absorption: { value: new THREE.Vector3() },
            scatter: { value: new THREE.Vector3() },
        },
        vertexShader: /* glsl */ `
            varying vec3 vWorld;
            void main() {
                vec4 world = modelMatrix * vec4(position, 1.0);
                vWorld = world.xyz;
                gl_Position = projectionMatrix * viewMatrix * world;
            }`,
        fragmentShader: /* glsl */ `
            uniform sampler2D reflection;
            uniform sampler2D refraction;
            uniform sampler2D refractionDepth;
            uniform mat4 reflectionMatrix;
            uniform mat4 refractionMatrix;
            uniform mat4 refractionInverse;
            uniform float time;
            uniform float surface;
            uniform vec3 light;
            uniform vec3 absorption;
            uniform vec3 scatter;
            varying vec3 vWorld;
            ${noise}
            void main() {
                vec3 n = waveNormal(vWorld.xz, time);
                vec3 toEye = normalize(cameraPosition - vWorld);
                float facing = max(dot(n, toEye), 0.0);
                float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);

                // die Spiegelung, ein wenig verbogen
                vec4 r = reflectionMatrix * vec4(vWorld, 1.0);
                vec3 mirrored = texture2D(reflection, r.xy / r.w + n.xz * 0.02).rgb;

                // durch das Wasser: verbogen, aber nicht über den Rand hinaus.
                // Wo das verbogene Bild nichts zeigt oder etwas über dem
                // Wasser, gilt die Stelle genau dahinter.
                vec4 q = refractionMatrix * vec4(vWorld, 1.0);
                vec2 straight = q.xy / q.w;
                // wie weit es bis zum Boden geht, ohne Verbiegen: Je mehr Wasser, desto stärker wackelt der Boden
                vec4 back = refractionInverse * vec4(straight * 2.0 - 1.0, texture2D(refractionDepth, straight).r * 2.0 - 1.0, 1.0);
                float deep = clamp(distance(back.xyz / back.w, vWorld), 0.0, 3.0);
                vec2 bent = straight + n.xz * 0.045 * clamp(deep / 1.5, 0.15, 1.0);
                vec4 seen = texture2D(refraction, bent);
                float depth = texture2D(refractionDepth, bent).r;
                if (seen.a < 0.5) { bent = straight; seen = texture2D(refraction, bent); depth = texture2D(refractionDepth, bent).r; }
                // wo der gesehene Punkt in der Welt liegt: aus dem Tiefenbild
                vec4 point = refractionInverse * vec4(bent * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
                vec3 below = point.xyz / point.w;
                float through = seen.a < 0.5 ? 30.0 : distance(below, vWorld);
                // helle Linien auf dem, was unter Wasser liegt
                float under = clamp((surface - below.y) * 3.0, 0.0, 1.0);
                vec3 floorColor = seen.rgb * (1.0 + 0.9 * caustic(below.xz / waveSize, time) * under * min(waveStrength / ${WAVES}, 1.5));
                vec3 kept = exp(-absorption * through);
                vec3 water = floorColor * kept + scatter * light * (1.0 - kept);

                gl_FragColor = vec4(mix(water, mirrored, fresnel), 1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }`,
    });
}

// Für VR, ohne Bilder mehr: zwei Durchgänge über dieselbe Fläche. multiply:
// was unter dem Wasser liegt, um den Weg durch das Wasser blaugrün (gebrochen
// an der Fläche, bis zum Boden des Beckens), flach darüber vom Spiegelbild
// verdeckt (Fresnel); add: das Spiegelbild aus dem Rundumbild über dem
// Becken (ohne eines: die Farbe des Raums) und das Licht, das im Wasser streut.
function simpleMaterials() {
    const uniforms = {
        time: { value: 0 }, light: { value: new THREE.Color() }, scatter: { value: new THREE.Vector3() },
        absorption: { value: new THREE.Vector3() }, depth: { value: 1 },
        waveSize: { value: 1 }, waveStrength: { value: WAVES }, environment: { value: null }, hasEnvironment: { value: 0 },
    };
    const vertexShader = /* glsl */ `
        varying vec3 vWorld;
        void main() {
            vec4 world = modelMatrix * vec4(position, 1.0);
            vWorld = world.xyz;
            gl_Position = projectionMatrix * viewMatrix * world;
        }`;
    const common = /* glsl */ `
        uniform float time;
        uniform vec3 light;
        uniform vec3 scatter;
        uniform vec3 absorption;
        uniform float depth;
        uniform samplerCube environment;
        uniform float hasEnvironment;
        varying vec3 vWorld;
        ${noise}
        // wie viel vom Boden durch das Wasser kommt: der Weg entlang des
        // Blicks bis zum Boden, wie am Rechner (dort aus dem Tiefenbild)
        vec3 through(vec3 view) {
            return exp(-absorption * depth / max(view.y, 0.15));
        }
        float fresnelOf(vec3 n, vec3 view) {
            return 0.02 + 0.98 * pow(1.0 - max(dot(n, view), 0.0), 5.0);
        }`;
    const multiply = new THREE.ShaderMaterial({
        // MultiplyBlending verlangt in three.js premultipliedAlpha (sonst
        // lässt es das Mischen weg, und das Wasser wird milchig weiß)
        transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true, uniforms, vertexShader,
        fragmentShader: /* glsl */ `
            ${common}
            void main() {
                vec3 n = waveNormal(vWorld.xz, time);
                vec3 view = normalize(cameraPosition - vWorld);
                // gleich auf das fertige Bild (sRGB): dunkler, als das Licht es
                // wäre, und so dunkel wie das Wasser am Rechner
                vec3 kept = through(view) * (1.0 - fresnelOf(n, view));
                gl_FragColor = vec4(kept, 1.0);
            }`,
    });
    const add = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms, vertexShader,
        fragmentShader: /* glsl */ `
            ${common}
            void main() {
                vec3 n = waveNormal(vWorld.xz, time);
                vec3 view = normalize(cameraPosition - vWorld);
                float fresnel = fresnelOf(n, view);
                vec3 mirrored = hasEnvironment > 0.5 ? textureCube(environment, reflect(-view, n)).rgb : vec3(0.5, 0.6, 0.62) * light;
                // wie am Rechner: das Licht, das im Wasser streut, wo es tief ist
                vec3 color = mirrored * fresnel + scatter * light * (1.0 - through(view)) * (1.0 - fresnel);
                gl_FragColor = vec4(color, 1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }`,
    });
    return { multiply, add };
}

// Die Wasserfläche eines Beckens: seine Felder als Rechtecke, auf Höhe des Wassers
function surfaceGeometry(pool, cell) {
    const positions = [], indices = [];
    for (const { x, z } of pool.cells) {
        const base = positions.length / 3;
        const y = pool.surface;
        positions.push(x * cell, y, z * cell, (x + 1) * cell, y, z * cell, (x + 1) * cell, y, (z + 1) * cell, x * cell, y, (z + 1) * cell);
        indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    return geometry;
}

// Die vordere Ebene einer Kamera so schräg stellen, dass sie in der Ebene
// plane liegt (in Koordinaten der Kamera): Was davor ist, schneidet sie ab
// (Lengyel, »Oblique View Frustum Depth Projection and Clipping«)
function clipProjection(projection, plane) {
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const e = projection.elements;
    const q = new THREE.Vector4((Math.sign(clip.x) + e[8]) / e[0], (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    clip.multiplyScalar(2 / clip.dot(q));
    e[2] = clip.x;
    e[6] = clip.y;
    e[10] = clip.z + 1;
    e[14] = clip.w;
}

const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

export class Water {
    // aus level.pools die Becken mit Wasser
    constructor(level, renderer) {
        this.renderer = renderer;
        this.meshes = [];
        // so fein wie das Bild, mal scale: Spiegelung und Blick ins Wasser (auf Handy und Tablet gröber)
        this.scale = window.matchMedia?.('(pointer: coarse)').matches ? 0.5 : 0.75;
        this.simple = false;
        const cell = level.settings.cell;
        for (const pool of level.pools.filter((p) => p.surface !== null)) {
            const fancy = waterMaterial();
            const { multiply, add: plain } = simpleMaterials();
            const geometry = surfaceGeometry(pool, cell);
            const mesh = new THREE.Mesh(geometry, fancy);
            fancy.uniforms.surface.value = pool.surface;
            const { absorption, scatter } = waterColor(pool.tint);
            fancy.uniforms.absorption.value.copy(absorption);
            fancy.uniforms.scatter.value.copy(scatter);
            plain.uniforms.scatter.value.copy(scatter);   // multiply teilt die Werte mit plain
            plain.uniforms.absorption.value.copy(absorption);
            plain.uniforms.depth.value = pool.surface - pool.bottom;
            // waves = 2: doppelt so steil und anderthalbmal so groß; 0: glatt
            for (const material of [fancy, plain]) {
                material.uniforms.waveSize.value = Math.max(0.3, Math.sqrt(Math.max(pool.waves, 0.1)) * (pool.waves > 1 ? 1.06 : 1));
                material.uniforms.waveStrength.value = WAVES * pool.waves;
            }
            // der erste Durchgang in VR, vor der Fläche selbst
            const under = new THREE.Mesh(geometry, multiply);
            under.visible = false;
            under.renderOrder = 5;
            mesh.userData = { pool, fancy, plain, under };
            mesh.onBeforeRender = (renderer, scene, camera) => this.prepare(mesh, scene, camera);
            this.meshes.push(mesh);
        }
        if (this.meshes.length === 0) return;
        const options = { type: THREE.HalfFloatType };
        this.reflection = new THREE.WebGLRenderTarget(1, 1, options);
        this.refraction = new THREE.WebGLRenderTarget(1, 1, { ...options, depthTexture: new THREE.DepthTexture(1, 1) });
        this.mirror = new THREE.PerspectiveCamera();
        this.under = new THREE.PerspectiveCamera();
        this.hide = [];      // was in diesen Bildern fehlt (der Schein der Leuchten)
        this.cull = null;    // (Kamera, Raum) => zeigt nur, was sie sieht, und gibt zurück, wie es vorher war
        this.busy = false;
    }

    addTo(scene) {
        for (const mesh of this.meshes) scene.add(mesh, mesh.userData.under);
    }

    // alle Flächen, auch die für den ersten Durchgang in VR (zum Ausblenden)
    get all() {
        return this.meshes.flatMap((mesh) => [mesh, mesh.userData.under]);
    }

    // das Rundumbild über einem Becken, für die Spiegelung in VR (main.js)
    setEnvironment(mesh, texture) {
        mesh.userData.plain.uniforms.environment.value = texture;
        mesh.userData.plain.uniforms.hasEnvironment.value = 1;
    }

    // jedes Bild: die Zeit für die Wellen, das Licht, einfach oder nicht
    update(time, brightness, simple) {
        this.simple = simple;
        for (const mesh of this.meshes) {
            const { fancy, plain, light, under } = mesh.userData;
            mesh.material = simple ? plain : fancy;
            under.visible = simple;
            mesh.renderOrder = simple ? 6 : 0;
            for (const material of [fancy, plain]) {
                material.uniforms.time.value = time;
                if (light) material.uniforms.light.value.copy(light).multiplyScalar(brightness);
            }
        }
    }

    // wie hell es über dem Wasser ist (Farbe), einmal ausgerechnet
    setLight(pool, color) {
        const mesh = this.meshes.find((m) => m.userData.pool === pool);
        if (mesh) mesh.userData.light = color.clone();
    }

    // Kurz bevor eine Wasserfläche gezeichnet wird: ihre zwei Bilder
    prepare(mesh, scene, camera) {
        if (this.simple || this.busy) return;
        const renderer = this.renderer;
        const surface = mesh.userData.pool.surface;
        const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
        if (eye.y < surface) return;   // von unten gibt es nichts zu spiegeln
        // so groß wie das Bild, in das gerade gezeichnet wird
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        const target = renderer.getRenderTarget();
        if (target) size.set(target.width, target.height);
        const w = Math.max(1, Math.round(size.x * this.scale)), h = Math.max(1, Math.round(size.y * this.scale));
        if (this.reflection.width !== w || this.reflection.height !== h) {
            this.reflection.setSize(w, h);
            this.refraction.setSize(w, h);
        }

        // die Kamera gespiegelt an der Wasserfläche (y = surface): so tief
        // darunter, wie du darüber bist, ihr Blick und ihr Oben gespiegelt.
        // Eine echte Drehung, keine Spiegelung: Ihr Bild ist seitenverkehrt,
        // aber die Wasserfläche holt sich jede Stelle dort, wo sie hingehört.
        const mirror = this.mirror;
        const reflect = (v) => { v.y = -v.y; return v; };
        const rotation = new THREE.Matrix4().extractRotation(camera.matrixWorld);
        const ahead = reflect(new THREE.Vector3(0, 0, -1).applyMatrix4(rotation));
        mirror.position.set(eye.x, 2 * surface - eye.y, eye.z);
        mirror.up.copy(reflect(new THREE.Vector3(0, 1, 0).applyMatrix4(rotation)));
        mirror.lookAt(mirror.position.clone().add(ahead));
        mirror.updateMatrixWorld();
        mirror.projectionMatrix.copy(camera.projectionMatrix);
        const above = new THREE.Plane(new THREE.Vector3(0, 1, 0), -surface).applyMatrix4(mirror.matrixWorldInverse);
        clipProjection(mirror.projectionMatrix, above);
        mirror.projectionMatrixInverse.copy(mirror.projectionMatrix).invert();

        // deine Kamera, nur unter dem Wasser
        const under = this.under;
        camera.matrixWorld.decompose(under.position, under.quaternion, under.scale);
        under.updateMatrixWorld();
        under.projectionMatrix.copy(camera.projectionMatrix);
        const belowPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), surface + 0.002).applyMatrix4(under.matrixWorldInverse);
        clipProjection(under.projectionMatrix, belowPlane);
        under.projectionMatrixInverse.copy(under.projectionMatrix).invert();

        const { fancy } = mesh.userData;
        fancy.uniforms.reflectionMatrix.value.multiplyMatrices(BIAS, mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);
        fancy.uniforms.refractionMatrix.value.multiplyMatrices(BIAS, under.projectionMatrix).multiply(under.matrixWorldInverse);
        fancy.uniforms.refractionInverse.value.multiplyMatrices(under.projectionMatrix, under.matrixWorldInverse).invert();
        fancy.uniforms.reflection.value = this.reflection.texture;
        fancy.uniforms.refraction.value = this.refraction.texture;
        fancy.uniforms.refractionDepth.value = this.refraction.depthTexture;

        // zeichnen, ohne die Wasserflächen selbst und ohne VR
        this.busy = true;
        const hidden = [...this.meshes, ...this.hide];
        const shown = hidden.map((m) => m.visible);
        for (const m of hidden) m.visible = false;
        const xr = renderer.xr.enabled;
        renderer.xr.enabled = false;
        const background = new THREE.Color();
        renderer.getClearColor(background);
        const alpha = renderer.getClearAlpha();
        const autoClear = renderer.autoClear;
        renderer.autoClear = true;
        const sceneBackground = scene.background;
        // ohne Hintergrund: Wo nichts ist, bleibt das Bild durchsichtig (a = 0)
        scene.background = null;
        renderer.setClearColor(0x000000, 0);
        for (const [view, into] of [[mirror, this.reflection], [under, this.refraction]]) {
            // die Spiegelung sieht andere Räume als du (portals.js, über main.js)
            const undo = view === mirror ? this.cull?.(mirror, mesh.userData.pool.room) : null;
            if (undo) for (const m of hidden) m.visible = false;
            renderer.setRenderTarget(into);
            renderer.clear();
            renderer.render(scene, view);
            undo?.();
        }
        scene.background = sceneBackground;
        renderer.setClearColor(background, alpha);
        renderer.autoClear = autoClear;
        renderer.xr.enabled = xr;
        renderer.setRenderTarget(target);
        if (camera.viewport) renderer.state.viewport(camera.viewport);
        hidden.forEach((m, i) => { m.visible = shown[i]; });
        this.busy = false;
    }
}

