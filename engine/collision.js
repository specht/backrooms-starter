// Was beim Laufen im Weg ist (K): die Kästen, die controls.js prüft, rot und
// halb durchsichtig, eine runde Säule als Zylinder. Dazu dein Kreis am Boden
// mit den acht Punkten, an denen das Programm nachsieht, ob dort Boden ist,
// auf den du treten kannst: grün ja, rot nein (eine Wand, eine zu hohe Stufe,
// Wasser). Wände sind keine Kästen: Sie sind die Felder ohne Boden.
import * as THREE from 'three';
import { RADIUS } from './controls.js';

const COLOR = '#ff4030';
const FREE = new THREE.Color('#40e070');
const BLOCKED = new THREE.Color('#ff4030');
const GROW = 0.01;   // gezeichnet 1 cm größer als geprüft, damit sie nicht mit den Flächen eines Blocks flimmern

export function collisionView(walker) {
    const group = new THREE.Group();
    // zum Betrachter hin versetzt: Auch weit weg, wo der Tiefenpuffer 1 cm
    // nicht mehr auflöst, liegen die Kästen vor der Fläche, die sie umgeben
    const fill = new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
    const edge = new THREE.LineBasicMaterial({ color: COLOR, toneMapped: false });
    const obstacles = new THREE.Group();
    group.add(obstacles);
    // die Kästen neu, wenn welche dazugekommen sind (Modelle laden später)
    let count = -1;
    const build = () => {
        if (walker.boxes.length === count) return;
        count = walker.boxes.length;
        for (const child of obstacles.children) child.geometry.dispose();
        obstacles.clear();
        for (const box of walker.boxes) {
            const y0 = box.y0 ?? 0, y1 = box.y1 ?? y0 + 2;
            const [w, h, d] = [box.x1 - box.x0 + 2 * GROW, y1 - y0 + 2 * GROW, box.z1 - box.z0 + 2 * GROW];
            const shape = box.round ? new THREE.CylinderGeometry(w / 2, w / 2, h, 32, 1, true) : new THREE.BoxGeometry(w, h, d);
            if (box.round) shape.scale(1, 1, d / w);
            const mesh = new THREE.Mesh(shape, fill);
            const lines = new THREE.LineSegments(new THREE.EdgesGeometry(shape, 30), edge);
            for (const object of [mesh, lines]) {
                object.position.set((box.x0 + box.x1) / 2, (y0 + y1) / 2, (box.z0 + box.z1) / 2);
                obstacles.add(object);
            }
        }
    };
    // dein Kreis, 1 cm über dem Boden, und die acht Punkte darauf
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
        [...Array(48).keys()].map((i) => new THREE.Vector3(Math.cos(i / 48 * Math.PI * 2) * RADIUS, 0.01, Math.sin(i / 48 * Math.PI * 2) * RADIUS))),
    new THREE.LineBasicMaterial({ color: '#ffffff', toneMapped: false }));
    group.add(ring);
    const dot = new THREE.SphereGeometry(0.035, 12, 8);
    const dots = [...Array(8).keys()].map((i) => {
        const mesh = new THREE.Mesh(dot, new THREE.MeshBasicMaterial({ toneMapped: false }));
        const angle = (i / 8) * Math.PI * 2;
        mesh.position.set(Math.cos(angle) * RADIUS, 0.035, Math.sin(angle) * RADIUS);
        ring.add(mesh);
        return mesh;
    });
    group.update = () => {
        build();
        const p = walker.player.position;
        ring.position.copy(p);
        dots.forEach((mesh) => mesh.material.color.copy(walker.solid(p.x + mesh.position.x, p.z + mesh.position.z) ? BLOCKED : FREE));
    };
    return group;
}
