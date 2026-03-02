import * as THREE from "three";
import { ThirdPersonController } from "./controller.js";
import { AudioEmitterSystem } from "./audioEmitters.js";
import { makePlaceholderCharacter, loadCharacterFromFile } from "./assets.js";

const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);
scene.fog = new THREE.Fog(0x0b0e14, 40, 260);

const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 1200);

// Lighting
const hemi = new THREE.HemisphereLight(0xdbeafe, 0x111827, 0.6);
scene.add(hemi);

const dir = new THREE.DirectionalLight(0xffffff, 1.0);
dir.position.set(20, 40, 20);
dir.castShadow = true;
dir.shadow.mapSize.set(2048, 2048);
dir.shadow.camera.left = -80;
dir.shadow.camera.right = 80;
dir.shadow.camera.top = 80;
dir.shadow.camera.bottom = -80;
scene.add(dir);

// Ground
const groundGeo = new THREE.PlaneGeometry(1200, 1200, 1, 1);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 1.0, metalness: 0.0 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(1200, 120, 0x1f2937, 0x111827);
grid.position.y = 0.01;
scene.add(grid);

// Center marker
const centerGeo = new THREE.TorusGeometry(6, 0.05, 10, 160);
const centerMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.95, metalness: 0.0 });
const centerRing = new THREE.Mesh(centerGeo, centerMat);
centerRing.rotation.x = Math.PI / 2;
centerRing.position.y = 0.03;
scene.add(centerRing);

// Character
let character = makePlaceholderCharacter();
scene.add(character);

// Audio listener MUST follow the character, not the camera
const listener = new THREE.AudioListener();
character.add(listener);

// We also want facing, so we keep a little anchor that we can rotate with body yaw.
// AudioListener is an Object3D, so this works cleanly.
listener.position.set(0, 1.6, 0);

// HUD refs
const hud = {
  status: document.getElementById("status"),
  speed: document.getElementById("speed"),
  sprint: document.getElementById("sprint"),
  mode: document.getElementById("mode")
};

// Simple ground function
function getGroundHeightAt(x, z) {
  return 0.0;
}

// Controller (pose callback drives listener pose)
const controller = new ThirdPersonController({
  camera,
  domElement: canvas,
  characterRoot: character,
  getGroundHeightAt,
  hud,
  onPose: ({ position, bodyYaw }) => {
    // listener is parented to character, so it already follows position.
    // Keep listener facing same way as body yaw for consistent HRTF orientation.
    listener.rotation.set(0, bodyYaw, 0);
  }
});

// Audio emitters
const emitterList = document.getElementById("emitterList");
const emitters = new AudioEmitterSystem({
  listener,
  scene,
  camera,
  domOverlayList: emitterList
});
emitters.createEmitters();

// Resize
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// Character file input hook
const charFile = document.getElementById("charFile");
charFile.addEventListener("change", async () => {
  if (!charFile.files || !charFile.files[0]) return;

  try {
    const loaded = await loadCharacterFromFile(charFile.files[0]);

    scene.remove(character);

    loaded.scale.setScalar(1.0);
    loaded.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });

    character = loaded;
    scene.add(character);

    // Re-parent listener to the new character root
    character.add(listener);
    listener.position.set(0, 1.6, 0);

    // Update controller root
    controller.setCharacterRoot(character);

    hud.status.textContent = "Character asset loaded. Root locomotion still drives the transform.";
  } catch (err) {
    console.error(err);
    hud.status.textContent = "Failed to load that model. Try a GLB with embedded buffers/textures.";
  }
});

// Render loop
let last = performance.now();
function tick() {
  const t = performance.now();
  const dt = Math.min(0.033, (t - last) / 1000);
  last = t;

  centerRing.rotation.z += dt * 0.25;

  controller.update(dt);
  emitters.update(dt);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();
