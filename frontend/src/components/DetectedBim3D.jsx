import { useEffect, useState, useMemo, useRef } from "react";
import * as THREE from "three";

/**
 * Geometric distance from point (px, pz) to line segment (x1, z1)-(x2, z2)
 */
function distPointToSegment(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const l2 = dx * dx + dz * dz;
  if (l2 < 1e-6) return Math.hypot(px - x1, pz - z1);
  let t = ((px - x1) * dx + (pz - z1) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projZ = z1 + t * dz;
  return Math.hypot(px - projX, pz - projZ);
}

/**
 * 3D Door Mesh Entity with frame, wooden leaf (slightly ajar), and brass handle
 */
function Door3DMesh({
  width,
  height,
  thickness = 0.20,
  isSelected,
  isHovered,
  onClick,
  onHover,
  onUnhover,
  doorEntity,
}) {
  const jambW = 0.05;
  const leafW = Math.max(0.1, width - jambW * 2);
  const leafH = Math.max(0.1, height - jambW);
  const leafThick = 0.045;
  const openAngle = Math.PI / 10; // ~18 deg ajar for architectural realism

  // Highlight colors
  const frameColor = isSelected ? "#f59e0b" : isHovered ? "#00e5ff" : "#334155";
  const leafColor = isSelected ? "#d97706" : isHovered ? "#38bdf8" : "#854d0e";
  const edgeColor = isSelected ? "#fbbf24" : isHovered ? "#a5f3fc" : "#64748b";

  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(doorEntity);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
        onHover?.(doorEntity);
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "auto";
        onUnhover?.(doorEntity);
      }}
    >
      {/* Left Frame Jamb */}
      <mesh position={[-width / 2 + jambW / 2, 0, 0]}>
        <boxGeometry args={[jambW, height, thickness + 0.01]} />
        <meshStandardMaterial color={frameColor} roughness={0.5} metalness={0.2} />
      </mesh>

      {/* Right Frame Jamb */}
      <mesh position={[width / 2 - jambW / 2, 0, 0]}>
        <boxGeometry args={[jambW, height, thickness + 0.01]} />
        <meshStandardMaterial color={frameColor} roughness={0.5} metalness={0.2} />
      </mesh>

      {/* Top Frame Jamb */}
      <mesh position={[0, height / 2 - jambW / 2, 0]}>
        <boxGeometry args={[width, jambW, thickness + 0.01]} />
        <meshStandardMaterial color={frameColor} roughness={0.5} metalness={0.2} />
      </mesh>

      {/* Door Leaf (hinged near left jamb, slightly ajar) */}
      <group position={[-width / 2 + jambW, -jambW / 2, 0]} rotation={[0, openAngle, 0]}>
        <mesh position={[leafW / 2, 0, 0]}>
          <boxGeometry args={[leafW, leafH, leafThick]} />
          <meshStandardMaterial color={leafColor} roughness={0.4} metalness={0.1} />
        </mesh>

        {/* Door Handle (brass / metallic lever) */}
        <group position={[leafW - 0.08, -leafH / 2 + 1.0, leafThick / 2 + 0.02]}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.012, 0.012, 0.04, 12]} />
            <meshStandardMaterial color="#f59e0b" metalness={0.9} roughness={0.2} />
          </mesh>
          <mesh position={[0.04, 0, 0.02]}>
            <boxGeometry args={[0.09, 0.018, 0.018]} />
            <meshStandardMaterial color="#f59e0b" metalness={0.9} roughness={0.2} />
          </mesh>
        </group>
      </group>

      {/* Selected / Hovered outline box */}
      {(isSelected || isHovered) && (
        <lineSegments>
          <edgesGeometry args={[new THREE.BoxGeometry(width + 0.02, height + 0.02, thickness + 0.04)]} />
          <lineBasicMaterial color={edgeColor} linewidth={2} />
        </lineSegments>
      )}
    </group>
  );
}

/**
 * 3D Window Mesh Entity with sleek aluminium frame, glass pane, and mullion bars
 */
