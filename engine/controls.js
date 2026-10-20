// Laufen: am Rechner mit Maus und Tastatur, auf dem Handy mit zwei Daumen,
// mit einer VR-Brille mit den Sticks der Controller. Wände und Modelle
// halten dich auf.
import * as THREE from 'three';

export const RADIUS = 0.25;   // so breit bist du, in Metern (ein Kreis um deine Füße)
const EYE_HEIGHT = 1.6;   // Augenhöhe am Rechner
const STICK_RADIUS = 55;  // so weit (Pixel) schiebt der Daumen den Stick bis zum Anschlag
const TOUCH_TURN = 0.005; // so viel dreht ein Pixel Wischen (Bogenmaß)
const FALL_FROM = 0.3;    // liegt der Boden tiefer als das unter den Füßen, fällt man
const GRAVITY = 9.81;     // m/s²

export class Walker {
    constructor(level, player, camera, renderer) {
        this.level = level;
        this.player = player;
        this.camera = camera;
        this.renderer = renderer;
        this.yaw = 0;
        this.pitch = 0;
        this.keys = new Set();
        this.enabled = () => true;
        this.mayCapture = () => true;  // ob ein Klick die Maus zum Umsehen fängt
        this.mayLook = () => true;     // ob die gefangene Maus gerade zum Umsehen dient
        this.mayTouch = () => true;    // ob Finger auf dem Bild laufen und schauen (nicht in der Automap)
        // Auf dem Handy: der linke Daumen schiebt einen Stick (x seitlich, y
        // nach vorn, je -1 bis 1), der rechte wischt zum Umsehen
        this.stick = { x: 0, y: 0 };
        this.touches = new Map();
        this.touched = false;
        // Blöcke, die bis unter Kopfhöhe reichen, stehen im Weg
        const cell = level.settings.cell;
        // (Modelle kommen mit addObstacle dazu, wenn sie geladen sind)
        // (y0 bis y1: wie hoch er reicht, damit ein Block in einem Raum
        // darüber unten nicht im Weg steht)
        this.boxes = level.things.filter((t) => t.type === 'block' && t.base + t.offset[1] < 1.7).map((t) => {
            const cx = (t.x + 0.5) * cell + t.offset[0], cz = (t.z + 0.5) * cell + t.offset[2];
            const y0 = t.floor + t.base + t.offset[1];
            return { x0: cx - t.size[0] / 2, x1: cx + t.size[0] / 2, z0: cz - t.size[2] / 2, z1: cz + t.size[2] / 2, y0, y1: y0 + t.size[1], round: t.shape === 'round', yaw: t.yaw ?? 0 };
        });
        // Eine runde Tür, schmaler als die Tür: neben ihrem Bogen ist Wand
        for (let k = 0; k < level.layers; k++) {
            for (let z = 0; z < level.depth; z++) {
                for (let x = 0; x < level.width; x++) {
                    const arch = level.archAt(x, z, k);
                    if (!arch) continue;
                    for (const [from, to] of [[arch.u0, arch.center - arch.radius], [arch.center + arch.radius, arch.u1]]) {
                        const lo = Math.max(from, arch.u0), hi = Math.min(to, arch.u1);
                        if (hi - lo < 0.01) continue;
                        const across = [(arch.alongX ? z : x) * cell, ((arch.alongX ? z : x) + 1) * cell];
                        const along = [arch.start + lo, arch.start + hi];
                        const [xs, zs] = arch.alongX ? [along, across] : [across, along];
                        this.boxes.push({ x0: xs[0], x1: xs[1], z0: zs[0], z1: zs[1], y0: arch.floor, y1: arch.top });
                    }
                }
            }
        }
        camera.position.set(0, EYE_HEIGHT, 0);
        const { start, settings } = level;
        this.toStart();

        const canvas = renderer.domElement;
        canvas.addEventListener('click', () => {
            if (!renderer.xr.isPresenting && !this.touched && this.mayCapture()) canvas.requestPointerLock?.();
        });
        this.setupTouch(canvas);
        document.addEventListener('mousemove', (event) => {
            if (document.pointerLockElement !== canvas || !this.mayLook(event)) return;
            this.yaw -= event.movementX * 0.0022;
            this.pitch = THREE.MathUtils.clamp(this.pitch - event.movementY * 0.0022, -1.4, 1.4);
        });
        document.addEventListener('keydown', (event) => this.keys.add(event.code));
        document.addEventListener('keyup', (event) => this.keys.delete(event.code));
        window.addEventListener('blur', () => this.keys.clear());
    }

