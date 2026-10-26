import { NextResponse } from "next/server";
import { actorFromPrincipal } from "@/lib/actor";
import { deny, resolveApiAccess } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
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
  return apiError("setup_required", {
    message: MESSAGES_SETUP_MESSAGE,
    fix: "Run supabase/migrations/20261005_messages_two_way.sql (or supabase/schema.sql), then retry.",
    extra: { setup_required: true, message: MESSAGES_SETUP_MESSAGE },
  });
}

export async function GET(req: Request) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  const url = new URL(req.url);
  const agent_id = url.searchParams.get("agent_id");
  if (!agent_id) {
    return apiError("missing_field", { message: "agent_id required", fields: { agent_id: "agent_id required" } });
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
    return publicError("[messages] list failed", e);
  }
}

export async function POST(req: Request) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true, note: "DATABASE_URL not set; message dropped" });
  }
  let body: { agent_id?: string; body?: string; created_by?: string };
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_json");
  }
  if (!body.agent_id || !body.body) {
    const fields: Record<string, string> = {};
    if (!body.agent_id) fields.agent_id = "agent_id is required";
    if (!body.body) fields.body = "body is required";
    return apiError("missing_field", { message: "agent_id and body are required", fields });
  }
  try {
    const msg = await enqueueMessage({
      agent_id: body.agent_id,
      body: body.body,
      created_by: body.created_by,
      actor: actorFromPrincipal(access.principal),
    });
    return NextResponse.json({ ok: true, id: msg.id, message: msg });
  } catch (e) {
    if (isMessagesSetupError(e)) return setupResponse();
    return publicError("[messages] send failed", e);
  }
}

export async function PATCH(req: Request) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true });
  }
  let body: { agent_id?: string };
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_json");
  }
  if (!body.agent_id) {
    return apiError("missing_field", { message: "agent_id required", fields: { agent_id: "agent_id required" } });
  }
  try {
    const updated = await markConversationRead({ agent_id: body.agent_id });
    return NextResponse.json({ ok: true, updated });
  } catch (e) {
    if (isMessagesSetupError(e)) return setupResponse();
    return publicError("[messages] read failed", e);
  }
}
