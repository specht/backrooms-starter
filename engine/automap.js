// Die Automap (M oder Tab): das ganze Bauwerk als Drahtgitter, schräg von oben.
// Jeder Raum hat seinen Namen, Leuchten sind gelbe Punkte,
// Modelle weiße, der Pfeil bist du. Ziehen mit der Maus dreht, das Mausrad
// zoomt.
import * as THREE from 'three';
import { outlineEdges } from './geometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// Linien des Drahtgitters, so breit in Punkten der Seite (LineSegments2
// rechnet das selbst auf die Pixel um): auch auf einem feinen Bildschirm und
// in einem großen Bild gut zu sehen
const LINE_WIDTH = 1.5;
// Linien hinter Wänden und Böden: so viel so hell wie die davor
const HIDDEN = 0.18;
// Linien nur hinter einer Decke: dünner und etwas blasser, aber zu sehen
const UNDER_CEILING = 0.55;
const UNDER_CEILING_WIDTH = 0.9;

// Eine Farbe für alles auf der Karte, wie eine Blaupause auf Schwarz
export const LINE_COLOR = '#6fd3ff';   // die Linien der Karte, und die Kanten im Bild (E, main.js)
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

// Ein Name ist in der Welt 0,8 m hoch, auf dem Bildschirm aber höchstens so
// viele Punkte der Seite: Aus der Nähe wächst er nicht über alles andere.
const LABEL_HEIGHT = 0.8;
const LABEL_MAX_PIXELS = 26;

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
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, toneMapped: false, transparent: true }));
    sprite.userData.aspect = canvas.width / canvas.height;
    sprite.scale.set(LABEL_HEIGHT * sprite.userData.aspect, LABEL_HEIGHT, 1);
    sprite.renderOrder = 10;
    return sprite;
}

