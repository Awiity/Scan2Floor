import { useCallback, useMemo } from "react";
import * as THREE from "three";

export const SUPPORTED_EQUIPMENT_LABELS = [
  "hasici_pristroj",
  "svitidlo",
  "nouzove_osvetleni",
];

export const EQUIPMENT_META = {
  hasici_pristroj: { en: "Fire Extinguisher", cz: "Hasicí přístroj", icon: "🧯" },
  svitidlo: { en: "Light Fixture", cz: "Svítidlo", icon: "💡" },
  nouzove_osvetleni: { en: "Emergency Light", cz: "Nouzové osvětlení", icon: "🚨" },
};

const FE_OUTLINE_GEO = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.24, 0.62, 0.24));
const LIGHT_OUTLINE_GEO = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.94, 0.09, 0.32));
const EXIT_OUTLINE_GEO = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.40, 0.22, 0.10));

const CATEGORY_COLORS = {
  // Fire / Safety
  hasici_pristroj: "#ef4444",
  hydrant: "#ef4444",
  detektor_koure: "#f87171",
  nouzove_osvetleni: "#10b981",
  // Electrical
  rozvadec: "#f59e0b",
  zasuvka: "#fbbf24",
  vypinac: "#facc15",
  svitidlo: "#fde047",
  // HVAC / Plumbing
  radiator: "#06b6d4",
  klimatizace: "#22d3ee",
  ventilace: "#38bdf8",
  kotel: "#0284c7",
  potrubi: "#0ea5e9",
  umyvadlo: "#67e8f9",
  wc: "#0891b2",
  sprcha: "#06b6d4",
  // Openings
  dvere: "#22c55e",
  okno: "#818cf8",
  // Security / IT
  kamera: "#ec4899",
  monitor: "#f472b6",
  // Furniture / Arch
  stul: "#a78bfa",
  zidle: "#c084fc",
  skrin: "#8b5cf6",
  schody: "#94a3b8",
  zabradli: "#cbd5e1",
};

export function colorForMpLabel(label) {
  return CATEGORY_COLORS[label] || "#f97316";
}

function FireExtinguisher3DMesh({
  item,
  isSelected,
  isHovered,
  onClick,
  onHover,
  onUnhover,
}) {
  const rotY = THREE.MathUtils.degToRad(Number(item.rotation_y || 0));
  const outlineColor = isSelected ? "#ffffff" : "#f87171";

  return (
    <group
      position={[item.x, item.y, item.z]}
      rotation={[0, rotY, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.({ kind: "equipment", isPlaced: true, data: item });
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
        onHover?.({ kind: "equipment", isPlaced: true, data: item });
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "auto";
        onUnhover?.(null);
      }}
    >
      {/* Wall mounting bracket */}
      <mesh position={[0, 0.02, -0.09]}>
        <boxGeometry args={[0.09, 0.24, 0.025]} />
        <meshStandardMaterial color="#1e293b" roughness={0.5} metalness={0.6} />
      </mesh>

      {/* Main tank cylinder */}
      <mesh position={[0, 0, 0]}>
        <cylinderGeometry args={[0.085, 0.085, 0.42, 20]} />
        <meshStandardMaterial
          color="#dc2626"
          emissive={isSelected ? "#ef4444" : isHovered ? "#dc2626" : "#000000"}
          emissiveIntensity={isSelected ? 0.35 : isHovered ? 0.2 : 0}
          roughness={0.3}
          metalness={0.35}
        />
      </mesh>

      {/* Top dome */}
      <mesh position={[0, 0.21, 0]}>
        <sphereGeometry args={[0.085, 16, 12]} />
        <meshStandardMaterial color="#dc2626" roughness={0.3} metalness={0.35} />
      </mesh>

      {/* Bottom skirt */}
      <mesh position={[0, -0.20, 0]}>
        <cylinderGeometry args={[0.088, 0.088, 0.045, 20]} />
        <meshStandardMaterial color="#111827" roughness={0.6} metalness={0.2} />
      </mesh>

      {/* Front inspection label band */}
      <mesh position={[0, 0.02, 0]}>
        <cylinderGeometry args={[0.087, 0.087, 0.14, 20, 1, true, -0.9, 1.8]} />
        <meshStandardMaterial color="#f8fafc" roughness={0.45} side={THREE.DoubleSide} />
      </mesh>

      {/* Brass/chrome valve neck */}
      <mesh position={[0, 0.30, 0]}>
        <cylinderGeometry args={[0.022, 0.028, 0.055, 12]} />
        <meshStandardMaterial color="#d4af37" roughness={0.25} metalness={0.85} />
      </mesh>

      {/* Squeeze lever */}
      <mesh position={[0, 0.335, -0.02]}>
        <boxGeometry args={[0.022, 0.012, 0.10]} />
        <meshStandardMaterial color="#1f2937" roughness={0.4} metalness={0.7} />
      </mesh>

      {/* Pressure gauge disc */}
      <mesh position={[0, 0.30, 0.028]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.016, 0.016, 0.01, 12]} />
        <meshStandardMaterial color="#22c55e" emissive="#16a34a" emissiveIntensity={0.35} />
      </mesh>

      {/* Discharge hose & flared horn */}
      <mesh position={[0.095, 0.08, 0.01]}>
        <cylinderGeometry args={[0.011, 0.013, 0.30, 10]} />
        <meshStandardMaterial color="#111827" roughness={0.7} />
      </mesh>
      <mesh position={[0.095, -0.09, 0.02]}>
        <cylinderGeometry args={[0.013, 0.026, 0.09, 10]} />
        <meshStandardMaterial color="#111827" roughness={0.6} />
      </mesh>

      {/* Selection / hover wireframe outline */}
      {(isSelected || isHovered) && (
        <lineSegments geometry={FE_OUTLINE_GEO} position={[0, 0.06, 0]}>
          <lineBasicMaterial color={outlineColor} />
        </lineSegments>
      )}
    </group>
  );
}

