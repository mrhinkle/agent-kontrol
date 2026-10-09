"use client";

import { useEffect, useMemo, useRef } from "react";
import { Billboard, Line, Text } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { DoubleSide, type Mesh, type MeshStandardMaterial } from "three";
import {
  AGENT_STATUS_COLORS,
  AGENT_STATUS_LABELS,
  GIBSON_BG,
  NEUTRAL,
  platformLabel,
  platformMatchesFilters,
  type GibsonAgentOrb,
  type GibsonFilters,
  type GibsonHoverInfo,
  type GibsonMachineLabel,
  type GibsonPlatformShape,
} from "@/lib/gibson-types";
import { useSceneHover } from "./hover";
import { DOCK_SHAPE_SIZE, DOCK_SHAPE_Y, hash01, type GibsonLayout } from "./layout";

const DIM = 0.15;

/** Emissive strength per status: problems and work glow, finished work recedes. */
const EMISSIVE: Record<GibsonAgentOrb["status"], number> = {
  active: 1.25,
  waiting: 1.1,
  failed: 1.4,
  done: 0.22,
  offline: 0.06,
};

export default function AgentDocks({
  orbs,
  machines,
  layout,
  selectedOrbId = null,
  hoveredOrbId = null,
  onOrbClick,
  filters,
  onHover,
  reducedMotion = false,
}: {
  orbs: GibsonAgentOrb[];
  machines: GibsonMachineLabel[];
  layout: GibsonLayout;
  selectedOrbId?: string | null;
  hoveredOrbId?: string | null;
  onOrbClick?: (orbId: string | null) => void;
  filters?: GibsonFilters;
  onHover?: (info: GibsonHoverInfo | null) => void;
  reducedMotion?: boolean;
}) {
  return (
    <group>
      {machines.map((m) => (
        <Billboard key={m.machine} position={[m.x, m.y, m.z]}>
          <Text
            fontSize={0.5}
            color={NEUTRAL.labelMuted}
            anchorX={m.align}
            anchorY="middle"
            letterSpacing={0.12}
            outlineWidth={0.03}
            outlineColor={GIBSON_BG}
          >
            {`${m.machine.toUpperCase()} · ${m.count}`}
          </Text>
        </Billboard>
      ))}
      {orbs.map((orb) => (
        <AgentDock
          key={orb.id}
          orb={orb}
          layout={layout}
          selected={selectedOrbId === orb.id}
          hovered={hoveredOrbId === orb.id}
          onOrbClick={onOrbClick}
          filters={filters}
          onHover={onHover}
          reducedMotion={reducedMotion}
        />
      ))}
    </group>
  );
}

function ShapeGeometry({ shape }: { shape: GibsonPlatformShape }) {
  const s = DOCK_SHAPE_SIZE;
  switch (shape) {
    case "diamond":
      return <octahedronGeometry args={[s * 1.05, 0]} />;
    case "cube":
      return <boxGeometry args={[s * 1.25, s * 1.25, s * 1.25]} />;
    case "pyramid":
      return <coneGeometry args={[s * 1.0, s * 1.6, 4]} />;
    case "sphere":
      return <sphereGeometry args={[s * 0.8, 24, 24]} />;
    default:
      return <cylinderGeometry args={[s * 0.85, s * 0.85, s * 0.9, 6]} />;
  }
}

