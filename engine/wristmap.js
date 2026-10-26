// Die Karte am Handgelenk (in VR, der Abzug der Hand, die nicht geht,
// meist der rechten): ein kleines Hologramm über diesem Handgelenk, das Bauwerk um dich herum (bis 10 m
// ganz, bis 15 m auslaufend) als
// cyanfarbene Linien, Linien hinter Wänden dünner und blasser, wie in der
// Automap. Sie liegt waagerecht und gleich ausgerichtet wie das Bauwerk: Ein
// Gang, der auf ihr nach links führt, führt auch wirklich nach links, egal wie
// du die Hand hältst. Du bist ein Ring auf ihrem Boden, der sich langsam dreht.
// Am Rechner zum Ausprobieren: ?wristmap zeigt sie unten rechts vor dir.
import * as THREE from 'three';
import { outlineEdges } from './geometry.js';
import { LINE_COLOR } from './automap.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const FULL = 10;              // bis hierher ganz zu sehen, in Metern um dich herum
const RADIUS = 15;            // bis hierher läuft sie aus
const SIZE = 0.27;            // so groß ist die Karte von Rand zu Rand, in Metern
const SCALE = SIZE / (2 * RADIUS);
const BELOW = 3, ABOVE = 5;   // so weit unter und über deinen Füßen zeigt sie das Bauwerk
const REBUILD = 0.5;          // nach so vielen Metern Weg werden die Linien neu ausgewählt
const LIFT = 0.07;            // so hoch über dem Handgelenk schwebt sie
const WIDTH = 0.0011;         // Linien, in Metern der Welt (die Karte ist klein)
const HIDDEN_WIDTH = 0.0005;  // Linien hinter Wänden
const OPACITY = 0.9;          // die Linien davor
const HIDDEN = 0.3;           // die dahinter, so viel davon
const GLOW_WIDTH = 0.005;     // der weiße Schein um die Linien davor
const GLOW = 0.5;             // so hell ist er an der Linie, nach außen weniger