    // Ein Finger links ist der Stick: Wo er aufsetzt, ist die Mitte, ein Ring
    // zeigt sie. Ein Finger rechts (oder ein zweiter links) wischt den Blick.
    setupTouch(canvas) {
        const ring = document.createElement('div');
        ring.className = 'touch-stick';
        const knob = document.createElement('div');
        ring.appendChild(knob);
        document.body.appendChild(ring);
        const showStick = (touch) => {
            ring.classList.toggle('active', !!touch);
            if (!touch) return;
            ring.style.left = `${touch.x0}px`;
            ring.style.top = `${touch.y0}px`;
            knob.style.transform = `translate(${this.stick.x * STICK_RADIUS}px, ${-this.stick.y * STICK_RADIUS}px)`;
        };
        const moving = () => [...this.touches.values()].find((t) => t.kind === 'move');

        canvas.addEventListener('touchstart', (event) => {
            this.touched = true;
            document.body.classList.add('touch');
            if (!this.mayTouch()) return;
            event.preventDefault();
            for (const t of event.changedTouches) {
                const kind = t.clientX < window.innerWidth / 2 && !moving() ? 'move' : 'look';
                this.touches.set(t.identifier, { kind, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY });
            }
            showStick(moving());
        }, { passive: false });
        canvas.addEventListener('touchmove', (event) => {
            if (!this.mayTouch()) return;
            event.preventDefault();
            for (const t of event.changedTouches) {
                const touch = this.touches.get(t.identifier);
                if (!touch) continue;
                if (touch.kind === 'look') {
                    this.yaw -= (t.clientX - touch.x) * TOUCH_TURN;
                    this.pitch = THREE.MathUtils.clamp(this.pitch - (t.clientY - touch.y) * TOUCH_TURN, -1.4, 1.4);
                } else {
                    // bis zum Anschlag, weiter geht der Stick nicht
                    let dx = (t.clientX - touch.x0) / STICK_RADIUS, dy = -(t.clientY - touch.y0) / STICK_RADIUS;
                    const length = Math.hypot(dx, dy);
                    if (length > 1) { dx /= length; dy /= length; }
                    this.stick = { x: dx, y: dy };
                }
                touch.x = t.clientX;
                touch.y = t.clientY;
            }
            showStick(moving());
        }, { passive: false });
        const end = (event) => {
            for (const t of event.changedTouches) {
                if (this.touches.get(t.identifier)?.kind === 'move') this.stick = { x: 0, y: 0 };
                this.touches.delete(t.identifier);
            }
            showStick(moving());
        };
        canvas.addEventListener('touchend', end);
        canvas.addEventListener('touchcancel', end);
    }

    // zurück zum @, in die Richtung aus der Level-Datei
    toStart() {
        const { start, settings } = this.level;
        this.player.position.set((start.x + 0.5) * settings.cell, this.level.floorAt(start.x + 0.5, start.z + 0.5, start.room), (start.z + 0.5) * settings.cell);
        // Himmelsrichtung im Uhrzeigersinn, Drehung (yaw) gegen den Uhrzeigersinn
        this.yaw = -THREE.MathUtils.degToRad(start.heading ?? 0);
        this.pitch = 0;
    }

