"use client";

import { useEffect, useMemo, useRef } from "react";
import { Billboard, Edges, Text } from "@react-three/drei";
import type { EdgesRef } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Color, type CanvasTexture, type Mesh, type MeshStandardMaterial } from "three";
import {
  GIBSON_BG,
  NEUTRAL,
  STATUS_COLORS,
  STATUS_LABELS,
  platformLabel,
  floorMatchesFilters,
  type GibsonFilters,
  type GibsonFloor,
  type GibsonFloorStatus,
  type GibsonHoverInfo,
  type GibsonTower,
} from "@/lib/gibson-types";
import { createDataFaceTexture } from "./dataface";
import { useSceneHover } from "./hover";
import {
  DONE_FLOOR_DEPTH,
  DONE_FLOOR_WIDTH,
  FLOOR_DEPTH,
  FLOOR_GAP,
  FLOOR_HEIGHT,
  FLOOR_WIDTH,
  LABEL_COLOR,
  hash01,
  stackHeight,
} from "./layout";

/** Darkened steel blue-gray derived from STATUS_COLORS.done (#3d5078). */
const DONE_BODY_COLOR = "#1a2438";
const FLOOR_SELECT_COLOR = NEUTRAL.select;
const FILTER_DIM = 0.12;
const DIM_FACE_OPACITY = 0.25;
const DONE_DIM_EMISSIVE = 0.03;
const DONE_DIM_OPACITY = 0.3;
const TOWER_LABEL_FADE = 0.3;
/** Warm data-face when work is running — the running status hue. */
const FACE_AMBER = STATUS_COLORS.running;
const FACE_CYAN = "#19d2ff";
const FACE_SCROLL = 0.006;
const FACE_DIM_OPACITY = 0.15;
const HISTORY_MERGE_MIN = 3;

interface TowerProps {
  tower: GibsonTower;
  selected: boolean;
  selectedTaskId?: number | null;
  onTowerClick?: (towerId: string | null) => void;
  onFloorClick?: (towerId: string, taskId: number) => void;
  filters?: GibsonFilters;
  onHover?: (info: GibsonHoverInfo | null) => void;
  reducedMotion?: boolean;
}

export default function Tower({
  tower,
  selected,
  selectedTaskId = null,
  onTowerClick,
  onFloorClick,
  filters,
  onHover,
  reducedMotion = false,
}: TowerProps) {
  const height = stackHeight(tower.floors.length);
  const floors = tower.floors;
  const doneFloors = useMemo(
    () => floors.filter((floor) => floor.status === "done"),
    [floors],
  );

  const labelFaded =
    floors.length > 0 &&
    floors.every((floor) => selectedTaskId !== floor.taskId && !floorMatchesFilters(floor, filters));

  const towerHover = useSceneHover(onHover, {
    kind: "tower",
    label: tower.label,
    sub: `project · ${floors.filter((f) => f.status !== "done").length} open · ${floors.filter((f) => f.status === "done").length} done · ${tower.activeAgents} active agents`,
  });

  const handleClick = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    onTowerClick?.(tower.id);
  };

  const handleOver = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    document.body.style.cursor = "pointer";
  };

  const handleOut = () => {
    document.body.style.cursor = "auto";
  };

  useEffect(() => {
    return () => {
      document.body.style.cursor = "auto";
    };
  }, []);

  return (
    <group
      position={[tower.gridX, 0, tower.gridZ]}
      onClick={handleClick}
      onPointerOver={handleOver}
      onPointerOut={handleOut}
    >
      {floors.length === 0 ? (
        <PadFloor hover={towerHover} />
      ) : (
        <>
          {doneFloors.length >= HISTORY_MERGE_MIN && (
            <DoneMonolith
              tower={tower}
              doneFloors={doneFloors}
              selected={selected}
              selectedTaskId={selectedTaskId}
              onTowerClick={onTowerClick}
              filters={filters}
              onHover={onHover}
              reducedMotion={reducedMotion}
            />
          )}
          {floors.map((floor, index) =>
            doneFloors.length >= HISTORY_MERGE_MIN && floor.status === "done" ? null : (
              <FloorBlock
                key={floor.taskId}
                floor={floor}
                index={index}
                selected={selectedTaskId === floor.taskId}
                onFloorClick={onFloorClick}
                towerId={tower.id}
                filters={filters}
                onHover={onHover}
                reducedMotion={reducedMotion}
              />
            ),
          )}
        </>
      )}

      {tower.heat > 0 && (
        <pointLight
          position={[0, height + 0.25, 0]}
          color={STATUS_COLORS.running}
          intensity={tower.heat * 1.6}
          distance={8}
          decay={2}
        />
      )}

      {selected && <SelectionRing />}

      <Billboard position={[0, height + 0.85, 0]}>
        <Text
          fontSize={selected ? 0.6 : 0.46}
          color={LABEL_COLOR}
          anchorX="center"
          anchorY="bottom"
          fillOpacity={selected ? 1 : labelFaded ? TOWER_LABEL_FADE : 0.92}
          outlineWidth={0.04}
          outlineColor={GIBSON_BG}
          onPointerOver={towerHover.onPointerOver}
          onPointerMove={towerHover.onPointerMove}
          onPointerOut={towerHover.onPointerOut}
        >
          {tower.label}
        </Text>
      </Billboard>
    </group>
  );
}

