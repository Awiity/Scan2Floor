/**
 * CameraFocuser.jsx
 *
 * Smoothly animates OrbitControls target and camera position to place the camera
 * INSIDE the selected room at human eye level (First-Person POV).
 *
 * Features:
 *   - Fixes floor level detection so rooms on any floor level are accurately targeted.
 *   - Positions the camera inside the room bounds at human eye height (~1.6m above floor).
 *   - Sets target looking across the room so the user immediately experiences the room POV.
 *   - Adjusts near clipping plane (0.05m) to prevent nearby points from clipping.
 */

import { useRef, useEffect } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";

export default function CameraFocuser({ highlightedRoom, modelInfo, controlsRef, activeFloor }) {
  const animRef = useRef(null);
  const { camera } = useThree();

  useEffect(() => {
    if (!highlightedRoom) return;

    const controls = controlsRef?.current;
    if (!controls) return;

    // 1. Determine accurate floor index and elevation
    const floorIdx = typeof highlightedRoom.floor_idx === "number"
      ? highlightedRoom.floor_idx
      : (typeof activeFloor === "number" ? activeFloor : 0);

    const levels = modelInfo?.floor_levels ?? [];
    const floorY = (levels.length > floorIdx && levels[floorIdx] != null)
      ? levels[floorIdx]
      : (floorIdx * 2.8);
    const nextFloorY = (levels.length > floorIdx + 1 && levels[floorIdx + 1] != null)
      ? levels[floorIdx + 1]
      : (floorY + 2.8);
    const storeyH = Math.max(2.2, nextFloorY - floorY);

    // 2. Human eye level inside the room (average ~1.55m - 1.6m above floor surface)
    const eyeY = floorY + Math.min(1.58, storeyH * 0.58);

    // 3. Room 2D horizontal centroid
    const bbox = highlightedRoom.bbox;
    const cx = (typeof highlightedRoom.centroid_x === "number" && !isNaN(highlightedRoom.centroid_x))
      ? highlightedRoom.centroid_x
      : (bbox ? (bbox.x_min + bbox.x_max) / 2 : 0);
    const cz = (typeof highlightedRoom.centroid_z === "number" && !isNaN(highlightedRoom.centroid_z))
      ? highlightedRoom.centroid_z
      : (bbox ? (bbox.z_min + bbox.z_max) / 2 : 0);

    const spanX = bbox ? Math.max(0.6, bbox.x_max - bbox.x_min) : 4;
    const spanZ = bbox ? Math.max(0.6, bbox.z_max - bbox.z_min) : 4;

    // 4. Person POV: standing inside the room, looking across the room
    const offsetX = Math.min(1.1, spanX * 0.22);
    const offsetZ = Math.min(1.1, spanZ * 0.22);

    // Standing position inside the room at eye level
    const endPos = new THREE.Vector3(cx - offsetX, eyeY, cz - offsetZ);
    // Look-at target inside the room across the center at eye level
    const endTarget = new THREE.Vector3(cx + offsetX * 0.7, eyeY - 0.05, cz + offsetZ * 0.7);

    // Prevent near clipping when inside the room
    camera.near = 0.05;
    camera.updateProjectionMatrix();

    const currentTarget = controls.target.clone();
    const currentPos = camera.position.clone();

    animRef.current = {
      startTarget: currentTarget,
      endTarget,
      startPos: currentPos,
      endPos,
      t: 0,
      duration: 0.55, // smooth 550 ms transition
    };
  }, [highlightedRoom, activeFloor, modelInfo]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((_, delta) => {
    const anim = animRef.current;
    if (!anim) return;

    const controls = controlsRef?.current;
    if (!controls) return;

    anim.t = Math.min(1, anim.t + delta / anim.duration);

    // Cubic easeInOut
    const t = anim.t;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    controls.target.lerpVectors(anim.startTarget, anim.endTarget, e);
    camera.position.lerpVectors(anim.startPos, anim.endPos, e);
    controls.update();

    if (anim.t >= 1) {
      animRef.current = null;
      controls.target.copy(anim.endTarget);
      camera.position.copy(anim.endPos);
      controls.update();
    }
  });

  return null;
}
