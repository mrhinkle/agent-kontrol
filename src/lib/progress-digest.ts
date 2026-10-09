import type { ProgressResponse } from "./progress-types";

/**
 * The progress board as one block of plain text.
 *
 * Hermes reads this on a schedule and messages it, which is the point: a
 * dashboard you have to remember to open is a dashboard that tells you about a
 * problem three days late. Same numbers, same thresholds — the page and the
 * digest cannot disagree because they come from the same response.
 */

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

export function formatDigest(data: ProgressResponse): string {
  const lines: string[] = [];
  const when = data.last_sync ? data.last_sync.replace("T", " ").slice(0, 16) + " UTC" : "never collected";

  lines.push(`Fleet progress — last ${data.window} (as of ${when})`);
  if (data.demo) lines.push("[demo mode — no database connected]");
  if (!data.window_complete) {
    lines.push(`[history doesn't reach back a full ${data.window} yet; totals cover less than the label claims]`);
  }
  lines.push("");

  const t = data.totals;
  const verdict =
    t.net_backlog > 0
      ? `the queue grew by ${t.net_backlog}`
      : t.net_backlog < 0
        ? `the queue shrank by ${Math.abs(t.net_backlog)}`
        : "the queue held level";
  lines.push(`${t.merged_prs} PRs merged, ${t.issues_closed} issues closed, ${t.issues_opened} opened — ${verdict}.`);
  lines.push("");

  const nameWidth = Math.max(...data.repos.map((r) => r.label.length), 12);
  for (const r of data.repos) {
    const blocked = r.blocked_ratio === null ? "blocked n/a" : `blocked ${Math.round(r.blocked_ratio * 100)}%`;
    lines.push(
      `  ${pad(r.label, nameWidth)}  ${pad(String(r.merged_prs) + " merged", 10)}` +
        `  closed ${r.issues_closed} / opened ${r.issues_opened}` +
        `  net ${pad(signed(r.net_backlog), 4)}` +
        `  queue ${r.open_issues}i ${r.open_prs}pr  ${blocked}`
    );
  }
  lines.push("");

  if (data.alerts.length === 0) {
    lines.push("Needs you: nothing. No threshold breaches, no stalled PRs.");
  } else {
    lines.push(`Needs you (${data.alerts.length}):`);
    for (const a of data.alerts) {
      lines.push(`  ${a.level === "bad" ? "!!" : " !"} ${a.message}${a.url ? `  ${a.url}` : ""}`);
    }
  }

  const lanes = Object.entries(t.lane_mix).sort((a, b) => b[1] - a[1]);
  if (lanes.length > 0) {
    lines.push("");
    lines.push(`Lanes: ${lanes.map(([k, v]) => `${k} ${v}`).join(" · ")}`);
    if (t.lane_mix.unattributed) {
      lines.push(`  (${t.lane_mix.unattributed} unattributed — that repo commits under one vendor-neutral bot)`);
    }
  }
  if (t.spend_usd !== null) lines.push(`Spend: $${t.spend_usd.toFixed(2)}`);

  return lines.join("\n");
}
