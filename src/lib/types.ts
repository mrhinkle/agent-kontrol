export type AgentStatus = "active" | "waiting" | "done" | "failed" | "offline";

export interface Agent {
  id: string;
  platform: string;
  machine: string | null;
  display_name: string | null;
  last_seen_at: string | null;
}

export interface Session {
  id: string;
  agent_id: string;
  project: string | null;
  status: string;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
  updated_at: string;
}

export interface Event {
  id: number;
  agent_id: string;
  session_id: string | null;
  kind: string;
  title: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export interface MemoryItem {
  id: number;
  key: string | null;
  content: string;
  tags: string[];
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

export type MessageDirection = "inbound" | "outbound";

export interface Message {
  id: number;
  agent_id: string;
  body: string;
  created_by: string | null;
  created_at: string;
  delivered_at: string | null;
  acked_at: string | null;
  direction: MessageDirection;
  in_reply_to: number | null;
  thread_id: string | null;
  read_by_dashboard_at: string | null;
}

export type TaskStatus =
  | "queued"
  | "claimed"
  | "running"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export interface Task {
  id: number;
  title: string;
  description: string | null;
  project: string | null;
  platform: string; // claude-code | codex | grok | hermes | cowork-cloud | any
  machine: string | null;
  priority: number; // 1 high, 2 normal, 3 low
  status: TaskStatus;
  reviewer_platform: string | null;
  assigned_agent: string | null;
  session_id: string | null;
  result: string | null;
  cost_usd: number | null;
  created_by: string | null;
  created_at: string;
  claimed_at: string | null;
  updated_at: string;
  completed_at: string | null;
}

export interface FleetAgent extends Agent {
  current_session: Session | null;
  recent_sessions: Session[];
  derived_status: AgentStatus;
  pending_messages: number;   // inbound, not yet acked by agent
  unread_replies: number;     // outbound replies the operator hasn't opened
}

export interface FleetResponse {
  demo: boolean;
  agents: FleetAgent[];
  events: Event[];
  generated_at: string;
}
