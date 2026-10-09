import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth";
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
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
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
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.agent_id || !body.body?.trim()) {
    return NextResponse.json({ error: "agent_id and body are required" }, { status: 400 });
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
      return NextResponse.json(
        { setup_required: true, error: MESSAGES_SETUP_MESSAGE, message: MESSAGES_SETUP_MESSAGE },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
