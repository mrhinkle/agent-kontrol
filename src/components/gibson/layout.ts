"use client";

import { QuadraticBezierCurve3, Vector3 } from "three";
import type { GibsonSceneModel } from "@/lib/gibson-types";

export const FLOOR_WIDTH = 2.2;
export const FLOOR_HEIGHT = 0.55;
export const FLOOR_DEPTH = 2.2;
/** Done floors are slightly narrower so the active crown reads as scaffolding. */
export const DONE_FLOOR_WIDTH = 2.05;
export const DONE_FLOOR_DEPTH = 2.05;
export const FLOOR_GAP = 0.08;
/** Height of an agent beacon's shape above its dock pad. */
export const DOCK_SHAPE_Y = 1.5;
export const DOCK_SHAPE_SIZE = 0.6;
export const STREAM_ARC = 6;
export const STREAM_SEGMENTS = 40;
export const LABEL_COLOR = "#e8efff";

export interface TowerPose {
  id: string;
  x: number;
  z: number;
  height: number;
}

export interface DockPose {
  id: string;
  x: number;
  z: number;
  /** World position of the agent's shape (stream/tether endpoint). */
  topY: number;
}

export interface GibsonLayout {
  towers: Map<string, TowerPose>;
  docks: Map<string, DockPose>;
}

/** Stable 0..1 hash from an id — never use Math.random() for visual phase. */
export function hash01(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export function stackHeight(floorCount: number): number {
  const n = Math.max(floorCount, 1);
  return n * FLOOR_HEIGHT + (n - 1) * FLOOR_GAP;
}

export function buildLayout(model: GibsonSceneModel): GibsonLayout {
  const towers = new Map<string, TowerPose>();
  for (const tower of model.towers) {
    towers.set(tower.id, {
      id: tower.id,
      x: tower.gridX,
      z: tower.gridZ,
      height: stackHeight(tower.floors.length),
    });
  }
  const docks = new Map<string, DockPose>();
  for (const orb of model.orbs) {
    docks.set(orb.id, { id: orb.id, x: orb.dockX, z: orb.dockZ, topY: DOCK_SHAPE_Y });
  }
  return { towers, docks };
}

export function makeStreamCurve(from: TowerPose, to: DockPose): QuadraticBezierCurve3 {
  const start = new Vector3(from.x, from.height, from.z);
  const end = new Vector3(to.x, to.topY, to.z);
  const mid = start.clone().lerp(end, 0.5);
  mid.y += STREAM_ARC;
  return new QuadraticBezierCurve3(start, mid, end);
}