interface DoneMonolithProps {
  tower: GibsonTower;
  doneFloors: GibsonFloor[];
  selected: boolean;
  selectedTaskId?: number | null;
  onTowerClick?: (towerId: string | null) => void;
  filters?: GibsonFilters;
  onHover?: (info: GibsonHoverInfo | null) => void;
  reducedMotion?: boolean;
}

function DoneMonolith({
  tower,
  doneFloors,
  selected,
  selectedTaskId = null,
  onTowerClick,
  filters,
  onHover,
  reducedMotion = false,
}: DoneMonolithProps) {
  const slabHeight = stackHeight(doneFloors.length);
  const historySelected =
    selectedTaskId !== null && doneFloors.some((floor) => floor.taskId === selectedTaskId);
  const dimmed =
    !selected &&
    !historySelected &&
    doneFloors.every((floor) => !floorMatchesFilters(floor, filters));
  const warm =
    tower.heat > 0.15 ||
    tower.floors.some((floor) => floor.status === "running" || floor.status === "claimed");
  const faceColor = warm ? FACE_AMBER : FACE_CYAN;
  const emissiveIntensity =
    (dimmed ? 0.08 : 0.85) * (selected ? 1.28 : 1) * (historySelected ? 1.12 : 1);

  const ledgerSig = tower.floors.map((floor) => `${floor.taskId}:${floor.title}:${floor.platform}`).join("\n");
  const texture = useMemo(
    () =>
      createDataFaceTexture({
        id: tower.id,
        label: tower.label,
        titles: tower.floors.map((floor) => floor.title),
        platforms: tower.floors.map((floor) => floor.platform),
      }),
    [tower.id, tower.label, ledgerSig],
  );
  const texRef = useRef<CanvasTexture>(texture);
  texRef.current = texture;

  useEffect(
    () => () => {
      texture.dispose();
    },
    [texture],
  );

  useFrame((_, delta) => {
    if (reducedMotion) return;
    const tex = texRef.current;
    tex.offset.y += FACE_SCROLL * delta;
  });

  const hover = useSceneHover(onHover, {
    kind: "tower",
    label: tower.label,
    sub: `${doneFloors.length} tasks completed in the last 7 days`,
  });

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onTowerClick?.(tower.id);
  };

  const bodyOpacity = dimmed ? FACE_DIM_OPACITY : 0.9;
  const faceMat = {
    color: DONE_BODY_COLOR,
    emissive: faceColor,
    emissiveMap: texture,
    emissiveIntensity,
    transparent: true,
    opacity: bodyOpacity,
    metalness: 0.3,
    roughness: 0.7,
    toneMapped: false as const,
  };
  const capMat = {
    color: DONE_BODY_COLOR,
    emissive: STATUS_COLORS.done,
    emissiveIntensity: dimmed ? DONE_DIM_EMISSIVE : 0.08,
    transparent: true,
    opacity: bodyOpacity,
    metalness: 0.3,
    roughness: 0.7,
    toneMapped: false as const,
  };

  return (
    <mesh
      position={[0, slabHeight / 2, 0]}
      onClick={handleClick}
      onPointerOver={hover.onPointerOver}
      onPointerMove={hover.onPointerMove}
      onPointerOut={hover.onPointerOut}
    >
      <boxGeometry args={[DONE_FLOOR_WIDTH, slabHeight, DONE_FLOOR_DEPTH]} />
      <meshStandardMaterial attach="material-0" {...faceMat} />
      <meshStandardMaterial attach="material-1" {...faceMat} />
      <meshStandardMaterial attach="material-2" {...capMat} />
      <meshStandardMaterial attach="material-3" {...capMat} />
      <meshStandardMaterial attach="material-4" {...faceMat} />
      <meshStandardMaterial attach="material-5" {...faceMat} />
      <Edges color={STATUS_COLORS.done} lineWidth={0.8} />
    </mesh>
  );
}