export class Automap {
    constructor(level, geometry, lights, models, player, renderer, pitch = () => 0) {
        this.pitch = pitch;   // wie weit du nach oben oder unten schaust
        this.renderer = renderer;
        this.player = player;
        this.active = false;
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color('#07070a');
        // Alles kommt in eine Gruppe (in VR gibt es diese Karte nicht, dort
        // ist sie am Handgelenk, wristmap.js)
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
        this.labels = [];
        this.model.add(this.lines);
        // Was hinter Wänden und Böden liegt, ist nur schwach zu sehen, was nur
        // hinter einer Decke liegt, dünner. Wände, Böden und Blöcke, dann die
        // Decken werden unsichtbar gezeichnet, nur in den Tiefenpuffer, etwas
        // nach hinten versetzt, damit ihre eigenen Kanten davor liegen. Jede
        // Linie gibt es dreimal: schwach (hinter Wänden), dünn (vor Wänden,
        // vielleicht hinter einer Decke) und kräftig (vor allem); render()
        // zeichnet sie in zwei Durchgängen.
        this.occluders = new THREE.Group();
        this.ceilingOccluders = new THREE.Group();
        this.linesBehind = new THREE.Group();
        this.linesThin = new THREE.Group();
        this.linesFront = new THREE.Group();
        this.lines.add(this.linesBehind, this.linesThin, this.linesFront);
        const hidden = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
        for (const { kind, room, geometry: mesh } of geometry.meshes) {
            const color = roomColor(room).multiplyScalar(kind === 'floor' ? 0.55 : 1);
            const opacity = kind === 'ceiling' ? 0.35 : 0.9;
            const edges = new LineSegmentsGeometry().fromEdgesGeometry(outlineEdges(mesh));
            const line = (extra) => new LineMaterial({ color, linewidth: LINE_WIDTH, toneMapped: false, transparent: true, opacity, depthWrite: false, ...extra });
            for (const [group, extra] of [[this.linesBehind, { opacity: opacity * HIDDEN, depthFunc: THREE.GreaterDepth }],
                [this.linesThin, { opacity: opacity * UNDER_CEILING, linewidth: UNDER_CEILING_WIDTH }], [this.linesFront, {}]]) {
                const lines = new LineSegments2(edges, line(extra));
                // für die Sicht (U): welcher Raum, und wie die Linie ohne sie aussieht
                lines.userData = { room, opacity: lines.material.opacity, color: color.clone() };
                group.add(lines);
            }
            const occluder = new THREE.Mesh(mesh, hidden);
            occluder.renderOrder = -1;
            if (kind === 'floor' || kind === 'wall' || kind === 'block') this.occluders.add(occluder);
            else if (kind === 'ceiling') this.ceilingOccluders.add(occluder);
        }
        this.model.add(this.occluders, this.ceilingOccluders);
        // Die Sicht (U): Welche Räume von deinem Platz aus gezeichnet werden
        // (portals.js). Sie bleiben hell, alle anderen werden blass; die
        // Portale, durch die du schaust, sind orange, dazu dein Blickfeld.
        this.sightView = false;
        this.sight = new THREE.Group();
        this.sight.renderOrder = 6;
        this.ceilingOccluders.visible = false;
        this.linesThin.visible = false;
        // Raumnamen über der Mitte jedes Raums
        for (const room of level.rooms) {
            const x = (room.ox + room.width / 2) * cell, z = (room.oz + room.depth / 2) * cell;
            const sprite = label(room.settings.name ?? room.id, roomColor(room.index));
            // über der höchsten Stelle seiner Decke, auch auf einer Rampe
            const top = Math.max(...[[0, 0], [room.width, 0], [0, room.depth], [room.width, room.depth], [room.width / 2, room.depth / 2]]
                .map(([cx, cz]) => room.ceilingAt(cx, cz)));
            sprite.position.set(x, top + 1.2, z);
            this.overlay.add(sprite);
            this.labels.push(sprite);
        }
        const dot = (color, size) => new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
        for (const light of lights) {
            const marker = dot(light.flicker > 0 ? '#ff9a3c' : '#ffe680', 0.12);
            marker.position.copy(light.position);
            this.overlay.add(marker);
        }
        for (const model of models) {
            const box = new THREE.Box3().setFromObject(model);
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
        this.overlay.add(this.sight);
        this.portalFill = new THREE.MeshBasicMaterial({ color: '#ffad3d', transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthTest: false, depthWrite: false, toneMapped: false });
        this.portalEdge = new THREE.LineBasicMaterial({ color: '#ffc46b', transparent: true, opacity: 0.95, depthTest: false, toneMapped: false });
        this.coneEdge = new THREE.LineBasicMaterial({ color: '#ff4060', transparent: true, opacity: 0.9, depthTest: false, toneMapped: false });

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
        // Mit Shift greift Ziehen das Level und verschiebt es über den Boden
        // (pan): seitlich und vor und zurück. Ist die Maus
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

        // Auf dem Handy: ein Finger dreht die Karte, zwei Finger zoomen
        // (auseinander: näher heran) und verschieben sie (beide zusammen).
        let fingers = null;
        const read = (touches) => {
            const list = [...touches];
            const x = list.reduce((sum, t) => sum + t.clientX, 0) / list.length;
            const y = list.reduce((sum, t) => sum + t.clientY, 0) / list.length;
            const spread = list.length > 1 ? Math.hypot(list[0].clientX - list[1].clientX, list[0].clientY - list[1].clientY) : 0;
            return { count: list.length, x, y, spread };
        };
        canvas.addEventListener('touchstart', (event) => {
            if (!this.active) return;
            event.preventDefault();
            fingers = read(event.touches);
        }, { passive: false });
        canvas.addEventListener('touchmove', (event) => {
            if (!this.active || !fingers) return;
            event.preventDefault();
            const now = read(event.touches);
            if (now.count !== fingers.count) { fingers = now; return; }
            if (now.count === 1) {
                this.follow = false;
                this.azimuth -= (now.x - fingers.x) * 0.008;
                this.elevation = THREE.MathUtils.clamp(this.elevation + (now.y - fingers.y) * 0.008, -1.5, 1.5);
            } else {
                this.pan(now.x - fingers.x, now.y - fingers.y);
                if (fingers.spread > 0 && now.spread > 0) {
                    this.distance = THREE.MathUtils.clamp(this.distance * fingers.spread / now.spread, 3, size * 4);
                }
            }
            fingers = now;
        }, { passive: false });
        canvas.addEventListener('touchend', (event) => { fingers = event.touches.length ? read(event.touches) : null; });
    }

    // Beim Öffnen fliegt die Kamera von deinen Augen aus nach oben und
    // zurück: du siehst, wo du bist. Die Automap kreist dann um dich.
    // Das Level unter der Maus mitnehmen, über den Boden: seitlich und vor
    // und zurück, in der Höhe deiner Füße. Wie weit ein Pixel reicht, ergibt
    // sich aus Entfernung und Blickwinkel der Kamera; vor und zurück so viel
    // weiter, wie der Boden schräg zu sehen ist, damit die Stelle unter der
    // Maus mitgeht (bei flachem Blick begrenzt). In der Bildebene verschoben,
    // stieg die Mitte bei schrägem Blick mit jedem Zug, das Level fiel unter
    // ihr zurück und kam der Maus immer langsamer nach.
    pan(dx, dy) {
        const c = this.camera;
        const perPixel = 2 * this.distance * Math.tan(THREE.MathUtils.degToRad(c.fov / 2)) / window.innerHeight;
        const right = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 0);
        right.y = 0;
        right.normalize();
        const forward = new THREE.Vector3(-Math.sin(this.azimuth), 0, -Math.cos(this.azimuth));
        const slant = Math.max(Math.sin(Math.abs(this.elevation)), 0.35);
        this.offset.addScaledVector(right, -dx * perPixel).addScaledVector(forward, dy * perPixel / slant);
    }