function AgentDock({
  orb,
  layout,
  selected,
  hovered,
  onOrbClick,
  filters,
  onHover,
  reducedMotion,
}: {
  orb: GibsonAgentOrb;
  layout: GibsonLayout;
  selected: boolean;
  hovered: boolean;
  onOrbClick?: (orbId: string | null) => void;
  filters?: GibsonFilters;
  onHover?: (info: GibsonHoverInfo | null) => void;
  reducedMotion: boolean;
}) {
  const shapeRef = useRef<Mesh>(null);
  const matRef = useRef<MeshStandardMaterial>(null);
  const padRef = useRef<Mesh>(null);
  const phase = useMemo(() => hash01(orb.id) * Math.PI * 2, [orb.id]);
  const color = AGENT_STATUS_COLORS[orb.status];
  const matches = platformMatchesFilters(orb.platform, filters);
  const dimmed = !selected && !matches;
  const base = EMISSIVE[orb.status] * (dimmed ? DIM : 1) * (selected || hovered ? 1.35 : 1);
  const emphasis = selected || hovered;
  const alarm = orb.status === "failed" || orb.status === "waiting";
  const tower = orb.towerId ? layout.towers.get(orb.towerId) : undefined;

  useEffect(() => {
    if (matRef.current) matRef.current.emissiveIntensity = base;
    if (shapeRef.current) shapeRef.current.scale.setScalar(1);
  }, [base, reducedMotion]);

  useFrame((state, delta) => {
    if (reducedMotion) return;
    const t = state.clock.elapsedTime;
    const mat = matRef.current;
    const mesh = shapeRef.current;
    if (!mat || !mesh) return;
    if (orb.status === "active") {
      const p = 0.5 + 0.5 * Math.sin(t * 3 + phase);
      mat.emissiveIntensity = base * (0.65 + 0.6 * p);
      mesh.scale.setScalar(1 + 0.08 * p);
      mesh.rotation.y += delta * 0.6;
    } else if (orb.status === "waiting") {
      mat.emissiveIntensity = base * (0.7 + 0.3 * Math.sin(t * 1.6 + phase));
    }
    if (padRef.current && alarm) {
      padRef.current.scale.setScalar(1 + 0.12 * (0.5 + 0.5 * Math.sin(t * 2 + phase)));
    }
  });

  const hover = useSceneHover(onHover, {
    kind: "orb",
    label: orb.label,
    sub: `${AGENT_STATUS_LABELS[orb.status]} · ${platformLabel(orb.platform)} · ${orb.machine}`,
    detail: orb.currentTask
      ? `Task #${orb.currentTask.id}: ${orb.currentTask.title}`
      : orb.summary
        ? orb.summary
        : orb.project
          ? `Project: ${orb.project}`
          : null,
    accent: color,
  });

  const handleClick = onOrbClick
    ? (e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onOrbClick(orb.id);
      }
    : undefined;

  useEffect(() => () => void (document.body.style.cursor = "auto"), []);

  const labelOpacity = dimmed ? 0.25 : orb.status === "offline" ? 0.55 : orb.status === "done" ? 0.78 : 1;
  const shapeY = DOCK_SHAPE_Y;

  return (
    <group position={[orb.dockX, 0, orb.dockZ]}>
      {/* Floor pad: status ring. Pulses for failed / waiting so problems catch the eye. */}
      <mesh ref={padRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
        <ringGeometry args={[0.95, 1.18, 48]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={dimmed ? 0.1 : orb.status === "done" ? 0.35 : orb.status === "offline" ? 0.18 : 0.85}
          side={DoubleSide}
          toneMapped={false}
        />
      </mesh>

      {/* Beacon column for anything that needs the operator. */}
      {alarm && !dimmed && (
        <mesh position={[0, 3.2, 0]}>
          <cylinderGeometry args={[0.05, 0.05, 6.4, 8]} />
          <meshBasicMaterial color={color} transparent opacity={0.45} toneMapped={false} />
        </mesh>
      )}

      <mesh ref={shapeRef} position={[0, shapeY, 0]} rotation={orb.shape === "cube" ? [0.5, 0.6, 0] : [0, 0, 0]}>
        <ShapeGeometry shape={orb.shape} />
        <meshStandardMaterial
          ref={matRef}
          color={color}
          emissive={color}
          emissiveIntensity={base}
          wireframe={orb.status === "offline"}
          roughness={0.35}
          metalness={0.1}
          transparent={dimmed}
          opacity={dimmed ? 0.4 : 1}
          toneMapped={false}
        />
      </mesh>

      {/* Neutral platform ring: identity lives in the silhouette, never in a status hue. */}
      {emphasis && (
        <mesh position={[0, shapeY, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.95, 0.03, 8, 48]} />
          <meshBasicMaterial color={NEUTRAL.select} toneMapped={false} />
        </mesh>
      )}

      {/* Generous invisible hit target: docks never move, so clicks always land. */}
      <mesh
        position={[0, shapeY - 0.3, 0]}
        onClick={handleClick}
        onPointerOver={(e) => {
          e.stopPropagation();
          if (onOrbClick) document.body.style.cursor = "pointer";
          hover.onPointerOver?.(e);
        }}
        onPointerMove={hover.onPointerMove}
        onPointerOut={(e) => {
          document.body.style.cursor = "auto";
          hover.onPointerOut?.(e);
        }}
      >
        <cylinderGeometry args={[1.25, 1.25, 3.2, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      <Billboard position={[0, shapeY + 0.85, 0]}>
        <Text
          position={[0, 0.4, 0]}
          fontSize={emphasis ? 0.62 : 0.54}
          color={NEUTRAL.label}
          anchorX="center"
          anchorY="bottom"
          fillOpacity={labelOpacity}
          outlineWidth={0.045}
          outlineColor={GIBSON_BG}
          maxWidth={emphasis ? 9 : undefined}
          textAlign="center"
        >
          {emphasis ? orb.label : orb.shortLabel}
        </Text>
        <Text
          fontSize={0.34}
          color={color}
          anchorX="center"
          anchorY="bottom"
          fillOpacity={dimmed ? 0.25 : 1}
          letterSpacing={0.08}
          outlineWidth={0.035}
          outlineColor={GIBSON_BG}
        >
          {AGENT_STATUS_LABELS[orb.status].toUpperCase()}
        </Text>
      </Billboard>

      {tower && (
        <Line
          points={[
            [0, shapeY, 0],
            [tower.x - orb.dockX, tower.height + 0.2, tower.z - orb.dockZ],
          ]}
          color={color}
          lineWidth={1.2}
          dashed
          dashSize={0.4}
          gapSize={0.25}
          transparent
          opacity={dimmed ? 0.08 : 0.55}
        />
      )}
    </group>
  );
}
