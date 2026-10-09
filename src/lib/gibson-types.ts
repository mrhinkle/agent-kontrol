/**
 * The Gibson view — shared contract between the data layer and the 3D scene.
 *
 * The data layer (src/lib/gibson-derive.ts, polled by src/components/use-gibson.ts)
 * turns /api/fleet + /api/tasks + /api/progress into a GibsonSceneModel. The scene
 * (src/components/gibson/GibsonScene.tsx) renders that model and knows nothing
 * about the APIs. Neither side imports the other's internals — only this file.
 *
 * Color rule: hue always means STATUS. Platform is shown by SHAPE (and a neutral
 * text tag), never by a status hue.
 */

import type { AgentStatus } from "./types";

export type GibsonPlatform =
  | "claude-code"
  | "codex"
  | "grok"
  | "hermes"
  | "cowork"
  | "any"
  | (string & {});

export type GibsonFloorStatus =
  | "queued"
  | "claimed"
  | "running"
  | "review"
  | "failed"
  | "done";

/**
 * One task, rendered as one floor of its project's tower.
 * "done" floors are the tower's permanent architecture (dim, solid) stacked at
 * the bottom, oldest first; open floors glow on top of them.
 */
export interface GibsonFloor {
  taskId: number;
  title: string;
  status: GibsonFloorStatus;
  platform: GibsonPlatform;
  priority: number; // 1 high, 2 normal, 3 low
  description: string | null;
  assignedAgent: string | null;
  costUsd: number | null;
  completedAt: string | null; // ISO; set for done floors
}

/** One project, rendered as a tower on the grid. */
export interface GibsonTower {
  id: string; // project slug (stable key)
  label: string; // display name
  gridX: number; // world-space X assigned by the data layer
  gridZ: number; // world-space Z assigned by the data layer
  floors: GibsonFloor[]; // bottom-up; length drives tower height
  activeAgents: number; // agents currently active on this project
  heat: number; // 0..1, recent event activity (drives glow intensity)
}

/** A session an agent ran — its work history, shown in the agent panel. */
export interface GibsonAgentJob {
  sessionId: string;
  project: string | null;
  towerId: string | null; // slug of project if that tower exists in the model
  status: string;
  summary: string | null;
  startedAt: string;
  endedAt: string | null;
}

export type GibsonPlatformShape = "diamond" | "cube" | "pyramid" | "sphere" | "hex";

/** An agent, rendered as a status-colored, platform-shaped beacon at its machine's dock. */
export interface GibsonAgentOrb {
  id: string;
  label: string; // full display name
  shortLabel: string; // collision-safe label drawn in the scene
  platform: GibsonPlatform;
  shape: GibsonPlatformShape;
  machine: string; // "unassigned" when the agent never reported one
  status: AgentStatus;
  /** Tower the agent's open session is working on; null when idle or the project has no tower. */
  towerId: string | null;
  project: string | null;
  /** Current session summary, or the most recent one when idle. */
  summary: string | null;
  sessionId: string | null;
  sessionStartedAt: string | null;
  lastSeenAt: string | null;
  pendingMessages: number;
  /** Agent replies the operator has not opened yet (Fleet conversation drawer). */
  unreadReplies: number;
  /** Open task assigned to this agent, if any. */
  /** Open task assigned to this agent while it is working (active, waiting) or broke on it (failed). */
  currentTask: { id: number; title: string; status: GibsonFloorStatus } | null;
  /** Open task still assigned to an idle (done/offline) agent: shown as assigned, never as current. */
  assignedTask: { id: number; title: string; status: GibsonFloorStatus } | null;
  /** Current + recent sessions, newest first. */
  jobs: GibsonAgentJob[];
  /** Dock position (world space), assigned by the data layer so labels never collide. */
  dockX: number;
  dockZ: number;
}

/** A cross-vendor review handoff: pulse from the tower to a reviewer agent of that platform. */
export interface GibsonStream {
  id: string;
  fromTowerId: string;
  toPlatform: GibsonPlatform;
  toAgentId: string;
  taskId: number;
}

/** Machine label drawn on the floor outside its group of docks. */
export interface GibsonMachineLabel {
  machine: string;
  x: number;
  z: number;
  /** Height above the floor: near-side labels lie on the floor outside the ring;
   *  far-side labels float above their group like a header. */
  y: number;
  count: number;
  /** Text anchor so labels at the screen edges grow toward the center, not off-canvas. */
  align: "left" | "center" | "right";
}

export type GibsonBannerLevel = "nominal" | "attention" | "critical" | "unknown";

export interface GibsonBannerItem {
  key: "failed-agents" | "failed-tasks" | "waiting" | "needs-you" | "offline" | "review";
  count: number;
  label: string;
  tone: "red" | "amber" | "cyan" | "gray";
}

export interface GibsonBanner {
  level: GibsonBannerLevel;
  headline: string;
  items: GibsonBannerItem[];
}

/** Every count shown in the HUD — derived from what is actually drawn. */
export interface GibsonCounts {
  agents: number;
  byStatus: Record<AgentStatus, number>;
  towers: number;
  openFloors: number;
  failedTasks: number;
  reviewTasks: number;
  streams: number;
  machines: number;
  /** Progress board alerts ("Needs you"); null when the progress feed is unavailable. */
  needsYou: number | null;
}

