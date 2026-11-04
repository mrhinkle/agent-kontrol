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

function signed(n: number | null): string {
  if (n === null) return "n/a";
  return n > 0 ? `+${n}` : String(n);
}

export function formatDigest(data: ProgressResponse): string {
  const lines: string[] = [];
  const when = data.last_sync ? data.last_sync.replace("T", " ").slice(0, 16) + " UTC" : "never collected";

  lines.push(`Fleet progress — last ${data.window} (as of ${when})`);
  if (data.demo) lines.push("[demo mode — no database connected]");
  if (!data.window_complete) {
    lines.push(`[partial totals: metrics are missing, stale, or don't cover the full ${data.window}]`);
  }
  if (data.coverage) {
    lines.push(`${data.coverage.shown_repos} repositories shown: open PRs or activity in the past 24h (plus pins). ${data.coverage.checked_repos}/${data.coverage.eligible_repos} freshly checked; ${data.coverage.tracked_repos} retained.`);
    if (data.coverage.incomplete.length) lines.push(`Activity coverage incomplete: ${data.coverage.incomplete.map((r) => `${r.repo} (${r.status})`).join(", ")}. Additional active repos may be missing.`);
    if (data.coverage.discovery_errors.length) lines.push(`Discovery unavailable: ${data.coverage.discovery_errors.join(", ")}.`);
  }
  lines.push("");

  const t = data.totals;
  const verdict =
    t.net_backlog === null ? "backlog change unavailable" : t.net_backlog > 0
      ? `the queue grew by ${t.net_backlog}`
      : t.net_backlog < 0
        ? `the queue shrank by ${Math.abs(t.net_backlog)}`
        : "the queue held level";
  lines.push(`${t.merged_prs ?? "n/a"} PRs merged, ${t.issues_closed ?? "n/a"} issues closed, ${t.issues_opened ?? "n/a"} opened — ${verdict}.`);
  lines.push("");

  const nameWidth = Math.max(...data.repos.map((r) => `${r.label} (${r.repo})`.length), 12);
  for (const r of data.repos) {
    const blocked = r.blocked_ratio === null ? "blocked n/a" : `blocked ${Math.round(r.blocked_ratio * 100)}%`;
    lines.push(
      `  ${pad(`${r.label} (${r.repo})`, nameWidth)}  ${pad(String(r.merged_prs ?? "n/a") + " merged", 10)}` +
        `  closed ${r.issues_closed ?? "n/a"} / opened ${r.issues_opened ?? "n/a"}` +
        `  net ${pad(signed(r.net_backlog), 4)}` +
        `  queue ${r.open_issues ?? "n/a"}i ${r.open_prs ?? "n/a"}pr  ${blocked}` +
        (r.activity && r.activity.status !== "fresh" ? `  activity ${r.activity.status}` : "")
    );
  }
  lines.push("");

  if (data.alerts.length === 0) {
    lines.push("Needs you: no alerts from the available metrics. Check coverage for unmeasured repositories.");
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

  if (data.skills) {
    const skills = data.skills;
    lines.push("");
    lines.push(`Skills — triggers in the last ${skills.window}`);
    lines.push(skills.note);
    if (skills.triggers_by_skill.length === 0) lines.push("  No triggers in this window.");
    for (const row of skills.triggers_by_skill) lines.push(`  ${row.id}  ${row.count}`);
    const runtimes = skills.triggers_by_runtime;
    lines.push(
      `  Runtimes: claude ${runtimes.claude} · codex ${runtimes.codex} · grok ${runtimes.grok} · hermes ${runtimes.hermes} · mini ${runtimes.mini} · nemoclaw ${runtimes.nemoclaw}`,
    );
    if (skills.stalled.length === 0) lines.push("  Stalled runs: none.");
    else lines.push(`  Stalled runs: ${skills.stalled.map((run) => `${run.skill_id} (${run.agent})`).join(", ")}`);
    if (skills.enabled_never_used.length > 0) {
      lines.push(`  Enabled, not used in this window: ${skills.enabled_never_used.join(", ")}`);
    }
  }

  return lines.join("\n");
}