function PadFloor({
  hover,
}: {
  hover: ReturnType<typeof useSceneHover>;
}) {
  const color = STATUS_COLORS.queued;
  return (
    <mesh
      position={[0, FLOOR_HEIGHT / 2, 0]}
      onPointerOver={hover.onPointerOver}
      onPointerMove={hover.onPointerMove}
      onPointerOut={hover.onPointerOut}
    >
      <boxGeometry args={[FLOOR_WIDTH, FLOOR_HEIGHT, FLOOR_DEPTH]} />
      <meshStandardMaterial
        color={GIBSON_BG}
        transparent
        opacity={0.55}
        emissive={color}
        emissiveIntensity={0.22}
        metalness={0.15}
        roughness={0.65}
        toneMapped={false}
      />
      <Edges color={color} lineWidth={1.1} />
    </mesh>
  );
}

interface FloorBlockProps {
  floor: GibsonFloor;
  index: number;
  selected: boolean;
  onFloorClick?: (towerId: string, taskId: number) => void;
  towerId: string;
  filters?: GibsonFilters;
  onHover?: (info: GibsonHoverInfo | null) => void;
  reducedMotion?: boolean;
}

function FloorBlock(props: FloorBlockProps) {
  return props.floor.status === "done" ? (
    <DoneFloorBlock {...props} />
  ) : (
    <ActiveFloorBlock {...props} />
  );
}

function floorClickHandler(
  towerId: string,
  taskId: number,
  onFloorClick?: (towerId: string, taskId: number) => void,
): ((e: ThreeEvent<MouseEvent>) => void) | undefined {
  // Only intercept when a handler exists so clicks fall through to the tower
  // group otherwise.
  if (!onFloorClick) return undefined;
  return (e) => {
    e.stopPropagation();
    onFloorClick(towerId, taskId);
  };
}

function FloorSelectionOutline({ width, depth }: { width: number; depth: number }) {
  return (
    <mesh>
      <boxGeometry args={[width * 1.06, FLOOR_HEIGHT * 1.2, depth * 1.06]} />
      <meshBasicMaterial color={FLOOR_SELECT_COLOR} wireframe toneMapped={false} />
    </mesh>
  );
}

/** Static architecture: no useFrame subscription, fully opaque when matching. */
function DoneFloorBlock({
  floor,
  index,
  selected,
  onFloorClick,
  towerId,
  filters,
  onHover,
}: FloorBlockProps) {
  const y = index * (FLOOR_HEIGHT + FLOOR_GAP) + FLOOR_HEIGHT / 2;
  const dimmed = !selected && !floorMatchesFilters(floor, filters);
  const hover = useSceneHover(onHover, {
    kind: "floor",
    label: floor.title,
    sub: `task #${floor.taskId} · ${STATUS_LABELS[floor.status]} · ${platformLabel(floor.platform)}`,
  });

  return (
    <mesh
      position={[0, y, 0]}
      onClick={floorClickHandler(towerId, floor.taskId, onFloorClick)}
      onPointerOver={hover.onPointerOver}
      onPointerMove={hover.onPointerMove}
      onPointerOut={hover.onPointerOut}
    >
      <boxGeometry args={[DONE_FLOOR_WIDTH, FLOOR_HEIGHT, DONE_FLOOR_DEPTH]} />
      <meshStandardMaterial
        color={DONE_BODY_COLOR}
        emissive={STATUS_COLORS.done}
        emissiveIntensity={dimmed ? DONE_DIM_EMISSIVE : selected ? 0.55 : 0.12}
        transparent={dimmed}
        opacity={dimmed ? DONE_DIM_OPACITY : 1}
        metalness={0.3}
        roughness={0.7}
        toneMapped={false}
      />
      <Edges color={STATUS_COLORS.done} lineWidth={0.8} />
      {selected && <FloorSelectionOutline width={DONE_FLOOR_WIDTH} depth={DONE_FLOOR_DEPTH} />}
    </mesh>
  );
}