    // auf den Boden an der Stelle, wo du stehst: Auf einer Rampe geht es
    // hinauf. Liegen Räume übereinander, auf den, auf dem deine Füße sind.
    // Liegt der Boden viel tiefer (ein Loch), fällt man dorthin (update).
    stand() {
        const p = this.player.position;
        const floor = this.level.floorAtPoint(p.x, p.z, p.y);
        if (floor > p.y - FALL_FROM) p.y = floor;
    }

    // Kein Boden, auf den man von hier aus treten kann: in keinem Raum dort
    // einer bis eine Stufe über den Füßen, unter einer Decke über dem Kopf,
    // und kein Wasser
    // Über einem Loch ist auch Boden: tief unten, man fällt hinein.
    solid(x, z) {
        const { settings } = this.level;
        const cx = Math.floor(x / settings.cell), cz = Math.floor(z / settings.cell);
        const y = this.player.position.y;
        return !this.level.slabs(cx, cz).some(({ room, layer }) => {
            // ins Wasser geht man nicht; in ein leeres Becken fällt man hinein
            const pool = this.level.poolAt(cx, cz, layer);
            if (pool && pool.surface !== null) return false;
            const floor = this.level.floorAt(x / settings.cell, z / settings.cell, room) - this.level.sunk(cx, cz, layer) + this.level.lift(cx, cz, layer, x / settings.cell, z / settings.cell);
            const ceiling = this.level.ceilingOfCell(cx, cz, layer)(x / settings.cell, z / settings.cell);
            return floor <= y + 0.45 && ceiling > Math.max(floor, y) + 1.0;
        });
    }

    // Etwas, um das man herumgehen muss: sein Grundriss, x0 bis x1 und z0 bis z1 in Metern
    addObstacle(box) {
        this.boxes.push(box);
    }

