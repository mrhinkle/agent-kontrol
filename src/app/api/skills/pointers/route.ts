import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
import { enforceApi } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { applyPointerBlock, MalformedBlockError } from "@/lib/skills/agents-md";
import { renderLaneSkillPointers } from "@/lib/skills/inject";
import { isRuntime, runtimeMustBeMessage } from "@/lib/skills/types";

export const dynamic = "force-dynamic";

const MAX_AGENTS_MD = 1_000_000;
const LANE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

/**
 * GET  /api/skills/pointers?lane=&runtime=&format=json|text
 * POST /api/skills/pointers  { lane, runtime, agents_md? }
 * Auth: enforceApi. Agent credentials need skills:read. Both are read-only:
 * nothing is stored, and POST returns the file content and writes no file.
 * GET returns the rendered block ("" when no skill matches). POST applies it
 * to the AGENTS.md text you send and returns the new text. A missing file is
 * agents_md omitted or null.
 */
export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const checked = checkTarget(url.searchParams.get("lane"), url.searchParams.get("runtime"));
  if (!checked.ok) return checked.response;
  const format = url.searchParams.get("format");
  if (format != null && format !== "json" && format !== "text") {
    return apiError("validation_failed", { message: "invalid format", fields: { format: "format must be json or text." } });
  }
  try {
    const block = await renderLaneSkillPointers({ lane: checked.lane, runtime: checked.runtime });
    if (format === "text") {
      return new NextResponse(block === "" ? "" : `${block}\n`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return NextResponse.json({ demo: !isConfigured(), lane: checked.lane, runtime: checked.runtime, empty: block === "", block });
  } catch (err) {
    return publicError("[skills] pointers failed", err);
  }
}

export async function POST(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError("validation_failed", { message: "body must be an object", fields: { body: "Send a JSON object." } });
  }
  const input = body as Record<string, unknown>;
  const checked = checkTarget(input.lane, input.runtime);
  if (!checked.ok) return checked.response;
  const file = input.agents_md;
  if (file != null && typeof file !== "string") {
    return apiError("validation_failed", { message: "invalid agents_md", fields: { agents_md: "agents_md must be a string or null." } });
  }
  if (typeof file === "string" && file.length > MAX_AGENTS_MD) {
    return apiError("validation_failed", { message: "agents_md too large", fields: { agents_md: `agents_md must be at most ${MAX_AGENTS_MD} characters.` } });
  }
  try {
    const block = await renderLaneSkillPointers({ lane: checked.lane, runtime: checked.runtime });
    const applied = applyPointerBlock(file, block);
    return NextResponse.json({
      demo: !isConfigured(),
      lane: checked.lane,
      runtime: checked.runtime,
      empty: block === "",
      changed: applied.changed,
      content: applied.content,
    });
  } catch (err) {
    if (err instanceof MalformedBlockError) {
      const detail = "agents_md has an unpaired or nested ak-skills marker. Fix or remove it by hand.";
      return apiError("validation_failed", { message: detail, fields: { agents_md: detail } });
    }
    return publicError("[skills] pointers failed", err);
  }
}

function checkTarget(
  lane: unknown,
  runtime: unknown,
): { ok: true; lane: string; runtime: string } | { ok: false; response: NextResponse } {
  const fields: Record<string, string> = {};
  if (typeof lane !== "string" || !LANE_RE.test(lane)) fields.lane = "lane is required: 1-100 characters of letters, digits, and . _ : / -.";
  if (typeof runtime !== "string" || !isRuntime(runtime)) fields.runtime = runtimeMustBeMessage();
  if (Object.keys(fields).length > 0) {
    return { ok: false, response: apiError("validation_failed", { message: "invalid lane or runtime", fields }) };
  }
  return { ok: true, lane: lane as string, runtime: runtime as string };
}
