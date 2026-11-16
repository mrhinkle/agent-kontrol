import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
import { deny, resolveApiAccess } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { validateOwnerName } from "@/lib/owner-validation";
import { isRfc3339, parseCollectorSweptAt, type GhListedRepo } from "@/lib/owner-discovery";
import { loadTrackedRepos } from "@/lib/watched-repos";
import type { DiscoveryFailureCode } from "@/lib/owner-discovery";
import {
  applyOwnerDiscovery,
  DiscoveryShortConflict,
  listWatchedOwners,
  ruleOf,
  sweepOf,
  type DiscoveryRequest,
} from "@/lib/watched-owners";

export const dynamic = "force-dynamic";

/**
 * One collector tick of `gh repo list` results.
 *
 * POST /api/settings/owners/discover  { results: [{ owner, ok, error?, repos?, truncated? }] }
 *
 * Auth matches PUT /api/settings/repos. A result that failed, was rate
 * limited, or listed zero repos records last_error and does not change
 * tracked repos. The same auth as settings writes; this route does not
 * replace the actor who saved the owner.
 */

const NAME_RE = /^[\w.-]+$/;

type DiscoveryItemCode = DiscoveryFailureCode | "owner_not_watched" | "discovery_not_configured" | "short_name_conflict";

const ITEM_TEACHING: Record<DiscoveryItemCode, { fix: string; retryable: boolean }> = {
  owner_not_watched: {
    fix: "Watch this owner in owner settings, or send a sweep for an owner that is already watched.",
    retryable: false,
  },
  collection_failed: {
    fix: "Retry the tick after the collector can list repositories. This sweep did not change tracked repos.",
    retryable: true,
  },
  empty_listing: {
    fix: "Retry the tick with the repositories the collector found. An empty list is not a completed sweep.",
    retryable: true,
  },
  invalid_listing: {
    fix: "Correct the listing and send the tick again. A value that is not safe to store was not applied.",
    retryable: false,
  },
  owner_removed: {
    fix: "Read owner settings again. This owner was removed before the sweep was saved.",
    retryable: false,
  },
  rule_changed: {
    fix: "Read owner settings again and send a new sweep. The discovery rule changed before this sweep was saved.",
    retryable: false,
  },
  discovery_not_configured: {
    fix: "Configure owner discovery storage, then retry the tick. This is not a transient client error.",
    retryable: false,
  },
  short_name_conflict: {
    fix: "Retry the tick.",
    retryable: true,
  },
};

function itemTeaching(code: DiscoveryItemCode, cause: string, fix?: string) {
  const known = ITEM_TEACHING[code];
  return {
    code,
    cause,
    fix: fix ?? known.fix,
    retryable: known.retryable,
  };
}

function parseRepos(raw: unknown): { ok: true; repos: GhListedRepo[] } | { ok: false; error: string; status?: 400 } {
  if (!Array.isArray(raw)) return { ok: false, error: "repos must be an array" };
  const repos: GhListedRepo[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "a repo entry was not an object" };
    }
    const row = item as Record<string, unknown>;
    if (typeof row.name !== "string" || !NAME_RE.test(row.name) || row.name.length > 100) {
      return { ok: false, error: "a repo name was not safe to store" };
    }
    const nameKey = row.name.toLowerCase();
    if (seen.has(nameKey)) {
      return { ok: false, status: 400, error: "A repo name was repeated with different casing." };
    }
    seen.add(nameKey);
    if (row.pushedAt != null && (typeof row.pushedAt !== "string" || !isRfc3339(row.pushedAt))) {
      return { ok: false, status: 400, error: "pushedAt must be an RFC 3339 timestamp or null." };
    }
    if (typeof row.isArchived !== "boolean" || typeof row.isFork !== "boolean") {
      return { ok: false, error: "isArchived and isFork must be booleans" };
    }
    repos.push({
      name: row.name,
      pushedAt: row.pushedAt ?? null,
      isArchived: row.isArchived,
      isFork: row.isFork,
    });
  }
  return { ok: true, repos };
}

/** Every discovery 409, including a short-name conflict, uses this body. */
function discoveryConflictResponse(
  parsed: DiscoveryRequest[],
  message: string,
  fix: string,
  error: string,
  itemCode: "discovery_not_configured" | "short_name_conflict",
) {
  const empty: string[] = [];
  const teaching = itemTeaching(itemCode, error, itemCode === "discovery_not_configured" ? fix : undefined);
  return apiError("conflict", {
    message,
    fix,
    extra: {
      results: parsed.map((item) => ({
        owner: item.owner,
        ok: false as const,
        error,
        added: [...empty],
        updated: [...empty],
        marked_gone: [...empty],
        ...teaching,
      })),
      added: [...empty],
      updated: [...empty],
      marked_gone: [...empty],
    },
  });
}

