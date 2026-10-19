// Laufen: am Rechner mit Maus und Tastatur, mit einer VR-Brille mit den
// Sticks der Controller. Wände und Statuen halten dich auf.
import * as THREE from 'three';

const RADIUS = 0.25;      // so breit bist du, in Metern
const EYE_HEIGHT = 1.6;   // Augenhöhe am Rechner

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
        // Blöcke, die bis unter Kopfhöhe reichen, stehen im Weg
        const cell = level.settings.cell;
        // (Statuen kommen mit addObstacle dazu, wenn sie geladen sind)
        this.boxes = level.things.filter((t) => t.type === 'block' && t.base + t.offset[1] < 1.7).map((t) => {
            const cx = (t.x + 0.5) * cell + t.offset[0], cz = (t.z + 0.5) * cell + t.offset[2];
            return { x0: cx - t.size[0] / 2, x1: cx + t.size[0] / 2, z0: cz - t.size[2] / 2, z1: cz + t.size[2] / 2 };
        });
        camera.position.set(0, EYE_HEIGHT, 0);
        const { start, settings } = level;
        this.toStart();

        const canvas = renderer.domElement;
        canvas.addEventListener('click', () => {
            if (!renderer.xr.isPresenting && this.mayCapture()) canvas.requestPointerLock?.();
        });
        document.addEventListener('mousemove', (event) => {
            if (document.pointerLockElement !== canvas || !this.mayLook(event)) return;
            this.yaw -= event.movementX * 0.0022;
            this.pitch = THREE.MathUtils.clamp(this.pitch - event.movementY * 0.0022, -1.4, 1.4);
        });
        document.addEventListener('keydown', (event) => this.keys.add(event.code));
        document.addEventListener('keyup', (event) => this.keys.delete(event.code));
        window.addEventListener('blur', () => this.keys.clear());
    }

    // zurück zum @, in die Richtung aus der Level-Datei
    toStart() {
        const { start, settings } = this.level;
        this.player.position.set((start.x + 0.5) * settings.cell, 0, (start.z + 0.5) * settings.cell);
        this.stand();
        // Himmelsrichtung im Uhrzeigersinn, Drehung (yaw) gegen den Uhrzeigersinn
        this.yaw = -THREE.MathUtils.degToRad(start.heading ?? 0);
        this.pitch = 0;
    }

    // auf den Boden an der Stelle, wo du stehst: Auf einer Rampe geht es hinauf
    stand() {
        const p = this.player.position;
        p.y = this.level.floorAtPoint(p.x, p.z);
    }

    solid(x, z) {
        const { width, depth, cells, settings } = this.level;
        const cx = Math.floor(x / settings.cell), cz = Math.floor(z / settings.cell);
        if (cx < 0 || cz < 0 || cx >= width || cz >= depth) return true;
        return cells[cz * width + cx] !== 'floor';
    }

    // Etwas, um das man herumgehen muss: sein Grundriss, x0 bis x1 und z0 bis z1 in Metern
    addObstacle(box) {
        this.boxes.push(box);
    }

    // Passt ein Kreis mit RADIUS an diese Stelle? Geprüft an acht Punkten des Rands.
    free(x, z) {
        if (this.solid(x, z)) return false;
        for (const box of this.boxes) {
            const nx = Math.max(box.x0, Math.min(x, box.x1)), nz = Math.max(box.z0, Math.min(z, box.z1));
            if ((x - nx) ** 2 + (z - nz) ** 2 < RADIUS * RADIUS) return false;
        }
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            if (this.solid(x + Math.cos(angle) * RADIUS, z + Math.sin(angle) * RADIUS)) return false;
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

    update(dt) {
        if (!this.enabled()) return;
        if (this.renderer.xr.isPresenting) {
            this.updateVR(dt);
            return;
        }
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
        if (forward === 0 && side === 0) return;
        // gemächlich gehen (1,25 m/s), mit Shift laufen
        const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 2.5 : 1.25) * dt;
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
