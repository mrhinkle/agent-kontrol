import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
import { deny, resolveApiAccess } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { validateOwnerName } from "@/lib/owner-validation";
import type { GhListedRepo } from "@/lib/owner-discovery";
import { loadTrackedRepos } from "@/lib/watched-repos";
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

function parseRepos(raw: unknown): { ok: true; repos: GhListedRepo[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "repos must be an array" };
  const repos: GhListedRepo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "a repo entry was not an object" };
    }
    const row = item as Record<string, unknown>;
    if (typeof row.name !== "string" || !NAME_RE.test(row.name) || row.name.length > 100) {
      return { ok: false, error: "a repo name was not safe to store" };
    }
    if (row.pushedAt != null && typeof row.pushedAt !== "string") {
      return { ok: false, error: "pushedAt must be a string or null" };
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

function parseSweptAt(raw: unknown): { ok: true; sweptAt: string } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: false, error: "swept_at is required." };
  if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
    return { ok: false, error: "swept_at must be an ISO timestamp." };
  }
  return { ok: true, sweptAt: new Date(raw).toISOString() };
}

function parseResult(raw: unknown): { ok: true; request: DiscoveryRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Each result must be an object." };
  }
  const row = raw as Record<string, unknown>;
  const name = validateOwnerName(row.owner);
  if (!name.ok) return { ok: false, error: name.message };
  if (typeof row.ok !== "boolean") return { ok: false, error: "ok must be true or false." };
  const error = row.error == null ? null : typeof row.error === "string" ? row.error : null;
  if (row.error != null && typeof row.error !== "string") return { ok: false, error: "error must be a string." };
  const swept = parseSweptAt(row.swept_at);
  if (!swept.ok) return { ok: false, error: swept.error };
  if (!row.ok) return { ok: true, request: { owner: name.owner, ok: false, error, sweptAt: swept.sweptAt } };
  const repos = parseRepos(row.repos);
  if (!repos.ok) return { ok: true, request: { owner: name.owner, ok: false, error: repos.error, sweptAt: swept.sweptAt } };
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
  const parsed: DiscoveryRequest[] = [];
  for (const item of results) {
    const one = parseResult(item);
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
    return apiError("conflict", {
      message: "Owner discovery can only be saved when a database is connected.",
      fix: "Connect a database (DATABASE_URL) and retry the tick.",
      extra: {
        results: parsed.map((item) => ({ owner: item.owner, ok: false, error: "no database" })),
      },
    });
  }
  try {
    const listed = await listWatchedOwners();
    if (!listed.writable) {
      return apiError("conflict", {
        message: "Owner discovery can only be saved after the owner store exists.",
        fix: "Apply supabase/migrations/20261028_watched_owners.sql, then retry the tick.",
        extra: {
          results: parsed.map((item) => ({
            owner: item.owner,
            ok: false,
            error: "owner store is not writable",
            added: 0,
            updated: 0,
            marked_gone: 0,
          })),
        },
      });
    }
    const owners = listed.owners;
    let existing = await loadTrackedRepos();
    const now = new Date();
    const out = [];
    for (const item of parsed) {
      const stored = owners.find((owner) => owner.owner === item.owner);
      if (!stored) {
        out.push({ owner: item.owner, ok: false, error: "owner is not watched", added: 0, updated: 0, marked_gone: 0 });
        continue;
      }
      const outcome = await applyOwnerDiscovery(ruleOf(stored), existing, sweepOf(item), now);
      if (!outcome.failure) existing = outcome.repos;
      out.push({
        owner: item.owner,
        ok: outcome.failure === null,
        error: outcome.failure ?? outcome.warning,
        ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
        added: outcome.added.length,
        updated: outcome.updated.length,
        marked_gone: outcome.markedGone.length,
      });
    }
    return NextResponse.json({ results: out });
  } catch (e) {
    if (e instanceof DiscoveryShortConflict) {
      return apiError("conflict", {
        message: "Discovery could not allocate a unique short name.",
        fix: "Retry the tick.",
      });
    }
    return publicError("[settings/owners/discover] apply failed", e, "Could not apply discovery.");
  }
}
