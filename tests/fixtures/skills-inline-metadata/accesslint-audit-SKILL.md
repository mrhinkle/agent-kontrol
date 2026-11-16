---
name: accesslint-audit
key: master.accesslint-audit
description: Find and fix WCAG 2.2 accessibility issues. Two modes — report (sweep a codebase or page, produce a prioritized written report, no edits) and fix (audit→edit→verify loop on a target). Prefers direct-CDP live-DOM auditing; falls back to HTML-string audits. Trigger on "audit my codebase", "make this accessible", "fix the a11y issues", "check this page for WCAG violations".
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, Skill, Task, mcp__accesslint__audit_html, mcp__accesslint__audit_live, mcp__accesslint__explain_rule, mcp__accesslint__list_rules
category: Website Operations
owner: mark-hinkle
version: 1.0.2
last_updated: 2026-11-02
metadata: {"hermes": {"tags": ["accessibility", "wcag", "audit", "a11y"]}}
tags: [audit, accessibility]
---

You audit accessibility and optionally fix what's broken.

## Pick a mode from the user's intent

- **Report mode** — "audit my codebase", "review src/components/", "what's wrong with this page?", "give me an a11y report". You audit + write a report. **You do not edit files.**
- **Fix mode** — "fix the a11y issues in X", "audit and fix", "make this accessible", "verify the contrast fix landed", or hands you a violation report and asks to apply it. You audit → edit → verify.

If unsure, ask. Don't default-to-fix when the user only asked for an audit.

For very large sweeps where main-thread context cost matters, you can be invoked via `Task` (general-purpose agent) for context isolation. The recipe is the same either way.

## Picking a flow

Two flows, in order of preference.

1. **`audit_live`** — try first for any URL. Ensures a debuggable Chrome (auto-launches one headless if none is reachable — no user setup needed), then audits the live DOM. Single call; the audit engine never enters your context. Use `selector` to scope to one component and `wait_for` to gate on async content.
2. **`audit_html`** — for raw HTML strings, files (`Read` first, then `audit_html`), or JSX you've rendered to a string.

For non-URL targets, use flow 2. For URLs, use flow 1; if Chrome can't be launched (no system Chrome and download disabled), fall back to flow 2 with a note that live-DOM coverage is limited.

Auditing a user's **already-open, authenticated** session isn't a separate flow anymore: have them start a headed debuggable Chrome (`npx @accesslint/chrome ensure --headed`), sign in there, then call `audit_live({ url, port })` — it attaches to that Chrome instead of launching its own.

## Scope handling (report mode)

- **Directory path** — analyze all relevant files within.
- **Multiple files** — analyze the listed files plus imports they reach.
- **A URL** — audit it. If it's a dev-server URL, that's flow 1.
- **No arguments** — ask the user to narrow scope. Whole-codebase sweeps are rarely the right thing.

State the scope explicitly at the start of your report.

## Approach (report mode)

1. **Map the surface.** Glob/Grep to enumerate components, templates, styles. Sample representative files; don't open everything blindly.
2. **Audit live where possible** — the rendered DOM catches issues source can't show. Use the flow picker above.
3. **Look for patterns.** If one component fails a rule, similar components likely do too. Group by rule ID and component family — don't list 30 instances of the same issue 30 times.
4. **Prioritize by user impact.** Critical/serious first. Many low-impact violations of one rule are often a single root-cause fix.
