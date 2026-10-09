"use client";

import { useEffect, useRef } from "react";
import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera as ThreePerspectiveCamera, Vector3 } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { GibsonCameraCommand } from "@/lib/gibson-types";

const FOV = 45;
/** Default view: 36° above the floor, looking from the +x/+z corner. */
const DEFAULT_ELEVATION = (36 * Math.PI) / 180;
const DEFAULT_AZIMUTH = Math.PI / 4;
/** Look at the middle of the tower field, slightly raised for the floating group headers. */
const TARGET = new Vector3(0, 1.6, 0);
const MIN_DISTANCE = 6;
const ZOOM_STEP = 0.78;
/** Exponential ease rate (per second) — frame-rate independent, so slow GPUs still settle fast. */
const EASE_RATE = 9;

function defaultDirection(): Vector3 {
  return new Vector3(
    Math.cos(DEFAULT_ELEVATION) * Math.cos(DEFAULT_AZIMUTH),
    Math.sin(DEFAULT_ELEVATION),
    Math.cos(DEFAULT_ELEVATION) * Math.sin(DEFAULT_AZIMUTH),
  ).normalize();
}

/**
 * Distance at which a floor disc of `radius` (plus ~3 units of labels above it)
 * fills the viewport when seen from `elevation`. The disc projects to an ellipse:
 * full width horizontally, radius·sin(elevation) vertically.
 */
export function fitDistance(radius: number, fovDeg: number, aspect: number, elevation = DEFAULT_ELEVATION): number {
  const vfov = (fovDeg * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const horizontal = radius / Math.tan(hfov / 2);
  const vertical = (radius * Math.sin(elevation) + 5 * Math.cos(elevation)) / Math.tan(vfov / 2);
  // The near rim sits closer to the camera and projects larger; pad for it.
  return Math.max(horizontal, vertical) * 1.0;
}

export default function CameraRig({
  fitRadius,
  command,
  autoRotate,
  reducedMotion = false,
  onUserInteract,
}: {
  fitRadius: number;
  command: GibsonCameraCommand | null;
  autoRotate: boolean;
  reducedMotion?: boolean;
  onUserInteract?: () => void;
}) {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  // Re-read the default camera: drei's <PerspectiveCamera makeDefault> swaps it in
  // after the first effect pass, and the initial fit must land on that camera.
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const goal = useRef<{ pos: Vector3; target: Vector3 } | null>(null);
  const lastFit = useRef<{ radius: number; aspect: number; camera: unknown } | null>(null);

  const aspect = size.width / Math.max(size.height, 1);
  const fitDist = fitDistance(fitRadius, FOV, aspect);
  const maxDistance = Math.max(80, fitDist * 2.5);

  /** Move the camera to `distance` along `dir` from `around` (default: scene center). */
  function aim(dir: Vector3, distance: number, around: Vector3 = TARGET) {
    const d = Math.min(Math.max(distance, MIN_DISTANCE), maxDistance);
    goal.current = { pos: around.clone().add(dir.clone().multiplyScalar(d)), target: around.clone() };
    if (reducedMotion) snap();
  }

  function snap() {
    const controls = controlsRef.current;
    if (!goal.current) return;
    camera.position.copy(goal.current.pos);
    controls?.target.copy(goal.current.target);
    controls?.update();
    goal.current = null;
  }

  function currentDirection(): Vector3 {
    const target = controlsRef.current?.target ?? TARGET;
    const dir = camera.position.clone().sub(target);
    return dir.lengthSq() < 1e-6 ? defaultDirection() : dir.normalize();
  }

  // Fit on first render, and again when the drawn fleet grows/shrinks or the
  // viewport changes shape — never on routine 7s polls.
  useEffect(() => {
    const prev = lastFit.current;
    const changed =
      !prev || prev.camera !== camera || Math.abs(prev.radius - fitRadius) / prev.radius > 0.08 || Math.abs(prev.aspect - aspect) > 0.15;
    if (!changed) return;
    const first = !prev || prev.camera !== camera;
    lastFit.current = { radius: fitRadius, aspect, camera };
    aim(first ? defaultDirection() : currentDirection(), fitDist);
    if (first) snap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRadius, aspect, camera]);

  useEffect(() => {
    if (!command) return;
    const target = controlsRef.current?.target ?? TARGET;
    const distance = camera.position.distanceTo(target);
    if (command.kind === "reset") aim(defaultDirection(), fitDist);
    else if (command.kind === "fit") aim(currentDirection(), fitDist);
    // Zoom keeps whatever the user panned to; Fit and Reset recenter.
    else if (command.kind === "zoom-in") aim(currentDirection(), distance * ZOOM_STEP, target.clone());
    else aim(currentDirection(), distance / ZOOM_STEP, target.clone());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command?.nonce]);

  useFrame((_, delta) => {
    const g = goal.current;
    const controls = controlsRef.current;
    if (!g || !controls) return;
    const t = 1 - Math.exp(-EASE_RATE * Math.min(delta, 0.25));
    camera.position.lerp(g.pos, t);
    controls.target.lerp(g.target, t);
    controls.update();
    if (camera.position.distanceTo(g.pos) < 0.05) snap();
  });

  useEffect(() => {
    if (camera instanceof ThreePerspectiveCamera) {
      camera.far = Math.max(200, maxDistance * 3);
      camera.updateProjectionMatrix();
    }
  }, [camera, maxDistance]);

  return (
    <>
      <PerspectiveCamera makeDefault position={[30, 26, 30]} fov={FOV} near={0.1} far={300} />
      <OrbitControls
        ref={controlsRef}
        makeDefault
        autoRotate={!reducedMotion && autoRotate}
        autoRotateSpeed={0.35}
        enablePan
        screenSpacePanning={false}
        enableZoom
        zoomSpeed={1.15}
        enableDamping={!reducedMotion}
        dampingFactor={0.08}
        maxPolarAngle={Math.PI / 2 - 0.08}
        minDistance={MIN_DISTANCE}
        maxDistance={maxDistance}
        target={[TARGET.x, TARGET.y, TARGET.z]}
        onStart={() => {
          goal.current = null;
          onUserInteract?.();
        }}
      />
    </>
  );
}
