import * as THREE from "three";
import { clamp, damp, nowSec } from "./utils.js";

export class ThirdPersonController {
  constructor({
    camera,
    domElement,
    characterRoot,
    getGroundHeightAt,
    hud,
    onPose,
  }) {
    this.camera = camera;
    this.domElement = domElement;
    this.characterRoot = characterRoot;
    this.getGroundHeightAt = getGroundHeightAt;
    this.hud = hud;
    this.onPose = onPose || null;

    // Kinematic character state
    this.pos = new THREE.Vector3(0, 1.0, 0);
    this.vel = new THREE.Vector3();
    this.move = new THREE.Vector3();

    // Aim view (pointer lock)
    this.yaw = 0;
    this.pitch = -0.15;

    // Orbit view (cursor mode)
    this.orbitYaw = 0;
    this.orbitPitch = -0.20;

    // Camera
    this.camTargetDist = 6.0;
    this.camDist = 6.0;
    this.camMin = 2.0;
    this.camMax = 18.0;
    this.camHeight = 1.6;

    // Movement
    this.walkSpeed = 6.0; // stage 0
    this.sprintSpeeds = [0, 10.0, 16.0, 26.0, 42.0]; // 1..4
    this.accelGround = 52.0;
    this.accelAir = 14.0;
    this.friction = 6.5;
    this.slideFriction = 2.2;
    this.gravity = 26.0;
    this.jumpSpeed = 8.5;

    // Crouch / slide
    this.isCrouching = false;
    this.crouchHeightFactor = 0.65;

    // Sprint stage logic
    this.sprintStage = 0;
    this.sprintHeld = false;
    this.lastShiftUpAt = -999;
    this.shiftChainWindow = 2.0;

    // Grounded
    this.grounded = false;

    // Input
    this.keys = new Set();
    this.pointerLocked = false;

    // RMB orbit drag (in cursor mode)
    this.rmbHeld = false;

    // Cursor mode toggle (ALT)
    this.cursorMode = false;

    // Cursor visibility rule: show cursor before first LMB, or in cursor mode
    this.firstLmbDone = false;

    // Mouse sensitivity
    this.sens = 0.0025;

    // Cache
    this._bodyYaw = 0;

    this._bindEvents();
    this._syncCharacter();
  }

  setCharacterRoot(newRoot) {
    this.characterRoot = newRoot;
    this._syncCharacter();
  }

  _bindEvents() {
    const onKeyDown = (e) => {
      // ALT toggles cursor mode
      if (e.code === "AltLeft" || e.code === "AltRight") {
        e.preventDefault();
        e.stopPropagation();
        this._toggleCursorMode();
        return;
      }

      // While cursor mode is on, avoid browser Alt-shortcut fallout as much as we can.
      // Some OS-level shortcuts may still win.
      if (this.cursorMode && e.altKey) {
        e.preventDefault();
        e.stopPropagation();
      }

      if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
        if (!this.sprintHeld) this._onShiftDown();
        this.sprintHeld = true;
      }

      if (e.code === "ControlLeft" || e.code === "ControlRight") {
        this.isCrouching = true;
      }

      if (e.code === "Space") {
        this._tryJump();
      }

      this.keys.add(e.code);
    };

    const onKeyUp = (e) => {
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
        this.sprintHeld = false;
        this.lastShiftUpAt = nowSec();
      }

      if (e.code === "ControlLeft" || e.code === "ControlRight") {
        this.isCrouching = false;
      }

