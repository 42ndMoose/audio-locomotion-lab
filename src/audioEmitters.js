import * as THREE from "three";
import { clamp } from "./utils.js";

export class AudioEmitterSystem {
  constructor({ listener, scene, camera, domOverlayList }) {
    this.listener = listener;
    this.scene = scene;
    this.camera = camera;
    this.domOverlayList = domOverlayList;

    this.raycaster = new THREE.Raycaster();
    this.mouseNDC = new THREE.Vector2();

    this.emitters = [];
    this.masterGain = null;

    this._initAudioGraph();
    this._bindPicking();
  }

  _initAudioGraph() {
    // Three.js Audio uses the same AudioContext underneath
    const ctx = this.listener.context;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.9;
    this.masterGain.connect(ctx.destination);
  }

  createEmitters() {
    // Minimal layout around center
    const points = [
      { name: "Emitter A", pos: new THREE.Vector3(8, 1, 0) },
      { name: "Emitter B", pos: new THREE.Vector3(-8, 1, 0) },
      { name: "Emitter C", pos: new THREE.Vector3(0, 1, 8) },
      { name: "Emitter D", pos: new THREE.Vector3(0, 1, -8) },
      { name: "Emitter E", pos: new THREE.Vector3(12, 1, 12) },
      { name: "Emitter F", pos: new THREE.Vector3(-12, 1, -12) }
    ];

    for (let i = 0; i < points.length; i++) {
      const e = this._makeOne(points[i], i);
      this.emitters.push(e);
      this.scene.add(e.group);
      this._addRowUI(e);
    }
  }

  _makeOne({ name, pos }, index) {
    const group = new THREE.Group();
    group.position.copy(pos);

    // Visible object (minimal)
    const baseGeo = new THREE.CylinderGeometry(0.7, 0.7, 0.25, 24);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x9aa4b2, roughness: 0.9, metalness: 0.05 });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = 0.2;
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    // Visualizer bar
    const vizGeo = new THREE.BoxGeometry(0.18, 1.0, 0.18);
    const vizMat = new THREE.MeshStandardMaterial({ color: 0xced6e0, roughness: 0.7, metalness: 0.1 });
    const viz = new THREE.Mesh(vizGeo, vizMat);
    viz.position.set(0, 1.0, 0);
    group.add(viz);

    // A faint ring
    const ringGeo = new THREE.TorusGeometry(1.1, 0.03, 10, 48);
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 1.0, metalness: 0.0 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.05;
    group.add(ring);

    // Positional audio + analyser
    const sound = new THREE.PositionalAudio(this.listener);
    sound.setRefDistance(4);
    sound.setRolloffFactor(1.7);
    sound.setDistanceModel("inverse");
    group.add(sound);

    const analyser = new THREE.AudioAnalyser(sound, 64);

    // start with a small oscillator so you get something immediately
    const oscNode = this._makeOscillatorSource(220 + index * 50);
    const ctx = this.listener.context;

    const gain = ctx.createGain();
    gain.gain.value = 0.0; // muted until playing

    oscNode.connect(gain);
    gain.connect(sound.getOutput());

    oscNode.start();

    // make picking easy
    group.userData._isEmitter = true;

    return {
      name,
      group,
      base,
      viz,
      ring,
      sound,
      analyser,
      playing: false,
      sourceKind: "osc",
      oscNode,
      gainNode: gain
    };
  }

  _makeOscillatorSource(freq) {
    const ctx = this.listener.context;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    return osc;
  }

  async setEmitterFile(emitter, file) {
    const ctx = this.listener.context;

    // Stop old oscillator path (we keep nodes but mute)
    emitter.gainNode.gain.value = 0.0;

    // Decode audio file
    const arr = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arr);

    // Create a looping buffer source
    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.loop = true;

    const gain = ctx.createGain();
    gain.gain.value = emitter.playing ? 0.9 : 0.0;

    src.connect(gain);
    gain.connect(emitter.sound.getOutput());
    src.start();

    emitter.sourceKind = "file";
    emitter.fileSource = src;
    emitter.fileGain = gain;
  }

  toggleEmitter(emitter) {
    // ensure audio context resumes on user gesture
    this.listener.context.resume?.();

    emitter.playing = !emitter.playing;

    if (emitter.sourceKind === "file" && emitter.fileGain) {
      emitter.fileGain.gain.value = emitter.playing ? 0.9 : 0.0;
    } else {
      emitter.gainNode.gain.value = emitter.playing ? 0.9 : 0.0;
    }
  }

  update(dt) {
    // update minimal visualizers
    for (const e of this.emitters) {
      const data = e.analyser.getFrequencyData();
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / (data.length * 255); // 0..1

      const height = 0.2 + avg * 3.0;
      e.viz.scale.y = height;
      e.viz.position.y = 0.55 + height * 0.5;

      const ringScale = 1.0 + avg * 0.5;
      e.ring.scale.set(ringScale, ringScale, ringScale);

      // subtle spin when active
      if (e.playing) e.ring.rotation.z += dt * (0.6 + avg * 1.2);
    }
  }

  _bindPicking() {
    window.addEventListener("click", (ev) => {
      // if pointer is locked, clicks are for gameplay, not picking
      if (document.pointerLockElement) return;

      const rect = this.camera?.viewportRect || this._getCanvasRect();
      const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);

      this.mouseNDC.set(x, y);
      this.raycaster.setFromCamera(this.mouseNDC, this.camera);

      const hits = this.raycaster.intersectObjects(this.emitters.map(e => e.group), true);
      if (!hits.length) return;

      const hit = hits[0].object;
      const emitterGroup = this._findEmitterGroup(hit);
      if (!emitterGroup) return;

      const emitter = this.emitters.find(e => e.group === emitterGroup);
      if (!emitter) return;

      this.toggleEmitter(emitter);
      this._syncUI();
    });
  }

  _findEmitterGroup(obj) {
    let cur = obj;
    while (cur) {
      if (cur.userData && cur.userData._isEmitter) return cur;
      cur = cur.parent;
    }
    return null;
  }

  _getCanvasRect() {
    // fallback, assumes full-screen canvas
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  _addRowUI(emitter) {
    const row = document.createElement("div");
    row.className = "emitterRow";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = emitter.name;

    const btn = document.createElement("button");
    btn.textContent = "Play";
    btn.addEventListener("click", () => {
      this.listener.context.resume?.();
      this.toggleEmitter(emitter);
      this._syncUI();
    });

    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.addEventListener("change", async () => {
      if (!input.files || !input.files[0]) return;
      await this.setEmitterFile(emitter, input.files[0]);
      this._syncUI();
    });

    row.appendChild(name);
    row.appendChild(input);
    row.appendChild(btn);

    this.domOverlayList.appendChild(row);

    emitter._ui = { row, btn, input };
    this._syncUI();
  }

  _syncUI() {
    for (const e of this.emitters) {
      if (!e._ui) continue;
      e._ui.btn.textContent = e.playing ? "Stop" : "Play";
      e._ui.row.style.opacity = e.playing ? "1.0" : "0.85";
    }
  }
}