    // Wie die Karte gerade liegt, für die Adresse (?automap=...): Drehung und
    // Neigung in Grad, Entfernung und Verschiebung in Metern, dazu follow
    // (dreht sich mit dir) und rooms (Räume statt Drahtgitter). null, wenn
    // sie zu ist.
    state() {
        if (!this.active) return null;
        const degrees = (radians) => Math.round(THREE.MathUtils.radToDeg(radians));
        const words = [this.follow && 'follow', this.roomsView && 'rooms', this.sightView && 'sight'].filter(Boolean);
        return [degrees(this.azimuth), degrees(this.elevation), this.distance.toFixed(1),
            ...this.offset.toArray().map((v) => v.toFixed(1)), ...words].join(',');
    }

    // öffnet die Karte so, wie state() sie beschrieben hat, ohne Flug
    restore(text) {
        if (!this.active) this.toggle();
        const values = text.split(',');
        const numbers = values.slice(0, 6).map(Number);
        if (numbers.length === 6 && numbers.every(Number.isFinite)) {
            this.follow = values.includes('follow');
            this.azimuth = THREE.MathUtils.degToRad(numbers[0]);
            this.elevation = THREE.MathUtils.degToRad(numbers[1]);
            this.distance = numbers[2];
            this.offset.set(numbers[3], numbers[4], numbers[5]);
        }
        this.roomsView = values.includes('rooms');
        this.sightView = values.includes('sight');
    }

