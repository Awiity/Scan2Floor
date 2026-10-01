/**
 * PointCloud — fetches preprocessed binary from /api/pointcloud and renders
 * as a Three.js Points object (already Y-up and centred by preprocess.py).
 *
 * Binary format: [uint32 N][float32 N*3 positions][uint8 N*3 colors]
 *
 * Features:
 *   - Classifies 3D points: Walls -> wallColor, Floor & Ceiling -> floorColor
 *   - Room highlighting: When a room is selected, a DENSE subset is fetched from
 *     /api/pointcloud/room (all 1%-cloud points in the room bbox = ~10x spatial
 *     density vs. the global sparse view).  Outside points are dimmed to 15%.
 *   - Floor-accurate clipping planes based on actual storey elevation.
 */

import { useEffect, useRef, useState, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE   from 'three'

/** Parse a CSS hex color string (#rrggbb or #rgb) to [r, g, b] in 0..1 range. */
function hexToRgb(hex) {
  const h = hex.replace('#', '')
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16) / 255,
      parseInt(h[1] + h[1], 16) / 255,
      parseInt(h[2] + h[2], 16) / 255,
    ]
  }
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ]
}

/**
 * Classifies point cloud points into:
 *   - Vertical walls   -> wallColor
 *   - Horizontal floors & ceilings -> floorColor
 */
function classifyAndColorPoints(posData, N, floorLevels, wallColor, floorColor) {
  const colData = new Float32Array(N * 3)
  const levels = (floorLevels && floorLevels.length > 0)
    ? [...floorLevels].sort((a, b) => a - b)
    : [-1.51, 1.04, 4.19]

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

  const [wallR, wallG, wallB]    = hexToRgb(wallColor  || '#f5f5f5')
  const [greenR, greenG, greenB] = hexToRgb(floorColor || '#2ed16b')

  for (let i = 0; i < N; i++) {
    const x = posData[i * 3]
    const y = posData[i * 3 + 1]
    const z = posData[i * 3 + 2]
    const key = `${Math.round(x * 5)},${Math.round(z * 5)}`
    const colMin  = cellMinY.get(key) ?? y
    const colMax  = cellMaxY.get(key) ?? y
    const colSpan = colMax - colMin

    let floorIdx = 0
    for (let k = 0; k < levels.length; k++) {
      if (y >= levels[k] - 0.25) floorIdx = k
    }
    const floorY = levels[floorIdx]
    const ceilY  = (floorIdx < levels.length - 1) ? levels[floorIdx + 1] : (floorY + 2.8)

    const isFloor = Math.abs(y - floorY) < 0.20 && (colSpan < 1.0 || y < floorY + 0.08)
    const isCeil  = Math.abs(y - ceilY)  < 0.25 && (colSpan < 1.0 || y > ceilY  - 0.08)

    if (isFloor || isCeil) {
      colData[i * 3] = greenR; colData[i * 3 + 1] = greenG; colData[i * 3 + 2] = greenB
    } else {
      colData[i * 3] = wallR;  colData[i * 3 + 1] = wallG;  colData[i * 3 + 2] = wallB
    }
  }
  return colData
}

const DEFAULT_WALL_COLOR  = '#f5f5f5'
const DEFAULT_FLOOR_COLOR = '#2ed16b'