function Window3DMesh({
  width,
  height,
  thickness = 0.20,
  isSelected,
  isHovered,
  onClick,
  onHover,
  onUnhover,
  windowEntity,
}) {
  const frameW = 0.045;
  const glassW = Math.max(0.1, width - frameW * 2);
  const glassH = Math.max(0.1, height - frameW * 2);

  const frameColor = isSelected ? "#f59e0b" : isHovered ? "#00e5ff" : "#1e293b";
  const edgeColor = isSelected ? "#fbbf24" : isHovered ? "#a5f3fc" : "#38bdf8";

  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(windowEntity);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
        onHover?.(windowEntity);
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "auto";
        onUnhover?.(windowEntity);
      }}
    >
      {/* Outer Aluminium Frame */}
      {/* Left */}
      <mesh position={[-width / 2 + frameW / 2, 0, 0]}>
        <boxGeometry args={[frameW, height, thickness + 0.01]} />
        <meshStandardMaterial color={frameColor} roughness={0.3} metalness={0.6} />
      </mesh>
      {/* Right */}
      <mesh position={[width / 2 - frameW / 2, 0, 0]}>
        <boxGeometry args={[frameW, height, thickness + 0.01]} />
        <meshStandardMaterial color={frameColor} roughness={0.3} metalness={0.6} />
      </mesh>
      {/* Top */}
      <mesh position={[0, height / 2 - frameW / 2, 0]}>
        <boxGeometry args={[width, frameW, thickness + 0.01]} />
        <meshStandardMaterial color={frameColor} roughness={0.3} metalness={0.6} />
      </mesh>
      {/* Bottom (Sill frame) */}
      <mesh position={[0, -height / 2 + frameW / 2, 0]}>
        <boxGeometry args={[width + 0.04, frameW, thickness + 0.04]} />
        <meshStandardMaterial color={frameColor} roughness={0.3} metalness={0.6} />
      </mesh>

      {/* Architectural Glass Pane */}
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[glassW, glassH, 0.018]} />
        <meshStandardMaterial
          color="#38bdf8"
          transparent
          opacity={0.35}
          roughness={0.08}
          metalness={0.85}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Center Vertical Mullion Bar (for wide windows) */}
      {width > 0.8 && (
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[0.03, glassH, 0.04]} />
          <meshStandardMaterial color={frameColor} roughness={0.3} metalness={0.6} />
        </mesh>
      )}

      {/* Horizontal Transom Mullion Bar (for tall windows) */}
      {height > 1.2 && (
        <mesh position={[0, height / 6, 0]}>
          <boxGeometry args={[glassW, 0.03, 0.04]} />
          <meshStandardMaterial color={frameColor} roughness={0.3} metalness={0.6} />
        </mesh>
      )}

      {/* Selected / Hovered outline box */}
      {(isSelected || isHovered) && (
        <lineSegments>
          <edgesGeometry args={[new THREE.BoxGeometry(width + 0.02, height + 0.02, thickness + 0.04)]} />
          <lineBasicMaterial color={edgeColor} linewidth={2} />
        </lineSegments>
      )}
    </group>
  );
}

/**
 * Single 3D Wall Entity with automatic opening cutouts and vertical margin headers/sills
 */
