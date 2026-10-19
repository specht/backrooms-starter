// Die Automap (M oder Tab): das ganze Bauwerk als Drahtgitter, schräg von oben.
// Jeder Raum hat seinen Namen, Leuchten sind gelbe Punkte,
// Statuen weiße, der Pfeil bist du. Ziehen mit der Maus dreht, das Mausrad
// zoomt.
import * as THREE from 'three';

// Eine Farbe für alles auf der Karte, wie eine Blaupause auf Schwarz
const LINE_COLOR = '#6fd3ff';
function roomColor() {
    return new THREE.Color(LINE_COLOR);
}

// Ein Raumname als Schild: helle, nicht fette Schrift, nur ein Hauch der
// Farbe des Raums, darunter ein schmaler Strich in seiner Farbe. Groß gezeichnet
// (120 px), damit er auch aus der Nähe scharf bleibt; in der Welt 0,8 m hoch.
// Wie die Karte beim Öffnen auf dich schaut: aus 17 m, um 35 Grad geneigt,
// auf eine Stelle ein Viertel dieses Abstands vor dir
const DISTANCE = 17;
const ELEVATION = 0.6;
const AHEAD = 0.25;

function label(text, color) {
    const font = '500 120px system-ui, sans-serif';
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = font;
    canvas.width = Math.ceil(context.measureText(text).width) + 72;
    canvas.height = 180;
    context.font = font;
    context.fillStyle = 'rgba(8, 8, 10, 0.6)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const tint = color.clone().lerp(new THREE.Color('#ffffff'), 0.75);
    context.fillStyle = `#${tint.getHexString()}`;
    context.textBaseline = 'middle';
    context.fillText(text, 36, 84);
    context.fillStyle = `#${color.getHexString()}`;
    context.fillRect(36, 150, canvas.width - 72, 6);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, toneMapped: false }));
    sprite.scale.set(0.8 * canvas.width / canvas.height, 0.8, 1);
    sprite.renderOrder = 10;
    return sprite;
}

