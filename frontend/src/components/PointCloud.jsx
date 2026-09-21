/**
 * PointCloud — fetches preprocessed binary from /api/pointcloud and renders
 * as a Three.js Points object (already Y-up and centred by preprocess.py).
 *
 * Binary format: [uint32 N][float32 N*3 positions][uint8 N*3 colors]
 *
 * Features:
 *   - Classifies 3D points: Walls -> White, Floor & Ceiling -> Green
 *   - Room highlighting: When a room is selected, room points are displayed at full
 *     brightness while outside points are dimmed to 15%.
 *   - Floor-accurate clipping planes based on actual storey elevation.
 */

import { useEffect, useRef, useState, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE   from 'three'

/**
 * Classifies point cloud points into:
 *   - Vertical walls -> White
 *   - Horizontal floors & ceilings -> Green
 */
function classifyAndColorPoints(posData, N, floorLevels) {
  const colData = new Float32Array(N * 3)
  const levels = (floorLevels && floorLevels.length > 0)
    ? [...floorLevels].sort((a, b) => a - b)
    : [-1.51, 1.04, 4.19]

  // Pass 1: compute vertical span of each (X, Z) column (cell size 0.20m)
  const cellMinY = new Map()
  const cellMaxY = new Map()

  for (let i = 0; i < N; i++) {
    const x = posData[i * 3]
    const y = posData[i * 3 + 1]
    const z = posData[i * 3 + 2]
    const key = `${Math.round(x * 5)},${Math.round(z * 5)}`
    const mn = cellMinY.get(key)
    if (mn === undefined || y < mn) cellMinY.set(key, y)
    const mx = cellMaxY.get(key)
    if (mx === undefined || y > mx) cellMaxY.set(key, y)
  }

  // Colors
  const wallR = 0.96, wallG = 0.96, wallB = 0.98   // Architectural crisp white
  const greenR = 0.18, greenG = 0.82, greenB = 0.42 // Architectural emerald green

  // Pass 2: assign colors based on vertical span and height relative to floor/ceiling
  for (let i = 0; i < N; i++) {
    const x = posData[i * 3]
    const y = posData[i * 3 + 1]
    const z = posData[i * 3 + 2]
    const key = `${Math.round(x * 5)},${Math.round(z * 5)}`

    const colMin = cellMinY.get(key) ?? y
    const colMax = cellMaxY.get(key) ?? y
    const colSpan = colMax - colMin

    // Find the floor storey index for this point
    let floorIdx = 0
    for (let k = 0; k < levels.length; k++) {
      if (y >= levels[k] - 0.25) {
        floorIdx = k
      }
    }
    const floorY = levels[floorIdx]
    const ceilY = (floorIdx < levels.length - 1) ? levels[floorIdx + 1] : (floorY + 2.8)

    const distFloor = Math.abs(y - floorY)
    const distCeil  = Math.abs(y - ceilY)

    // Points close to floor level or ceiling level (and not in the middle of a continuous wall)
    const isFloor = distFloor < 0.20 && (colSpan < 1.0 || y < floorY + 0.08)
    const isCeil  = distCeil  < 0.25 && (colSpan < 1.0 || y > ceilY - 0.08)

    if (isFloor || isCeil) {
      colData[i * 3]     = greenR
      colData[i * 3 + 1] = greenG
      colData[i * 3 + 2] = greenB
    } else {
      colData[i * 3]     = wallR
      colData[i * 3 + 1] = wallG
      colData[i * 3 + 2] = wallB
    }
  }

  return colData
}

export default function PointCloud({ modelInfo, activeFloor, onLoadStart, onLoaded, reloadKey, highlightedRoom }) {
  const [points, setPoints] = useState(null)
  const { camera }          = useThree()
  const mounted             = useRef(true)

  useEffect(() => {
    mounted.current = true
    onLoadStart?.()

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

        // Classify points: Walls -> White, Floor/Ceiling -> Green
        const colData = classifyAndColorPoints(posData, N, modelInfo?.floor_levels)

        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(posData, 3))
        geo.setAttribute('color',    new THREE.BufferAttribute(colData, 3))

        // Fit camera once on initial load
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
  }, [reloadKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-classify colors whenever floor_levels become available/change
  useEffect(() => {
    if (!points || !modelInfo?.floor_levels) return
    const posAttr = points.getAttribute('position')
    const colAttr = points.getAttribute('color')
    if (!posAttr || !colAttr) return

    const N = posAttr.count
    const posData = posAttr.array
    const newColors = classifyAndColorPoints(posData, N, modelInfo.floor_levels)
    colAttr.array.set(newColors)
    colAttr.needsUpdate = true
  }, [modelInfo?.floor_levels, points])

  // Material refs to trigger needsUpdate when clipping planes change
  const matRef          = useRef(null)
  const highlightMatRef = useRef(null)

  // Floor-level clipping planes for active floor
  const clippingPlanes = useMemo(() => {
    if (activeFloor === 'all' || !modelInfo?.floor_levels) return []
    const levels = modelInfo.floor_levels
    const i = typeof activeFloor === 'number' ? activeFloor : 0
    const planes = []
    
    // Bottom clip (Y > min)
    const minHeight = levels[i] - 0.2
    planes.push(new THREE.Plane(new THREE.Vector3(0, 1, 0), -minHeight))
    
    // Top clip (Y < max)
    if (i < levels.length - 1) {
      const maxHeight = levels[i + 1] - 0.2
      planes.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), maxHeight))
    }
    
    return planes
  }, [activeFloor, modelInfo])

  // Room highlight clipping planes — used for the bright room overlay
  const roomClipPlanes = useMemo(() => {
    if (!highlightedRoom?.bbox) return null
    const { x_min, x_max, z_min, z_max } = highlightedRoom.bbox
    const pad = 0.35

    const roomFloor = typeof highlightedRoom.floor_idx === 'number'
      ? highlightedRoom.floor_idx
      : (typeof activeFloor === 'number' ? activeFloor : 0)

    const levels = modelInfo?.floor_levels ?? []
    const floorY = (levels.length > roomFloor && levels[roomFloor] != null)
      ? levels[roomFloor]
      : (roomFloor * 2.8)
    const nextFloorY = (levels.length > roomFloor + 1 && levels[roomFloor + 1] != null)
      ? levels[roomFloor + 1]
      : (floorY + 2.8)

    const minHeight = floorY - 0.25
    const maxHeight = nextFloorY - 0.15

    return [
      // Storey height clipping (floor to ceiling)
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -minHeight),
      new THREE.Plane(new THREE.Vector3(0, -1, 0), maxHeight),
      // Room perimeter XZ bounds with padding
      new THREE.Plane(new THREE.Vector3(1, 0, 0), -(x_min - pad)),
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), (x_max + pad)),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -(z_min - pad)),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), (z_max + pad)),
    ]
  }, [highlightedRoom, activeFloor, modelInfo])

  // Force WebGL material shader uniform updates whenever clipping planes change
  useEffect(() => {
    if (matRef.current) matRef.current.needsUpdate = true
    if (highlightMatRef.current) highlightMatRef.current.needsUpdate = true
  }, [clippingPlanes, roomClipPlanes])

  if (!points) return null

  const hasRoomHighlight = roomClipPlanes != null

  return (
    <group>
      {/* Base point cloud — dimmed to 15% when a room is highlighted */}
      <points>
        <primitive object={points} attach="geometry" />
        <pointsMaterial
          ref={matRef}
          attach="material"
          size={0.06}
          vertexColors
          sizeAttenuation
          transparent
          opacity={hasRoomHighlight ? 0.15 : 0.85}
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