export interface GibsonSceneModel {
  demo: boolean;
  towers: GibsonTower[];
  orbs: GibsonAgentOrb[];
  streams: GibsonStream[];
  machines: GibsonMachineLabel[];
  /** Radius of the agent dock ring; the camera fits to this. */
  ringRadius: number;
  counts: GibsonCounts;
  banner: GibsonBanner;
  generatedAt: string;
}

/**
 * Legend-driven filters. Empty arrays mean "no filter on that axis".
 * Matching is AND across axes. Non-matching scene elements are dimmed, never
 * hidden — the architecture stays legible. Agents are filtered by platform only.
 */
export interface GibsonFilters {
  statuses: GibsonFloorStatus[];
  platforms: string[];
}

/** Pointer-hover info the scene reports so the HUD can render a tooltip. */
export interface GibsonHoverInfo {
  kind: "floor" | "orb" | "tower";
  label: string; // task title / agent label / project label
  sub: string; // e.g. "active · Codex · macbook-pro-4"
  /** Optional extra lines (current task, summary). */
  detail?: string | null;
  accent?: string; // status color for the tooltip edge
  clientX: number;
  clientY: number;
}

export type GibsonCameraCommand = { kind: "fit" | "reset" | "zoom-in" | "zoom-out"; nonce: number };

export interface GibsonSceneProps {
  model: GibsonSceneModel;
  selectedTowerId?: string | null;
  onTowerClick?: (towerId: string | null) => void;
  /** Selected floor's taskId; the scene highlights that floor. */
  selectedTaskId?: number | null;
  /** Clicking a floor selects its tower AND that task. */
  onFloorClick?: (towerId: string, taskId: number) => void;
  selectedOrbId?: string | null;
  hoveredOrbId?: string | null;
  onOrbClick?: (orbId: string | null) => void;
  filters?: GibsonFilters;
  onHover?: (info: GibsonHoverInfo | null) => void;
  /** True disables auto-rotate and pulse/flicker animation (prefers-reduced-motion). */
  reducedMotion?: boolean;
  autoRotate?: boolean;
  cameraCommand?: GibsonCameraCommand | null;
  /** Called when the user drags/zooms, so the HUD can pause auto-rotate. */
  onUserInteract?: () => void;
}

export function floorMatchesFilters(
  floor: Pick<GibsonFloor, "status" | "platform">,
  filters: GibsonFilters | undefined,
): boolean {
  if (!filters) return true;
  const statusOk = filters.statuses.length === 0 || filters.statuses.includes(floor.status);
  const platformOk =
    filters.platforms.length === 0 || filters.platforms.includes(floor.platform);
  return statusOk && platformOk;
}

export function platformMatchesFilters(
  platform: string,
  filters: GibsonFilters | undefined,
): boolean {
  if (!filters) return true;
  return filters.platforms.length === 0 || filters.platforms.includes(platform);
}

/** Agent status colors. Active pulses, waiting is amber, failed red, done dim. */
export const AGENT_STATUS_COLORS: Record<AgentStatus, string> = {
  active: "#2ee6a6",
  waiting: "#ffb020",
  failed: "#ff3b5c",
  done: "#5c6f96",
  offline: "#3b4559",
};

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  active: "Active",
  waiting: "Needs you",
  failed: "Failed",
  done: "Done",
  offline: "Offline",
};

/** Task-status colors for tower floors — same hue family as agent status. */
export const STATUS_COLORS: Record<GibsonFloorStatus, string> = {
  queued: "#4a5f9e",
  claimed: "#7f9cff",
  running: "#2ee6a6",
  review: "#19d2ff",
  failed: "#ff3b5c",
  done: "#3d5078",
};

export const STATUS_LABELS: Record<GibsonFloorStatus, string> = {
  queued: "Queued",
  claimed: "Claimed",
  running: "Running",
  review: "In review",
  failed: "Failed",
  done: "Done",
};

/** Neutral (non-status) colors for chrome: labels, selection, platform glyphs. */
export const NEUTRAL = {
  label: "#e8efff",
  labelMuted: "#93a4c8",
  glyph: "#c9d4ee",
  select: "#ffffff",
} as const;

export const PLATFORM_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  cowork: "Cowork",
  "cowork-cloud": "Cowork · Cloud",
  "cowork-local": "Cowork · Local",
  "chatgpt-work": "ChatGPT Work",
  codex: "Codex",
  grok: "Grok",
  hermes: "Hermes",
  any: "Any platform",
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

/** Platform → silhouette. Anthropic diamond, OpenAI cube, xAI pyramid, Hermes sphere. */
export function platformShape(platform: string): GibsonPlatformShape {
  if (platform === "claude-code" || platform.startsWith("cowork")) return "diamond";
  if (platform === "codex" || platform === "chatgpt-work") return "cube";
  if (platform === "grok") return "pyramid";
  if (platform === "hermes") return "sphere";
  return "hex";
}

/** Shapes shown in the platform key, in display order. */
export const PLATFORM_KEY: Array<{ shape: GibsonPlatformShape; label: string; platforms: string[] }> = [
  { shape: "diamond", label: "Claude Code / Cowork", platforms: ["claude-code", "cowork", "cowork-cloud", "cowork-local"] },
  { shape: "cube", label: "Codex / ChatGPT", platforms: ["codex", "chatgpt-work"] },
  { shape: "pyramid", label: "Grok", platforms: ["grok"] },
  { shape: "sphere", label: "Hermes", platforms: ["hermes"] },
  { shape: "hex", label: "Other", platforms: [] },
];

export const GIBSON_BG = "#05070f";
