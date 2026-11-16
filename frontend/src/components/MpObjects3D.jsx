import { useMemo } from "react";
import * as THREE from "three";

const CATEGORY_COLORS = {
  // Fire / Safety
  hasici_pristroj: "#ef4444",
  hydrant: "#ef4444",
  detektor_koure: "#f87171",
  nouzove_osvetleni: "#fb7185",
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

/**
 * 3D Matterport Equipment Instances, Viewpoint Pins, Sweep Nodes, and Live 360 Camera Avatar.
 * Coordinates use backend-enriched `s2f_position` ({x, y, z} in Three.js Y-up space).
 */
export default function MpObjects3D({
  instances = [],
  points = [],
  sweeps = {},
  activeFloor = "all",
  showEquipment = true,
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

  const onChosenFloor = (item) =>
    floorNum !== null && item?.floor_idx != null && Number(item.floor_idx) === floorNum;

  const visibleInstances = useMemo(() => {
    if (!showEquipment || floorNum === null) return [];
    return instances.filter((inst) => {
      if (!inst?.s2f_position || !onChosenFloor(inst)) return false;
      if (labelFilter && inst.label !== labelFilter) return false;
      if (hiddenLabels.includes(inst.label)) return false;
      return true;
    });
  }, [instances, showEquipment, floorNum, labelFilter, hiddenLabels]);

  const visiblePoints = useMemo(() => {
    if (!showPoints || floorNum === null) return [];
    return points.filter((pt) => Boolean(pt?.s2f_position) && onChosenFloor(pt));
  }, [points, showPoints, floorNum]);

  const visibleSweeps = useMemo(() => {
    if (!showSweeps || floorNum === null) return [];
    return Object.values(sweeps || {}).filter((sw) => Boolean(sw?.s2f_position) && onChosenFloor(sw));
  }, [sweeps, showSweeps, floorNum]);

  const poseVisible = useMemo(() => {
    if (!showLivePose || floorNum === null) return false;
    if (!livePose?.s2f_position) return false;
    return onChosenFloor(livePose);
  }, [livePose, showLivePose, floorNum]);

  const cameraYawRad = useMemo(() => {
    const yawDeg = Number(livePose?.rotation?.y ?? 0);
    return THREE.MathUtils.degToRad(yawDeg);
  }, [livePose]);

  return (
    <group name="matterport-3d-overlay">
      {/* Clustered Equipment Instances */}
      {visibleInstances.map((inst) => {
        const p = inst.s2f_position;
        const isSelected =
          selectedMpItem?.kind === "instance" &&
          selectedMpItem?.data?.instance_id === inst.instance_id;
        const isHovered =
          hoveredMpItem?.kind === "instance" &&
          hoveredMpItem?.data?.instance_id === inst.instance_id;
        const baseColor = colorForMpLabel(inst.label);
        const scale = isSelected ? 1.45 : isHovered ? 1.25 : 1.0;

        return (
          <group key={inst.instance_id} position={[p.x, p.y, p.z]} scale={scale}>
            <mesh
              onClick={(e) => {
                e.stopPropagation();
                onSelectMpItem?.({ kind: "instance", data: inst });
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                onHoverMpItem?.({ kind: "instance", data: inst });
              }}
              onPointerOut={(e) => {
                e.stopPropagation();
                onHoverMpItem?.(null);
              }}
            >
              <boxGeometry args={[0.2, 0.2, 0.2]} />
              <meshStandardMaterial
                color={isSelected ? "#ffffff" : baseColor}
                emissive={baseColor}
                emissiveIntensity={isSelected ? 0.9 : isHovered ? 0.65 : 0.35}
                roughness={0.35}
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