export class WristMap {
    // hand(): an welcher Hand sie hängt ('right' oder 'left')
    constructor(geometry, renderer, player, camera, scene, hand = () => 'right') {
        this.renderer = renderer;
        this.hand = hand;
        this.player = player;
        this.camera = camera;
        this.visible = false;
        this.preview = false;   // ?wristmap: am Rechner vor der Kamera
        // Alle Kanten und Flächen einmal, in Metern des Bauwerks; was gezeigt
        // wird, sucht rebuild() daraus aus
        const edges = [], tints = [], triangles = [];
        for (const { kind, geometry: mesh } of geometry.meshes) {
            if (kind === 'ceiling') continue;   // von oben nur im Weg
            const tint = kind === 'floor' ? 0.55 : 1;
            const lines = outlineEdges(mesh).attributes.position.array;
            for (let i = 0; i < lines.length; i += 6) {
                edges.push(lines[i], lines[i + 1], lines[i + 2], lines[i + 3], lines[i + 4], lines[i + 5]);
                tints.push(tint);
            }
            if (kind !== 'floor' && kind !== 'wall' && kind !== 'block') continue;
            const flat = mesh.index ? mesh.toNonIndexed() : mesh;
            const p = flat.attributes.position.array;
            for (let i = 0; i < p.length; i++) triangles.push(p[i]);
        }
        this.edges = new Float32Array(edges);
        this.tints = new Float32Array(tints);
        this.triangles = new Float32Array(triangles);

        // waagerecht, wie das Bauwerk ausgerichtet; model: das Bauwerk darin, verkleinert
        this.group = new THREE.Group();
        this.group.visible = false;
        this.model = new THREE.Group();
        this.model.scale.setScalar(SCALE);
        this.group.add(this.model);
        scene.add(this.group);

        // Cyan über allem, durchsichtig statt leuchtend: Linien, die sich
        // addieren, würden über einer hellen Wand und übereinander weiß. Die
        // Farbe der Ecken (vertexColors) trägt nur, wie sichtbar die Linie
        // dort ist (zum Rand hin weniger); daraus wird ihre Deckkraft.
        const holo = new THREE.Color(LINE_COLOR);
        // glow: der Schein, weiß, breiter, von der Mitte nach außen schwächer
        // (norm: 0 in der Mitte der Linie, 0,5 an ihrem Rand) und addiert, so
        // dass er leuchtet; die cyanfarbene Linie liegt darüber
        const material = (opacity, extra, glow = false) => {
            const line = new LineMaterial({
                color: 0xffffff, vertexColors: true, worldUnits: true, linewidth: WIDTH, toneMapped: false,
                transparent: true, depthWrite: false, opacity, ...extra,
            });
            line.onBeforeCompile = (shader) => {
                shader.uniforms.holoColor = { value: glow ? new THREE.Color('#ffffff') : holo };
                const fade = glow ? ' * pow( 1.0 - 2.0 * norm, 2.0 )' : '';
                shader.fragmentShader = 'uniform vec3 holoColor;\n' + shader.fragmentShader.replace(
                    'gl_FragColor = vec4( diffuseColor.rgb, alpha );',
                    `gl_FragColor = vec4( holoColor, alpha * diffuseColor.r${fade} );`);
            };
            line.customProgramCacheKey = () => (glow ? 'wristmap-glow' : 'wristmap-line');
            return line;
        };
        // erst die Flächen, nur in den Tiefenpuffer (etwas nach hinten, damit
        // ihre eigenen Kanten davor liegen), dann die Linien davor kräftig und
        // die dahinter schwach und dünn
        this.occluder = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
            colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
        }));
        this.occluder.renderOrder = 30;
        this.glow = new LineSegments2(new LineSegmentsGeometry(), material(GLOW, { linewidth: GLOW_WIDTH, blending: THREE.AdditiveBlending }, true));
        this.glow.renderOrder = 31;
        this.front = new LineSegments2(new LineSegmentsGeometry(), material(OPACITY, {}));
        this.front.renderOrder = 31.5;
        this.behind = new LineSegments2(new LineSegmentsGeometry(), material(OPACITY * HIDDEN, { linewidth: HIDDEN_WIDTH, depthFunc: THREE.GreaterDepth }));
        this.behind.renderOrder = 32;
        for (const part of [this.occluder, this.glow, this.front, this.behind]) {
            part.frustumCulled = false;
            this.model.add(part);
        }

        // du: ein Ring auf dem Boden der Karte mit einer Lücke, damit man sieht,
        // dass er sich dreht (in Metern der Karte)
        const red = new THREE.MeshBasicMaterial({ color: '#ff4060', side: THREE.DoubleSide, toneMapped: false, transparent: true, opacity: 0.95, depthTest: false });
        this.ring = new THREE.Mesh(new THREE.RingGeometry(0.0055, 0.0075, 40, 1, 0.5, Math.PI * 2 - 1.0), red);
        this.ring.rotation.x = -Math.PI / 2;
        this.ring.renderOrder = 33;
        this.you = new THREE.Group();
        this.you.add(this.ring);
        this.group.add(this.you);

        // die Griffe beider Hände hängen am Spieler wie die Kamera
        this.grips = new Map();   // Hand -> Griff
        for (let i = 0; i < 2; i++) {
            const grip = renderer.xr.getControllerGrip(i);
            player.add(grip);
            grip.addEventListener('connected', (event) => this.grips.set(event.data.handedness, grip));
            grip.addEventListener('disconnected', () => {
                for (const [hand, other] of this.grips) if (other === grip) this.grips.delete(hand);
            });
        }
        this.built = null;   // wo die Linien zuletzt ausgesucht wurden
        this.squeezed = false;
    }

    toggle() {
        this.visible = !this.visible;
    }

    // Die Linien und Flächen um feet: innerhalb des Radius und der Höhen, die
    // Linien zum Rand hin durchsichtiger (als Grau in ihrer Farbe, siehe oben)
    rebuild(feet) {
        this.built = feet.clone();
        const { edges, tints, triangles } = this;
        const positions = [], colors = [];
        const fade = (x, z) => {
            const d = Math.hypot(x - feet.x, z - feet.z);
            return 1 - THREE.MathUtils.smoothstep(d, FULL, RADIUS);
        };
        const near = (y) => y > feet.y - BELOW && y < feet.y + ABOVE;
        for (let i = 0, k = 0; i < edges.length; i += 6, k++) {
            const ax = edges[i], ay = edges[i + 1], az = edges[i + 2], bx = edges[i + 3], by = edges[i + 4], bz = edges[i + 5];
            const fa = fade(ax, az), fb = fade(bx, bz);
            if ((fa <= 0 && fb <= 0) || (!near(ay) && !near(by))) continue;
            positions.push(ax, ay, az, bx, by, bz);
            const t = tints[k];
            colors.push(t * fa, t * fa, t * fa, t * fb, t * fb, t * fb);
        }
        for (const lines of [this.glow, this.front, this.behind]) {
            lines.geometry.dispose();
            lines.geometry = new LineSegmentsGeometry();
            if (positions.length) {
                lines.geometry.setPositions(positions);
                lines.geometry.setColors(colors);
            }
            lines.visible = positions.length > 0;
        }
        const kept = [];
        for (let i = 0; i < triangles.length; i += 9) {
            const x = (triangles[i] + triangles[i + 3] + triangles[i + 6]) / 3, z = (triangles[i + 2] + triangles[i + 5] + triangles[i + 8]) / 3;
            const y = (triangles[i + 1] + triangles[i + 4] + triangles[i + 7]) / 3;
            if (Math.hypot(x - feet.x, z - feet.z) > RADIUS + 2 || !near(y)) continue;
            for (let j = 0; j < 9; j++) kept.push(triangles[i + j]);
        }
        this.occluder.geometry.dispose();
        this.occluder.geometry = new THREE.BufferGeometry();
        this.occluder.geometry.setAttribute('position', new THREE.Float32BufferAttribute(kept, 3));
    }

    // jedes Bild: der Abzug ihrer Hand schaltet, die Karte folgt dem Handgelenk
    update(time) {
        const xr = this.renderer.xr;
        const grip = this.grips.get(this.hand());
        if (xr.isPresenting) {
            for (const source of xr.getSession()?.inputSources ?? []) {
                if (source.handedness !== this.hand() || !source.gamepad) continue;
                const pressed = Boolean(source.gamepad.buttons[0]?.pressed);   // xr-standard: 0 der Abzug (Zeigefinger)
                if (pressed && !this.squeezed) this.toggle();
                this.squeezed = pressed;
            }
        }
        const anchor = new THREE.Vector3();
        if (xr.isPresenting && grip) {
            grip.getWorldPosition(anchor);
            anchor.y += LIFT;
        } else if (this.preview && !xr.isPresenting) {
            // am Rechner: unten rechts vor dir, als hieltest du sie hoch
            this.camera.updateMatrixWorld(true);
            anchor.copy(this.camera.localToWorld(new THREE.Vector3(0.11, -0.1, -0.32)));
        } else {
            this.group.visible = false;
            return;
        }
        this.group.visible = this.visible;
        if (!this.visible) return;
        const feet = this.player.position;
        if (!this.built || this.built.distanceTo(feet) > REBUILD) this.rebuild(feet);
        // die Mitte der Karte ist dein Platz: das verkleinerte Bauwerk so
        // verschoben, dass deine Füße über dem Handgelenk liegen
        this.group.position.copy(anchor);
        this.model.position.set(-feet.x * SCALE, -feet.y * SCALE, -feet.z * SCALE);
        // du auf ihrem Boden
        this.you.position.set(0, 0.0005, 0);
        this.ring.rotation.z = time * 0.8;
        // die Linien brauchen die Größe des Bildes für ihre Breite
        const size = this.renderer.getSize(new THREE.Vector2());
        this.front.material.resolution.copy(size);
        this.glow.material.resolution.copy(size);
        this.behind.material.resolution.copy(size);
    }
}