    // Passt ein Kreis mit RADIUS an diese Stelle? Geprüft an acht Punkten des Rands.
    free(px, pz) {
        if (this.solid(px, pz)) return false;
        const y = this.player.position.y;
        for (const box of this.boxes) {
            if (box.y0 !== undefined && (box.y1 < y + 0.1 || box.y0 > y + 1.7)) continue;
            // ein gedrehter Block: die Stelle zurückgedreht, dann wie ein gerader
            let [x, z] = [px, pz];
            if (box.yaw) {
                const mx = (box.x0 + box.x1) / 2, mz = (box.z0 + box.z1) / 2, c = Math.cos(box.yaw), s = Math.sin(box.yaw);
                [x, z] = [mx + (px - mx) * c - (pz - mz) * s, mz + (px - mx) * s + (pz - mz) * c];
            }
            if (box.round) {
                // eine runde Säule: Abstand zur Mitte, im Verhältnis zu ihrem Radius (um RADIUS größer)
                const rx = (box.x1 - box.x0) / 2 + RADIUS, rz = (box.z1 - box.z0) / 2 + RADIUS;
                if (((x - (box.x0 + box.x1) / 2) / rx) ** 2 + ((z - (box.z0 + box.z1) / 2) / rz) ** 2 < 1) return false;
                continue;
            }
            const nx = Math.max(box.x0, Math.min(x, box.x1)), nz = Math.max(box.z0, Math.min(z, box.z1));
            if ((x - nx) ** 2 + (z - nz) ** 2 < RADIUS * RADIUS) return false;
        }
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            if (this.solid(px + Math.cos(angle) * RADIUS, pz + Math.sin(angle) * RADIUS)) return false;
        }
        return true;
    }

    // Erst in x, dann in z: so gleitet man an einer Wand entlang, statt hängen zu bleiben.
    move(dx, dz) {
        const p = this.player.position;
        if (this.free(p.x + dx, p.z)) p.x += dx;
        if (this.free(p.x, p.z + dz)) p.z += dz;
        this.stand();
    }

    // Fallen: schneller und schneller, bis auf den Boden darunter
    fall(dt) {
        const p = this.player.position;
        const floor = this.level.floorAtPoint(p.x, p.z, p.y);
        if (p.y <= floor + 1e-4) { this.falling = 0; return; }
        this.falling = (this.falling ?? 0) + GRAVITY * dt;
        p.y = Math.max(floor, p.y - this.falling * dt);
    }

    // Treppen: Die Füße stehen sofort auf der nächsten Stufe, die Augen
    // gleiten hinterher (in etwa 0,1 s); sonst springt das Bild bei jeder
    // Stufe. Beim Fallen und nach einem großen Sprung (an eine andere Stelle
    // gesetzt) sofort.
    glide(dt) {
        const y = this.player.position.y;
        if (this.eyeFloor === undefined || this.falling > 0 || Math.abs(y - this.eyeFloor) > 0.6) this.eyeFloor = y;
        else this.eyeFloor += (y - this.eyeFloor) * (1 - Math.exp(-dt / 0.1));
        this.camera.position.y = EYE_HEIGHT + this.eyeFloor - y;
    }

    update(dt) {
        if (!this.enabled()) return;
        this.fall(dt);
        if (this.renderer.xr.isPresenting) {
            this.updateVR(dt);
            return;
        }
        this.glide(dt);
        // Pfeiltasten drehen, für alle ohne Maus
        if (this.keys.has('ArrowLeft')) this.yaw += 1.8 * dt;
        if (this.keys.has('ArrowRight')) this.yaw -= 1.8 * dt;
        this.camera.rotation.set(this.pitch, 0, 0);
        this.player.rotation.set(0, this.yaw, 0);

        let forward = 0, side = 0;
        if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) forward += 1;
        if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) forward -= 1;
        if (this.keys.has('KeyD')) side += 1;
        if (this.keys.has('KeyA')) side -= 1;
        // der Stick auf dem Handy: ein wenig geschoben geht langsam, ganz geschoben läuft
        const pushed = Math.hypot(this.stick.x, this.stick.y);
        let amount = 1;
        if (forward === 0 && side === 0 && pushed > 0.15) {
            forward = this.stick.y;
            side = this.stick.x;
            amount = pushed;
        }
        if (forward === 0 && side === 0) return;
        // gemächlich gehen (1,25 m/s), mit Shift oder dem Stick am Anschlag laufen
        const running = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || pushed > 0.95;
        const speed = (running ? 2.5 : 1.25) * amount * dt;
        const length = Math.hypot(forward, side);
        const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
        // Blickrichtung ist -z, um yaw gedreht
        const dx = (-sin * forward + cos * side) / length * speed;
        const dz = (-cos * forward - sin * side) / length * speed;
        this.move(dx, dz);
    }

    // Linker Stick: laufen in Blickrichtung, rechter Stick: drehen.
    updateVR(dt) {
        const session = this.renderer.xr.getSession();
        if (!session) return;
        let move = null, turn = null;
        for (const source of session.inputSources) {
            const axes = source.gamepad?.axes;
            if (!axes || axes.length < 2) continue;
            const x = axes[axes.length - 2] ?? 0, y = axes[axes.length - 1] ?? 0;
            const stick = { x: Math.abs(x) > 0.15 ? x : 0, y: Math.abs(y) > 0.15 ? y : 0 };
            if (source.handedness === 'right') turn = stick; else move = stick;
        }
        if (turn && turn.x) {
            // um den Kopf drehen, nicht um die Mitte des Spielfelds
            const head = new THREE.Vector3();
            this.camera.getWorldPosition(head);
            this.player.rotation.y -= turn.x * 1.6 * dt;
            this.player.updateMatrixWorld(true);
            const after = new THREE.Vector3();
            this.camera.getWorldPosition(after);
            this.player.position.add(head.sub(after));
        }
        if (move && (move.x || move.y)) {
            const forward = new THREE.Vector3();
            this.camera.getWorldDirection(forward);
            forward.y = 0;
            forward.normalize();
            const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
            const step = forward.multiplyScalar(-move.y).add(right.multiplyScalar(move.x)).multiplyScalar(1.25 * dt);
            this.move(step.x, step.z);
        }
    }
}
