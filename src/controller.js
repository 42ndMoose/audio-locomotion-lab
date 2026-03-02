import * as THREE from "three";
import { clamp, damp, nowSec } from "./utils.js";

export class ThirdPersonController {
  constructor({ camera, domElement, characterRoot, getGroundHeightAt, hud, onPose }) {
    this.camera = camera;
    this.domElement = domElement;
    this.characterRoot = characterRoot;
    this.getGroundHeightAt = getGroundHeightAt;
    this.hud = hud;
    this.onPose = onPose || null;

    this.pos = new THREE.Vector3(0, 1.0, 0);
    this.vel = new THREE.Vector3();
    this.move = new THREE.Vector3();

    // Free camera orbit (also movement basis)
    this.camYaw = 0;
    this.camPitch = -0.20;

    // Aim angles (pointer lock drives these)
    this.aimYaw = 0;
    this.aimPitch = -0.15;

    this.camTargetDist = 6.0;
    this.camDist = 6.0;
    this.camMin = 2.0;
    this.camMax = 18.0;
    this.camHeight = 1.6;

    this.walkSpeed = 6.0;
    this.sprintSpeeds = [0, 10.0, 16.0, 26.0, 42.0];
    this.accelGround = 52.0;
    this.accelAir = 14.0;
    this.friction = 6.5;
    this.slideFriction = 2.2;
    this.gravity = 26.0;
    this.jumpSpeed = 8.5;

    this.isCrouching = false;
    this.crouchHeightFactor = 0.65;

    this.sprintStage = 0;
    this.sprintHeld = false;
    this.lastShiftUpAt = -999;
    this.shiftChainWindow = 2.0;

    this.grounded = false;

    this.keys = new Set();
    this.rmbHeld = false;
    this.pointerLocked = false;

    this.sens = 0.0025;
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
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
        if (!this.sprintHeld) this._onShiftDown();
        this.sprintHeld = true;
      }
      if (e.code === "ControlLeft" || e.code === "ControlRight") this.isCrouching = true;
      if (e.code === "Space") this._tryJump();
      this.keys.add(e.code);
    };

    const onKeyUp = (e) => {
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
        this.sprintHeld = false;
        this.lastShiftUpAt = nowSec();
      }
      if (e.code === "ControlLeft" || e.code === "ControlRight") this.isCrouching = false;
      this.keys.delete(e.code);
    };

    const onMouseDown = (e) => {
      if (e.button === 2) this.rmbHeld = true;

      // LMB enters aim (pointer lock)
      if (e.button === 0) {
        this.domElement.requestPointerLock?.();
        this._updateCursorStyle();
      }
    };

    const onMouseUp = (e) => {
      if (e.button === 2) this.rmbHeld = false;
    };

    const onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.domElement;

      if (this.pointerLocked) {
        // enter aim: no snap
        this.aimYaw = this.camYaw;
        this.aimPitch = this.camPitch;
      } else {
        // exit aim: no snap
        this.camYaw = this.aimYaw;
        this.camPitch = this.aimPitch;
      }
      this._updateCursorStyle();
    };

    const onMouseMove = (e) => {
      const dx = e.movementX || 0;
      const dy = e.movementY || 0;

      if (this.pointerLocked) {
        this.aimYaw -= dx * this.sens;
        this.aimPitch -= dy * this.sens;
        this.aimPitch = clamp(this.aimPitch, -1.1, 0.35);

        // camera follows aim
        this.camYaw = this.aimYaw;
        this.camPitch = this.aimPitch;
        return;
      }

      if (!this.rmbHeld) return;

      // free orbit
      this.camYaw -= dx * this.sens;
      this.camPitch -= dy * this.sens;
      this.camPitch = clamp(this.camPitch, -1.2, 0.35);

      // KEY FIX: keep aim synced while not locked
      this.aimYaw = this.camYaw;
      this.aimPitch = this.camPitch;
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

  _updateCursorStyle() {
    // No cursor mode:
    // free = crosshair, aim = hidden
    this.domElement.style.cursor = this.pointerLocked ? "none" : "crosshair";
  }

  _onShiftDown() {
    const t = nowSec();
    const dtSinceUp = t - this.lastShiftUpAt;
    this.sprintStage = (dtSinceUp <= this.shiftChainWindow)
      ? Math.min(4, Math.max(1, this.sprintStage + 1))
      : 1;
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
    if (this.sprintHeld) return this.sprintStage;
    if (this.sprintStage > 0 && this._timeSinceShiftUp() <= this.shiftChainWindow) return this.sprintStage;
    this.sprintStage = 0;
    return 0;
  }

  update(dt) {
    // Movement basis ALWAYS camera yaw
    const basisYaw = this.camYaw;

    const fwd = new THREE.Vector3(Math.sin(basisYaw), 0, Math.cos(basisYaw));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);

    let x = 0, z = 0;
    if (this.keys.has("KeyW")) z += 1;
    if (this.keys.has("KeyS")) z -= 1;

    // Keep your mapping
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

    const crouchSpeedFactor = this.isCrouching ? 0.78 : 1.0;
    const targetSpeed = baseSpeed * crouchSpeedFactor;

    const accel = this.grounded ? this.accelGround : this.accelAir;
    const fric = (this.isCrouching && this.grounded) ? this.slideFriction : this.friction;

    const hv = new THREE.Vector3(this.vel.x, 0, this.vel.z);

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

    this.vel.y -= this.gravity * dt;
    this.pos.addScaledVector(this.vel, dt);

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

    // Facing
    let bodyYaw = this._bodyYaw;
    if (this.pointerLocked) {
      bodyYaw = this.camYaw; // aim feel
    } else if (hasMove) {
      bodyYaw = Math.atan2(this.move.x, this.move.z);
    }
    this._bodyYaw = bodyYaw;
    this.characterRoot.rotation.y = bodyYaw;

    // Camera
    this.camDist = damp(this.camDist, this.camTargetDist, 10.0, dt);

    const height = this.camHeight * (this.isCrouching ? this.crouchHeightFactor : 1.0);
    const target = new THREE.Vector3(this.pos.x, this.pos.y + height, this.pos.z);

    const camBack = new THREE.Vector3(
      Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      Math.cos(this.camYaw) * Math.cos(this.camPitch)
    );

    const camPos = new THREE.Vector3().copy(target).addScaledVector(camBack, -this.camDist);
    this.camera.position.lerp(camPos, 1 - Math.exp(-18.0 * dt));
    this.camera.lookAt(target);

    this._syncCharacter();
    this._updateHud(stage);

    if (this.onPose) this.onPose({ position: this.pos, bodyYaw: this._bodyYaw });
  }

  _syncCharacter() {
    this.characterRoot.position.copy(this.pos);
  }

  _updateHud(stageActive) {
    if (!this.hud) return;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.hud.speed.textContent = `Speed: ${speed.toFixed(1)}`;
    this.hud.sprint.textContent = `Sprint: ${stageActive}`;
    this.hud.mode.textContent = `Mode: ${this.pointerLocked ? "aim" : "free"}`;
  }
}
