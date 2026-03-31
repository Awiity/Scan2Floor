/**
 * OBJModel — loads the Matterport OBJ mesh (pre-converted to GLB) from the
 * FastAPI backend and renders it in the Three.js scene, aligned with the
 * pre-processed point cloud.
 *
 * ── Coordinate system ────────────────────────────────────────────────────────
 * Both the raw OBJ/GLB and cloud.xyz use Matterport's Z-up convention:
 *   • X  — horizontal
 *   • Y  — horizontal (depth)
 *   • Z  — vertical (height)
 *
 * preprocess.py converts the point cloud to Y-up + centres it:
 *   pos_yup = (raw_x − cx,  raw_z,  −(raw_y − cy))
 *
 * We apply the identical transform to the mesh via a declarative <group>:
 *   rotation-x = −π/2   →  swaps axes: (x,y,z)_zup → (x, z, −y)_world
 *   position   = [−cx, 0, cy]  →  centres the horizontal axes
 *
 * ── Bug that was fixed ───────────────────────────────────────────────────────
 * The previous implementation used a single `notified` ref to make the
 * alignment effect run only once.  Because modelInfo (which carries
 * centroid_xy) arrives asynchronously from the backend poll, the effect often
 * fired for the first time while modelInfo was still null, silently applying
 * the fallback centroid [0, 0].  The early-return prevented the real centroid
 * from ever being used, leaving the mesh ≈ 17 m away from the point cloud.
 *
 * Fix: derive [cx, cy] directly from the modelInfo prop on every render and
 * pass them as declarative JSX props on the wrapper <group>.  React Three
 * Fiber updates the Three.js transform automatically on every re-render, so
 * the centroid is always in sync with the latest modelInfo — no mutation of
 * React state, no "run-once" guard that could block updates.
 */
import { useEffect, useRef, useMemo, useState } from "react";
import { useThree } from "@react-three/fiber";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three";

const GLB_URL = "/model/mesh.glb";

export default function OBJModel({
  modelInfo,
  activeFloor,
  onLoadStart,
  onProgress,
  onLoaded,
}) {
  const groupRef = useRef();
  const { camera } = useThree();

  // one-shot flags — never reset while the component is mounted
  const cameraFramed = useRef(false); // camera positioned once after centroid known
  const loadedFired = useRef(false); // onLoaded callback fired once

  const [obj, setObj] = useState(null);

  // ── Centroid — derived every render, no mutation required ─────────────────
  const [cx, cy] = modelInfo?.centroid_xy ?? [0, 0];

  // ── Flat grey material — created once ─────────────────────────────────────
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x99aabb,
        roughness: 0.8,
        metalness: 0.2,
        side: THREE.DoubleSide,
      }),
    [],
  );

  // ── Load GLB ───────────────────────────────────────────────────────────────
  useEffect(() => {
    onLoadStart?.();
    const loader = new GLTFLoader();
    // Cache-buster keeps the browser from serving a stale build
    const url = GLB_URL + "?v=" + Date.now();

    loader.load(
      url,
      (gltf) => {
        setObj(gltf.scene);
      },
      (xhr) => {
        const total = xhr.total || 16_674_176;
        const pct = Math.min(100, Math.round((xhr.loaded / total) * 100));
        onProgress?.(pct);
      },
      (error) => {
        console.error("OBJModel: failed to load GLB", error);
        onLoaded?.(); // unblock loading overlay on error
      },
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Apply flat material (once per GLB load) ────────────────────────────────
  useEffect(() => {
    if (!obj) return;
    obj.traverse((child) => {
      if (child.isMesh) child.material = material;
    });
  }, [obj, material]);

  // ── Signal loading done (once, as soon as GLB scene is available) ──────────
  useEffect(() => {
    if (!obj || loadedFired.current) return;
    loadedFired.current = true;
    onLoaded?.();
  }, [obj]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Frame camera once, after centroid is known ─────────────────────────────
  // We wait for modelInfo so the bounding-box centre is already in the
  // correctly-translated world position.
  useEffect(() => {
    if (!obj || !modelInfo || cameraFramed.current || !groupRef.current) return;
    cameraFramed.current = true;

    // Box3.setFromObject calls updateWorldMatrix internally, so the group's
    // rotation-x and position props (set by R3F) are already reflected.
    const box = new THREE.Box3().setFromObject(groupRef.current);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    camera.position.set(
      centre.x + maxDim * 0.8,
      maxDim * 0.6,
      centre.z + maxDim * 0.8,
    );
    camera.lookAt(centre.x, size.y * 0.3, centre.z);
    camera.updateProjectionMatrix();
  }, [obj, modelInfo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Floor clipping planes ──────────────────────────────────────────────────
  const clippingPlanes = useMemo(() => {
    if (activeFloor === "all" || !modelInfo?.floor_levels) return [];

    const levels = modelInfo.floor_levels;
    const i = activeFloor;
    const planes = [];

    // keep world-Y ≥ floor bottom  (plane normal +Y, constant = −minHeight)
    const minHeight = levels[i] - 0.2; // 20 cm tolerance below floor peak
    planes.push(new THREE.Plane(new THREE.Vector3(0, 1, 0), -minHeight));

    // keep world-Y ≤ floor top  (plane normal −Y, constant = +maxHeight)
    if (i < levels.length - 1) {
      const maxHeight = levels[i + 1] - 0.2;
      planes.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), maxHeight));
    }

    return planes;
  }, [activeFloor, modelInfo]);

  // Apply / update clipping planes on every mesh's material
  useEffect(() => {
    if (!obj) return;
    obj.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const mats = Array.isArray(child.material)
        ? child.material
        : [child.material];
      mats.forEach((m) => {
        m.clippingPlanes = clippingPlanes;
      });
    });
  }, [obj, clippingPlanes]);

  if (!obj) return null;

  // ── Render ─────────────────────────────────────────────────────────────────
  // The <group> carries the Z-up → Y-up rotation and the centroid translation
  // as declarative R3F props.  React Three Fiber synchronises these with the
  // underlying THREE.Group on every render, so the transform is always correct
  // even if modelInfo arrives after the GLB finishes loading.
  return (
    <group ref={groupRef} rotation-x={-Math.PI / 2} position={[-cx, 0, cy]}>
      <primitive object={obj} />
    </group>
  );
}