function LightFixture3DMesh({
  item,
  isSelected,
  isHovered,
  onClick,
  onHover,
  onUnhover,
}) {
  const rotY = THREE.MathUtils.degToRad(Number(item.rotation_y || 0));
  const isEmergency = item.label === "nouzove_osvetleni";
  const outlineColor = isSelected ? "#ffffff" : isEmergency ? "#34d399" : "#fde047";

  return (
    <group
      position={[item.x, item.y, item.z]}
      rotation={[0, rotY, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.({ kind: "equipment", isPlaced: true, data: item });
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
        onHover?.({ kind: "equipment", isPlaced: true, data: item });
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "auto";
        onUnhover?.(null);
      }}
    >
      {isEmergency ? (
        <>
          <mesh>
            <boxGeometry args={[0.36, 0.18, 0.06]} />
            <meshStandardMaterial color="#f1f5f9" roughness={0.35} metalness={0.2} />
          </mesh>
          <mesh position={[0, 0, 0.004]}>
            <boxGeometry args={[0.32, 0.14, 0.065]} />
            <meshStandardMaterial
              color="#ecfdf5"
              emissive="#10b981"
              emissiveIntensity={isSelected ? 1.8 : isHovered ? 1.4 : 1.2}
              roughness={0.25}
            />
          </mesh>
          {(isSelected || isHovered) && (
            <lineSegments geometry={EXIT_OUTLINE_GEO}>
              <lineBasicMaterial color={outlineColor} />
            </lineSegments>
          )}
        </>
      ) : (
        <>
          {/* Brushed aluminium luminaire housing */}
          <mesh>
            <boxGeometry args={[0.90, 0.045, 0.28]} />
            <meshStandardMaterial color="#cbd5e1" metalness={0.5} roughness={0.35} />
          </mesh>

          {/* Glowing LED diffuser panel */}
          <mesh position={[0, -0.022, 0]}>
            <boxGeometry args={[0.84, 0.015, 0.22]} />
            <meshStandardMaterial
              color="#fef9c3"
              emissive="#fde047"
              emissiveIntensity={isSelected ? 1.8 : isHovered ? 1.4 : 1.0}
              roughness={0.2}
            />
          </mesh>

          {/* Soft downward volumetric glow cone (non-raycastable) */}
          <mesh position={[0, -0.30, 0]} raycast={() => {}}>
            <coneGeometry args={[0.48, 0.55, 20, 1, true]} />
            <meshBasicMaterial
              color="#fef08a"
              transparent
              opacity={isSelected ? 0.24 : isHovered ? 0.18 : 0.12}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>

          {(isSelected || isHovered) && (
            <lineSegments geometry={LIGHT_OUTLINE_GEO}>
              <lineBasicMaterial color={outlineColor} />
            </lineSegments>
          )}
        </>
      )}
    </group>
  );
}

/**
 * 3D Equipment Objects (placed procedural meshes + Matterport candidate hints),
 * Viewpoint Pins, Sweep Nodes, and Live 360 Camera Avatar.
 */
