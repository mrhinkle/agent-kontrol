import { NextResponse } from "next/server";
import { enforceBearer } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { replyFromAgent } from "@/lib/store";
import { isMessagesSetupError, MESSAGES_SETUP_MESSAGE } from "@/lib/message-errors";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/messages/reply
 * Non-MCP agents (hooks, watchers, scripts) post replies here with Bearer MC_TOKEN.
 *
 * Body: { agent_id, body, in_reply_to?, created_by? }
 */
export async function POST(req: Request) {
  const denied = await enforceBearer(req);
  if (denied) return denied;
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true, note: "DATABASE_URL not set; reply dropped" });
  }
  let body: {
    agent_id?: string;
    body?: string;
    in_reply_to?: number;
    created_by?: string;
  };
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_json");
  }
  if (!body.agent_id || !body.body?.trim()) {
    const fields: Record<string, string> = {};
    if (!body.agent_id) fields.agent_id = "agent_id is required";
    if (!body.body?.trim()) fields.body = "body is required";
    return apiError("missing_field", { message: "agent_id and body are required", fields });
  }
  try {
    const msg = await replyFromAgent({
      agent_id: body.agent_id,
      body: body.body.trim(),
      in_reply_to: body.in_reply_to,
      created_by: body.created_by,
    });
    return NextResponse.json({ ok: true, id: msg.id, message: msg });
  } catch (e) {
    if (isMessagesSetupError(e)) {
      return apiError("setup_required", {
        message: MESSAGES_SETUP_MESSAGE,
        fix: "Run supabase/migrations/20261005_messages_two_way.sql (or supabase/schema.sql), then retry.",
        extra: { setup_required: true, message: MESSAGES_SETUP_MESSAGE },
      });
    }
    return publicError("[messages] reply failed", e);
  }
}