function WallMesh3D({
  wall,
  isHovered,
  isSelected,
  onHover,
  onUnhover,
  onClick,
  selectedOpening,
  hoveredOpening,
  onSelectOpening,
  onHoverOpening,
  onUnhoverOpening,
}) {
  const { id, x1, z1, x2, z2, length, height, floorY, openings = [] } = wall;

  const dx = x2 - x1;
  const dz = z2 - z1;
  const angleY = -Math.atan2(dz, dx);
  const thickness = 0.20;

  // Unit vector along wall
  const ux = length > 1e-4 ? dx / length : 1;
  const uz = length > 1e-4 ? dz / length : 0;

  // Color styling based on wall selection/hover
  let wallColor = "#3b82f6"; // BIM blue
  let wallOpacity = 0.55;
  let edgeColor = "#60a5fa";
  let edgeOpacity = 0.8;

  if (isSelected) {
    wallColor = "#f59e0b"; // vibrant amber
    wallOpacity = 0.90;
    edgeColor = "#fbbf24";
    edgeOpacity = 1.0;
  } else if (isHovered) {
    wallColor = "#00e5ff"; // bright cyan
    wallOpacity = 0.80;
    edgeColor = "#a5f3fc";
    edgeOpacity = 1.0;
  }

  // Precompute solid segments, top margin headers, bottom margin sills, and opening meshes
  const wallElements = useMemo(() => {
    if (!openings || openings.length === 0) {
      return {
        solids: [{ start: 0, end: length }],
        openingsData: [],
      };
    }

    // Sort openings along the wall by s_start
    const sortedOps = [...openings].sort((a, b) => a.s_start - b.s_start);

    const solids = [];
    const opsData = [];
    let curS = 0;

    for (const op of sortedOps) {
      const sStart = Math.max(0, Math.min(length - 0.05, op.s_start));
      const sEnd = Math.max(sStart + 0.05, Math.min(length, op.s_end));

      // Solid segment preceding this opening
      if (sStart - curS > 0.02) {
        solids.push({ start: curS, end: sStart });
      }

      // Vertical margins for this opening
      const opWidth = sEnd - sStart;
      const midS = (sStart + sEnd) / 2;

      // Top margin (header wall above door or window)
      const topMargin = Math.max(0.1, Math.min(op.top_margin ?? 0.70, height - 0.4));

      // Bottom margin (sill wall below window; doors start at floor level 0)
      const isWindow = op.type === "window";
      const bottomMargin = isWindow
        ? Math.max(0, Math.min(op.bottom_margin ?? 0.90, height - topMargin - 0.3))
        : 0;

      // Void height and vertical center
      const voidH = Math.max(0.2, height - topMargin - bottomMargin);
      const voidY = bottomMargin + voidH / 2;

      // Header block geometry
      const headerH = topMargin;
      const headerY = height - headerH / 2;

      // Sill block geometry (for window only)
      const sillH = bottomMargin;
      const sillY = sillH / 2;

      // World coordinates for the opening
      const worldX = x1 + ux * midS;
      const worldZ = z1 + uz * midS;
      const worldElevation = floorY + bottomMargin;

      const openingEntity = {
        id: op.id,
        isUser: op.isUser,
        floorIdx: wall.floorIdx,
        wallIdx: wall.wallIdx,
        type: op.type,
        width: opWidth,
        height: voidH,
        top_margin: topMargin,
        bottom_margin: bottomMargin,
        position_t: typeof op.position_t === "number" ? op.position_t : (length > 1e-4 ? midS / length : 0.5),
        wall_x1: x1,
        wall_z1: z1,
        wall_x2: x2,
        wall_z2: z2,
        wall_len: length,
        x: worldX,
        z: worldZ,
        elevation_y: worldElevation,
        raw: op.raw,
      };

      opsData.push({
        openingEntity,
        midS,
        opWidth,
        topMargin,
        headerH,
        headerY,
        hasSill: isWindow && sillH > 0.02,
        sillH,
        sillY,
        voidH,
        voidY,
      });

      curS = sEnd;
    }

    // Trailing solid segment after last opening
    if (length - curS > 0.02) {
      solids.push({ start: curS, end: length });
    }

    return { solids, openingsData: opsData };
  }, [openings, length, height, x1, z1, ux, uz, floorY, wall.floorIdx, wall.wallIdx]);

  return (
    <group
      position={[x1, floorY, z1]}
      rotation={[0, angleY, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(wall);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
        onHover?.(wall);
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "auto";
        onUnhover?.(wall);
      }}
    >
      {/* 1. Solid Wall Segments */}
      {wallElements.solids.map((seg, idx) => {
        const segLen = seg.end - seg.start;
        const segMidX = (seg.start + seg.end) / 2;
        return (
          <group key={`solid_${idx}`} position={[segMidX, height / 2, 0]}>
            <mesh>
              <boxGeometry args={[segLen, height, thickness]} />
              <meshStandardMaterial
                color={wallColor}
                transparent
                opacity={wallOpacity}
                roughness={0.35}
                metalness={0.15}
                side={THREE.DoubleSide}
              />
            </mesh>
            <lineSegments>
              <edgesGeometry args={[new THREE.BoxGeometry(segLen, height, thickness)]} />
              <lineBasicMaterial
                color={edgeColor}
                transparent
                opacity={edgeOpacity}
                linewidth={isSelected ? 2 : 1}
              />
            </lineSegments>
          </group>
        );
      })}

      {/* 2. Top Margin Wall Headers & Bottom Margin Sills around openings */}
      {wallElements.openingsData.map((op, idx) => (
        <group key={`op_margins_${idx}`}>
          {/* Header block (Top margin above opening) */}
          <group position={[op.midS, op.headerY, 0]}>
            <mesh>
              <boxGeometry args={[op.opWidth, op.headerH, thickness]} />
              <meshStandardMaterial
                color={wallColor}
                transparent
                opacity={wallOpacity}
                roughness={0.35}
                metalness={0.15}
                side={THREE.DoubleSide}
              />
            </mesh>
            <lineSegments>
              <edgesGeometry args={[new THREE.BoxGeometry(op.opWidth, op.headerH, thickness)]} />
              <lineBasicMaterial
                color={edgeColor}
                transparent
                opacity={edgeOpacity}
                linewidth={isSelected ? 2 : 1}
              />
            </lineSegments>
          </group>

          {/* Sill block (Bottom margin below window) */}
          {op.hasSill && (
            <group position={[op.midS, op.sillY, 0]}>
              <mesh>
                <boxGeometry args={[op.opWidth, op.sillH, thickness]} />
                <meshStandardMaterial
                  color={wallColor}
                  transparent
                  opacity={wallOpacity}
                  roughness={0.35}
                  metalness={0.15}
                  side={THREE.DoubleSide}
                />
              </mesh>
              <lineSegments>
                <edgesGeometry args={[new THREE.BoxGeometry(op.opWidth, op.sillH, thickness)]} />
                <lineBasicMaterial
                  color={edgeColor}
                  transparent
                  opacity={edgeOpacity}
                  linewidth={isSelected ? 2 : 1}
                />
              </lineSegments>
            </group>
          )}

          {/* 3. Interactive Door / Window 3D Entity in Void */}
          <group position={[op.midS, op.voidY, 0]}>
            {op.openingEntity.type === "door" ? (
              <Door3DMesh
                width={op.opWidth}
                height={op.voidH}
                thickness={thickness}
                doorEntity={op.openingEntity}
                isSelected={selectedOpening?.id === op.openingEntity.id}
                isHovered={hoveredOpening?.id === op.openingEntity.id}
                onClick={onSelectOpening}
                onHover={onHoverOpening}
                onUnhover={onUnhoverOpening}
              />
            ) : (
              <Window3DMesh
                width={op.opWidth}
                height={op.voidH}
                thickness={thickness}
                windowEntity={op.openingEntity}
                isSelected={selectedOpening?.id === op.openingEntity.id}
                isHovered={hoveredOpening?.id === op.openingEntity.id}
                onClick={onSelectOpening}
                onHover={onHoverOpening}
                onUnhover={onUnhoverOpening}
              />
            )}
          </group>
        </group>
      ))}
    </group>
  );
}