export default function MpObjects3D({
  instances = [],
  placedEquipment = [],
  points = [],
  sweeps = {},
  activeFloor = "all",
  showEquipment = true,
  showUnplacedHints = true,
  showSweeps = false,
  showPoints = true,
  showLivePose = true,
  hiddenLabels = [],
  labelFilter = null,
  livePose = null,
  selectedMpItem = null,
  hoveredMpItem = null,
  onSelectMpItem,
  onHoverMpItem,
}) {
  const floorNum = activeFloor === "all" || activeFloor == null ? null : Number(activeFloor);

  const onChosenFloor = useCallback(
    (item) =>
      floorNum === null
        ? item?.floor_idx != null
        : item?.floor_idx != null && Number(item.floor_idx) === floorNum,
    [floorNum]
  );

  const placedIdSet = useMemo(
    () => new Set((placedEquipment || []).map((eq) => eq.instance_id).filter(Boolean)),
    [placedEquipment]
  );

  const visiblePlaced = useMemo(() => {
    if (!showEquipment) return [];
    return (placedEquipment || []).filter((eq) => {
      if (eq?.x == null || eq?.y == null || eq?.z == null || !onChosenFloor(eq)) return false;
      if (labelFilter && eq.label !== labelFilter) return false;
      if (hiddenLabels.includes(eq.label)) return false;
      return true;
    });
  }, [placedEquipment, showEquipment, onChosenFloor, labelFilter, hiddenLabels]);

  const visibleHints = useMemo(() => {
    if (!showEquipment || !showUnplacedHints) return [];
    return (instances || []).filter((inst) => {
      if (!SUPPORTED_EQUIPMENT_LABELS.includes(inst?.label)) return false;
      if (placedIdSet.has(inst.instance_id)) return false;
      if (!(inst?.snapped_s2f_position || inst?.s2f_position) || !onChosenFloor(inst)) return false;
      if (labelFilter && inst.label !== labelFilter) return false;
      if (hiddenLabels.includes(inst.label)) return false;
      return true;
    });
  }, [instances, placedIdSet, showEquipment, showUnplacedHints, onChosenFloor, labelFilter, hiddenLabels]);

  const visiblePoints = useMemo(() => {
    if (!showPoints) return [];
    return points.filter((pt) => Boolean(pt?.s2f_position) && onChosenFloor(pt));
  }, [points, showPoints, onChosenFloor]);

  const visibleSweeps = useMemo(() => {
    if (!showSweeps) return [];
    return Object.values(sweeps || {}).filter((sw) => Boolean(sw?.s2f_position) && onChosenFloor(sw));
  }, [sweeps, showSweeps, onChosenFloor]);

  const poseVisible = useMemo(() => {
    if (!showLivePose || !livePose?.s2f_position) return false;
    return onChosenFloor(livePose);
  }, [livePose, showLivePose, onChosenFloor]);

  const cameraYawRad = useMemo(() => {
    const yawDeg = Number(livePose?.rotation?.y ?? 0);
    return THREE.MathUtils.degToRad(yawDeg);
  }, [livePose]);

  return (
    <group name="matterport-3d-overlay">
      {/* Placed 3D Equipment Models (Fire Extinguishers & Light Sources) */}
      {visiblePlaced.map((eq) => {
        const isSelected =
          (selectedMpItem?.kind === "equipment" && selectedMpItem?.data?.id === eq.id) ||
          (Boolean(eq.instance_id) &&
            selectedMpItem?.isPlaced &&
            selectedMpItem?.data?.instance_id === eq.instance_id);
        const isHovered =
          (hoveredMpItem?.kind === "equipment" && hoveredMpItem?.data?.id === eq.id) ||
          (Boolean(eq.instance_id) &&
            hoveredMpItem?.isPlaced &&
            hoveredMpItem?.data?.instance_id === eq.instance_id);

        if (eq.label === "hasici_pristroj") {
          return (
            <FireExtinguisher3DMesh
              key={eq.id || eq.instance_id}
              item={eq}
              isSelected={isSelected}
              isHovered={isHovered}
              onClick={onSelectMpItem}
              onHover={onHoverMpItem}
              onUnhover={onHoverMpItem}
            />
          );
        }
        return (
          <LightFixture3DMesh
            key={eq.id || eq.instance_id}
            item={eq}
            isSelected={isSelected}
            isHovered={isHovered}
            onClick={onSelectMpItem}
            onHover={onHoverMpItem}
            onUnhover={onHoverMpItem}
          />
        );
      })}

      {/* Unplaced Matterport Detection Hints */}
      {visibleHints.map((inst) => {
        const p = inst.snapped_s2f_position || inst.s2f_position;
        const isSelected =
          selectedMpItem?.kind === "instance" &&
          !selectedMpItem?.isPlaced &&
          selectedMpItem?.data?.instance_id === inst.instance_id;
        const isHovered =
          hoveredMpItem?.kind === "instance" &&
          !hoveredMpItem?.isPlaced &&
          hoveredMpItem?.data?.instance_id === inst.instance_id;
        const baseColor = colorForMpLabel(inst.label);
        const scale = isSelected ? 1.35 : isHovered ? 1.2 : 1.0;
        const isExtinguisher = inst.label === "hasici_pristroj";

        return (
          <group
            key={inst.instance_id}
            position={[p.x, p.y, p.z]}
            rotation={[0, THREE.MathUtils.degToRad(Number(inst.rotation_y || 0)), 0]}
            scale={scale}
          >
            <mesh
              onClick={(e) => {
                e.stopPropagation();
                onSelectMpItem?.({ kind: "instance", isPlaced: false, data: inst });
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                document.body.style.cursor = "pointer";
                onHoverMpItem?.({ kind: "instance", isPlaced: false, data: inst });
              }}
              onPointerOut={(e) => {
                e.stopPropagation();
                document.body.style.cursor = "auto";
                onHoverMpItem?.(null);
              }}
            >
              {isExtinguisher ? (
                <cylinderGeometry args={[0.10, 0.10, 0.42, 12]} />
              ) : (
                <boxGeometry args={[0.38, 0.08, 0.18]} />
              )}
              <meshStandardMaterial
                color={isSelected ? "#ffffff" : baseColor}
                emissive={baseColor}
                emissiveIntensity={isSelected ? 0.85 : isHovered ? 0.55 : 0.25}
                transparent
                opacity={isSelected ? 0.72 : 0.42}
                wireframe={!isSelected}
              />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={() => {}}>
              <ringGeometry args={[0.16, 0.22, 18]} />
              <meshBasicMaterial
                color={isSelected ? "#ffffff" : baseColor}
                transparent
                opacity={isSelected ? 0.9 : 0.55}
                side={THREE.DoubleSide}
                depthWrite={false}
              />
            </mesh>
          </group>
        );
      })}

      {/* Saved Camera Viewpoints */}
      {visiblePoints.map((pt) => {
        const p = pt.s2f_position;
        const isSelected =
          selectedMpItem?.kind === "point" && selectedMpItem?.data?.id === pt.id;
        const isHovered =
          hoveredMpItem?.kind === "point" && hoveredMpItem?.data?.id === pt.id;
        return (
          <group
            key={`pt-${pt.id}`}
            position={[p.x, p.y + 0.15, p.z]}
            scale={isSelected ? 1.4 : isHovered ? 1.2 : 1.0}
          >
            <mesh
              onClick={(e) => {
                e.stopPropagation();
                onSelectMpItem?.({ kind: "point", data: pt });
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                onHoverMpItem?.({ kind: "point", data: pt });
              }}
              onPointerOut={(e) => {
                e.stopPropagation();
                onHoverMpItem?.(null);
              }}
            >
              <octahedronGeometry args={[0.18, 0]} />
              <meshStandardMaterial
                color={isSelected ? "#ffffff" : "#38bdf8"}
                emissive="#0284c7"
                emissiveIntensity={isSelected ? 1.0 : 0.55}
              />
            </mesh>
          </group>
        );
      })}

      {/* Sweep Pucks (optional floor panorama nodes) */}
      {visibleSweeps.map((sw) => {
        const p = sw.s2f_position;
        const isSelected =
          selectedMpItem?.kind === "sweep" &&
          selectedMpItem?.data?.sweep_id === sw.sweep_id;
        return (
          <mesh
            key={`sw-${sw.sweep_id}`}
            position={[p.x, p.y - 1.25, p.z]}
            rotation={[-Math.PI / 2, 0, 0]}
            onClick={(e) => {
              e.stopPropagation();
              onSelectMpItem?.({ kind: "sweep", data: sw });
            }}
            onPointerOver={(e) => {
              e.stopPropagation();
              onHoverMpItem?.({ kind: "sweep", data: sw });
            }}
            onPointerOut={(e) => {
              e.stopPropagation();
              onHoverMpItem?.(null);
            }}
          >
            <ringGeometry args={[0.14, 0.24, 24]} />
            <meshBasicMaterial
              color={isSelected ? "#ffffff" : "#60a5fa"}
              side={THREE.DoubleSide}
              transparent
              opacity={0.78}
            />
          </mesh>
        );
      })}

      {/* Live 360° Showcase Camera Avatar */}
      {poseVisible && (
        <group
          position={[
            livePose.s2f_position.x,
            livePose.s2f_position.y,
            livePose.s2f_position.z,
          ]}
          rotation={[0, cameraYawRad, 0]}
        >
          <mesh>
            <sphereGeometry args={[0.2, 16, 16]} />
            <meshStandardMaterial
              color="#fbbf24"
              emissive="#f59e0b"
              emissiveIntensity={0.85}
            />
          </mesh>
          {/* Viewing direction cone pointing forward (-Z in Matterport yaw=0) */}
          <mesh position={[0, 0, -0.55]} rotation={[Math.PI / 2, 0, 0]}>
            <coneGeometry args={[0.32, 0.85, 18, 1, true]} />
            <meshBasicMaterial
              color="#fbbf24"
              transparent
              opacity={0.28}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        </group>
      )}
    </group>
  );
}