      this.keys.delete(e.code);
    };

    const onMouseDown = (e) => {
      if (e.button === 2) this.rmbHeld = true;

      // First LMB enables pointer lock only if not in cursor mode
      if (e.button === 0) {
        this.firstLmbDone = true;
        if (!this.cursorMode) {
          this.domElement.requestPointerLock?.();
        }
        this._updateCursorStyle();
      }
    };

    const onMouseUp = (e) => {
      if (e.button === 2) this.rmbHeld = false;
    };

    const onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.domElement;
      this._updateCursorStyle();
    };

    const onMouseMove = (e) => {
      const dx = e.movementX || 0;
      const dy = e.movementY || 0;

      // Cursor mode: orbit only when RMB is held
      if (this.cursorMode) {
        if (this.rmbHeld) {
          this.orbitYaw -= dx * this.sens;
          this.orbitPitch -= dy * this.sens;
          this.orbitPitch = clamp(this.orbitPitch, -1.2, 0.35);
        }
        return;
      }

      // Aim mode: requires pointer lock
      if (!this.pointerLocked) return;

      this.yaw -= dx * this.sens;
      this.pitch -= dy * this.sens;
      this.pitch = clamp(this.pitch, -1.1, 0.35);
    };

    const onWheel = (e) => {
      const delta = Math.sign(e.deltaY);
      this.camTargetDist = clamp(this.camTargetDist + delta * 0.7, this.camMin, this.camMax);
    };

    window.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousemove", onMouseMove);
    this.domElement.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("wheel", onWheel, { passive: true });
    document.addEventListener("pointerlockchange", onPointerLockChange);

    this._updateCursorStyle();
  }

  _toggleCursorMode() {
    this.cursorMode = !this.cursorMode;

    // Entering cursor mode must NOT snap the view.
    // Sync orbit angles to the current aim angles so it continues seamlessly.
    if (this.cursorMode) {
      this.orbitYaw = this.yaw;
      this.orbitPitch = this.pitch;

      // Cursor mode wants cursor visible and pointer unlocked
      if (this.pointerLocked) document.exitPointerLock?.();
    }

    this._updateCursorStyle();
  }

  _updateCursorStyle() {
    // Cursor visible:
    // - before first LMB
    // - OR while cursor mode is on
    if (!this.firstLmbDone || this.cursorMode) {
      this.domElement.style.cursor = "default";
      return;
    }
    this.domElement.style.cursor = this.pointerLocked ? "none" : "crosshair";
  }

  _onShiftDown() {
    const t = nowSec();
    const dtSinceUp = t - this.lastShiftUpAt;

    if (dtSinceUp <= this.shiftChainWindow) {
      this.sprintStage = Math.min(4, Math.max(1, this.sprintStage + 1));
    } else {
      this.sprintStage = 1;
    }
  }

  _tryJump() {
    if (!this.grounded) return;
    this.vel.y = this.jumpSpeed;
    this.grounded = false;
  }

  _timeSinceShiftUp() {
    return nowSec() - this.lastShiftUpAt;
  }

  _sprintStageActive() {
    // Stage persists for up to 2s after releasing Shift, to preserve momentum feel.
    if (this.sprintHeld) return this.sprintStage;
    if (this.sprintStage > 0 && this._timeSinceShiftUp() <= this.shiftChainWindow) return this.sprintStage;
    this.sprintStage = 0;
    return 0;
  }

  update(dt) {
    // Movement basis:
    // - aim mode uses yaw
    // - cursor mode uses orbitYaw
    const camYaw = this.cursorMode ? this.orbitYaw : this.yaw;

    const fwd = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);

    let x = 0, z = 0;
    if (this.keys.has("KeyW")) z += 1;
    if (this.keys.has("KeyS")) z -= 1;

    // FIX: A/D are inverted in your build, so flip the contributions directly.
    // A should strafe left, D should strafe right.
    if (this.keys.has("KeyD")) x -= 1;
    if (this.keys.has("KeyA")) x += 1;

    this.move.set(0, 0, 0);
    this.move.addScaledVector(fwd, z);
    this.move.addScaledVector(right, x);

    const hasMove = this.move.lengthSq() > 0.0001;
    if (hasMove) this.move.normalize();

    const stage = this._sprintStageActive();
    let baseSpeed = this.walkSpeed;
    if (stage > 0) baseSpeed = this.sprintSpeeds[stage];

    const crouch = this.isCrouching;
    const crouchSpeedFactor = crouch ? 0.78 : 1.0;
    const targetSpeed = baseSpeed * crouchSpeedFactor;

    const accel = this.grounded ? this.accelGround : this.accelAir;
    const fric = (crouch && this.grounded) ? this.slideFriction : this.friction;

    // Horizontal velocity
    const hv = new THREE.Vector3(this.vel.x, 0, this.vel.z);

    // Friction on ground only
    if (this.grounded) {
      const speed = hv.length();
      if (speed > 0.0001) {
        const drop = speed * fric * dt;
        const newSpeed = Math.max(0, speed - drop);
        hv.multiplyScalar(newSpeed / speed);
        this.vel.x = hv.x;
        this.vel.z = hv.z;
      }
    }

    // Only push toward desired velocity when player is actively moving
    if (hasMove) {
      const desiredVel = new THREE.Vector3().copy(this.move).multiplyScalar(targetSpeed);

      const hvDir = hv.lengthSq() > 0.0001 ? hv.clone().normalize() : null;
      const oppose = hvDir ? (hvDir.dot(this.move) < -0.25) : false;
      const accelUse = oppose ? accel * 1.35 : accel;

      const delta = desiredVel.sub(new THREE.Vector3(this.vel.x, 0, this.vel.z));
      const maxChange = accelUse * dt;
      if (delta.length() > maxChange) delta.setLength(maxChange);

      this.vel.x += delta.x;
      this.vel.z += delta.z;
    }

    // Gravity
    this.vel.y -= this.gravity * dt;

    // Integrate
    this.pos.addScaledVector(this.vel, dt);

    // Ground collision
    const groundY = this.getGroundHeightAt(this.pos.x, this.pos.z);
    const charHalfHeight = 0.9;
    const footY = this.pos.y - charHalfHeight;

    if (footY <= groundY) {
      this.pos.y = groundY + charHalfHeight;
      if (this.vel.y < 0) this.vel.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    // Facing rules
    // - cursor mode: omnidirectional, face movement direction if moving
    // - aim mode + pointer lock: face aim yaw
    // - aim mode + no lock: face movement direction if moving
    let bodyYaw = this.yaw;

    if (this.cursorMode) {
      if (hasMove) {
        bodyYaw = Math.atan2(this.move.x, this.move.z) + camYaw;
      }
      // IMPORTANT: RMB orbit must not affect facing. Only movement affects it.
    } else {
      if (this.pointerLocked) {
        bodyYaw = this.yaw;
      } else if (hasMove) {
        bodyYaw = Math.atan2(this.move.x, this.move.z) + camYaw;
      }
    }

    this._bodyYaw = bodyYaw;
    this.characterRoot.rotation.y = bodyYaw;

    // Smooth zoom
    this.camDist = damp(this.camDist, this.camTargetDist, 10.0, dt);

    // Camera pitch basis
    const pitchUsed = this.cursorMode ? this.orbitPitch : this.pitch;

    const height = this.camHeight * (this.isCrouching ? this.crouchHeightFactor : 1.0);
    const target = new THREE.Vector3(this.pos.x, this.pos.y + height, this.pos.z);

    const camBack = new THREE.Vector3(
      Math.sin(camYaw) * Math.cos(pitchUsed),
      Math.sin(pitchUsed),
      Math.cos(camYaw) * Math.cos(pitchUsed)
    );

    const camPos = new THREE.Vector3().copy(target).addScaledVector(camBack, -this.camDist);

    this.camera.position.lerp(camPos, 1 - Math.exp(-18.0 * dt));
    this.camera.lookAt(target);

    this._syncCharacter();
    this._updateHud(stage);

    if (this.onPose) {
      this.onPose({
        position: this.pos,
        bodyYaw: this._bodyYaw,
      });
    }
  }

  _syncCharacter() {
    this.characterRoot.position.copy(this.pos);
  }

  _updateHud(stageActive) {
    if (!this.hud) return;

    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.hud.speed.textContent = `Speed: ${speed.toFixed(1)}`;
    this.hud.sprint.textContent = `Sprint: ${stageActive}`;

    const mode = this.cursorMode ? "cursor" : (this.pointerLocked ? "aim" : "free");
    this.hud.mode.textContent = `Mode: ${mode}`;
  }
}
