/**
 * Pure data derivation for the Gibson. No React, no three.js, no fetch — so the
 * rules that decide what the operator sees at a glance (who is drawn, what color, what
 * the banner says) are unit-tested in tests/ui/gibson-derive.test.ts.
 *
 * Inputs are the same payloads the Fleet (/api/fleet), Tasks (/api/tasks) and
 * Progress (/api/progress) pages render, so the three views cannot disagree.
 */

import {
  platformShape,
  type GibsonAgentJob,
  type GibsonAgentOrb,
  type GibsonBanner,
  type GibsonBannerItem,
  type GibsonCounts,
  type GibsonFloor,
  type GibsonFloorStatus,
  type GibsonMachineLabel,
  type GibsonSceneModel,
  type GibsonStream,
  type GibsonTower,
} from "./gibson-types";
import type { AgentStatus, FleetAgent, FleetResponse, Session, Task } from "./types";

export const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const HEAT_WINDOW_MS = 60 * 60 * 1000;
const MAX_OPEN_FLOORS = 24;
const MAX_DONE_FLOORS = 24;
const GOLDEN_ANGLE = 2.399963;
/** Tower spiral spacing (world units). */
const TOWER_SPACING = 5.2;
/** Minimum arc between neighbouring agent docks — wide enough for an 18-char label. */
export const DOCK_MIN_ARC = 5;
const RING_MIN_RADIUS = 11;
const RING_TOWER_CLEARANCE = 4.8;
export const SHORT_LABEL_MAX = 18;
export const UNASSIGNED_MACHINE = "unassigned";

const OPEN_STATUSES = new Set<GibsonFloorStatus>(["queued", "claimed", "running", "review", "failed"]);
const AGENT_STATUSES: AgentStatus[] = ["active", "waiting", "failed", "done", "offline"];

export interface TasksPayload {
  demo?: boolean;
  tasks: Task[];
}

export interface ProgressPayload {
  alerts: unknown[];
}

export interface GibsonInputs {
  fleet: FleetResponse;
  tasks: TasksPayload;
  /** null = progress feed unavailable (banner must not claim NOMINAL). */
  progress: ProgressPayload | null;
  now?: number;
}

