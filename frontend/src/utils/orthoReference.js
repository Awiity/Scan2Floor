/**
 * orthoReference.js — Geo-referenced top-down orthographic reference overlays
 * for the 2D Vector Plan:
 *   1. fetchPointCloudOrtho — full-density point cloud slice PNG (floor/ceiling omitted)
 *   2. renderPhotoOrtho     — Matterport photo-textured GLB rendered top-down via WebGL
 *                             with ceiling (and optionally floor/horizontal surfaces) omitted
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const GLB_URL = "/api/textured-mesh";

let _gltfPromise = null;
let _renderer = null;

function getOffscreenRenderer() {
  if (!_renderer) {
    _renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    _renderer.localClippingEnabled = true;
    _renderer.outputColorSpace = THREE.SRGBColorSpace;
    _renderer.toneMapping = THREE.NoToneMapping;
    _renderer.setClearColor(0x000000, 0);
  }
  return _renderer;
}

function loadTexturedGltf() {
  if (!_gltfPromise) {
    _gltfPromise = new Promise((resolve, reject) => {
      new GLTFLoader().load(
        GLB_URL,
        (gltf) => {
          gltf.scene.updateMatrixWorld(true);
          resolve(gltf.scene);
        },
        undefined,
        (err) => {
          _gltfPromise = null;
          reject(err || new Error("Photo-textured mesh unavailable"));
        },
      );
    });
  }
  return _gltfPromise;
}

function decodeBlobImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

/**
 * Fetch pre-rendered orthographic point cloud PNG (floor & ceiling omitted)
 * with world XZ bounds parsed from X-Bounds-* headers.
 */
export async function fetchPointCloudOrtho(
  apiBase,
  floorIdx,
  { mode = "walls", bottomCut = 0.30, topCut = 0.35, signal } = {},
) {
  const qs = new URLSearchParams({
    mode,
    bottom_cut: Number(bottomCut).toFixed(2),
    top_cut: Number(topCut).toFixed(2),
  });
  const url = `${apiBase}/walls/${floorIdx}/pointcloud-ortho?${qs.toString()}`;
  const resp = await fetch(url, { signal });
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const errJson = await resp.json();
      if (errJson?.detail) detail = errJson.detail;
    } catch { /* ignore */ }
    throw new Error(detail);
  }

  const xMin = parseFloat(resp.headers.get("X-Bounds-XMin"));
  const xMax = parseFloat(resp.headers.get("X-Bounds-XMax"));
  const zMin = parseFloat(resp.headers.get("X-Bounds-ZMin"));
  const zMax = parseFloat(resp.headers.get("X-Bounds-ZMax"));
  if (![xMin, xMax, zMin, zMax].every(Number.isFinite)) {
    throw new Error("Point cloud ortho response missing world bounds headers");
  }

  const blob = await resp.blob();
  const image = await decodeBlobImage(blob);
  return {
    image,
    bounds: { x_min: xMin, x_max: xMax, z_min: zMin, z_max: zMax },
  };
}

/**
 * Render a geo-referenced orthographic top-down image of mesh_textured.glb
 * for a chosen floor, omitting the ceiling (and floor in "photo-walls" mode).
 */
