import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/db";
import {
  enqueueMessage,
  fetchMessages,
  listConversation,
  markConversationRead,
} from "@/lib/store";
import { isMessagesSetupError, MESSAGES_SETUP_MESSAGE } from "@/lib/message-errors";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Two-way messaging.
 * Auth: dashboard session cookie, or MC_TOKEN bearer (middleware).
 *
 * GET  ?agent_id=X&ack=true              -> agent pulls inbound inbox
 * GET  ?agent_id=X&conversation=true     -> full history for the drawer
 * POST { agent_id, body, created_by? }   -> operator enqueues inbound
 * PATCH { agent_id }                     -> operator marks outbound replies read
 */

function setupResponse() {
  return NextResponse.json(
    { setup_required: true, message: MESSAGES_SETUP_MESSAGE, error: MESSAGES_SETUP_MESSAGE },
    { status: 503 }
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const agent_id = url.searchParams.get("agent_id");
  if (!agent_id) {
    return NextResponse.json({ error: "agent_id required" }, { status: 400 });
  }
  if (!isConfigured()) {
    return NextResponse.json({ messages: [], demo: true });
  }
  try {
    if (url.searchParams.get("conversation") === "true") {
      const messages = await listConversation({ agent_id });
      return NextResponse.json({ messages });
    }
    const messages = await fetchMessages({
      agent_id,
      ack: url.searchParams.get("ack") === "true",
    });
    return NextResponse.json({ messages });
  } catch (e) {
    if (isMessagesSetupError(e)) return setupResponse();
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true, note: "DATABASE_URL not set; message dropped" });
  }
  let body: { agent_id?: string; body?: string; created_by?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.agent_id || !body.body) {
    return NextResponse.json({ error: "agent_id and body are required" }, { status: 400 });
  }
  try {
    const msg = await enqueueMessage({
      agent_id: body.agent_id,
      body: body.body,
      created_by: body.created_by,
    });
    return NextResponse.json({ ok: true, id: msg.id, message: msg });
  } catch (e) {
    if (isMessagesSetupError(e)) return setupResponse();
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true });
  }
  let body: { agent_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.agent_id) {
    return NextResponse.json({ error: "agent_id required" }, { status: 400 });
  }
  try {
    const updated = await markConversationRead({ agent_id: body.agent_id });
    return NextResponse.json({ ok: true, updated });
  } catch (e) {
    if (isMessagesSetupError(e)) return setupResponse();
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
