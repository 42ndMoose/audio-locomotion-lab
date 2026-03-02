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

    // Kinematic state
    this.pos = new THREE.Vector3(0, 1.0, 0);
    this.vel = new THREE.Vector3();
    this.move = new THREE.Vector3();

    // Aim yaw/pitch (drives crosshair + movement basis in Aim)
    this.moveYaw = 0;
    this.movePitch = -0.15;

    // Camera orbit yaw/pitch (drives camera placement in Free/Cursor/Aim)
    this.camYaw = 0;
    this.camPitch = -0.15;

    // Camera distance
    this.camTargetDist = 6.0;
    this.camDist = 6.0;
    this.camMin = 2.0;
    this.camMax = 18.0;
    this.camHeight = 1.6;

    // Movement tuning
    this.walkSpeed = 6.0;
    this.sprintSpeeds = [0, 10.0, 16.0, 26.0, 42.0];
    this.accelGround = 52.0;
    this.accelAir = 14.0;
    this.friction = 6.5;
    this.slideFriction = 2.2;
    this.gravity = 26.0;
    this.jumpSpeed = 8.5;

    // Crouch
    this.isCrouching = false;
    this.crouchHeightFactor = 0.65;

    // Sprint
    this.sprintStage = 0;
    this.sprintHeld = false;
    this.lastShiftUpAt = -999;
    this.shiftChainWindow = 2.0;

    // Grounded
    this.grounded = false;

    // Input
    this.keys = new Set();
    this.pointerLocked = false;
    this.rmbHeld = false;

    // Mode toggle (ALT)
    this.cursorMode = false;

    // Cursor visibility rule
    this.firstLmbDone = false;

    // Sensitivity
    this.sens = 0.0025;

    // Facing cache
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
      if (e.code === "AltLeft" || e.code === "AltRight") {
        e.preventDefault();
        e.stopPropagation();
        this._toggleCursorMode();
        return;
      }

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

      if (e.button === 0) {
        this.firstLmbDone = true;

        // LMB locks pointer only when NOT in cursor mode
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

      // Cursor mode OR Free mode with cursor visible: RMB orbit only
      if ((this.cursorMode || !this.pointerLocked) && this.rmbHeld) {
        this.camYaw -= dx * this.sens;
        this.camPitch -= dy * this.sens;
        this.camPitch = clamp(this.camPitch, -1.2, 0.35);
        return;
      }

      // Aim mode (pointer locked, not cursor mode): mouse drives both moveYaw and camYaw
      if (!this.pointerLocked || this.cursorMode) return;

      this.moveYaw -= dx * this.sens;
      this.movePitch -= dy * this.sens;
      this.movePitch = clamp(this.movePitch, -1.1, 0.35);

      // Keep camera aligned to aim
      this.camYaw = this.moveYaw;
      this.camPitch = this.movePitch;
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

    if (this.cursorMode) {
      // Entering cursor mode: keep camera where it is, and keep movement basis stable.
      // We do NOT change moveYaw here.
      if (this.pointerLocked) document.exitPointerLock?.();
    } else {
      // Leaving cursor mode: go back to Free mode (not Aim unless user clicks to lock)
      // keep camera as-is
    }

    this._updateCursorStyle();
  }

  _updateCursorStyle() {
    // Cursor visible before first LMB OR while cursor mode
    if (!this.firstLmbDone || this.cursorMode) {
      this.domElement.style.cursor = "default";
      return;
    }
    // Free mode with pointer unlocked: crosshair
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
    if (this.sprintHeld) return this.sprintStage;
    if (this.sprintStage > 0 && this._timeSinceShiftUp() <= this.shiftChainWindow) return this.sprintStage;
    this.sprintStage = 0;
    return 0;
  }

  update(dt) {
    // Movement basis:
    // - Aim mode: moveYaw (camera aligned anyway)
    // - Free/Cursor: moveYaw stays stable unless aim mode updates it
    const basisYaw = this.moveYaw;

    const fwd = new THREE.Vector3(Math.sin(basisYaw), 0, Math.cos(basisYaw));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);

    let x = 0, z = 0;
    if (this.keys.has("KeyW")) z += 1;
    if (this.keys.has("KeyS")) z -= 1;

    // A left, D right (your working mapping)
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

    // Facing:
    // - Aim mode: snap to face away from camera (crosshair): face moveYaw
    // - Free/Cursor: face movement direction when moving, otherwise keep last yaw
    const inAimMode = this.pointerLocked && !this.cursorMode;

    let bodyYaw = this._bodyYaw;
    if (inAimMode) {
      bodyYaw = this.moveYaw;
    } else {
      if (hasMove) {
        // Face the actual movement direction (omnidir), independent from camera orbit
        bodyYaw = Math.atan2(this.move.x, this.move.z);
      }
    }

    this._bodyYaw = bodyYaw;
    this.characterRoot.rotation.y = bodyYaw;

    // Camera positioning uses camYaw/camPitch always (orbit/aim both supported)
    this.camDist = damp(this.camDist, this.camTargetDist, 10.0, dt);

    const pitchUsed = this.camPitch;
    const yawUsed = this.camYaw;

    const height = this.camHeight * (this.isCrouching ? this.crouchHeightFactor : 1.0);
    const target = new THREE.Vector3(this.pos.x, this.pos.y + height, this.pos.z);

    const camBack = new THREE.Vector3(
      Math.sin(yawUsed) * Math.cos(pitchUsed),
      Math.sin(pitchUsed),
      Math.cos(yawUsed) * Math.cos(pitchUsed)
    );

    const camPos = new THREE.Vector3().copy(target).addScaledVector(camBack, -this.camDist);
    this.camera.position.lerp(camPos, 1 - Math.exp(-18.0 * dt));
    this.camera.lookAt(target);

    this._syncCharacter();
    this._updateHud();

    if (this.onPose) {
      this.onPose({ position: this.pos, bodyYaw: this._bodyYaw });
    }
  }

  _syncCharacter() {
    this.characterRoot.position.copy(this.pos);
  }

  _updateHud() {
    if (!this.hud) return;

    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.hud.speed.textContent = `Speed: ${speed.toFixed(1)}`;

    const stage = this._sprintStageActive();
    this.hud.sprint.textContent = `Sprint: ${stage}`;

    const mode = (this.pointerLocked && !this.cursorMode) ? "aim" : (this.cursorMode ? "cursor" : "free");
    this.hud.mode.textContent = `Mode: ${mode}`;
  }
}
