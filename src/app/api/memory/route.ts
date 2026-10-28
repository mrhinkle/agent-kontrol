import { NextResponse } from "next/server";
import { enforceApi } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { diffMemoryWrite, readDryRun } from "@/lib/dry-run";
import { previewMemoryWrite } from "@/lib/dry-run-actions";
import { recall, remember } from "@/lib/store";
import { demoMemory } from "@/lib/demo-data";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** GET /api/memory?query=&tag=&limit= — memory browser feed for the dashboard. */
export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  if (!isConfigured()) {
    return NextResponse.json({ demo: true, items: demoMemory() });
  }
  const url = new URL(req.url);
  try {
    const items = await recall({
      query: url.searchParams.get("query") ?? undefined,
      tags: url.searchParams.get("tag") ? [url.searchParams.get("tag")!] : undefined,
      limit: Number(url.searchParams.get("limit") ?? 50),
    });
    return NextResponse.json({ demo: false, items });
  } catch (e) {
    return publicError("[memory]", e);
  }
}

/**
 * POST /api/memory { content, key?, tags?, agent_id?, dry_run? }
 * The REST twin of MCP `remember`. `dry_run: true` returns the insert or
 * overwrite and writes nothing. A non-boolean `dry_run` is 400 and writes nothing.
 */
export async function POST(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  let body: {
    content?: unknown;
    key?: unknown;
    tags?: unknown;
    agent_id?: unknown;
    dry_run?: unknown;
  } | null;
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_json");
  }
  // `null` is valid JSON. Reading `.content` on it throws, which became a 500.
  if (body === null) return apiError("invalid_json");
  if (typeof body.content !== "string") {
    return apiError("missing_field", {
      message: "content is required",
      fields: { content: "content is required" },
    });
  }
  if (body.key !== undefined && body.key !== null && typeof body.key !== "string") {
    return apiError("validation_failed", {
      message: "key must be a string.",
      fields: { key: "Use a string key, or omit it." },
    });
  }
  const key = typeof body.key === "string" ? body.key : undefined;
  if (key !== undefined && (key.length < 1 || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key))) {
    return apiError("memory_key_invalid", {
      fields: { key: "Use 1 to 200 characters and no control characters, or omit the key." },
    });
  }
  let tags: string[] | undefined;
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string")) {
      return apiError("validation_failed", {
        message: "tags must be an array of strings.",
        fields: { tags: "tags must be an array of strings." },
      });
    }
    tags = body.tags;
  }
  if (body.agent_id !== undefined && body.agent_id !== null && typeof body.agent_id !== "string") {
    return apiError("validation_failed", {
      message: "agent_id must be a string.",
      fields: { agent_id: "agent_id must be a string." },
    });
  }
  const agent_id = typeof body.agent_id === "string" ? body.agent_id : body.agent_id === null ? null : undefined;
  const dry = readDryRun(body.dry_run);
  if (!dry.ok) {
    return apiError("validation_failed", {
      message: "dry_run must be a boolean.",
      fields: { dry_run: "Use true to preview, or false to save." },
    });
  }
  const input = { content: body.content, key, tags, agent_id };
  if (!isConfigured()) {
    if (dry.dryRun) {
      const preview = diffMemoryWrite(null, input);
      return NextResponse.json({
        ...preview,
        would_write: false,
        note: "DATABASE_URL not set; note not stored.",
      });
    }
    return NextResponse.json({ ok: true, demo: true, applied: false, note: "DATABASE_URL not set; note not stored." });
  }
  try {
    if (dry.dryRun) return NextResponse.json(await previewMemoryWrite(input));
    const item = await remember({
      content: input.content,
      key: input.key,
      tags: input.tags,
      agent_id: typeof input.agent_id === "string" ? input.agent_id : undefined,
    });
    return NextResponse.json({ ok: true, applied: true, item });
  } catch (e) {
    return publicError("[memory] write failed", e);
  }
}