export async function renderPhotoOrtho({
  modelInfo,
  floorIdx = 0,
  mode = "photo-walls",
  bottomCut = 0.30,
  topCut = 0.35,
  wallFlare = 0.08,
  resolution = 2048,
}) {
  const gltfScene = await loadTexturedGltf();
  const [cx, cy] = modelInfo?.centroid_xy ?? [0, 0];
  const levels = modelInfo?.floor_levels ?? [];
  const fi = Number(floorIdx) || 0;
  const floorY = fi >= 0 && fi < levels.length ? Number(levels[fi]) : fi * 2.8;
  const storeyH = Math.max(2.4, fi + 1 < levels.length ? Number(levels[fi + 1]) - floorY : 3.0);
  const ceilY = floorY + storeyH;

  const cutBottom = Math.max(0.02, Math.min(2.2, Number(bottomCut) || 0.30));
  const cutTop = Math.max(0.02, Math.min(2.2, Number(topCut) || 0.35));
  const minBandY = mode === "photo-walls" ? floorY + cutBottom : floorY - 0.20;
  const maxBandY = Math.max(minBandY + 0.40, ceilY - cutTop);
  const flareSpan = Math.max(0.30, maxBandY - (floorY + cutBottom));

  const root = new THREE.Group();
  const tempMats = [];
  const tempGeos = [];
  const vPos = new THREE.Vector3();

  let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;

  gltfScene.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    const srcGeo = child.geometry;
    const posAttr = srcGeo.getAttribute("position");
    const uvAttr = srcGeo.getAttribute("uv");
    if (!posAttr) return;

    const index = srcGeo.getIndex();
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3);
    if (triCount <= 0) return;

    const matList = Array.isArray(child.material) ? child.material : [child.material];
    const baseMat = matList[0];
    const mWorld = child.matrixWorld;

    const outPos = [];
    const outUv = [];

    const readWorldYup = (vi) => {
      vPos.fromBufferAttribute(posAttr, vi).applyMatrix4(mWorld);
      return [vPos.x - cx, vPos.z, -(vPos.y - cy)];
    };

    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

      const [ax, ay, az] = readWorldYup(i0);
      const [bx, by, bz] = readWorldYup(i1);
      const [dx_, dy_, dz_] = readWorldYup(i2);

      const minY = Math.min(ay, by, dy_);
      const maxY = Math.max(ay, by, dy_);
      if (maxY < minBandY - 0.25 || minY > maxBandY + 0.25) continue;

      // Triangle normal in Y-up space
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = dx_ - ax, e2y = dy_ - ay, e2z = dz_ - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const nLen = Math.hypot(nx, ny, nz);
      if (nLen < 1e-8) continue;

      const uny = ny / nLen;
      const triMidY = (ay + by + dy_) / 3;

      if (mode === "photo-walls") {
        // Omit floor, ceiling, and near-horizontal furniture tops
        if (Math.abs(uny) > 0.58) continue;
      } else {
        // Cutaway mode: omit downward-facing ceiling slabs & upper slab geometry
        if (uny < -0.45 && triMidY > floorY + 1.2) continue;
      }

      let pax = ax, paz = az;
      let pbx = bx, pbz = bz;
      let pcx = dx_, pcz = dz_;

      // Flare vertical wall triangles horizontally across height so photo textures
      // form a crisp ribbon visible in strict top-down orthographic projection
      if (mode === "photo-walls" && wallFlare > 0) {
        const hLen = Math.hypot(nx, nz);
        if (hLen > 1e-6) {
          const hnx = nx / hLen, hnz = nz / hLen;
          const flareOffset = (yVal) => {
            const frac = Math.max(0, Math.min(1, (yVal - (floorY + cutBottom)) / flareSpan));
            return (frac - 0.5) * wallFlare;
          };
          const oa = flareOffset(ay);
          const ob = flareOffset(by);
          const oc = flareOffset(dy_);
          pax += hnx * oa; paz += hnz * oa;
          pbx += hnx * ob; pbz += hnz * ob;
          pcx += hnx * oc; pcz += hnz * oc;
        }
      }

      outPos.push(pax, ay, paz, pbx, by, pbz, pcx, dy_, pcz);
      if (uvAttr) {
        outUv.push(
          uvAttr.getX(i0), uvAttr.getY(i0),
          uvAttr.getX(i1), uvAttr.getY(i1),
          uvAttr.getX(i2), uvAttr.getY(i2),
        );
      } else {
        outUv.push(0, 0, 0, 0, 0, 0);
      }

      xMin = Math.min(xMin, pax, pbx, pcx);
      xMax = Math.max(xMax, pax, pbx, pcx);
      zMin = Math.min(zMin, paz, pbz, pcz);
      zMax = Math.max(zMax, paz, pbz, pcz);
    }

    if (outPos.length === 0) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(outPos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(outUv, 2));
    tempGeos.push(geo);

    const basicMat = new THREE.MeshBasicMaterial({
      map: baseMat?.map || null,
      color: baseMat?.map ? 0xffffff : (baseMat?.color || 0xd4d4d8),
      side: THREE.DoubleSide,
      transparent: false,
    });
    tempMats.push(basicMat);

    root.add(new THREE.Mesh(geo, basicMat));
  });

  if (!Number.isFinite(xMin) || root.children.length === 0) {
    tempGeos.forEach((g) => g.dispose());
    tempMats.forEach((m) => m.dispose());
    throw new Error("No wall photo geometry matched this floor/cut range");
  }

  const pad = 0.25;
  xMin -= pad;
  xMax += pad;
  zMin -= pad;
  zMax += pad;

  const clipPlanes = [
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -minBandY),
    new THREE.Plane(new THREE.Vector3(0, -1, 0), maxBandY),
  ];
  tempMats.forEach((m) => {
    m.clippingPlanes = clipPlanes;
  });

  const bw = Math.max(0.5, xMax - xMin);
  const bh = Math.max(0.5, zMax - zMin);
  const width = bw >= bh ? resolution : Math.max(64, Math.round((bw / bh) * resolution));
  const height = bh > bw ? resolution : Math.max(64, Math.round((bh / bw) * resolution));

  const renderer = getOffscreenRenderer();
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);

  const scene = new THREE.Scene();
  scene.add(root);

  const cam = new THREE.OrthographicCamera(xMin, xMax, -zMin, -zMax, 0.1, 500);
  cam.position.set(0, 200, 0);
  cam.up.set(0, 0, -1);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();

  renderer.render(scene, cam);

  const copyCanvas = document.createElement("canvas");
  copyCanvas.width = width;
  copyCanvas.height = height;
  const ctx2d = copyCanvas.getContext("2d");
  ctx2d.drawImage(renderer.domElement, 0, 0);

  tempGeos.forEach((g) => g.dispose());
  tempMats.forEach((m) => m.dispose());

  return {
    image: copyCanvas,
    bounds: { x_min: xMin, x_max: xMax, z_min: zMin, z_max: zMax },
  };
}

