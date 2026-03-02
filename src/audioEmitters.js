import * as THREE from "three";

export class AudioEmitterSystem {
  constructor({ listener, scene, camera, domOverlayList }) {
    this.listener = listener;
    this.scene = scene;
    this.camera = camera;
    this.domOverlayList = domOverlayList;

    this.raycaster = new THREE.Raycaster();
    this.mouseNDC = new THREE.Vector2();

    this.emitters = [];

    this._bindPicking();
  }

  createEmitters() {
    const points = [
      { name: "Emitter A", pos: new THREE.Vector3(8, 1, 0) },
      { name: "Emitter B", pos: new THREE.Vector3(-8, 1, 0) },
      { name: "Emitter C", pos: new THREE.Vector3(0, 1, 8) },
      { name: "Emitter D", pos: new THREE.Vector3(0, 1, -8) },
      { name: "Emitter E", pos: new THREE.Vector3(12, 1, 12) },
      { name: "Emitter F", pos: new THREE.Vector3(-12, 1, -12) },
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

    // Visible object
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

    // Ring
    const ringGeo = new THREE.TorusGeometry(1.1, 0.03, 10, 48);
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 1.0, metalness: 0.0 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.05;
    group.add(ring);

    // Positional audio
    const sound = new THREE.PositionalAudio(this.listener);
    sound.setRefDistance(4);
    sound.setRolloffFactor(1.7);
    sound.setDistanceModel("inverse");
    sound.setDirectionalCone(210, 260, 0.35);
    group.add(sound);

    // IMPORTANT FIX:
    // Route sources through THREE's positional chain using setNodeSource()
    // so the panner uses the emitter object's world position.
    const ctx = this.listener.context;

    // Default: oscillator so you hear something immediately
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 220 + index * 50;

    const gain = ctx.createGain();
    gain.gain.value = 0.0; // muted until playing

    osc.connect(gain);
    sound.setNodeSource(gain);

    osc.start();

    const analyser = new THREE.AudioAnalyser(sound, 64);

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

      // source state
      sourceKind: "osc",
      oscNode: osc,
      nodeGain: gain,

      // file state (if loaded)
      fileSource: null,
    };
  }

  async setEmitterFile(emitter, file) {
    const ctx = this.listener.context;

    // Decode audio
    const arr = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arr);

    // Stop previous file source if any
    if (emitter.fileSource) {
      try { emitter.fileSource.stop(); } catch (_) {}
      emitter.fileSource = null;
    }

    // Create looping buffer source
    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.loop = true;

    // Keep the same gain node already connected through the positional chain
    // Just swap the upstream source feeding it.
    // Mute oscillator upstream (it can keep running quietly).
    emitter.nodeGain.gain.value = emitter.playing ? 0.9 : 0.0;

    // Disconnect oscillator from gain to avoid mixing (safe-guard)
    try { emitter.oscNode.disconnect(); } catch (_) {}

    // Connect file source into gain
    src.connect(emitter.nodeGain);
    src.start();

    emitter.sourceKind = "file";
    emitter.fileSource = src;
  }

  toggleEmitter(emitter) {
    this.listener.context.resume?.();
    emitter.playing = !emitter.playing;
    emitter.nodeGain.gain.value = emitter.playing ? 0.9 : 0.0;
  }

  update(dt) {
    for (const e of this.emitters) {
      const data = e.analyser.getFrequencyData();
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / (data.length * 255);

      const height = 0.2 + avg * 3.0;
      e.viz.scale.y = height;
      e.viz.position.y = 0.55 + height * 0.5;

      const ringScale = 1.0 + avg * 0.5;
      e.ring.scale.set(ringScale, ringScale, ringScale);

      if (e.playing) e.ring.rotation.z += dt * (0.6 + avg * 1.2);
    }
  }

  _bindPicking() {
    window.addEventListener("click", (ev) => {
      // if pointer is locked, clicks are gameplay
      if (document.pointerLockElement) return;

      const rect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
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
