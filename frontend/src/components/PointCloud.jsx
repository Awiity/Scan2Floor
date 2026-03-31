/**
 * PointCloud — fetches preprocessed binary from /api/pointcloud and renders
 * as a Three.js Points object (already Y-up and centred by preprocess.py).
 *
 * Binary format: [uint32 N][float32 N*3 positions][uint8 N*3 colors]
 */
import { useEffect, useRef, useState, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE   from 'three'

export default function PointCloud({ modelInfo, activeFloor, onLoadStart, onLoaded }) {
  const [points, setPoints] = useState(null)
  const { camera }          = useThree()
  const mounted             = useRef(true)

  useEffect(() => {
    mounted.current = true
    onLoadStart?.()

    fetch('/api/pointcloud')
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
  }, [])

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

  if (!points) return null

  return (
    <points>
      <primitive object={points} attach="geometry" />
      <pointsMaterial
        attach="material"
        size={0.06}
        vertexColors
        sizeAttenuation
        transparent
        opacity={0.85}
        clippingPlanes={clippingPlanes}
      />
    </points>
  )
}
