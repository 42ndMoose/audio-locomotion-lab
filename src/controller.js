import * as THREE from "three";
import { clamp, damp, nowSec } from "./utils.js";

export class ThirdPersonController {
  constructor({
    camera,
    domElement,
    characterRoot,
    getGroundHeightAt,      // function(x,z) -> y
    hud,
    onPose,                 // optional callback({ position, bodyYaw })
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

    // Orientation
    this.yaw = 0;           // aim yaw
    this.pitch = -0.15;     // aim pitch

    // Orbit state (ALT camera)
    this.orbitYaw = 0;
    this.orbitPitch = -0.20;

    // Camera
    this.camTargetDist = 6.0;
    this.camDist = 6.0;
    this.camMin = 2.0;
    this.camMax = 18.0;
    this.camHeight = 1.6;

    // Movement tuning
    this.walkSpeed = 6.0;   // sprint stage 0
    // 1 jog, 2 sprint, 3 superhuman, 4 overdrive (sonic-fast)
    this.sprintSpeeds = [0, 10.0, 16.0, 26.0, 42.0];

    this.accelGround = 52.0;
    this.accelAir = 14.0;

    // Friction must not delete momentum instantly
    this.friction = 6.5;
    this.slideFriction = 2.2;

    this.gravity = 26.0;
    this.jumpSpeed = 8.5;

    // Crouch / slide
    this.isCrouching = false;
    this.crouchHeightFactor = 0.65;

    // Sprint stages logic
    this.sprintStage = 0;       // 0..4
    this.sprintHeld = false;
    this.lastShiftUpAt = -999;
    this.lastShiftDownAt = -999;
    this.shiftChainWindow = 2.0;

    // Grounded
    this.grounded = false;

    // Input
    this.keys = new Set();
    this.pointerLocked = false;
    this.altHeld = false;
    this.rmbHeld = false;

    // Mouse sensitivity
    this.sens = 0.0025;

    // Cursor visibility rule: show cursor only before first LMB, or while ALT held
    this.firstLmbDone = false;

    // cache for HUD
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
        this.altHeld = true;

        // Cursor must show while ALT is held, so unlock pointer if needed
        if (this.pointerLocked) {
          document.exitPointerLock?.();
        }
        this._updateCursorStyle();
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
      if (e.code === "AltLeft" || e.code === "AltRight") {
        this.altHeld = false;
        // When ALT releases, we go back to aim mode behavior
        this._updateCursorStyle();
      }

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

      // First LMB should enable pointer lock, unless ALT is held
      if (e.button === 0) {
        this.firstLmbDone = true;

        if (!this.altHeld) {
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

      // While ALT held, we only move orbit camera when RMB held
      if (this.altHeld) {
        if (this.rmbHeld) {
          this.orbitYaw -= dx * this.sens;
          this.orbitPitch -= dy * this.sens;
          this.orbitPitch = clamp(this.orbitPitch, -1.2, 0.35);
        }
        return;
      }

      // Normal aim mode requires pointer lock
      if (!this.pointerLocked) return;

      this.yaw -= dx * this.sens;
      this.pitch -= dy * this.sens;
      this.pitch = clamp(this.pitch, -1.1, 0.35);
    };

    const onWheel = (e) => {
      const delta = Math.sign(e.deltaY);
      this.camTargetDist = clamp(this.camTargetDist + delta * 0.7, this.camMin, this.camMax);
    };

    // Prevent context menu on RMB
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
    // Cursor rule:
    // - Before first LMB: cursor visible
    // - After first LMB: cursor hidden while pointer locked
    // - Any time ALT held: cursor visible
    if (!this.firstLmbDone || this.altHeld) {
      this.domElement.style.cursor = "default";
      return;
    }
    this.domElement.style.cursor = this.pointerLocked ? "none" : "crosshair";
  }

  _onShiftDown() {
    const t = nowSec();
    this.lastShiftDownAt = t;

    const dtSinceUp = t - this.lastShiftUpAt;

    // Stage-up only when you re-tap within 2 seconds
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
    // Keep sprint stage "live" for up to 2 seconds after releasing Shift.
    // After that, drop to 0 (walking), unless Shift is currently held.
    if (this.sprintHeld) return this.sprintStage;
    if (this.sprintStage > 0 && this._timeSinceShiftUp() <= this.shiftChainWindow) return this.sprintStage;

    this.sprintStage = 0;
    return 0;
  }

  update(dt) {
    // Camera yaw basis:
    // - While ALT held: camera stays in orbit view even if RMB not held (no snapping back)
    // - Otherwise: aim yaw/pitch
    const camYaw = this.altHeld ? this.orbitYaw : this.yaw;

    // Forward vector points toward +Z when yaw = 0
    const fwd = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));

    // FIX: A/D inversion (right must be +X when yaw=0)
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);

