import { NextResponse } from "next/server";
import { actorFromPrincipal } from "@/lib/actor";
import { apiError, publicError } from "@/lib/api-error";
import { deny, resolveApiAccess } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { diffOwnerList, readDryRun } from "@/lib/dry-run";
import { MAX_OWNERS, validateOwnerList, type OwnerError, type OwnerInput } from "@/lib/owner-validation";
import { listWatchedOwners, ownerListVersion, replaceWatchedOwners } from "@/lib/watched-owners";

export const dynamic = "force-dynamic";

/**
 * GitHub owners whose repos the collector discovers.
 *
 * GET  /api/settings/owners
 * PUT  /api/settings/owners  { owners: [...], version?: string, dry_run?: boolean }
 *
 * Auth matches PUT /api/settings/repos: dashboard session or MC_TOKEN.
 * An agent credential is denied. The actor on each row is the principal,
 * never a field in the body. dev-open stores null actor fields.
 * Removing an owner does not delete repos already tracked for them.
 */

function ownerFields(errors: OwnerError[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const row of errors) {
    const key = row.index < 0 ? row.field : `${row.index}.${row.field}`;
    fields[key] = fields[key] ? `${fields[key]} ${row.message}` : row.message;
  }
  return fields;
}

function failure(e: unknown, what: string) {
  return publicError(`[settings/owners] ${what}`, e, `Could not ${what}.`);
}

function notReady(fix: string) {
  return apiError("conflict", {
    message: "Owners can only be saved when a database is connected.",
    fix,
  });
}

async function current() {
  const listed = await listWatchedOwners();
  return {
    writable: listed.writable,
    max: MAX_OWNERS,
    version: ownerListVersion(listed.owners),
    owners: listed.owners.map((owner) => ({
      owner: owner.owner,
      activity_days: owner.activityDays,
      include_forks: owner.includeForks,
      include_archived: owner.includeArchived,
      last_error: owner.lastError,
      last_error_at: owner.lastErrorAt,
      last_discovered_at: owner.lastDiscoveredAt,
      actor_type: owner.actorType,
      actor_id: owner.actorId,
    })),
  };
}

function asOwnerInput(cur: Awaited<ReturnType<typeof current>>): OwnerInput[] {
  return cur.owners.map((owner) => ({
    owner: owner.owner,
    activityDays: owner.activity_days,
    includeForks: owner.include_forks,
    includeArchived: owner.include_archived,
  }));
}

export async function GET(req: Request) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  if (!isConfigured()) {
    return NextResponse.json({ writable: false, max: MAX_OWNERS, version: ownerListVersion([]), owners: [] });
  }
  try {
    return NextResponse.json(await current());
  } catch (e) {
    return failure(e, "load owners");
  }
}

export async function PUT(req: Request) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const row = { index: -1, field: "owners" as const, message: "Request body must be JSON." };
    return apiError("invalid_json", {
      message: row.message,
      fields: { owners: row.message },
      extra: { errors: [row] },
    });
  }
  const checked = validateOwnerList((body as { owners?: unknown } | null)?.owners);
  if (!checked.ok) {
    return apiError("validation_failed", {
      message: checked.errors[0]?.message ?? "The owner list is invalid.",
      fields: ownerFields(checked.errors),
      extra: { errors: checked.errors },
    });
  }
  const dry = readDryRun((body as { dry_run?: unknown } | null)?.dry_run);
  if (!dry.ok) {
    return apiError("validation_failed", {
      message: "dry_run must be a boolean.",
      fields: { dry_run: "Use true to preview, or false to save." },
    });
  }
  if (!isConfigured()) {
    if (dry.dryRun) {
      try {
        const cur = await current();
        return NextResponse.json(diffOwnerList(asOwnerInput(cur), checked.owners, false));
      } catch (e) {
        return failure(e, "load owners");
      }
    }
    return notReady("Connect a database (DATABASE_URL) and retry the save.");
  }
  try {
    const sent = (body as { version?: unknown } | null)?.version;
    const cur = await current();
    if (!cur.writable) {
      if (dry.dryRun) return NextResponse.json(diffOwnerList(asOwnerInput(cur), checked.owners, false));
      return notReady("Apply supabase/migrations/20261028_watched_owners.sql, then retry the save.");
    }
    // A mismatch here is enough for a dry run, which writes nothing. A real
    // save checks the version again under the owner-list lock.
    if (typeof sent === "string" && sent !== cur.version) {
      return apiError("stale");
    }
    if (dry.dryRun) {
      return NextResponse.json(diffOwnerList(asOwnerInput(cur), checked.owners, true));
    }
    const saved = await replaceWatchedOwners(
      checked.owners,
      actorFromPrincipal(access.principal),
      typeof sent === "string" ? sent : undefined,
    );
    if (!saved.ok) {
      if (saved.reason === "stale") return apiError("stale");
      return notReady("Apply supabase/migrations/20261028_watched_owners.sql, then retry the save.");
    }
    return NextResponse.json(await current());
  } catch (e) {
    return failure(e, "save owners");
  }
}