/**
 * Single 3D Room Floor Slab Entity
 * Accurately aligns with walls in world XZ coordinates with ZERO inversion/flip
 */
function RoomFloorMesh3D({
  room,
  floorY,
  floorIdx,
  isSelected,
  isHovered,
  onHover,
  onUnhover,
  onClick,
}) {
  const { id, area_m2, bbox, polygon } = room;

  const geomData = useMemo(() => {
    // 1. Polygon Mode: direct 3D vertex triangulation in the XZ horizontal plane
    if (polygon && polygon.length >= 3) {
      const pts2D = polygon.map((p) => new THREE.Vector2(p[0], p[1]));
      const triangles = THREE.ShapeUtils.triangulateShape(pts2D, []);
      const positions = [];

      for (const tri of triangles) {
        // [tri[0], tri[2], tri[1]] ensures normal points up (+Y) in Three.js right-handed coordinates
        for (const idx of [tri[0], tri[2], tri[1]]) {
          const p = pts2D[idx];
          positions.push(p.x, floorY + 0.015, p.y);
        }
      }

      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      g.computeVertexNormals();

      // Perimeter edge lines
      const edgePositions = [];
      for (let i = 0; i < polygon.length; i++) {
        const p1 = polygon[i];
        const p2 = polygon[(i + 1) % polygon.length];
        edgePositions.push(p1[0], floorY + 0.02, p1[1]);
        edgePositions.push(p2[0], floorY + 0.02, p2[1]);
      }
      const eg = new THREE.BufferGeometry();
      eg.setAttribute("position", new THREE.Float32BufferAttribute(edgePositions, 3));

      return { type: "polygon", geometry: g, edgeGeometry: eg };
    }

    // 2. Fallback: Bounding box rectangle slab
    if (bbox) {
      const w = Math.max(0.1, bbox.x_max - bbox.x_min);
      const d = Math.max(0.1, bbox.z_max - bbox.z_min);
      const cx = (bbox.x_min + bbox.x_max) / 2;
      const cz = (bbox.z_min + bbox.z_max) / 2;
      const bg = new THREE.BoxGeometry(w, 0.02, d);
      const eg = new THREE.EdgesGeometry(bg);

      return {
        type: "box",
        geometry: bg,
        edgeGeometry: eg,
        cx,
        cz,
      };
    }

    return null;
  }, [polygon, bbox, floorY]);

  useEffect(() => {
    return () => {
      geomData?.geometry?.dispose();
      geomData?.edgeGeometry?.dispose();
    };
  }, [geomData]);

  if (!geomData) return null;

  let floorColor = "#10b981"; // emerald for detected room floor
  let floorOpacity = 0.28;
  let edgeColor = "#34d399";
  let edgeOpacity = 0.7;

  if (isSelected) {
    floorColor = "#00e5ff"; // bright cyan when selected
    floorOpacity = 0.65;
    edgeColor = "#67e8f9";
    edgeOpacity = 1.0;
  } else if (isHovered) {
    floorColor = "#34d399";
    floorOpacity = 0.48;
    edgeColor = "#a7f3d0";
    edgeOpacity = 0.9;
  }

  const roomEntity = {
    ...room,
    floorIdx,
    floorY,
    type: "room",
  };

  if (geomData.type === "polygon") {
    return (
      <group
        position={[0, 0, 0]}
        rotation={[0, 0, 0]}
        onClick={(e) => {
          e.stopPropagation();
          onClick?.(roomEntity);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = "pointer";
          onHover?.(roomEntity);
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          document.body.style.cursor = "auto";
          onUnhover?.(roomEntity);
        }}
      >
        <mesh geometry={geomData.geometry}>
          <meshStandardMaterial
            color={floorColor}
            transparent
            opacity={floorOpacity}
            roughness={0.6}
            metalness={0.1}
            side={THREE.DoubleSide}
          />
        </mesh>
        {geomData.edgeGeometry && (
          <lineSegments geometry={geomData.edgeGeometry}>
            <lineBasicMaterial
              color={edgeColor}
              transparent
              opacity={edgeOpacity}
              linewidth={isSelected ? 2 : 1}
            />
          </lineSegments>
        )}
      </group>
    );
  }

  // BBox BoxGeometry fallback
  return (
    <group
      position={[geomData.cx, floorY + 0.015, geomData.cz]}
      rotation={[0, 0, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(roomEntity);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
        onHover?.(roomEntity);
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "auto";
        onUnhover?.(roomEntity);
      }}
    >
      <mesh geometry={geomData.geometry}>
        <meshStandardMaterial
          color={floorColor}
          transparent
          opacity={floorOpacity}
          roughness={0.6}
          metalness={0.1}
          side={THREE.DoubleSide}
        />
      </mesh>
      {geomData.edgeGeometry && (
        <lineSegments geometry={geomData.edgeGeometry}>
          <lineBasicMaterial
            color={edgeColor}
            transparent
            opacity={edgeOpacity}
            linewidth={isSelected ? 2 : 1}
          />
        </lineSegments>
      )}
    </group>
  );
}