function ActiveFloorBlock({
  floor,
  index,
  selected,
  onFloorClick,
  towerId,
  filters,
  onHover,
  reducedMotion = false,
}: FloorBlockProps) {
  const y = index * (FLOOR_HEIGHT + FLOOR_GAP) + FLOOR_HEIGHT / 2;
  const statusColor = STATUS_COLORS[floor.status];
  const matRef = useRef<MeshStandardMaterial>(null);
  const edgesRef = useRef<EdgesRef>(null);
  const phase = useMemo(() => hash01(String(floor.taskId)) * Math.PI * 2, [floor.taskId]);
  const workColor = useMemo(() => new Color(), []);
  const baseColor = useMemo(() => new Color(statusColor), [statusColor]);
  const midIntensity = useMemo(() => statusIntensity(floor.status, 0, 0), [floor.status]);
  const dimmed = !selected && !floorMatchesFilters(floor, filters);
  const hover = useSceneHover(onHover, {
    kind: "floor",
    label: floor.title,
    sub: `task #${floor.taskId} · ${STATUS_LABELS[floor.status]} · ${platformLabel(floor.platform)}`,
  });

  useFrame((state) => {
    const pulse = reducedMotion
      ? midIntensity
      : statusIntensity(floor.status, state.clock.elapsedTime, phase);
    const intensity = pulse + (selected ? 0.8 : 0);
    const factor = dimmed ? FILTER_DIM : 1;
    const mat = matRef.current;
    if (mat) mat.emissiveIntensity = intensity * factor;
    const edges = edgesRef.current;
    if (edges) {
      workColor.copy(baseColor).multiplyScalar(0.4 + intensity * 0.55);
      if (factor !== 1) workColor.multiplyScalar(factor);
      edges.material.color.copy(workColor);
    }
  });

  return (
    <mesh
      position={[0, y, 0]}
      onClick={floorClickHandler(towerId, floor.taskId, onFloorClick)}
      onPointerOver={hover.onPointerOver}
      onPointerMove={hover.onPointerMove}
      onPointerOut={hover.onPointerOut}
    >
      <boxGeometry args={[FLOOR_WIDTH, FLOOR_HEIGHT, FLOOR_DEPTH]} />
      <meshStandardMaterial
        ref={matRef}
        color={GIBSON_BG}
        transparent
        opacity={dimmed ? DIM_FACE_OPACITY : 0.55}
        emissive={statusColor}
        emissiveIntensity={0.4}
        metalness={0.18}
        roughness={0.58}
        toneMapped={false}
      />
      <Edges ref={edgesRef} color={statusColor} lineWidth={1.35} />
      {selected && <FloorSelectionOutline width={FLOOR_WIDTH} depth={FLOOR_DEPTH} />}
    </mesh>
  );
}

function statusIntensity(status: GibsonFloorStatus, t: number, phase: number): number {
  switch (status) {
    case "running":
      return 0.85 + 0.75 * (0.5 + 0.5 * Math.sin(t * 2.8 + phase));
    case "review":
      return 1.05;
    case "claimed":
      return 0.55 + 0.28 * (0.5 + 0.5 * Math.sin(t * 0.95 + phase));
    case "queued":
      return 0.28;
    case "failed": {
      const flicker = Math.sin(t * 21.7 + phase) * Math.sin(t * 8.3 + phase * 1.9);
      return 0.22 + 1.15 * Math.max(0, flicker);
    }
    case "done":
      return 0.12;
  }
}

function SelectionRing() {
  const ref = useRef<Mesh>(null);
  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.y += delta * 0.55;
  });
  return (
    <mesh ref={ref} position={[0, 0.06, 0]} rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[1.72, 0.03, 8, 56]} />
      <meshBasicMaterial color={NEUTRAL.select} wireframe toneMapped={false} />
    </mesh>
  );
}
