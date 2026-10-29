import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
import { enforceApi } from "@/lib/auth";
import { bundleGzip, loadExportSkills, parseExportQuery } from "@/lib/skills/formats/bundle";

export const dynamic = "force-dynamic";

/**
 * GET /api/skills/export?runtime=hermes&lane=
 * Operator route. An agent credential cannot call it. There is no agent scope
 * for it. The body is a gzip-compressed tar of the skill tree for that runtime.
 * Visibility matches list_skills: trigger off is omitted, and a selected scope
 * is omitted unless lane admits it.
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
    const bytes = bundleGzip(loaded.skills, parsed.filter);
    const filename = `skills-${parsed.filter.runtime}.tar.gz`;
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
        "x-ak-demo": loaded.demo ? "true" : "false",
      },
    });
  } catch (err) {
    return publicError("[skills] export failed", err);
  }
}
