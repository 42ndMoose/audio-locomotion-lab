import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export async function loadCharacterFromFile(file) {
  const url = URL.createObjectURL(file);
  const loader = new GLTFLoader();

  const gltf = await new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });

  URL.revokeObjectURL(url);

  // Return the loaded scene; caller can scale/position
  return gltf.scene;
}

export function makePlaceholderCharacter() {
  // Minimal capsule-ish placeholder: body + head marker
  const root = new THREE.Group();

  const bodyGeo = new THREE.CapsuleGeometry(0.35, 1.1, 6, 14);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.85, metalness: 0.05 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);

  const headGeo = new THREE.SphereGeometry(0.12, 16, 16);
  const headMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.8, metalness: 0.05 });
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.set(0, 0.9, 0.32); // front marker
  root.add(head);

  root.userData._headMarker = head;
  return root;
}
