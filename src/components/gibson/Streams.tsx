"use client";

import { useMemo, useRef } from "react";
import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { Vector3, type Mesh, type QuadraticBezierCurve3 } from "three";
import {
  STATUS_COLORS,
  platformMatchesFilters,
  type GibsonFilters,
  type GibsonStream,
} from "@/lib/gibson-types";
import { STREAM_SEGMENTS, hash01, makeStreamCurve, type GibsonLayout } from "./layout";

const LINE_OPACITY = 0.4;
const DIM_LINE = 0.25;
const STATIC_U = [0.33, 0.66] as const;

export default function Streams({
  streams,
  layout,
  filters,
  reducedMotion = false,
}: {
  streams: GibsonStream[];
  layout: GibsonLayout;
  filters?: GibsonFilters;
  reducedMotion?: boolean;
}) {
  return (
    <group>
      {streams.map((stream) => (
        <StreamPath
          key={stream.id}
          stream={stream}
          layout={layout}
          filters={filters}
          reducedMotion={reducedMotion}
        />
      ))}
    </group>
  );
}

function StreamPath({
  stream,
  layout,
  filters,
  reducedMotion,
}: {
  stream: GibsonStream;
  layout: GibsonLayout;
  filters?: GibsonFilters;
  reducedMotion: boolean;
}) {
  const curve = useMemo(() => {
    const from = layout.towers.get(stream.fromTowerId);
    const to = layout.docks.get(stream.toAgentId);
    if (!from || !to) return null;
    return makeStreamCurve(from, to);
  }, [layout, stream.fromTowerId, stream.toAgentId]);

  const points = useMemo(() => (curve ? curve.getPoints(STREAM_SEGMENTS) : null), [curve]);
  const seed = useMemo(() => hash01(stream.id), [stream.id]);
  // Review handoffs are a task state, so they wear the review status hue.
  const color = STATUS_COLORS.review;
  const speed = 0.16 + seed * 0.1;
  const matches = platformMatchesFilters(stream.toPlatform, filters);
  const lineOpacity = matches ? LINE_OPACITY : LINE_OPACITY * DIM_LINE;

  if (!curve || !points) return null;

  return (
    <group>
      <Line points={points} color={color} lineWidth={1} transparent opacity={lineOpacity} />
      {matches &&
        (reducedMotion ? (
          <>
            <StreamPulse curve={curve} color={color} offset={STATIC_U[0]} speed={0} frozen />
            <StreamPulse curve={curve} color={color} offset={STATIC_U[1]} speed={0} frozen />
          </>
        ) : (
          <>
            <StreamPulse curve={curve} color={color} offset={seed} speed={speed} />
            <StreamPulse curve={curve} color={color} offset={seed + 1 / 3} speed={speed} />
            <StreamPulse curve={curve} color={color} offset={seed + 2 / 3} speed={speed} />
          </>
        ))}
    </group>
  );
}

function StreamPulse({
  curve,
  color,
  offset,
  speed,
  frozen = false,
}: {
  curve: QuadraticBezierCurve3;
  color: string;
  offset: number;
  speed: number;
  frozen?: boolean;
}) {
  const meshRef = useRef<Mesh>(null);
  const scratch = useMemo(() => new Vector3(), []);
  const initial = useMemo(() => {
    const point = new Vector3();
    curve.getPoint(((offset % 1) + 1) % 1, point);
    return point;
  }, [curve, offset]);

  useFrame((state) => {
    if (frozen) return;
    const mesh = meshRef.current;
    if (!mesh) return;
    const u = (state.clock.elapsedTime * speed + offset) % 1;
    curve.getPoint(u, scratch);
    mesh.position.copy(scratch);
  });

  return (
    <mesh ref={meshRef} position={initial}>
      <sphereGeometry args={[0.11, 10, 10]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={2.2}
        toneMapped={false}
      />
    </mesh>
  );
}
