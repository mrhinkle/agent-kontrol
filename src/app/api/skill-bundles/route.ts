import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
import { enforceApi } from "@/lib/auth";
import { archiveFiles, buildBundle, loadExportSkills, parseExportQuery } from "@/lib/skills/formats/bundle";
import { tarGzip } from "@/lib/skills/formats/tar";

export const dynamic = "force-dynamic";

/**
 * GET /api/skill-bundles?runtime=hermes&lane=
 * Operator route. A dashboard session or MC_TOKEN. An agent credential
 * cannot call it. There is no agent scope for it.
 * The body is a gzip-compressed tar of the skill tree for that runtime.
 * Visibility matches list_skills: trigger off is omitted, and a selected
 * scope is omitted unless lane admits it.
 * Skills left out are listed in x-ak-skipped and, when any were left out,
 * in manifest.json. The archive has one entry per path.
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
        "x-ak-skipped": JSON.stringify(built.skipped),
      },
    });
  } catch (err) {
    return publicError("[skills] export failed", err);
  }
}