    let x = 0, z = 0;
    if (this.keys.has("KeyW")) z += 1;
    if (this.keys.has("KeyS")) z -= 1;
    if (this.keys.has("KeyD")) x += 1;
    if (this.keys.has("KeyA")) x -= 1;

    this.move.set(0, 0, 0);
    this.move.addScaledVector(fwd, z);
    this.move.addScaledVector(right, x);

    const hasMove = this.move.lengthSq() > 0.0001;
    if (hasMove) this.move.normalize();

    // Speed selection
    const stage = this._sprintStageActive();

    let baseSpeed = this.walkSpeed;
    if (stage > 0) baseSpeed = this.sprintSpeeds[stage];

    // crouch affects speed and friction
    const crouch = this.isCrouching;
    const crouchSpeedFactor = crouch ? 0.78 : 1.0;
    const targetSpeed = baseSpeed * crouchSpeedFactor;

    const accel = this.grounded ? this.accelGround : this.accelAir;
    const fric = (crouch && this.grounded) ? this.slideFriction : this.friction;

    // Current horizontal velocity
    const hv = new THREE.Vector3(this.vel.x, 0, this.vel.z);

    // Apply friction (ground only)
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

    // Momentum rule:
    // - Do not auto-decelerate toward walk speed just because Shift released.
    // - Only push velocity toward a desired velocity when the player is actively giving move input.
    if (hasMove) {
      const desiredVel = new THREE.Vector3().copy(this.move).multiplyScalar(targetSpeed);

      // If player is pushing opposite direction of current motion, allow stronger correction
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

    // Ground collision (flat or heightmap)
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

    // Body facing:
    // - If not in ALT mode and pointer locked, face aim
    // - Otherwise, face movement if moving
    let bodyYaw = this.yaw;
    if (this.altHeld) {
      // while ALT held, keep body yaw stable unless moving
      if (hasMove) bodyYaw = Math.atan2(this.move.x, this.move.z) + camYaw;
    } else {
      if (!this.pointerLocked && hasMove) {
        bodyYaw = Math.atan2(this.move.x, this.move.z) + camYaw;
      }
    }

    this._bodyYaw = bodyYaw;
    this.characterRoot.rotation.y = bodyYaw;

    // Smooth zoom
    this.camDist = damp(this.camDist, this.camTargetDist, 10.0, dt);

    // Camera pitch basis
    const pitchUsed = this.altHeld ? this.orbitPitch : this.pitch;

    const height = this.camHeight * (this.isCrouching ? this.crouchHeightFactor : 1.0);
    const target = new THREE.Vector3(this.pos.x, this.pos.y + height, this.pos.z);

    const camBack = new THREE.Vector3(
      Math.sin(camYaw) * Math.cos(pitchUsed),
      Math.sin(pitchUsed),
      Math.cos(camYaw) * Math.cos(pitchUsed)
    );

    const camPos = new THREE.Vector3().copy(target).addScaledVector(camBack, -this.camDist);

    // Smooth camera position
    this.camera.position.lerp(camPos, 1 - Math.exp(-18.0 * dt));
    this.camera.lookAt(target);

    this._syncCharacter();
    this._updateHud(stage);

    // Pose callback (for audio listener following character)
    if (this.onPose) {
      this.onPose({
        position: this.pos,
        bodyYaw: this._bodyYaw
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

    // Show stage even if Shift is released, as long as it's still inside the 2s window
    this.hud.sprint.textContent = `Sprint: ${stageActive}`;

    const mode =
      this.altHeld ? "orbit" :
      (this.pointerLocked ? "aim" : "free");

    this.hud.mode.textContent = `Mode: ${mode}`;
  }
}