function parseResult(raw: unknown, now: Date): { ok: true; request: DiscoveryRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Each result must be an object." };
  }
  const row = raw as Record<string, unknown>;
  const name = validateOwnerName(row.owner);
  if (!name.ok) return { ok: false, error: name.message };
  if (typeof row.ok !== "boolean") return { ok: false, error: "ok must be true or false." };
  const error = row.error == null ? null : typeof row.error === "string" ? row.error : null;
  if (row.error != null && typeof row.error !== "string") return { ok: false, error: "error must be a string." };
  // A malformed flag must not read as a complete listing: that would mark absent repos gone.
  if (row.truncated !== undefined && typeof row.truncated !== "boolean") {
    return { ok: false, error: "truncated must be true or false." };
  }
  const swept = parseCollectorSweptAt(row.swept_at, now);
  if (!swept.ok) return { ok: false, error: swept.error };
  if (!row.ok) {
    return {
      ok: true,
      request: { owner: name.owner, ok: false, error, sweptAt: swept.sweptAt, failureCode: "collection_failed" },
    };
  }
  const repos = parseRepos(row.repos);
  if (!repos.ok) {
    if (repos.status === 400) return { ok: false, error: repos.error };
    return {
      ok: true,
      request: {
        owner: name.owner,
        ok: false,
        error: repos.error,
        sweptAt: swept.sweptAt,
        failureCode: "invalid_listing",
      },
    };
  }
  return {
    ok: true,
    request: {
      owner: name.owner,
      ok: true,
      error,
      repos: repos.repos,
      truncated: row.truncated === true,
      sweptAt: swept.sweptAt,
    },
  };
}

export async function POST(req: Request) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_json", { message: "Request body must be JSON.", fields: { results: "Request body must be JSON." } });
  }
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    return apiError("validation_failed", {
      message: "Expected results, a list of owner sweeps.",
      fields: { results: "Expected an array." },
    });
  }
  const now = new Date();
  const parsed: DiscoveryRequest[] = [];
  for (const item of results) {
    const one = parseResult(item, now);
    if (!one.ok) {
      return apiError("validation_failed", { message: one.error, fields: { results: one.error } });
    }
    parsed.push(one.request);
  }
  const seen = new Set<string>();
  for (const item of parsed) {
    if (seen.has(item.owner)) {
      return apiError("validation_failed", {
        message: "Each owner may appear once in a discovery request.",
        fields: { results: "Duplicate owner in results." },
      });
    }
    seen.add(item.owner);
  }
  if (!isConfigured()) {
    return discoveryConflictResponse(
      parsed,
      "Owner discovery can only be saved when a database is connected.",
      "Connect a database (DATABASE_URL) and retry the tick.",
      "no database",
      "discovery_not_configured",
    );
  }
  try {
    const listed = await listWatchedOwners();
    if (!listed.writable) {
      return discoveryConflictResponse(
        parsed,
        "Owner discovery can only be saved after the owner store exists.",
        "Apply supabase/migrations/20261028_watched_owners.sql, then retry the tick.",
        "owner store is not writable",
        "discovery_not_configured",
      );
    }
    const owners = listed.owners;
    let existing = await loadTrackedRepos();
    const out = [];
    for (const item of parsed) {
      const stored = owners.find((owner) => owner.owner === item.owner);
      if (!stored) {
        out.push({
          owner: item.owner,
          ok: false,
          error: "owner is not watched",
          added: 0,
          updated: 0,
          marked_gone: 0,
          ...itemTeaching("owner_not_watched", "owner is not watched"),
        });
        continue;
      }
      const outcome = await applyOwnerDiscovery(ruleOf(stored), existing, sweepOf(item), now);
      if (!outcome.failure) existing = outcome.repos;
      const failed = outcome.failure !== null;
      out.push({
        owner: item.owner,
        ok: !failed,
        error: outcome.failure ?? outcome.warning,
        ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
        added: outcome.added.length,
        updated: outcome.updated.length,
        marked_gone: outcome.markedGone.length,
        ...(failed ? itemTeaching(outcome.failureCode ?? "collection_failed", outcome.failure ?? "") : {}),
      });
    }
    return NextResponse.json({ results: out });
  } catch (e) {
    if (e instanceof DiscoveryShortConflict) {
      return discoveryConflictResponse(
        parsed,
        "Discovery could not allocate a unique short name.",
        "Retry the tick.",
        "short name conflict",
        "short_name_conflict",
      );
    }
    return publicError("[settings/owners/discover] apply failed", e, "Could not apply discovery.");
  }
}
