"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Billboard, Text } from "@react-three/drei";
import { Canvas, useFrame, type RootState } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import type { Group } from "three";
import { GIBSON_BG, STATUS_COLORS, type GibsonSceneProps } from "@/lib/gibson-types";
import AgentDocks from "./AgentDocks";
import CameraRig from "./CameraRig";
import CircuitFloor from "./CircuitFloor";
import GridFloor from "./GridFloor";
import { buildLayout } from "./layout";
import Streams from "./Streams";
import Tower from "./Tower";

export default function GibsonScene({
  model,
  selectedTowerId = null,
  onTowerClick,
  selectedTaskId = null,
  onFloorClick,
  selectedOrbId = null,
  hoveredOrbId = null,
  onOrbClick,
  filters,
  onHover,
  reducedMotion = false,
  autoRotate = false,
  cameraCommand = null,
  onUserInteract,
}: GibsonSceneProps) {
  const fitRadius = model.ringRadius + 3.6;
  // Bloom allocates offscreen buffers that can blow the WebGL context on weak
  // GPUs; on context loss we remount the Canvas with effects disabled.
  const [effectsEnabled, setEffectsEnabled] = useState(true);
  const [canvasKey, setCanvasKey] = useState(0);
  const handleCreated = useCallback((state: RootState) => {
    state.gl.domElement.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      setEffectsEnabled(false);
      setCanvasKey((k) => k + 1);
    });
  }, []);

  return (
    <Canvas
      key={canvasKey}
      onCreated={handleCreated}
      className="h-full w-full"
      style={{ width: "100%", height: "100%", display: "block" }}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: false }}
      onPointerMissed={() => {
        onTowerClick?.(null);
        onOrbClick?.(null);
      }}
    >
      <color attach="background" args={[GIBSON_BG]} />
      <fog attach="fog" args={[GIBSON_BG, fitRadius * 2.2, fitRadius * 6]} />
      <ambientLight intensity={0.25} />
      <CameraRig
        fitRadius={fitRadius}
        command={cameraCommand}
        autoRotate={autoRotate}
        reducedMotion={reducedMotion}
        onUserInteract={onUserInteract}
      />
      <GridFloor />
      <CircuitFloor towers={model.towers} />
      <GibsonWorld
        model={model}
        selectedTowerId={selectedTowerId ?? null}
        onTowerClick={onTowerClick}
        selectedTaskId={selectedTaskId ?? null}
        onFloorClick={onFloorClick}
        selectedOrbId={selectedOrbId ?? null}
        hoveredOrbId={hoveredOrbId ?? null}
        onOrbClick={onOrbClick}
        filters={filters}
        onHover={onHover}
        reducedMotion={reducedMotion}
      />
      {effectsEnabled && (
        <EffectComposer enableNormalPass={false} multisampling={0}>
          <Bloom luminanceThreshold={0.35} intensity={0.7} mipmapBlur />
        </EffectComposer>
      )}
    </Canvas>
  );
}

function GibsonWorld({
  model,
  selectedTowerId,
  onTowerClick,
  selectedTaskId,
  onFloorClick,
  selectedOrbId,
  hoveredOrbId,
  onOrbClick,
  filters,
  onHover,
  reducedMotion = false,
}: {
  model: GibsonSceneProps["model"];
  selectedTowerId: string | null;
  onTowerClick?: GibsonSceneProps["onTowerClick"];
  selectedTaskId: number | null;
  onFloorClick?: GibsonSceneProps["onFloorClick"];
  selectedOrbId: string | null;
  hoveredOrbId: string | null;
  onOrbClick?: GibsonSceneProps["onOrbClick"];
  filters?: GibsonSceneProps["filters"];
  onHover?: GibsonSceneProps["onHover"];
  reducedMotion?: boolean;
}) {
  const layout = useMemo(() => buildLayout(model), [model]);

  return (
    <>
      {model.towers.map((tower) => (
        <Tower
          key={tower.id}
          tower={tower}
          selected={selectedTowerId === tower.id}
          selectedTaskId={selectedTaskId}
          onTowerClick={onTowerClick}
          onFloorClick={onFloorClick}
          filters={filters}
          onHover={onHover}
          reducedMotion={reducedMotion}
        />
      ))}
      <AgentDocks
        orbs={model.orbs}
        machines={model.machines}
        layout={layout}
        selectedOrbId={selectedOrbId}
        hoveredOrbId={hoveredOrbId}
        onOrbClick={onOrbClick}
        filters={filters}
        onHover={onHover}
        reducedMotion={reducedMotion}
      />
      <Streams streams={model.streams} layout={layout} filters={filters} reducedMotion={reducedMotion} />
      {model.towers.length === 0 && <EmptyConstructs reducedMotion={reducedMotion} />}
    </>
  );
}

function EmptyConstructs({ reducedMotion = false }: { reducedMotion?: boolean }) {
  const ref = useRef<Group>(null);

  useEffect(() => {
    if (reducedMotion && ref.current) {
      ref.current.position.y = 4;
    }
  }, [reducedMotion]);

  useFrame((state) => {
    if (reducedMotion || !ref.current) return;
    ref.current.position.y = 4 + Math.sin(state.clock.elapsedTime * 0.7) * 0.25;
  });

  return (
    <group ref={ref} position={[0, 4, 0]}>
      <Billboard>
        <Text
          fontSize={0.7}
          color={STATUS_COLORS.review}
          anchorX="center"
          anchorY="middle"
          fillOpacity={0.45}
          letterSpacing={0.08}
          outlineWidth={0.012}
          outlineColor={GIBSON_BG}
        >
          NO ACTIVE CONSTRUCTS
        </Text>
      </Billboard>
    </group>
  );
}