export class Automap {
    constructor(level, geometry, lights, statues, player, renderer, pitch = () => 0) {
        this.pitch = pitch;   // wie weit du nach oben oder unten schaust
        this.renderer = renderer;
        this.player = player;
        this.active = false;
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color('#07070a');
        // Alles kommt in eine Gruppe: am Rechner in voller Größe, in VR als
        // kleines Modell vor dir, wie ein Puppenhaus.
        this.model = new THREE.Group();
        this.scene.add(this.model);
        // Namen, Punkte und der Pfeil: über dem Drahtgitter und, in der
        // Ansicht mit Räumen (V), über der richtigen Szene
        this.overlay = new THREE.Group();
        this.model.add(this.overlay);
        this.roomsView = false;
        const cell = level.settings.cell;

        // das Drahtgitter, in der Ansicht mit Räumen auch über den Räumen
        this.lines = new THREE.Group();
        this.model.add(this.lines);
        for (const { kind, room, geometry: mesh } of geometry.meshes) {
            const color = roomColor(room).multiplyScalar(kind === 'floor' ? 0.55 : 1);
            const material = new THREE.LineBasicMaterial({ color, toneMapped: false, transparent: true, opacity: kind === 'ceiling' ? 0.35 : 0.9 });
            this.lines.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh), material));
        }
        // Raumnamen über der Mitte jedes Raums
        for (const room of level.rooms) {
            const x = (room.ox + room.width / 2) * cell, z = (room.oz + room.depth / 2) * cell;
            const sprite = label(room.settings.name ?? room.id, roomColor(room.index));
            // über der höchsten Stelle seiner Decke, auch auf einer Rampe
            const top = Math.max(...[[0, 0], [room.width, 0], [0, room.depth], [room.width, room.depth], [room.width / 2, room.depth / 2]]
                .map(([cx, cz]) => room.ceilingAt(cx, cz)));
            sprite.position.set(x, top + 1.2, z);
            this.overlay.add(sprite);
        }
        const dot = (color, size) => new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
        for (const light of lights) {
            const marker = dot(light.flicker > 0 ? '#ff9a3c' : '#ffe680', 0.12);
            marker.position.copy(light.position);
            this.overlay.add(marker);
        }
        for (const statue of statues) {
            const box = new THREE.Box3().setFromObject(statue);
            const marker = dot('#ffffff', 0.2);
            box.getCenter(marker.position);
            marker.position.y = box.max.y;
            this.overlay.add(marker);
        }
        // du: ein Pfeil auf dem Boden von deinem Platz in Blickrichtung, ein
        // pulsierender Ring um dich und ein Strahl nach oben
        const red = new THREE.MeshBasicMaterial({ color: '#ff4060', side: THREE.DoubleSide, toneMapped: false });
        const arrow = new THREE.Shape([
            new THREE.Vector2(-0.07, 0), new THREE.Vector2(0.07, 0), new THREE.Vector2(0.07, 0.65),
            new THREE.Vector2(0.24, 0.65), new THREE.Vector2(0, 1.0), new THREE.Vector2(-0.24, 0.65), new THREE.Vector2(-0.07, 0.65),
        ]);
        const pointer = new THREE.Mesh(new THREE.ShapeGeometry(arrow), red);
        // die Form zeigt in +y; flach hingelegt zeigt sie nach -z, der Blickrichtung bei yaw 0
        pointer.rotation.x = -Math.PI / 2;
        this.you = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.3, 32), red);
        this.you.rotation.x = -Math.PI / 2;
        this.youPivot = new THREE.Group();
        this.youPivot.add(pointer);
        this.youPivot.add(this.you);
        // ein Strahl von deinem Platz nach oben, durch alle Decken zu sehen
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1, 8),
            new THREE.MeshBasicMaterial({ color: '#ff4060', transparent: true, opacity: 0.7, depthTest: false, toneMapped: false }));
        const top = geometry.maxHeight - geometry.minHeight + 2;   // vom tiefsten Boden bis über die höchste Decke
        beam.scale.y = top;
        beam.position.y = top / 2;
        beam.renderOrder = 5;
        this.youPivot.add(beam);
        this.overlay.add(this.youPivot);

        // Kamera kreist um die Mitte des Bauwerks
        const size = Math.max(level.width, level.depth) * cell;
        this.center = new THREE.Vector3(level.width * cell / 2, 0, level.depth * cell / 2);
        this.distance = size * 0.9;
        this.azimuth = 0.6;
        this.elevation = 0.95;
        this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, size * 10);
        this.size = size;

        // Die Karte folgt dir und dreht sich mit deinem Blick. Ziehen dreht
        // sie selbst, auch nach oben und unten (dann nicht mehr mit dir).
        // Mit Shift greift Ziehen das Level und verschiebt es so, wie es gerade
        // zu sehen ist: seitlich und nach oben und unten. Ist die Maus
        // gefangen, dreht Bewegen mit gedrückter Taste, Shift und Bewegen schiebt.
        this.follow = true;
        this.offset = new THREE.Vector3();
        this.dragging = false;
        const canvas = renderer.domElement;
        canvas.addEventListener('pointerdown', () => { if (this.active) this.dragging = true; });
        window.addEventListener('pointerup', () => { this.dragging = false; });
        window.addEventListener('mousemove', (event) => {
            if (!this.active) return;
            const captured = document.pointerLockElement === canvas;
            if (event.shiftKey && (this.dragging || captured)) {
                this.pan(event.movementX, event.movementY);
            } else if (this.dragging) {
                this.follow = false;
                this.azimuth -= event.movementX * 0.006;
                this.elevation = THREE.MathUtils.clamp(this.elevation + event.movementY * 0.006, -1.5, 1.5);
            }
        });
        canvas.addEventListener('wheel', (event) => {
            if (!this.active) return;
            event.preventDefault();
            this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(event.deltaY * 0.001), 3, size * 4);
        }, { passive: false });
    }

    // Beim Öffnen fliegt die Kamera von deinen Augen aus nach oben und
    // zurück: du siehst, wo du bist. Die Automap kreist dann um dich.
    // Das Level unter der Maus mitnehmen, in der Bildebene: wie weit ein
    // Pixel reicht, ergibt sich aus Entfernung und Blickwinkel der Kamera.
    pan(dx, dy) {
        const c = this.camera;
        const perPixel = 2 * this.distance * Math.tan(THREE.MathUtils.degToRad(c.fov / 2)) / window.innerHeight;
        const right = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 1);
        this.offset.addScaledVector(right, -dx * perPixel).addScaledVector(up, dy * perPixel);
    }

    toggle(eye = null) {
        this.active = !this.active;
        document.body.classList.toggle('automap', this.active);
        if (!this.active) return;
        // Die Maus freigeben: Auf der Karte zieht man mit ihr, statt sich umzusehen
        if (document.pointerLockElement) document.exitPointerLock();
        this.follow = true;
        this.offset.set(0, 0, 0);
        this.center.set(this.player.position.x, this.player.position.y, this.player.position.z);
        this.azimuth = this.player.rotation.y;
        this.elevation = ELEVATION;
        this.distance = DISTANCE;
        this.flight = null;
        if (eye) {
            eye.updateMatrixWorld(true);
            const from = new THREE.Vector3().setFromMatrixPosition(eye.matrixWorld);
            const look = new THREE.Vector3(0, 0, -1).transformDirection(eye.matrixWorld).multiplyScalar(4).add(from);
            this.flight = { start: performance.now(), from, look };
        }
    }

    resize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
    }

    // anaglyph: am Rechner mit Rot-Cyan-Brille. vrCamera: in VR die Kamera
    // des Spielers, das Modell steht dann klein vor ihm. rooms: die richtige
    // Szene und was darin für die Ansicht von oben verschwinden muss (Decken,
    // Leuchten); mit roomsView zeichnet die Karte dann sie statt des
    // Drahtgitters, in VR bleibt es beim Drahtgitter.
    render({ anaglyph = null, vrCamera = null, rooms = null } = {}) {
        this.youPivot.position.set(this.player.position.x, this.player.position.y + 0.05, this.player.position.z);
        this.youPivot.rotation.y = this.player.rotation.y;
        if (vrCamera) {
            // Der Spieler steht nicht in dieser Szene: seine Lage selbst aktualisieren
            vrCamera.parent?.updateMatrixWorld(true);
            // anderthalb Meter groß, 70 cm vor dir, auf Tischhöhe
            const scale = 1.5 / this.size;
            const head = new THREE.Vector3();
            vrCamera.getWorldPosition(head);
            const forward = new THREE.Vector3();
            vrCamera.getWorldDirection(forward);
            forward.y = 0;
            forward.normalize();
            this.model.scale.setScalar(scale);
            this.model.position.set(head.x + forward.x * 0.7 - this.center.x * scale, 0.85, head.z + forward.z * 0.7 - this.center.z * scale);
            this.model.updateMatrixWorld(true);
            this.renderer.render(this.scene, vrCamera);
            return;
        }
        this.model.scale.setScalar(1);
        this.model.position.set(0, 0, 0);
        this.center.set(this.player.position.x, this.player.position.y, this.player.position.z).add(this.offset);
        if (this.follow) {
            // mit dir drehen und neigen: schaust du nach unten, sieht die Karte von oben
            this.azimuth = this.player.rotation.y;
            this.elevation = THREE.MathUtils.clamp(ELEVATION - this.pitch(), -1.4, 1.5);
        }
        const pulse = 1 + 0.25 * Math.sin(performance.now() / 180);
        this.you.scale.setScalar(pulse);
        const c = this.camera;
        c.position.set(
            this.center.x + Math.sin(this.azimuth) * Math.cos(this.elevation) * this.distance,
            this.center.y + Math.sin(this.elevation) * this.distance,
            this.center.z + Math.cos(this.azimuth) * Math.cos(this.elevation) * this.distance,
        );
        // der Blick geht ein Stück vor dich: Du stehst unten im Bild, vor dir liegt das Level
        const target = this.center.clone().add(new THREE.Vector3(
            -Math.sin(this.azimuth), 0, -Math.cos(this.azimuth)).multiplyScalar(this.distance * AHEAD));
        if (this.flight) {
            // eine Sekunde lang von den Augen hierher, sanft an- und auslaufend
            const t = Math.min(1, (performance.now() - this.flight.start) / 1000);
            const ease = t * t * (3 - 2 * t);
            c.position.lerpVectors(this.flight.from, c.position, ease);
            target.lerpVectors(this.flight.look, this.center, ease);
            if (t >= 1) this.flight = null;
        }
        c.lookAt(target);
        c.updateMatrixWorld(true);
        // Mit Räumen: die Szene ohne Decken und Leuchten, darin für dieses
        // Bild die Namen, Punkte und der Pfeil
        let scene = this.scene;
        if (this.roomsView && rooms) {
            scene = rooms.scene;
            for (const object of rooms.hide) object.visible = false;
            scene.add(this.overlay);
            scene.add(this.lines);
        }
        const restore = () => {
            if (scene === this.scene) return;
            for (const object of rooms.hide) object.visible = true;
            this.model.add(this.overlay);
            this.model.add(this.lines);
        };
        if (anaglyph) {
            // Das Bauwerk wie ein Modell auf dem Tisch: Augenabstand und
            // Bildebene wachsen mit der Entfernung, sonst wirkt es flach.
            const distance = c.position.distanceTo(target);
            const { eyeSep, planeDistance } = anaglyph;
            anaglyph.eyeSep = distance * 0.04;
            anaglyph.planeDistance = distance;
            anaglyph.render(scene, c);
            anaglyph.eyeSep = eyeSep;
            anaglyph.planeDistance = planeDistance;
        } else {
            this.renderer.render(scene, c);
        }
        restore();
    }
}
