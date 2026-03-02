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

// Lighting (minimal but readable)
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

// Ground: huge open plane
const groundGeo = new THREE.PlaneGeometry(1200, 1200, 1, 1);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 1.0, metalness: 0.0 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Subtle grid lines
const grid = new THREE.GridHelper(1200, 120, 0x1f2937, 0x111827);
grid.position.y = 0.01;
scene.add(grid);

// Center markers
const centerGeo = new THREE.TorusGeometry(6, 0.05, 10, 160);
const centerMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.95, metalness: 0.0 });
const centerRing = new THREE.Mesh(centerGeo, centerMat);
centerRing.rotation.x = Math.PI / 2;
centerRing.position.y = 0.03;
scene.add(centerRing);

// Character
let character = makePlaceholderCharacter();
scene.add(character);

// Audio Listener
const listener = new THREE.AudioListener();
camera.add(listener);

// HUD refs
const hud = {
  status: document.getElementById("status"),
  speed: document.getElementById("speed"),
  sprint: document.getElementById("sprint"),
  mode: document.getElementById("mode")
};

// Simple ground function (flat now, but you can swap to noise later)
function getGroundHeightAt(x, z) {
  return 0.0;
}

// Controller
const controller = new ThirdPersonController({
  camera,
  domElement: canvas,
  characterRoot: character,
  getGroundHeightAt,
  hud
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

    // remove old
    scene.remove(character);

    // Normalize scale-ish: you will probably change this depending on your model
    loaded.scale.setScalar(1.0);
    loaded.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });

    character = loaded;
    scene.add(character);

    // Point controller at new root
    controller.characterRoot = character;

    hud.status.textContent = "Character asset loaded. Controller still drives root position/rotation.";
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

  // gentle center ring rotation
  centerRing.rotation.z += dt * 0.25;

  controller.update(dt);
  emitters.update(dt);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();
