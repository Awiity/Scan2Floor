/**
 * CameraFocuser.jsx
 *
 * Manages smooth camera transitions and First-Person View (FPV / 360° Look-Around):
 *   1. Room selection focus: smooth entry inside selected room at eye level.
 *   2. Equipment / Door / Viewpoint FPV (`fpvRequest`): places camera at standing eye
 *      position (`eyePos`), points directly at `lookAtPos`, and pulls OrbitControls
 *      target `0.12 m` in front of the eye so mouse drag rotates 360° in place.
 *   3. Interactive First-Person walk/strafe (`WASD` / Arrows, `E`/`Q` eye height,
 *      mouse wheel step forward/back along viewing direction) when `fpvMode` is active.
 */

import { useRef, useEffect } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";

const FPV_ORBIT_OFFSET = 0.12; // meters in front of camera so drag = 360° look-around
const ORBIT_RESET_DIST = 4.0;
const WALK_SPEED_MPS = 3.2;
const WALK_FAST_MPS = 6.0;
const _fpvDir = new THREE.Vector3();

function resolveFloorIdx(y, modelInfo, activeFloor) {
  if (activeFloor !== "all" && activeFloor != null) {
    const n = Number(activeFloor);
    if (Number.isFinite(n)) return n;
  }
  const levels = modelInfo?.floor_levels ?? [];
  for (let i = levels.length - 1; i >= 0; i--) {
    if (levels[i] != null && y >= Number(levels[i]) - 0.3) return i;
  }
  return 0;
}

function getFloorEyeInfo(modelInfo, activeFloor) {
  const floorIdx = activeFloor === "all" || activeFloor == null ? 0 : Number(activeFloor);
  const levels = modelInfo?.floor_levels ?? [];
  const floorY =
    levels.length > floorIdx && levels[floorIdx] != null
      ? levels[floorIdx]
      : floorIdx * 2.8;
  const nextFloorY =
    levels.length > floorIdx + 1 && levels[floorIdx + 1] != null
      ? levels[floorIdx + 1]
      : floorY + 2.8;
  const storeyH = Math.max(2.2, nextFloorY - floorY);
  const eyeY = floorY + Math.min(1.58, storeyH * 0.58);
  return { floorIdx, floorY, storeyH, eyeY };
}

