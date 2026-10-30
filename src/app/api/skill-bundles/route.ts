import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
import { enforceApi } from "@/lib/auth";
import { archiveFiles, buildBundle, loadExportSkills, parseExportQuery, skippedHeader } from "@/lib/skills/formats/bundle";
import { tarGzip } from "@/lib/skills/formats/tar";

export const dynamic = "force-dynamic";

/**
 * GET /api/skill-bundles?runtime=hermes&lane=
 * Operator route. A dashboard session or MC_TOKEN. An agent credential
 * cannot call it. There is no agent scope for it.
 * The body is a gzip-compressed tar of the skill tree for that runtime.
 * Visibility is the list_skills check: trigger off is omitted, a trigger
 * outside the supported set is omitted and reported as invalid trigger, and
 * a selected scope is omitted unless lane admits it.
 * Every omission is one {skill, path?, reason} entry. When that list is not
 * empty, manifest.json holds all of it. x-ak-skipped carries the count and
 * the first 20 entries, at most 4 KB, and says see manifest.json.
 * A path tarGzip cannot represent throws, and this route answers 500.
 */

export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  const parsed = parseExportQuery(req.url);
  if (!parsed.ok) {
    return apiError("validation_failed", {
      message: parsed.message,
      fields: { [parsed.field]: parsed.message },
    });
  }
  try {
    const loaded = await loadExportSkills();
    const built = buildBundle(loaded.skills, parsed.filter);
    const bytes = tarGzip(archiveFiles(built));
    const filename = `skills-${parsed.filter.runtime}.tar.gz`;
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
        "x-ak-demo": loaded.demo ? "true" : "false",
        "x-ak-skipped": skippedHeader(built.skipped),
      },
    });
  } catch (err) {
    return publicError("[skills] export failed", err);
  }
}
