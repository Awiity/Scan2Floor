/**
 * TexturedMesh — Matterport photo-textured mesh layer.
 *
 * The matterpak photos (jpg atlases) are UV-mapped onto the Matterport mesh;
 * convert_textured_glb.py bakes that into mesh_textured.glb. Here it is draped
 * over the point cloud / BIM layers using the SAME Z-up → Y-up + centroid
 * transform as the point cloud (see OBJModel.jsx), so photos line up exactly
 * with detected walls, doors and windows and help verify/refine their placement.
 *
 * The mesh is never raycast, so BIM entities stay clickable through it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three";

const GLB_URL = "/api/textured-mesh";

export default function TexturedMesh({
  modelInfo,
  activeFloor,
  opacity = 0.85,
  onLoadStart,
  onProgress,
  onLoaded,
}) {
  const [obj, setObj] = useState(null);
  const [cx, cy] = modelInfo?.centroid_xy ?? [0, 0];
  const cbRef = useRef({});
  useEffect(() => {
    cbRef.current = { onLoadStart, onProgress, onLoaded };
  });

  useEffect(() => {
    let cancelled = false;
    cbRef.current.onLoadStart?.();
    new GLTFLoader().load(
      GLB_URL,
      (gltf) => {
        if (cancelled) return;
        gltf.scene.traverse((c) => {
          if (c.isMesh) {
            c.raycast = () => {}; // never block BIM picking
            const mats = Array.isArray(c.material) ? c.material : [c.material];
            mats.forEach((m) => {
              m.side = THREE.DoubleSide;
              m.transparent = true;
              m.polygonOffset = true; // sit slightly behind coplanar BIM/cloud
              m.polygonOffsetFactor = 1;
              m.polygonOffsetUnits = 1;
            });
          }
        });
        setObj(gltf.scene);
        cbRef.current.onLoaded?.();
      },
      (xhr) => {
        if (xhr.total) cbRef.current.onProgress?.(Math.round((xhr.loaded / xhr.total) * 100));
      },
      (err) => {
        console.error("TexturedMesh: failed to load", err);
        cbRef.current.onLoaded?.();
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const clippingPlanes = useMemo(() => {
    if (activeFloor === "all" || activeFloor == null || !modelInfo?.floor_levels) return [];
    const levels = modelInfo.floor_levels;
    const i = Number(activeFloor);
    const planes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -(levels[i] - 0.2))];
    if (i < levels.length - 1) {
      planes.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), levels[i + 1] - 0.2));
    }
    return planes;
  }, [activeFloor, modelInfo]);

  useEffect(() => {
    if (!obj) return;
    obj.traverse((c) => {
      if (!c.isMesh) return;
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach((m) => {
        m.opacity = opacity;
        m.depthWrite = opacity >= 0.99;
        m.clippingPlanes = clippingPlanes;
        m.needsUpdate = true;
      });
    });
  }, [obj, opacity, clippingPlanes]);

  if (!obj) return null;
  return (
    <group rotation-x={-Math.PI / 2} position={[-cx, 0, cy]} renderOrder={-1}>
      <primitive object={obj} />
    </group>
  );
}
