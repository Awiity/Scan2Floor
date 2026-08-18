/**
 * CameraFocuser.jsx
 *
 * Lives inside the R3F <Canvas>. When `highlightedRoom` changes,
 * it smoothly animates the OrbitControls target (and camera position)
 * to centre on the room's 3D centroid using useFrame.
 *
 * Animation: 450 ms easeInOut pan.
 * The camera keeps its current angle and adjusts distance to frame the room.
 */

import { useRef, useEffect } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";

export default function CameraFocuser({ highlightedRoom, modelInfo, controlsRef }) {
  const animRef = useRef(null);
  const { camera } = useThree();

  useEffect(() => {
    if (!highlightedRoom) return;

    const controls = controlsRef?.current;
    if (!controls) return;

    // 3D target: room centroid XZ, floor Y height + mid-room elevation
    const cx = highlightedRoom.centroid_x;
    const cz = highlightedRoom.centroid_z;
    const floorIdx = typeof highlightedRoom.floor_idx === "number" ? highlightedRoom.floor_idx : 0;
    const levels = modelInfo?.floor_levels;
    const floorY = levels && levels[floorIdx] != null ? levels[floorIdx] : 0;

    const endTarget = new THREE.Vector3(cx, floorY + 1.2, cz);

    // Compute desired camera distance to frame the room
    const bbox = highlightedRoom.bbox;
    const roomSpan = bbox
      ? Math.max(bbox.x_max - bbox.x_min, bbox.z_max - bbox.z_min, 4)
      : 10;
    const desiredDist = Math.max(roomSpan * 1.6, 8);

    // Keep camera angle/direction, just change distance and target
    const currentTarget = controls.target.clone();
    const currentPos = camera.position.clone();
    const offset = currentPos.clone().sub(currentTarget);
    const newOffset = offset.normalize().multiplyScalar(desiredDist);
    const endPos = endTarget.clone().add(newOffset);

    animRef.current = {
      startTarget: currentTarget,
      endTarget,
      startPos: currentPos,
      endPos,
      t: 0,
      duration: 0.45, // seconds
    };
  }, [highlightedRoom]); // eslint-disable-line react-hooks/exhaustive-deps

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

    if (anim.t >= 1) animRef.current = null;
  });

  return null;
}