export default function PointCloud({
  modelInfo, activeFloor, onLoadStart, onLoaded, reloadKey, highlightedRoom,
  wallColor = DEFAULT_WALL_COLOR, floorColor = DEFAULT_FLOOR_COLOR,
}) {
  const [points, setPoints] = useState(null)
  const { camera } = useThree()
  const mounted    = useRef(true)

  // Global 1% cloud
  useEffect(() => {
    mounted.current = true
    onLoadStart?.()
    const url = reloadKey ? `/api/pointcloud?v=${encodeURIComponent(reloadKey)}` : '/api/pointcloud'
    fetch(url)
      .then(r => { if (!r.ok) throw new Error('not ready'); return r.arrayBuffer() })
      .then(buf => {
        if (!mounted.current) return
        const view = new DataView(buf)
        const N    = view.getUint32(0, true)
        const posData = new Float32Array(buf, 4, N * 3)
        const colData = classifyAndColorPoints(posData, N, modelInfo?.floor_levels, wallColor, floorColor)
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(posData, 3))
        geo.setAttribute('color',    new THREE.BufferAttribute(colData, 3))
        geo.computeBoundingBox()
        const box = geo.boundingBox, centre = new THREE.Vector3(), size = new THREE.Vector3()
        box.getCenter(centre); box.getSize(size)
        const maxDim = Math.max(size.x, size.y, size.z)
        camera.position.set(maxDim * 0.8, maxDim * 0.6, maxDim * 0.8)
        camera.lookAt(centre); camera.updateProjectionMatrix()
        setPoints(geo); onLoaded?.(N)
      })
      .catch(err => { console.warn('PointCloud load error:', err); onLoaded?.(0) })
    return () => { mounted.current = false }
  }, [reloadKey, wallColor, floorColor]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!points) return
    const posAttr = points.getAttribute('position'), colAttr = points.getAttribute('color')
    if (!posAttr || !colAttr) return
    const newColors = classifyAndColorPoints(posAttr.array, posAttr.count, modelInfo?.floor_levels, wallColor, floorColor)
    colAttr.array.set(newColors); colAttr.needsUpdate = true
  }, [modelInfo?.floor_levels, wallColor, floorColor, points])

  // Dense room geometry — fetched from /api/pointcloud/room when a room is selected
  const [roomGeo, setRoomGeo] = useState(null)

  useEffect(() => {
    setRoomGeo(null)
    if (!highlightedRoom?.bbox) return

    const { x_min, x_max, z_min, z_max } = highlightedRoom.bbox
    const levels    = modelInfo?.floor_levels ?? []
    const roomFloor = typeof highlightedRoom.floor_idx === 'number' ? highlightedRoom.floor_idx
                    : (typeof activeFloor === 'number' ? activeFloor : 0)
    const floorY = levels.length > roomFloor && levels[roomFloor] != null ? levels[roomFloor] : roomFloor * 2.8
    const nextY  = levels.length > roomFloor + 1 && levels[roomFloor + 1] != null ? levels[roomFloor + 1] : floorY + 2.8

    const params = new URLSearchParams({
      xmin: x_min, xmax: x_max, zmin: z_min, zmax: z_max,
      ymin: floorY - 0.3, ymax: nextY - 0.1, pad: 0.35,
    })
    const controller = new AbortController()

    fetch(`/api/pointcloud/room?${params}`, { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error('unavailable'); return r.arrayBuffer() })
      .then(buf => {
        if (controller.signal.aborted) return
        const M = new DataView(buf).getUint32(0, true)
        if (M === 0) return
        const posData = new Float32Array(buf, 4, M * 3)
        const colData = classifyAndColorPoints(posData, M, modelInfo?.floor_levels, wallColor, floorColor)
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(posData.slice(), 3))
        geo.setAttribute('color',    new THREE.BufferAttribute(colData, 3))
        setRoomGeo(geo)
      })
      .catch(err => { if (err.name !== 'AbortError') console.warn('Dense room cloud:', err) })

    return () => controller.abort()
  }, [highlightedRoom, activeFloor, modelInfo, wallColor, floorColor]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!roomGeo) return
    const posAttr = roomGeo.getAttribute('position'), colAttr = roomGeo.getAttribute('color')
    if (!posAttr || !colAttr) return
    const newColors = classifyAndColorPoints(posAttr.array, posAttr.count, modelInfo?.floor_levels, wallColor, floorColor)
    colAttr.array.set(newColors); colAttr.needsUpdate = true
  }, [modelInfo?.floor_levels, wallColor, floorColor, roomGeo])

  const matRef          = useRef(null)
  const highlightMatRef = useRef(null)

  const clippingPlanes = useMemo(() => {
    if (activeFloor === 'all' || !modelInfo?.floor_levels) return []
    const levels = modelInfo.floor_levels
    const i = typeof activeFloor === 'number' ? activeFloor : 0
    const planes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -(levels[i] - 0.2))]
    if (i < levels.length - 1) planes.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), levels[i + 1] - 0.2))
    return planes
  }, [activeFloor, modelInfo])

  // Fallback clip planes (used only while roomGeo is loading)
  const roomClipPlanes = useMemo(() => {
    if (!highlightedRoom?.bbox) return null
    const { x_min, x_max, z_min, z_max } = highlightedRoom.bbox
    const pad       = 0.35
    const roomFloor = typeof highlightedRoom.floor_idx === 'number' ? highlightedRoom.floor_idx
                    : (typeof activeFloor === 'number' ? activeFloor : 0)
    const levels     = modelInfo?.floor_levels ?? []
    const floorY     = (levels.length > roomFloor && levels[roomFloor] != null) ? levels[roomFloor] : roomFloor * 2.8
    const nextFloorY = (levels.length > roomFloor + 1 && levels[roomFloor + 1] != null) ? levels[roomFloor + 1] : floorY + 2.8
    return [
      new THREE.Plane(new THREE.Vector3(0,  1, 0), -(floorY     - 0.25)),
      new THREE.Plane(new THREE.Vector3(0, -1, 0),  (nextFloorY - 0.15)),
      new THREE.Plane(new THREE.Vector3( 1, 0, 0), -(x_min - pad)),
      new THREE.Plane(new THREE.Vector3(-1, 0, 0),  (x_max + pad)),
      new THREE.Plane(new THREE.Vector3(0, 0,  1), -(z_min - pad)),
      new THREE.Plane(new THREE.Vector3(0, 0, -1),  (z_max + pad)),
    ]
  }, [highlightedRoom, activeFloor, modelInfo])

  useEffect(() => {
    if (matRef.current)          matRef.current.needsUpdate          = true
    if (highlightMatRef.current) highlightMatRef.current.needsUpdate = true
  }, [clippingPlanes, roomClipPlanes])

  if (!points) return null

  const hasRoomHighlight = highlightedRoom?.bbox != null

  return (
    <group>
      {/* Global cloud — dimmed when a room is selected */}
      <points>
        <primitive object={points} attach="geometry" />
        <pointsMaterial ref={matRef} attach="material"
          size={0.06} vertexColors sizeAttenuation transparent
          opacity={hasRoomHighlight ? 0.15 : 0.85}
          clippingPlanes={clippingPlanes}
        />
      </points>

      {/* Dense room overlay */}
      {hasRoomHighlight && (
        roomGeo
          ? (
            <points key={`room-dense-${highlightedRoom.id}`}>
              <primitive object={roomGeo} attach="geometry" />
              <pointsMaterial ref={highlightMatRef} attach="material"
                size={0.07} vertexColors sizeAttenuation transparent opacity={1.0}
              />
            </points>
          ) : (
            <points>
              <primitive object={points} attach="geometry" />
              <pointsMaterial ref={highlightMatRef} attach="material"
                size={0.08} vertexColors sizeAttenuation transparent opacity={1.0}
                clippingPlanes={roomClipPlanes ?? []}
              />
            </points>
          )
      )}
    </group>
  )
}
