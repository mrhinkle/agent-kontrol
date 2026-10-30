/**
 * Who made a write, taken from the authenticated principal.
 *
 * Request fields such as created_by, actor_type, and actor_id are not read
 * here. A caller can still store a free-text created_by label; it is not
 * the actor.
 *
 * dev-open is not a signed-in person. The dashboard password is unset and
 * the request presented no credential, so the write stores null actor
 * fields. Recording human/operator there would be a false audit record.
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
const principalStorage = new AsyncLocalStorage<Principal>();

/** Authenticated reporter recorded on an event. Never read from a request body. */
export interface Provenance {
  principal_kind: "legacy" | "agent" | "oauth" | "session";
  principal_id: string;
}

/** Null when the caller is dev-open: allowed, but not an authenticated actor. */
export function actorFromPrincipal(principal: Principal): Actor | null {
  switch (principal.kind) {
    case "agent":
      return { actor_type: "agent", actor_id: principal.id };
    case "oauth":
      return { actor_type: "agent", actor_id: principal.id };
    case "legacy":
      return { actor_type: "agent", actor_id: LEGACY_ACTOR_ID };
    case "session":
      return { actor_type: "human", actor_id: DASHBOARD_ACTOR_ID };
    case "dev-open":
      return null;
  }
}

/** MCP tool handlers read the actor for the request that invoked them. */
export function runWithActor<T>(actor: Actor | null, fn: () => T): T {
  if (!actor) return fn();
  return storage.run(actor, fn);
}

export function currentActor(): Actor | null {
  return storage.getStore() ?? null;
}

/**
 * Null for dev-open: allowed, but nobody authenticated, so the event stays
 * unmeasured for consumer liveness. Ids use the actor vocabulary above.
 */
export function provenanceFromPrincipal(principal: Principal | null | undefined): Provenance | null {
  if (!principal) return null;
  switch (principal.kind) {
    case "legacy":
      return { principal_kind: "legacy", principal_id: LEGACY_ACTOR_ID };
    case "session":
      return { principal_kind: "session", principal_id: DASHBOARD_ACTOR_ID };
    case "agent":
      return principal.id ? { principal_kind: "agent", principal_id: principal.id } : null;
    case "oauth":
      return principal.id ? { principal_kind: "oauth", principal_id: principal.id } : null;
    case "dev-open":
      return null;
  }
}

/** MCP requests: the actor and the verified principal for the handlers below. */
export function runWithPrincipal<T>(principal: Principal, fn: () => T): T {
  return principalStorage.run(principal, () => runWithActor(actorFromPrincipal(principal), fn));
}

export function currentPrincipal(): Principal | null {
  return principalStorage.getStore() ?? null;
}
