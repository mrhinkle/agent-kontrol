"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import type { GibsonHoverInfo } from "@/lib/gibson-types";

const MOVE_THROTTLE_MS = 50;
const COORD_EPS = 4;

type HoverMeta = Pick<GibsonHoverInfo, "kind" | "label" | "sub" | "detail" | "accent">;

type HoverHandlers = {
  onPointerOver?: (e: ThreeEvent<PointerEvent>) => void;
  onPointerMove?: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOut?: (e: ThreeEvent<PointerEvent>) => void;
};

/**
 * Pointer-hover reporting for the HUD tooltip.
 * Handlers are omitted entirely when `onHover` is missing so the mesh does
 * not become a hit target solely for a no-op callback.
 */
export function useSceneHover(
  onHover: ((info: GibsonHoverInfo | null) => void) | undefined,
  info: HoverMeta,
): HoverHandlers {
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const infoRef = useRef(info);
  infoRef.current = info;

  const last = useRef({ label: "", x: Number.NaN, y: Number.NaN });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pending.current = null;
  }, []);

  const emit = useCallback((x: number, y: number) => {
    const hover = onHoverRef.current;
    if (!hover) return;
    const { kind, label, sub, detail, accent } = infoRef.current;
    const prev = last.current;
    if (
      prev.label === label &&
      Math.abs(prev.x - x) <= COORD_EPS &&
      Math.abs(prev.y - y) <= COORD_EPS
    ) {
      return;
    }
    last.current = { label, x, y };
    hover({ kind, label, sub, detail, accent, clientX: x, clientY: y });
  }, []);

  useEffect(() => () => clearTimer(), [clearTimer]);

  if (onHover === undefined) return {};

  return {
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      clearTimer();
      emit(e.nativeEvent.clientX, e.nativeEvent.clientY);
    },
    onPointerMove: (e: ThreeEvent<PointerEvent>) => {
      pending.current = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
      if (timer.current !== null) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        const next = pending.current;
        pending.current = null;
        if (next) emit(next.x, next.y);
      }, MOVE_THROTTLE_MS);
    },
    onPointerOut: () => {
      clearTimer();
      last.current = { label: "", x: Number.NaN, y: Number.NaN };
      onHoverRef.current?.(null);
    },
  };
}

export function mergePointerHandlers<E>(
  a?: (e: E) => void,
  b?: (e: E) => void,
): ((e: E) => void) | undefined {
  if (!a) return b;
  if (!b) return a;
  return (e: E) => {
    a(e);
    b(e);
  };
}
