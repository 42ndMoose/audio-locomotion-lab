import * as THREE from "three";
import { clamp, damp } from "./utils.js";

export class ThirdPersonController {
  constructor({
    camera,
    domElement,
    characterRoot,
    getGroundHeightAt,  // function(x,z) -> y
    hud
  }) {
    this.camera = camera;
    this.domElement = domElement;
    this.characterRoot = characterRoot;
    this.getGroundHeightAt = getGroundHeightAt;
    this.hud = hud;

    // Kinematic capsule-ish character state
    this.pos = new THREE.Vector3(0, 1.0, 0);
    this.vel = new THREE.Vector3();
    this.move = new THREE.Vector3();

    // Orientation
    this.yaw = 0;
    this.pitch = -0.15;
    this.headYaw = 0;
    this.headPitch = 0;

    // Camera
    this.camTargetDist = 6.0;
    this.camDist = 6.0;
    this.camMin = 2.0;
    this.camMax = 14.0;
    this.camHeight = 1.6;

    // Movement tuning
    this.walkSpeed = 6.0;
    this.sprintSpeeds = [0, 9.0, 12.0, 15.0, 18.0]; // stages 1..4
    this.accelGround = 40.0;
    this.accelAir = 12.0;
    this.friction = 10.0;
    this.gravity = 26.0;
    this.jumpSpeed = 8.5;

    // Crouch / slide
    this.isCrouching = false;
    this.slideFriction = 2.5;
    this.crouchHeightFactor = 0.65;

    // Sprint stages logic
    this.sprintStage = 0;     // 0 none, 1..4 stages
    this.sprintHeld = false;
    this.lastShiftUpAt = -999;
    this.shiftChainWindow = 2.0;

    // Grounded
    this.grounded = false;

    // Input
    this.keys = new Set();
    this.pointerLocked = false;
    this.altHeld = false;
    this.rmbHeld = false;

    // Orbit drag when Alt+RMB
    this.orbitYaw = 0;
    this.orbitPitch = -0.20;

    // Mouse sensitivity
    this.sens = 0.0025;

    this._bindEvents();
    this._syncCharacter();
  }

  _bindEvents() {
    const onKeyDown = (e) => {
      if (e.code === "AltLeft" || e.code === "AltRight") this.altHeld = true;
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
      if (e.code === "AltLeft" || e.code === "AltRight") this.altHeld = false;
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
        this.sprintHeld = false;
        this.lastShiftUpAt = performance.now() / 1000;
      }
      if (e.code === "ControlLeft" || e.code === "ControlRight") {
        this.isCrouching = false;
      }
      this.keys.delete(e.code);
    };

    const onMouseDown = (e) => {
      if (e.button === 2) this.rmbHeld = true; // RMB
      // If not Alt, clicking canvas should lock pointer for aim mode
      if (!this.altHeld && e.button === 0) {
        this.domElement.requestPointerLock?.();
      }
    };

    const onMouseUp = (e) => {
      if (e.button === 2) this.rmbHeld = false;
    };