    // Die Sicht zeigen (sightView) oder nicht: sight = { rooms, seen, camera }
    // aus portals.js, oder null
    showSight(sight) {
        for (const child of [...this.sight.children]) {
            child.geometry.dispose();
            this.sight.remove(child);
        }
        const on = this.sightView && sight;
        for (const group of [this.linesBehind, this.linesThin, this.linesFront]) {
            for (const lines of group.children) {
                const { room, opacity, color } = lines.userData;
                const shown = !on || sight.rooms.has(room);
                lines.material.opacity = shown ? opacity : opacity * 0.22;
                lines.material.color.copy(color);
                if (!shown) lines.material.color.lerp(new THREE.Color('#5a6470'), 0.7);
            }
        }
        // die Namen auch: blass, wo der Raum nicht gezeichnet wird
        this.labels.forEach((sprite, room) => { sprite.material.opacity = !on || sight.rooms.has(room) ? 1 : 0.3; });
        if (!on) return;
        const done = new Set();
        for (const { portal } of sight.seen) {
            if (done.has(portal)) continue;
            done.add(portal);
            const [a, b, c, d] = portal.corners;
            const fill = new THREE.BufferGeometry().setFromPoints([a, b, c, a, c, d]);
            const quad = new THREE.Mesh(fill, this.portalFill);
            quad.renderOrder = 6;
            this.sight.add(quad);
            const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([a, b, c, d]), this.portalEdge);
            edge.renderOrder = 7;
            this.sight.add(edge);
        }
        // dein Blickfeld: vier Strahlen aus deinen Augen durch die Ecken des Bilds, 3 m lang
        const camera = sight.camera;
        const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
        const ends = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => new THREE.Vector3(x, y, 0.5).unproject(camera).sub(eye).normalize().multiplyScalar(3).add(eye));
        const rays = [];
        for (const end of ends) rays.push(eye, end);
        for (let i = 0; i < 4; i++) rays.push(ends[i], ends[(i + 1) % 4]);
        const cone = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(rays), this.coneEdge);
        cone.renderOrder = 7;
        this.sight.add(cone);
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

    // Zwei Durchgänge: zuerst Wände und Böden in den Tiefenpuffer, die Linien
    // dahinter schwach und davor dünn; dann die Decken dazu und die Linien vor
    // allem kräftig darüber. So ist dünn, was nur eine Decke verdeckt.
    renderLayered(c) {
        const renderer = this.renderer;
        const keep = renderer.autoClear;
        this.linesFront.visible = false;
        this.overlay.visible = false;
        this.linesThin.visible = true;
        renderer.render(this.scene, c);
        renderer.autoClear = false;
        this.occluders.visible = false;
        this.linesBehind.visible = false;
        this.linesThin.visible = false;
        this.ceilingOccluders.visible = true;
        this.linesFront.visible = true;
        this.overlay.visible = true;
        // ohne Hintergrund: Er würde das erste Bild übermalen
        const background = this.scene.background;
        this.scene.background = null;
        // Wände und Böden noch einmal in die Tiefe, dazu die Decken
        this.occluders.visible = true;
        renderer.render(this.scene, c);
        this.scene.background = background;
        renderer.autoClear = keep;
        this.ceilingOccluders.visible = false;
        this.linesBehind.visible = true;
    }

    resize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
    }

    // anaglyph: am Rechner mit Rot-Cyan-Brille. rooms: die richtige Szene
    // und was darin für die Ansicht von oben verschwinden muss (Decken,
    // Leuchten); mit roomsView zeichnet die Karte dann sie statt des
    // Drahtgitters. In VR gibt es sie nicht, dort ist die Karte am
    // Handgelenk (wristmap.js).
    render({ anaglyph = null, rooms = null } = {}) {
        this.youPivot.position.set(this.player.position.x, this.player.position.y + 0.05, this.player.position.z);
        this.youPivot.rotation.y = this.player.rotation.y;
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
            target.lerpVectors(this.flight.look, target, ease);   // zu demselben Ziel wie danach: kein Sprung
            if (t >= 1) this.flight = null;
        }
        c.lookAt(target);
        c.updateMatrixWorld(true);
        // die Namen nicht größer als LABEL_MAX_PIXELS: wie viele Punkte ein
        // Meter in seiner Entfernung auf dem Bildschirm hat
        const perMeter = window.innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(c.fov / 2)));
        for (const sprite of this.labels) {
            const height = Math.min(LABEL_HEIGHT, LABEL_MAX_PIXELS * c.position.distanceTo(sprite.position) / perMeter);
            sprite.scale.set(height * sprite.userData.aspect, height, 1);
        }
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
        } else if (scene === this.scene) {
            this.renderLayered(c);
        } else {
            this.renderer.render(scene, c);
        }
        restore();
    }
}
