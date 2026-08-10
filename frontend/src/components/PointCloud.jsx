/**
 * PointCloud — fetches preprocessed binary from /api/pointcloud and renders
 * as a Three.js Points object (already Y-up and centred by preprocess.py).
 *
 * Binary format: [uint32 N][float32 N*3 positions][uint8 N*3 colors]
 *
 * Room highlighting: when `highlightedRoom` is provided, points outside
 * the room's XZ bounding box are dimmed, and a bright overlay shows
 * only the room's points.
 */
import { useEffect, useRef, useState, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE   from 'three'

export default function PointCloud({ modelInfo, activeFloor, onLoadStart, onLoaded, reloadKey, highlightedRoom }) {
  const [points, setPoints] = useState(null)
  const { camera }          = useThree()
  const mounted             = useRef(true)

  useEffect(() => {
    mounted.current = true
    onLoadStart?.()

    // Append reloadKey as a cache-busting param so the browser always
    // fetches the latest pointcloud.bin after a reprocess.
    const url = reloadKey
      ? `/api/pointcloud?v=${encodeURIComponent(reloadKey)}`
      : '/api/pointcloud'

    fetch(url)
      .then(r => {
        if (!r.ok) throw new Error('Point cloud not ready')
        return r.arrayBuffer()
      })
      .then(buf => {
        if (!mounted.current) return

        const view = new DataView(buf)
        const N    = view.getUint32(0, /* littleEndian */ true)

        // Positions: offset 4, N*3 float32
        const posData = new Float32Array(buf, 4, N * 3)

        // Colors: offset 4 + N*12, N*3 uint8 → normalize to [0,1]
        const rawCol  = new Uint8Array(buf, 4 + N * 12, N * 3)
        const colData = new Float32Array(N * 3)
        for (let i = 0; i < N * 3; i++) colData[i] = rawCol[i] / 255

        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(posData, 3))
        geo.setAttribute('color',    new THREE.BufferAttribute(colData, 3))

        // Fit camera once
        geo.computeBoundingBox()
        const box    = geo.boundingBox
        const centre = new THREE.Vector3()
        box.getCenter(centre)
        const size   = new THREE.Vector3()
        box.getSize(size)
        const maxDim = Math.max(size.x, size.y, size.z)
        camera.position.set(maxDim * 0.8, maxDim * 0.6, maxDim * 0.8)
        camera.lookAt(centre)
        camera.updateProjectionMatrix()

        setPoints(geo)
        onLoaded?.(N)
      })
      .catch(err => {
        console.warn('PointCloud load error:', err)
        onLoaded?.(0)
      })

    return () => { mounted.current = false }
  }, [reloadKey])

  // Material refs to trigger needsUpdate when clipping planes change
  const matRef          = useRef(null)
  const highlightMatRef = useRef(null)

  // Floor-level clipping planes
  const clippingPlanes = useMemo(() => {
    if (activeFloor === 'all' || !modelInfo?.floor_levels) return []
    const levels = modelInfo.floor_levels
    const i = activeFloor
    const planes = []
    
    // Bottom clip (Y > min)
    const minHeight = levels[i] - 0.2 // 20cm tolerance below floor peak
    planes.push(new THREE.Plane(new THREE.Vector3(0, 1, 0), -minHeight))
    
    // Top clip (Y < max)
    if (i < levels.length - 1) {
      const maxHeight = levels[i + 1] - 0.2
      planes.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), maxHeight))
    }
    
    return planes
  }, [activeFloor, modelInfo])

  // Room highlight clipping planes — used for the bright overlay
  // Clips to the room's XZ bounding box AND Y-height storey bounds so only room points are bright.
  const roomClipPlanes = useMemo(() => {
    if (!highlightedRoom?.bbox) return null
    const { x_min, x_max, z_min, z_max } = highlightedRoom.bbox
    const pad = 0.3

    // Ensure Y-height storey clipping planes are present even when activeFloor === 'all'
    const basePlanes = [...clippingPlanes]
    if (basePlanes.length === 0 && modelInfo?.floor_levels) {
      const roomFloor = typeof highlightedRoom.floor_idx === 'number' ? highlightedRoom.floor_idx : 0
      const levels = modelInfo.floor_levels
      if (roomFloor < levels.length) {
        const minHeight = levels[roomFloor] - 0.2
        basePlanes.push(new THREE.Plane(new THREE.Vector3(0, 1, 0), -minHeight))
        if (roomFloor < levels.length - 1) {
          const maxHeight = levels[roomFloor + 1] - 0.2
          basePlanes.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), maxHeight))
        }
      }
    }

    return [
      ...basePlanes,
      // X >= x_min
      new THREE.Plane(new THREE.Vector3(1, 0, 0), -(x_min - pad)),
      // X <= x_max
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), (x_max + pad)),
      // Z >= z_min
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -(z_min - pad)),
      // Z <= z_max
      new THREE.Plane(new THREE.Vector3(0, 0, -1), (z_max + pad)),
    ]
  }, [highlightedRoom, clippingPlanes, modelInfo])

  // Force WebGL material shader uniform updates whenever clipping planes change
  useEffect(() => {
    if (matRef.current) matRef.current.needsUpdate = true
    if (highlightMatRef.current) highlightMatRef.current.needsUpdate = true
  }, [clippingPlanes, roomClipPlanes])

  if (!points) return null

  const hasRoomHighlight = roomClipPlanes != null

  return (
    <group>
      {/* Base point cloud — dimmed when a room is highlighted */}
      <points>
        <primitive object={points} attach="geometry" />
        <pointsMaterial
          ref={matRef}
          attach="material"
          size={0.06}
          vertexColors
          sizeAttenuation
          transparent
          opacity={hasRoomHighlight ? 0.18 : 0.85}
          clippingPlanes={clippingPlanes}
        />
      </points>

      {/* Bright overlay — only points inside the room bbox */}
      {hasRoomHighlight && (
        <points>
          <primitive object={points} attach="geometry" />
          <pointsMaterial
            ref={highlightMatRef}
            attach="material"
            size={0.08}
            vertexColors
            sizeAttenuation
            transparent
            opacity={1.0}
            clippingPlanes={roomClipPlanes}
          />
        </points>
      )}
    </group>
  )
}
