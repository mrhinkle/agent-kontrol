"use client";

import { useEffect, useMemo } from "react";
import {
  CanvasTexture,
  LinearFilter,
  LinearSRGBColorSpace,
} from "three";
import type { GibsonTower } from "@/lib/gibson-types";
import { hash32, mulberry32 } from "./dataface";

const WORLD = 100;
const TEX = 1024;
const PLANE_Y = 0.02;

type CircuitPoint = { x: number; z: number };

function circuitKey(towers: readonly Pick<GibsonTower, "id" | "gridX" | "gridZ">[]): string {
  return towers
    .map((t) => `${t.id}:${t.gridX.toFixed(2)}:${t.gridZ.toFixed(2)}`)
    .sort()
    .join("|");
}

function pointsFromKey(key: string): CircuitPoint[] {
  if (!key) return [];
  const points: CircuitPoint[] = [];
  for (const part of key.split("|")) {
    const segs = part.split(":");
    const zs = segs.pop();
    const xs = segs.pop();
    if (xs === undefined || zs === undefined) continue;
    const x = Number(xs);
    const z = Number(zs);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    points.push({ x, z });
  }
  return points;
}

function toPx(x: number, z: number): { x: number; y: number } {
  return {
    x: ((x + WORLD / 2) / WORLD) * TEX,
    y: ((z + WORLD / 2) / WORLD) * TEX,
  };
}

function createCircuitTexture(key: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = TEX;
  canvas.height = TEX;
  const ctx = canvas.getContext("2d");
  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = LinearSRGBColorSpace;

  if (!ctx) {
    texture.needsUpdate = true;
    return texture;
  }

  ctx.clearRect(0, 0, TEX, TEX);
  const points = pointsFromKey(key);
  if (points.length === 0) {
    texture.needsUpdate = true;
    return texture;
  }

  const rand = mulberry32(hash32(key));
  const origin = toPx(0, 0);

  ctx.lineWidth = 1.15;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  ctx.strokeStyle = "rgba(139, 157, 255, 0.26)";
  ctx.fillStyle = "rgba(139, 157, 255, 0.36)";

  for (const p of points) {
    const start = toPx(p.x, p.z);
    const xFirst = rand() < 0.5;
    const mid = xFirst ? { x: origin.x, y: start.y } : { x: start.x, y: origin.y };

    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(mid.x, mid.y);
    ctx.lineTo(origin.x, origin.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(start.x, start.y, 2.3, 0, Math.PI * 2);
    ctx.fill();

    const hasElbow =
      (Math.abs(mid.x - start.x) > 3 && Math.abs(mid.y - origin.y) > 3) ||
      (Math.abs(mid.y - start.y) > 3 && Math.abs(mid.x - origin.x) > 3);
    if (hasElbow) {
      ctx.beginPath();
      ctx.arc(mid.x, mid.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (rand() < 0.32) {
      const t = 0.28 + rand() * 0.4;
      ctx.beginPath();
      ctx.arc(start.x + (mid.x - start.x) * t, start.y + (mid.y - start.y) * t, 1.15, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.beginPath();
  ctx.arc(origin.x, origin.y, 2.6, 0, Math.PI * 2);
  ctx.fill();

  texture.needsUpdate = true;
  return texture;
}

function noopRaycast(): void {}

export default function CircuitFloor({
  towers,
}: {
  towers: readonly Pick<GibsonTower, "id" | "gridX" | "gridZ">[];
}) {
  const key = circuitKey(towers);
  const texture = useMemo(() => createCircuitTexture(key), [key]);

  useEffect(
    () => () => {
      texture.dispose();
    },
    [texture],
  );

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, PLANE_Y, 0]} raycast={noopRaycast}>
      <planeGeometry args={[WORLD, WORLD]} />
      <meshBasicMaterial map={texture} transparent opacity={0.5} toneMapped={false} depthWrite={false} />
    </mesh>
  );
}