export function slugify(project: string): string {
  return project
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Normalise whatever derived_status the API sent into one of the five agent states. */
export function normalizeAgentStatus(status: string | null | undefined): AgentStatus {
  return (AGENT_STATUSES as string[]).includes(status ?? "") ? (status as AgentStatus) : "offline";
}

/**
 * A label short enough to never collide with its neighbours on the dock ring.
 * Prefers dropping a trailing "(machine)" suffix — the machine is already
 * printed on the floor next to the group — before truncating with an ellipsis.
 */
export function shortLabel(label: string, machine?: string | null, max = SHORT_LABEL_MAX): string {
  let s = label.trim();
  if (machine) {
    const suffix = `(${machine})`;
    if (s.toLowerCase().endsWith(suffix.toLowerCase())) s = s.slice(0, -suffix.length).trim();
    if (s.toLowerCase().endsWith(`-${machine}`.toLowerCase()) && s.length > machine.length + 1) {
      s = s.slice(0, -(machine.length + 1));
    }
  }
  if (s.length === 0) s = label.trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function isOpenTask(task: Task, now: number): task is Task & { status: GibsonFloorStatus } {
  if (!OPEN_STATUSES.has(task.status as GibsonFloorStatus)) return false;
  if (task.status !== "failed") return true;
  const updatedAt = Date.parse(task.updated_at);
  const age = now - updatedAt;
  return Number.isFinite(updatedAt) && age >= 0 && age <= FAILED_WINDOW_MS;
}

function completedAt(task: Task): string {
  return task.completed_at ?? task.updated_at;
}

function isRecentDoneTask(task: Task, now: number): task is Task & { status: "done" } {
  if (task.status !== "done") return false;
  const completed = Date.parse(completedAt(task));
  const age = now - completed;
  return Number.isFinite(completed) && age >= 0 && age <= DONE_WINDOW_MS;
}

function toFloor(task: Task & { status: GibsonFloorStatus }): GibsonFloor {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    platform: task.platform,
    priority: task.priority,
    description: task.description,
    assignedAgent: task.assigned_agent,
    costUsd: task.cost_usd,
    completedAt: task.status === "done" ? completedAt(task) : task.completed_at,
  };
}

function towerPosition(index: number): { gridX: number; gridZ: number } {
  if (index === 0) return { gridX: 0, gridZ: 0 };
  const radius = TOWER_SPACING * Math.sqrt(index);
  const theta = index * GOLDEN_ANGLE;
  return {
    gridX: Number((radius * Math.cos(theta)).toFixed(2)),
    gridZ: Number((radius * Math.sin(theta)).toFixed(2)),
  };
}

function sessionsOf(agent: FleetAgent): Session[] {
  const recent = [...agent.recent_sessions].sort(
    (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at),
  );
  const all = agent.current_session ? [agent.current_session, ...recent] : recent;
  const seen = new Set<string>();
  return all.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}

/**
 * Dock positions on a ring around the towers, grouped by machine with one empty
 * slot between groups. Arc spacing >= DOCK_MIN_ARC guarantees labels never
 * overlap regardless of how many agents report in.
 */
export function layoutDocks(
  agents: Array<{ id: string; machine: string }>,
  towerExtent: number,
): { docks: Map<string, { x: number; z: number }>; machines: GibsonMachineLabel[]; ringRadius: number } {
  const groups = new Map<string, string[]>();
  for (const a of agents) groups.set(a.machine, [...(groups.get(a.machine) ?? []), a.id]);
  const machineOrder = [...groups.keys()].sort((a, b) =>
    a === UNASSIGNED_MACHINE ? 1 : b === UNASSIGNED_MACHINE ? -1 : a.localeCompare(b),
  );

  const slots: Array<{ id: string; machine: string } | null> = [];
  for (const m of machineOrder) {
    if (slots.length > 0 && machineOrder.length > 1) slots.push(null);
    for (const id of groups.get(m) ?? []) slots.push({ id, machine: m });
  }
  if (machineOrder.length > 1) slots.push(null); // gap between last and first group

  const n = Math.max(slots.length, 1);
  const ringRadius = Number(
    Math.max(RING_MIN_RADIUS, towerExtent + RING_TOWER_CLEARANCE, (n * DOCK_MIN_ARC) / (2 * Math.PI)).toFixed(2),
  );
  // Start at the back of the default camera view (camera sits at +x/+z) so the
  // first group reads left-to-right across the top of the screen.
  const start = Math.PI / 4 + Math.PI - (Math.PI * 2 * (n - 1)) / (2 * n);
  const docks = new Map<string, { x: number; z: number }>();
  const angleByMachine = new Map<string, number[]>();
  slots.forEach((slot, i) => {
    if (!slot) return;
    const angle = start + (i / n) * Math.PI * 2;
    docks.set(slot.id, {
      x: Number((Math.cos(angle) * ringRadius).toFixed(2)),
      z: Number((Math.sin(angle) * ringRadius).toFixed(2)),
    });
    angleByMachine.set(slot.machine, [...(angleByMachine.get(slot.machine) ?? []), angle]);
  });

  const machines: GibsonMachineLabel[] = machineOrder.map((machine) => {
    const angles = angleByMachine.get(machine) ?? [0];
    const mid = angles.reduce((s, a) => s + a, 0) / angles.length;
    // Near-side groups (facing the default camera) get a floor label just outside
    // the ring, which lands below their docks on screen. Far-side groups get a
    // label floating above the group, so it reads as a header and never touches
    // the towers in the middle or the agent labels.
    const nearSide = Math.cos(mid - Math.PI / 4) >= -0.2;
    const r = nearSide ? ringRadius + 2.6 : ringRadius + 0.6;
    const x = Math.cos(mid) * r;
    const z = Math.sin(mid) * r;
    // Default camera's screen-right axis is (1, 0, -1)/√2.
    const screenX = (x - z) / Math.SQRT2 / r;
    return {
      machine,
      x: Number(x.toFixed(2)),
      z: Number(z.toFixed(2)),
      y: nearSide ? 0.35 : 4.6,
      count: angles.length,
      align: screenX < -0.45 ? "left" : screenX > 0.45 ? "right" : "center",
    };
  });

  return { docks, machines, ringRadius };
}

export function deriveCounts(
  model: Pick<GibsonSceneModel, "towers" | "orbs" | "streams" | "machines">,
  needsYou: number | null,
): GibsonCounts {
  const byStatus: Record<AgentStatus, number> = { active: 0, waiting: 0, failed: 0, done: 0, offline: 0 };
  for (const orb of model.orbs) byStatus[orb.status] += 1;
  let openFloors = 0;
  let failedTasks = 0;
  let reviewTasks = 0;
  for (const tower of model.towers) {
    for (const floor of tower.floors) {
      if (floor.status !== "done") openFloors += 1;
      if (floor.status === "failed") failedTasks += 1;
      if (floor.status === "review") reviewTasks += 1;
    }
  }
  return {
    agents: model.orbs.length,
    byStatus,
    towers: model.towers.length,
    openFloors,
    failedTasks,
    reviewTasks,
    streams: model.streams.length,
    machines: model.machines.length,
    needsYou,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The status banner. NOMINAL is only allowed when nothing has failed, no agent
 * is waiting on the operator, and the Progress board has zero "needs you" items. If the
 * progress feed is down we say so rather than claiming NOMINAL.
 */
export function deriveBanner(counts: GibsonCounts): GibsonBanner {
  const items: GibsonBannerItem[] = [];
  const failedAgents = counts.byStatus.failed;
  if (failedAgents > 0) items.push({ key: "failed-agents", count: failedAgents, label: plural(failedAgents, "agent failed", "agents failed"), tone: "red" });
  if (counts.failedTasks > 0) items.push({ key: "failed-tasks", count: counts.failedTasks, label: plural(counts.failedTasks, "task failed", "tasks failed"), tone: "red" });
  if (counts.byStatus.waiting > 0) items.push({ key: "waiting", count: counts.byStatus.waiting, label: plural(counts.byStatus.waiting, "agent waiting", "agents waiting"), tone: "amber" });
  if (counts.needsYou !== null && counts.needsYou > 0) items.push({ key: "needs-you", count: counts.needsYou, label: plural(counts.needsYou, "needs you", "need you"), tone: "amber" });
  if (counts.reviewTasks > 0) items.push({ key: "review", count: counts.reviewTasks, label: `${counts.reviewTasks} in review`, tone: "cyan" });
  if (counts.byStatus.offline > 0) items.push({ key: "offline", count: counts.byStatus.offline, label: `${counts.byStatus.offline} offline`, tone: "gray" });

  if (failedAgents > 0 || counts.failedTasks > 0) return { level: "critical", headline: "Failures need attention", items };
  if (counts.byStatus.waiting > 0 || (counts.needsYou ?? 0) > 0) return { level: "attention", headline: "Needs you", items };
  if (counts.needsYou === null) return { level: "unknown", headline: "No failures · progress feed unavailable", items };
  return { level: "nominal", headline: "All systems nominal", items };
}

export function aggregate({ fleet, tasks: tasksPayload, progress, now = Date.now() }: GibsonInputs): GibsonSceneModel {
  const tasks = tasksPayload.tasks ?? [];
  const openTasks = tasks.filter((t) => isOpenTask(t, now));
  const doneTasks = tasks.filter((t) => isRecentDoneTask(t, now));
  const byProject = new Map<string, { open: Array<Task & { status: GibsonFloorStatus }>; done: Array<Task & { status: "done" }> }>();
  const bucket = (p: string) => {
    const b = byProject.get(p) ?? { open: [], done: [] };
    byProject.set(p, b);
    return b;
  };
  for (const t of openTasks) bucket(t.project ?? "unrouted").open.push(t);
  for (const t of doneTasks) bucket(t.project ?? "unrouted").done.push(t);
  for (const agent of fleet.agents) {
    const p = agent.current_session?.project;
    if (p) bucket(p);
  }

  const sessionProjects = new Map<string, string>();
  for (const agent of fleet.agents) for (const s of sessionsOf(agent)) if (s.project) sessionProjects.set(s.id, s.project);
  const heatByProject = new Map<string, number>();
  for (const e of fleet.events) {
    if (!e.session_id || e.kind === "heartbeat") continue;
    const age = now - Date.parse(e.created_at);
    if (!Number.isFinite(age) || age < 0 || age > HEAT_WINDOW_MS) continue;
    const p = sessionProjects.get(e.session_id);
    if (p) heatByProject.set(p, (heatByProject.get(p) ?? 0) + 1);
  }

  const sorted = [...byProject.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const usedSlugs = new Map<string, number>();
  const idByLabel = new Map<string, string>();
  for (const [label] of sorted) {
    const base = slugify(label) || "project";
    const n = usedSlugs.get(base) ?? 0;
    usedSlugs.set(base, n + 1);
    idByLabel.set(label, n === 0 ? base : `${base}-${n + 1}`);
  }

  const towers: GibsonTower[] = sorted.map(([label, b], index) => {
    const done = [...b.done]
      .sort((x, y) => Date.parse(completedAt(y)) - Date.parse(completedAt(x)) || y.id - x.id)
      .slice(0, MAX_DONE_FLOORS)
      .reverse()
      .map(toFloor);
    const open = [...b.open]
      .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))
      .slice(0, MAX_OPEN_FLOORS)
      .sort((x, y) => x.priority - y.priority || Date.parse(x.created_at) - Date.parse(y.created_at))
      .map(toFloor);
    return {
      id: idByLabel.get(label) ?? slugify(label),
      label,
      ...towerPosition(index),
      floors: [...done, ...open],
      activeAgents: fleet.agents.filter(
        (a) => normalizeAgentStatus(a.derived_status) === "active" && a.current_session?.project === label,
      ).length,
      heat: Math.min((heatByProject.get(label) ?? 0) / 10, 1),
    };
  });
  const towerIds = new Set(towers.map((t) => t.id));
  const towerExtent = towers.reduce((m, t) => Math.max(m, Math.hypot(t.gridX, t.gridZ) + 1.6), 0);

  // Every agent Fleet knows is drawn — no agent is ever dropped for lacking a
  // project, a tower, or a platform we have a shape for.
  const agentsSorted = [...fleet.agents].sort((a, b) => {
    const ma = a.machine ?? UNASSIGNED_MACHINE;
    const mb = b.machine ?? UNASSIGNED_MACHINE;
    return ma.localeCompare(mb) || a.platform.localeCompare(b.platform) || (a.display_name ?? a.id).localeCompare(b.display_name ?? b.id);
  });
  const { docks, machines, ringRadius } = layoutDocks(
    agentsSorted.map((a) => ({ id: a.id, machine: a.machine ?? UNASSIGNED_MACHINE })),
    towerExtent,
  );

  const openTaskByAgent = new Map<string, Task>();
  for (const t of [...openTasks].sort((a, b) => a.priority - b.priority)) {
    if (t.assigned_agent && !openTaskByAgent.has(t.assigned_agent)) openTaskByAgent.set(t.assigned_agent, t);
  }

  const orbs: GibsonAgentOrb[] = agentsSorted.map((agent) => {
    const status = normalizeAgentStatus(agent.derived_status);
    const sessions = sessionsOf(agent);
    const latest = agent.current_session ?? sessions[0] ?? null;
    const project = agent.current_session?.project ?? null;
    const candidate = project ? idByLabel.get(project) ?? null : null;
    const attached = (status === "active" || status === "waiting") && candidate !== null && towerIds.has(candidate);
    const jobs: GibsonAgentJob[] = sessions.slice(0, 8).map((s) => ({
      sessionId: s.id,
      project: s.project,
      towerId: s.project ? idByLabel.get(s.project) ?? null : null,
      status: s.status,
      summary: s.summary,
      startedAt: s.started_at,
      endedAt: s.ended_at,
    }));
    const task = openTaskByAgent.get(agent.id);
    // A task outlives its session unless someone clears assigned_agent, so an idle
    // agent only "has" the task as an assignment, not as current work.
    const working = status === "active" || status === "waiting" || status === "failed";
    const machine = agent.machine ?? UNASSIGNED_MACHINE;
    const label = agent.display_name ?? agent.id;
    const dock = docks.get(agent.id) ?? { x: 0, z: 0 };
    return {
      id: agent.id,
      label,
      shortLabel: shortLabel(label, agent.machine),
      platform: agent.platform,
      shape: platformShape(agent.platform),
      machine,
      status,
      towerId: attached ? candidate : null,
      project: latest?.project ?? null,
      summary: latest?.summary ?? null,
      sessionId: latest?.id ?? null,
      sessionStartedAt: latest?.started_at ?? null,
      lastSeenAt: agent.last_seen_at,
      pendingMessages: agent.pending_messages ?? 0,
      unreadReplies: agent.unread_replies ?? 0,
      currentTask: task && working ? { id: task.id, title: task.title, status: task.status as GibsonFloorStatus } : null,
      assignedTask: task && !working ? { id: task.id, title: task.title, status: task.status as GibsonFloorStatus } : null,
      jobs,
      dockX: dock.x,
      dockZ: dock.z,
    };
  });

  // Review handoffs go to a reviewer agent of that platform; a stream with no
  // drawable target is dropped so the "streams" count matches the scene.
  const streams: GibsonStream[] = openTasks.flatMap((task) => {
    if (task.status !== "review" || !task.reviewer_platform) return [];
    const fromTowerId = idByLabel.get(task.project ?? "unrouted");
    if (!fromTowerId || !towerIds.has(fromTowerId)) return [];
    const reviewers = orbs.filter((o) => o.platform === task.reviewer_platform);
    const target = reviewers.find((o) => o.status === "active") ?? reviewers.find((o) => o.status !== "offline") ?? reviewers[0];
    if (!target) return [];
    return [{ id: `stream-${task.id}`, fromTowerId, toPlatform: task.reviewer_platform, toAgentId: target.id, taskId: task.id }];
  });

  const partial = { towers, orbs, streams, machines };
  const counts = deriveCounts(partial, progress ? progress.alerts.length : null);
  return {
    demo: Boolean(fleet.demo || tasksPayload.demo),
    ...partial,
    ringRadius,
    counts,
    banner: deriveBanner(counts),
    generatedAt: fleet.generated_at,
  };
}
