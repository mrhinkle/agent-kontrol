/**
 * Who made a write, taken from the authenticated principal.
 *
 * Request fields such as created_by, actor_type, and actor_id are not read
 * here. A caller can still store a free-text created_by label; it is not
 * the actor.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Principal } from "./scopes";

export type ActorType = "human" | "agent";

export interface Actor {
  actor_type: ActorType;
  actor_id: string;
}

/** The single dashboard account. There is no per-user id. */
export const DASHBOARD_ACTOR_ID = "operator";

/** Shared MC_TOKEN. It is an agent credential, not a signed-in person. */
export const LEGACY_ACTOR_ID = "mc-token";

const storage = new AsyncLocalStorage<Actor>();

export function actorFromPrincipal(principal: Principal): Actor {
  switch (principal.kind) {
    case "agent":
      return { actor_type: "agent", actor_id: principal.id };
    case "oauth":
      return { actor_type: "agent", actor_id: principal.id };
    case "legacy":
      return { actor_type: "agent", actor_id: LEGACY_ACTOR_ID };
    case "session":
    case "dev-open":
      return { actor_type: "human", actor_id: DASHBOARD_ACTOR_ID };
  }
}

/** MCP tool handlers read the actor for the request that invoked them. */
export function runWithActor<T>(actor: Actor, fn: () => T): T {
  return storage.run(actor, fn);
}

export function currentActor(): Actor | null {
  return storage.getStore() ?? null;
}