    const onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.domElement;
      // cursor changes
      this.domElement.style.cursor = this.pointerLocked ? "none" : (this.altHeld ? "default" : "crosshair");
    };

    const onMouseMove = (e) => {
      const dx = e.movementX || 0;
      const dy = e.movementY || 0;

      // Alt shows cursor; orbit only when Alt+RMB
      if (this.altHeld && this.rmbHeld) {
        this.orbitYaw -= dx * this.sens;
        this.orbitPitch -= dy * this.sens;
        this.orbitPitch = clamp(this.orbitPitch, -1.2, 0.35);
        return;
      }

      if (!this.pointerLocked) return;

      // Aim mode controls yaw/pitch (camera crosshair)
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
  }

  _onShiftDown() {
    const t = performance.now() / 1000;
    const dtSinceUp = t - this.lastShiftUpAt;

    if (dtSinceUp <= this.shiftChainWindow) {
      this.sprintStage = Math.min(4, Math.max(1, this.sprintStage + 1));
    } else {
      this.sprintStage = 1;
    }
  }

  _tryJump() {
    if (!this.grounded) return;
    // jump carries horizontal momentum
    this.vel.y = this.jumpSpeed;
    this.grounded = false;
  }

  update(dt) {
    // derive desired move direction relative to camera/aim yaw (or orbit yaw if alt+rmb)
    const forward = (this.pointerLocked || (!this.altHeld)) ? this.yaw : this.yaw; // keep consistent
    const camYaw = (this.altHeld && this.rmbHeld) ? this.orbitYaw : forward;

    const fwd = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
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

    // target speed
    let targetSpeed = this.walkSpeed;
    const sprintActive = this.sprintHeld && this.sprintStage > 0;
    if (sprintActive) targetSpeed = this.sprintSpeeds[this.sprintStage];

    // crouch affects speed and friction
    const crouch = this.isCrouching;
    const crouchSpeedFactor = crouch ? 0.75 : 1.0;
    targetSpeed *= crouchSpeedFactor;

    // acceleration & friction
    const accel = this.grounded ? this.accelGround : this.accelAir;
    const fric = (crouch && this.grounded) ? this.slideFriction : this.friction;

    // accelerate toward desired horizontal velocity
    const desiredVel = new THREE.Vector3().copy(this.move).multiplyScalar(targetSpeed);

    // current horizontal velocity
    const hv = new THREE.Vector3(this.vel.x, 0, this.vel.z);

    // apply friction (only on ground)
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

    // accelerate
    const delta = desiredVel.sub(hv);
    const maxChange = accel * dt;
    if (delta.length() > maxChange) delta.setLength(maxChange);
    this.vel.x += delta.x;
    this.vel.z += delta.z;

    // gravity
    this.vel.y -= this.gravity * dt;

    // integrate position
    this.pos.addScaledVector(this.vel, dt);

    // simple ground collision
    const groundY = this.getGroundHeightAt(this.pos.x, this.pos.z);
    const charHalfHeight = 0.9; // placeholder capsule half height
    const footY = this.pos.y - charHalfHeight;

    if (footY <= groundY) {
      this.pos.y = groundY + charHalfHeight;
      if (this.vel.y < 0) this.vel.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    // character facing
    // When aiming (pointer locked), body faces aim yaw, otherwise it faces movement direction if moving
    let bodyYaw = this.yaw;
    if (!this.pointerLocked && hasMove) {
      bodyYaw = Math.atan2(this.move.x, this.move.z) + camYaw;
    }
    this.characterRoot.rotation.y = bodyYaw;

    // head aim relative to body (simple)
    this.headYaw = THREE.MathUtils.euclideanModulo(this.yaw - bodyYaw + Math.PI, Math.PI * 2) - Math.PI;
    this.headPitch = this.pitch;

    // camera smooth distance
    this.camDist = damp(this.camDist, this.camTargetDist, 10.0, dt);

    // camera pose
    const useOrbit = this.altHeld && this.rmbHeld;
    const yawUsed = useOrbit ? this.orbitYaw : this.yaw;
    const pitchUsed = useOrbit ? this.orbitPitch : this.pitch;

    const height = this.camHeight * (this.isCrouching ? this.crouchHeightFactor : 1.0);
    const target = new THREE.Vector3(this.pos.x, this.pos.y + height, this.pos.z);

    // camera behind target
    const camBack = new THREE.Vector3(
      Math.sin(yawUsed) * Math.cos(pitchUsed),
      Math.sin(pitchUsed),
      Math.cos(yawUsed) * Math.cos(pitchUsed)
    );

    const camPos = new THREE.Vector3().copy(target).addScaledVector(camBack, -this.camDist);

    // smooth camera position a bit for nicer feel
    this.camera.position.lerp(camPos, 1 - Math.exp(-18.0 * dt));
    this.camera.lookAt(target);

    this._syncCharacter();
    this._updateHud();
  }

  _syncCharacter() {
    this.characterRoot.position.copy(this.pos);
  }

  _updateHud() {
    if (!this.hud) return;

    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.hud.speed.textContent = `Speed: ${speed.toFixed(1)}`;
    this.hud.sprint.textContent = `Sprint: ${this.sprintHeld ? this.sprintStage : 0}`;
    const mode =
      (this.altHeld && this.rmbHeld) ? "orbit" :
      (this.pointerLocked ? "aim" : "free");
    this.hud.mode.textContent = `Mode: ${mode}`;
  }
}