export default function CameraFocuser({
  highlightedRoom,
  modelInfo,
  controlsRef,
  activeFloor,
  fpvRequest = null,
  fpvMode = false,
  fpvPoseStore = null,
}) {
  const animRef = useRef(null);
  const lastRoomIdRef = useRef(null);
  const lastFpvReqIdRef = useRef(null);
  const prevFpvModeRef = useRef(fpvMode);
  const prevActiveFloorRef = useRef(activeFloor);
  const keysRef = useRef(new Set());
  const lastPoseEmitRef = useRef({
    x: NaN,
    y: NaN,
    z: NaN,
    dirX: NaN,
    dirZ: NaN,
    floorIdx: -1,
    active: false,
    t: 0,
  });
  const { camera, gl } = useThree();

  // ── 1. Room selection focus (preserves existing one-shot behavior) ───────
  useEffect(() => {
    if (!highlightedRoom) {
      lastRoomIdRef.current = null;
      return;
    }
    const roomId =
      highlightedRoom.id ??
      highlightedRoom.label ??
      JSON.stringify(highlightedRoom.bbox);

    if (roomId === lastRoomIdRef.current) return;
    lastRoomIdRef.current = roomId;

    const controls = controlsRef?.current;
    if (!controls) return;

    const floorIdx =
      typeof highlightedRoom.floor_idx === "number"
        ? highlightedRoom.floor_idx
        : typeof activeFloor === "number"
        ? activeFloor
        : 0;

    const levels = modelInfo?.floor_levels ?? [];
    const floorY =
      levels.length > floorIdx && levels[floorIdx] != null
        ? levels[floorIdx]
        : floorIdx * 2.8;
    const nextFloorY =
      levels.length > floorIdx + 1 && levels[floorIdx + 1] != null
        ? levels[floorIdx + 1]
        : floorY + 2.8;
    const storeyH = Math.max(2.2, nextFloorY - floorY);
    const eyeY = floorY + Math.min(1.58, storeyH * 0.58);

    const bbox = highlightedRoom.bbox;
    const cx =
      typeof highlightedRoom.centroid_x === "number" &&
      !isNaN(highlightedRoom.centroid_x)
        ? highlightedRoom.centroid_x
        : bbox
        ? (bbox.x_min + bbox.x_max) / 2
        : 0;
    const cz =
      typeof highlightedRoom.centroid_z === "number" &&
      !isNaN(highlightedRoom.centroid_z)
        ? highlightedRoom.centroid_z
        : bbox
        ? (bbox.z_min + bbox.z_max) / 2
        : 0;

    const spanX = bbox ? Math.max(0.6, bbox.x_max - bbox.x_min) : 4;
    const spanZ = bbox ? Math.max(0.6, bbox.z_max - bbox.z_min) : 4;
    const offsetX = Math.min(1.1, spanX * 0.22);
    const offsetZ = Math.min(1.1, spanZ * 0.22);

    const endPos = new THREE.Vector3(cx - offsetX, eyeY, cz - offsetZ);
    const endTarget = new THREE.Vector3(
      cx + offsetX * 0.7,
      eyeY - 0.05,
      cz + offsetZ * 0.7
    );

    camera.near = 0.03;
    camera.updateProjectionMatrix();

    animRef.current = {
      startTarget: controls.target.clone(),
      endTarget,
      startPos: camera.position.clone(),
      endPos,
      t: 0,
      duration: 0.55,
    };
  }, [highlightedRoom?.id, highlightedRoom?.label, highlightedRoom?.bbox]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 2. Explicit First-Person View / Object Jump (`fpvRequest`) ─────────────
  useEffect(() => {
    if (!fpvRequest || fpvRequest.id === lastFpvReqIdRef.current) return;
    lastFpvReqIdRef.current = fpvRequest.id;

    const controls = controlsRef?.current;
    if (!controls || !fpvRequest.eyePos || !fpvRequest.lookAtPos) return;

    const eye = new THREE.Vector3(
      fpvRequest.eyePos.x,
      fpvRequest.eyePos.y,
      fpvRequest.eyePos.z
    );
    const look = new THREE.Vector3(
      fpvRequest.lookAtPos.x,
      fpvRequest.lookAtPos.y,
      fpvRequest.lookAtPos.z
    );
    const dir = new THREE.Vector3().subVectors(look, eye);
    if (dir.lengthSq() < 1e-6) {
      dir.set(0, 0, -1);
    } else {
      dir.normalize();
    }

    const endPos = eye.clone();
    const endTarget = fpvRequest.lockFpv !== false
      ? eye.clone().addScaledVector(dir, FPV_ORBIT_OFFSET)
      : look.clone();

    camera.near = 0.03;
    camera.updateProjectionMatrix();

    // Prevent toggle effect below from double-adjusting on this same render
    prevFpvModeRef.current = Boolean(fpvRequest.lockFpv !== false);

    animRef.current = {
      startTarget: controls.target.clone(),
      endTarget,
      startPos: camera.position.clone(),
      endPos,
      t: 0,
      duration: 0.5,
    };
  }, [fpvRequest, camera, controlsRef]);

  // ── 3. In-place toggle of First-Person Look-Around mode ────────────────────
  useEffect(() => {
    if (prevFpvModeRef.current === fpvMode) return;
    prevFpvModeRef.current = fpvMode;

    const controls = controlsRef?.current;
    if (!controls) return;

    // If an animation is already heading into fpvRequest, let it finish
    if (animRef.current) return;

    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();

    if (fpvMode) {
      camera.near = 0.03;
      camera.updateProjectionMatrix();

      const { floorY, storeyH, eyeY } = getFloorEyeInfo(modelInfo, activeFloor);
      const b = modelInfo?.bounds;
      const outsideHeight = camera.position.y < floorY + 0.3 || camera.position.y > floorY + storeyH - 0.1;
      const outsideXZ = Boolean(
        b && (
          camera.position.x < b.x_min - 2 ||
          camera.position.x > b.x_max + 2 ||
          camera.position.z < b.z_min - 2 ||
          camera.position.z > b.z_max + 2
        )
      );

      if (outsideHeight || outsideXZ) {
        let tx = controls.target.x;
        let tz = controls.target.z;
        if (highlightedRoom) {
          const rb = highlightedRoom.bbox;
          tx = typeof highlightedRoom.centroid_x === "number" && !Number.isNaN(highlightedRoom.centroid_x)
            ? highlightedRoom.centroid_x
            : rb ? (rb.x_min + rb.x_max) / 2 : tx;
          tz = typeof highlightedRoom.centroid_z === "number" && !Number.isNaN(highlightedRoom.centroid_z)
            ? highlightedRoom.centroid_z
            : rb ? (rb.z_min + rb.z_max) / 2 : tz;
        } else if (b) {
          const padX = Math.min(1.0, (b.x_max - b.x_min) * 0.15);
          const padZ = Math.min(1.0, (b.z_max - b.z_min) * 0.15);
          tx = Math.max(b.x_min + padX, Math.min(b.x_max - padX, tx));
          tz = Math.max(b.z_min + padZ, Math.min(b.z_max - padZ, tz));
        }

        const horizDir = new THREE.Vector3(dir.x, 0, dir.z);
        if (horizDir.lengthSq() < 1e-4) horizDir.set(0, 0, -1);
        else horizDir.normalize();

        const endPos = new THREE.Vector3(tx, eyeY, tz);
        const endTarget = endPos.clone().addScaledVector(horizDir, FPV_ORBIT_OFFSET);
        animRef.current = {
          startTarget: controls.target.clone(),
          endTarget,
          startPos: camera.position.clone(),
          endPos,
          t: 0,
          duration: 0.45,
        };
      } else {
        controls.target.copy(camera.position).addScaledVector(dir, FPV_ORBIT_OFFSET);
        controls.update();
      }
    } else {
      controls.target.copy(camera.position).addScaledVector(dir, ORBIT_RESET_DIST);
      controls.update();
    }
  }, [fpvMode, camera, controlsRef, modelInfo, activeFloor, highlightedRoom]);

  // ── 3b. Keep FPV eye height synced when switching floors ───────────────────
  useEffect(() => {
    if (prevActiveFloorRef.current === activeFloor) return;
    prevActiveFloorRef.current = activeFloor;

    if (!fpvMode || typeof activeFloor !== "number" || animRef.current) return;
    const controls = controlsRef?.current;
    if (!controls) return;

    const { eyeY } = getFloorEyeInfo(modelInfo, activeFloor);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    else dir.normalize();

    const endPos = new THREE.Vector3(camera.position.x, eyeY, camera.position.z);
    const endTarget = endPos.clone().addScaledVector(dir, FPV_ORBIT_OFFSET);
    animRef.current = {
      startTarget: controls.target.clone(),
      endTarget,
      startPos: camera.position.clone(),
      endPos,
      t: 0,
      duration: 0.35,
    };
  }, [activeFloor, fpvMode, modelInfo, camera, controlsRef]);

  // ── 4. Keyboard & Scroll-Wheel step walking in First-Person Mode ───────────
  useEffect(() => {
    if (!fpvMode) {
      keysRef.current.clear();
      if (lastPoseEmitRef.current.active) {
        lastPoseEmitRef.current.active = false;
      }
      if (fpvPoseStore?.current?.active) {
        fpvPoseStore.set({ ...fpvPoseStore.current, active: false });
      }
      return;
    }

    const onKeyDown = (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      keysRef.current.add(e.code);
    };
    const onKeyUp = (e) => {
      keysRef.current.delete(e.code);
    };
    const onBlur = () => keysRef.current.clear();

    const dom = gl?.domElement;
    const onWheel = (e) => {
      const controls = controlsRef?.current;
      if (!controls) return;
      e.preventDefault();
      e.stopPropagation();

      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();

      const step = (e.deltaY < 0 ? 1 : -1) * 0.38;
      camera.position.addScaledVector(forward, step);
      controls.target.addScaledVector(forward, step);
      controls.update();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    dom?.addEventListener("wheel", onWheel, { passive: false, capture: true });

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      dom?.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, [fpvMode, camera, controlsRef, gl, fpvPoseStore]);

  // ── 5. Per-frame animation & WASD walking ──────────────────────────────────
  useFrame((_, delta) => {
    const controls = controlsRef?.current;
    if (!controls) return;

    const syncFpvPose = (force = false) => {
      if (!fpvMode || !fpvPoseStore) return;
      camera.getWorldDirection(_fpvDir);
      let dirX = _fpvDir.x;
      let dirZ = _fpvDir.z;
      const hLen = Math.hypot(dirX, dirZ);
      if (hLen < 1e-5) {
        dirX = 0;
        dirZ = -1;
      } else {
        dirX /= hLen;
        dirZ /= hLen;
      }

      const x = camera.position.x;
      const y = camera.position.y;
      const z = camera.position.z;
      const floorIdx = resolveFloorIdx(y, modelInfo, activeFloor);
      const last = lastPoseEmitRef.current;

      const moved =
        force ||
        !last.active ||
        floorIdx !== last.floorIdx ||
        Math.abs(x - last.x) > 0.015 ||
        Math.abs(z - last.z) > 0.015 ||
        Math.abs(y - last.y) > 0.04 ||
        Math.abs(dirX - last.dirX) > 0.02 ||
        Math.abs(dirZ - last.dirZ) > 0.02;

      if (!moved) return;

      const now = performance.now();
      if (!force && last.active && now - last.t < 40) return;

      last.x = x;
      last.y = y;
      last.z = z;
      last.dirX = dirX;
      last.dirZ = dirZ;
      last.floorIdx = floorIdx;
      last.active = true;
      last.t = now;

      fpvPoseStore.set({
        x,
        y,
        z,
        dirX,
        dirZ,
        headingRad: Math.atan2(dirZ, dirX),
        floor_idx: floorIdx,
        active: true,
      });
    };

    const anim = animRef.current;
    if (anim) {
      anim.t = Math.min(1, anim.t + delta / anim.duration);
      const t = anim.t;
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      controls.target.lerpVectors(anim.startTarget, anim.endTarget, e);
      camera.position.lerpVectors(anim.startPos, anim.endPos, e);
      controls.update();

      const finished = anim.t >= 1;
      if (finished) {
        animRef.current = null;
        controls.target.copy(anim.endTarget);
        camera.position.copy(anim.endPos);
        controls.update();
      }
      if (fpvMode) syncFpvPose(finished);
      return;
    }

    if (!fpvMode) return;

    // Guard: keep OrbitControls pivot tightly anchored 0.12 m ahead of eye in FPV mode
    const pivotDist = camera.position.distanceTo(controls.target);
    if (Math.abs(pivotDist - FPV_ORBIT_OFFSET) > 0.05) {
      const guardDir = new THREE.Vector3();
      camera.getWorldDirection(guardDir);
      if (guardDir.lengthSq() < 1e-6) guardDir.set(0, 0, -1);
      else guardDir.normalize();
      controls.target.copy(camera.position).addScaledVector(guardDir, FPV_ORBIT_OFFSET);
      controls.update();
    }

    syncFpvPose(false);

    if (keysRef.current.size === 0) return;

    const keys = keysRef.current;
    const speed =
      (keys.has("ShiftLeft") || keys.has("ShiftRight")
        ? WALK_FAST_MPS
        : WALK_SPEED_MPS) * Math.min(delta, 0.1);

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();

    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const move = new THREE.Vector3();

    if (keys.has("KeyW") || keys.has("ArrowUp")) move.add(forward);
    if (keys.has("KeyS") || keys.has("ArrowDown")) move.sub(forward);
    if (keys.has("KeyD") || keys.has("ArrowRight")) move.add(right);
    if (keys.has("KeyA") || keys.has("ArrowLeft")) move.sub(right);
    if (keys.has("KeyE")) move.y += 0.65;
    if (keys.has("KeyQ")) move.y -= 0.65;

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed);
      camera.position.add(move);
      controls.target.add(move);
      controls.update();
      syncFpvPose(false);
    }
  });

  return null;
}
