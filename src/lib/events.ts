import type { Event } from "./types";

/** Event kinds that only say "still alive". They carry no story and drown out the timeline. */
const HEARTBEAT_KINDS = new Set(["heartbeat", "ping", "keepalive", "alive"]);

/** Machine telemetry (e.g. "Hermes collector health", "Hermes tool observed"), reported every few seconds. */
const TELEMETRY_KINDS = new Set(["telemetry"]);

export function isHeartbeat(e: Pick<Event, "kind" | "title">): boolean {
  const kind = (e.kind ?? "").toLowerCase();
  if (HEARTBEAT_KINDS.has(kind)) return true;
  // Some collectors report heartbeats as a generic status with a heartbeat title.
  const title = (e.title ?? "").trim().toLowerCase();
  return kind === "status" && (title === "heartbeat" || title === "alive");
}

/** Background noise: heartbeats plus collector telemetry. Hidden by default in feeds. */
export function isBackground(e: Pick<Event, "kind" | "title">): boolean {
  return isHeartbeat(e) || TELEMETRY_KINDS.has((e.kind ?? "").toLowerCase());
}