/**
 * DetectedBim3D Component — Renders all detected walls, doors, windows, and floors as interactable 3D entities
 */
export default function DetectedBim3D({
  modelInfo,
  activeFloor = "all",
  dataVersion = 0,
  loadedSave = null,
  selectedRoomId = null,
  onSelectRoom,
  selectedWall = null,
  onSelectWall,
  hoveredWall = null,
  setHoveredWall,
  hoveredRoom = null,
  setHoveredRoom,
  selectedOpening = null,
  onSelectOpening,
  hoveredOpening = null,
  setHoveredOpening,
}) {
  const [wallsData, setWallsData] = useState([]);
  const [roomsData, setRoomsData] = useState([]);

  const selectedWallRef = useRef(selectedWall);
  useEffect(() => { selectedWallRef.current = selectedWall; }, [selectedWall]);

  const selectedOpeningRef = useRef(selectedOpening);
  useEffect(() => { selectedOpeningRef.current = selectedOpening; }, [selectedOpening]);

  const apiBase = loadedSave
    ? `/api/saves/${encodeURIComponent(loadedSave)}`
    : "/api";

  const floorLevels = modelInfo?.floor_levels ?? [-1.51, 1.04, 4.19];

  // Fetch walls, rooms, and openings for all relevant floors
  useEffect(() => {
    let cancelled = false;
    const numFloors = floorLevels.length > 0 ? floorLevels.length : 1;
    const floorsToFetch =
      activeFloor === "all" || activeFloor == null
        ? Array.from({ length: numFloors }, (_, i) => i)
        : [Number(activeFloor)];

    const wallPromises = floorsToFetch.map((fIdx) =>
      fetch(`${apiBase}/walls/${fIdx}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => ({ floorIdx: fIdx, data }))
        .catch(() => ({ floorIdx: fIdx, data: null }))
    );

    const roomPromises = floorsToFetch.map((fIdx) =>
      fetch(`${apiBase}/rooms/${fIdx}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => ({ floorIdx: fIdx, data }))
        .catch(() => ({ floorIdx: fIdx, data: null }))
    );

    const openingPromises = floorsToFetch.map((fIdx) =>
      fetch(`${apiBase}/openings/${fIdx}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => ({ floorIdx: fIdx, data }))
        .catch(() => ({ floorIdx: fIdx, data: null }))
    );

    Promise.all([
      Promise.all(wallPromises),
      Promise.all(roomPromises),
      Promise.all(openingPromises),
    ]).then(([wallResults, roomResults, openingResults]) => {
      if (cancelled) return;

      // 1. Collect all openings per floor
      const openingsByFloor = new Map();
      openingResults.forEach(({ floorIdx, data }) => {
        if (!data) return;
        const list = [];
        // Auto-detected openings
        if (Array.isArray(data.openings)) {
          data.openings.forEach((op, opIdx) => {
            list.push({
              id: op.id || `auto_${floorIdx}_${opIdx}`,
              isUser: false,
              floorIdx,
              type: op.type === "door" ? "door" : "window",
              width: Number(op.width) || (op.type === "door" ? 0.90 : 1.20),
              top_margin: typeof op.top_margin === "number" ? op.top_margin : 0.70,
              bottom_margin: op.type === "door" ? 0 : typeof op.bottom_margin === "number" ? op.bottom_margin : 0.90,
              x: op.x,
              z: op.z,
              wall_idx: op.wall_idx,
              wall_x1: op.wall_x1,
              wall_z1: op.wall_z1,
              wall_x2: op.wall_x2,
              wall_z2: op.wall_z2,
              u_start: op.u_start,
              u_end: op.u_end,
              raw: op,
            });
          });
        }
        // User-placed openings
        // User-placed openings
        if (Array.isArray(data.user_openings)) {
          data.user_openings.forEach((op, opIdx) => {
            const opWidth = Number(op.width ?? op.width_m) || (op.type === "door" ? 0.90 : 1.20);
            let posX = op.x;
            let posZ = op.z;
            if ((posX == null || posZ == null) && op.wall_x1 != null && op.wall_x2 != null && op.position_t != null) {
              posX = op.wall_x1 + op.position_t * (op.wall_x2 - op.wall_x1);
              posZ = op.wall_z1 + op.position_t * (op.wall_z2 - op.wall_z1);
            }
            list.push({
              id: op.id || `user_${floorIdx}_${opIdx}`,
              isUser: true,
              floorIdx,
              type: op.type === "door" ? "door" : "window",
              width: opWidth,
              width_m: opWidth,
              top_margin: typeof op.top_margin === "number" ? op.top_margin : 0.70,
              bottom_margin: op.type === "door" ? 0 : (typeof op.bottom_margin === "number" ? op.bottom_margin : 0.90),
              position_t: typeof op.position_t === "number" ? op.position_t : null,
              x: posX,
              z: posZ,
              wall_idx: op.wall_idx,
              wall_x1: op.wall_x1,
              wall_z1: op.wall_z1,
              wall_x2: op.wall_x2,
              wall_z2: op.wall_z2,
              u_start: op.u_start,
              u_end: op.u_end,
              raw: op,
            });
          });
        }
        openingsByFloor.set(floorIdx, list);
      });

      // 2. Process walls into 3D items with matched openings
      const processedWalls = [];
      wallResults.forEach(({ floorIdx, data }) => {
        if (!data || !Array.isArray(data.lines)) return;
        const floorY =
          floorLevels.length > floorIdx && floorLevels[floorIdx] != null
            ? floorLevels[floorIdx]
            : floorIdx * 2.8;
        const nextY =
          floorLevels.length > floorIdx + 1 && floorLevels[floorIdx + 1] != null
            ? floorLevels[floorIdx + 1]
            : floorY + 2.8;
        const height = Math.max(1.8, nextY - floorY);

        const floorOpenings = openingsByFloor.get(floorIdx) || [];

        data.lines.forEach((pts, wallIdx) => {
          if (!pts || pts.length < 2) return;
          const [[x1, z1], [x2, z2]] = pts;
          const length = Math.hypot(x2 - x1, z2 - z1);
          if (length < 0.05) return; // skip tiny segments

          const dx = x2 - x1;
          const dz = z2 - z1;
          const ux = dx / length;
          const uz = dz / length;

          // Find openings that belong to this wall
          const matchedOps = [];
          floorOpenings.forEach((op) => {
            const opWidth = Number(op.width ?? op.width_m) || (op.type === "door" ? 0.90 : 1.20);
            let sMid = null;

            // Strategy 1: World coordinate projection
            let posX = op.x;
            let posZ = op.z;
            if ((posX == null || posZ == null) && op.wall_x1 != null && op.wall_x2 != null && op.position_t != null) {
              posX = op.wall_x1 + op.position_t * (op.wall_x2 - op.wall_x1);
              posZ = op.wall_z1 + op.position_t * (op.wall_z2 - op.wall_z1);
            }

            if (posX != null && posZ != null) {
              const proj = (posX - x1) * ux + (posZ - z1) * uz;
              const perpDist = Math.abs((posX - x1) * (-uz) + (posZ - z1) * ux);
              if (perpDist < 0.35 && proj >= -0.30 && proj <= length + 0.30) {
                sMid = proj;
              }
            }

            // Strategy 2: If wall endpoints match stored wall endpoints
            if (sMid === null && op.wall_x1 != null && op.wall_z1 != null && op.wall_x2 != null && op.wall_z2 != null) {
              const forwardMatch =
                Math.hypot(op.wall_x1 - x1, op.wall_z1 - z1) < 0.25 &&
                Math.hypot(op.wall_x2 - x2, op.wall_z2 - z2) < 0.25;
              const reverseMatch =
                Math.hypot(op.wall_x1 - x2, op.wall_z1 - z2) < 0.25 &&
                Math.hypot(op.wall_x2 - x1, op.wall_z2 - z1) < 0.25;

              if (forwardMatch) {
                const t = typeof op.position_t === "number" ? op.position_t : 0.5;
                sMid = t * length;
              } else if (reverseMatch) {
                const t = typeof op.position_t === "number" ? 1 - op.position_t : 0.5;
                sMid = t * length;
              }
            }

            // Strategy 3: Direct wall_idx fallback if on this wall
            if (sMid === null && op.wall_idx === wallIdx) {
              if (typeof op.position_t === "number") {
                sMid = op.position_t * length;
              } else if (op.u_start != null && op.u_end != null && op.u_start <= length) {
                sMid = (op.u_start + op.u_end) / 2;
              }
            }

            if (sMid === null) return;

            const sStart = Math.max(0, sMid - opWidth / 2);
            const sEnd = Math.min(length, sMid + opWidth / 2);
            if (sEnd - sStart < 0.05) return;

            matchedOps.push({
              ...op,
              width: opWidth,
              width_m: opWidth,
              s_start: sStart,
              s_end: sEnd,
              position_t: typeof op.position_t === "number" ? op.position_t : (length > 1e-4 ? sMid / length : 0.5),
              wall_x1: x1,
              wall_z1: z1,
              wall_x2: x2,
              wall_z2: z2,
              wall_len: length,
              x: posX ?? (x1 + ux * sMid),
              z: posZ ?? (z1 + uz * sMid),
            });
          });

          processedWalls.push({
            id: `f${floorIdx}_w${wallIdx}`,
            floorIdx,
            wallIdx,
            x1,
            z1,
            x2,
            z2,
            length,
            height,
            floorY,
            openings: matchedOps,
          });
        });
      });

      // 3. Process rooms into 3D items
      const processedRooms = [];
      roomResults.forEach(({ floorIdx, data }) => {
        if (!data || !Array.isArray(data.rooms)) return;
        const floorY =
          floorLevels.length > floorIdx && floorLevels[floorIdx] != null
            ? floorLevels[floorIdx]
            : floorIdx * 2.8;

        data.rooms.forEach((rm) => {
          processedRooms.push({
            ...rm,
            floorIdx,
            floorY,
          });
        });
      });

      setWallsData(processedWalls);
      setRoomsData(processedRooms);

      // Synchronize selected wall if active
      const curWall = selectedWallRef.current;
      if (curWall) {
        let updatedWall = processedWalls.find((w) => w.id === curWall.id);
        if (!updatedWall) {
          updatedWall = processedWalls.find((w) =>
            w.floorIdx === curWall.floorIdx &&
            ((Math.hypot(w.x1 - curWall.x1, w.z1 - curWall.z1) < 0.30 && Math.hypot(w.x2 - curWall.x2, w.z2 - curWall.z2) < 0.30) ||
             (Math.hypot(w.x1 - curWall.x2, w.z1 - curWall.z2) < 0.30 && Math.hypot(w.x2 - curWall.x1, w.z2 - curWall.z1) < 0.30))
          );
        }
        onSelectWall?.(updatedWall || null);
      }

      // Synchronize selected opening if active
      const curOp = selectedOpeningRef.current;
      if (curOp) {
        let updatedOp = null;
        for (const w of processedWalls) {
          if (curOp.floorIdx != null && w.floorIdx !== curOp.floorIdx) continue;
          for (const op of (w.openings || [])) {
            const sameId = curOp.id && op.id && curOp.id === op.id;
            const samePos = op.x != null && curOp.x != null && Math.hypot(op.x - curOp.x, op.z - curOp.z) < 0.35;
            if (sameId || samePos) {
              updatedOp = { ...op, floorY: w.floorY, wallHeight: w.height };
              break;
            }
          }
          if (updatedOp) break;
        }

        if (updatedOp) {
          const topMargin = Math.max(0.1, Math.min(updatedOp.top_margin ?? 0.70, updatedOp.wallHeight - 0.4));
          const bottomMargin = updatedOp.type === "door" ? 0 : Math.max(0, Math.min(updatedOp.bottom_margin ?? 0.90, updatedOp.wallHeight - topMargin - 0.3));
          const voidH = Math.max(0.4, updatedOp.wallHeight - topMargin - bottomMargin);
          onSelectOpening?.({
            id: updatedOp.id,
            isUser: updatedOp.isUser,
            floorIdx: updatedOp.floorIdx,
            wallIdx: updatedOp.wallIdx,
            type: updatedOp.type,
            width: updatedOp.width,
            height: voidH,
            top_margin: topMargin,
            bottom_margin: bottomMargin,
            position_t: updatedOp.position_t,
            wall_x1: updatedOp.wall_x1,
            wall_z1: updatedOp.wall_z1,
            wall_x2: updatedOp.wall_x2,
            wall_z2: updatedOp.wall_z2,
            wall_len: updatedOp.wall_len,
            x: updatedOp.x,
            z: updatedOp.z,
            elevation_y: updatedOp.floorY + bottomMargin,
            raw: updatedOp.raw,
          });
        } else {
          onSelectOpening?.(null);
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeFloor, dataVersion, loadedSave, floorLevels.length]);

  return (
    <group name="detected-bim-group">
      {/* 3D Detected Walls with cutouts and doors/windows */}
      {wallsData.map((wall) => {
        const isHovered = hoveredWall?.id === wall.id;
        const isSelected = selectedWall?.id === wall.id;
        return (
          <WallMesh3D
            key={wall.id}
            wall={wall}
            isHovered={isHovered}
            isSelected={isSelected}
            onHover={setHoveredWall}
            onUnhover={() => setHoveredWall(null)}
            onClick={onSelectWall}
            selectedOpening={selectedOpening}
            hoveredOpening={hoveredOpening}
            onSelectOpening={onSelectOpening}
            onHoverOpening={setHoveredOpening}
            onUnhoverOpening={() => setHoveredOpening(null)}
          />
        );
      })}

      {/* 3D Detected Room Floors */}
      {roomsData.map((rm) => {
        const isHovered =
          hoveredRoom?.id === rm.id && hoveredRoom?.floorIdx === rm.floorIdx;
        const isSelected = selectedRoomId === rm.id;
        return (
          <RoomFloorMesh3D
            key={`rm_${rm.floorIdx}_${rm.id}`}
            room={rm}
            floorY={rm.floorY}
            floorIdx={rm.floorIdx}
            isSelected={isSelected}
            isHovered={isHovered}
            onHover={setHoveredRoom}
            onUnhover={() => setHoveredRoom(null)}
            onClick={(r) => onSelectRoom?.(r.id, rm.floorIdx, rm)}
          />
        );
      })}
    </group>
  );
}
