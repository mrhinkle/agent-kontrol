import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGitHubFetcher } from "../../src/lib/skills/source";
import type { SkillSourceRecord } from "../../src/lib/skills/types";

const source = { id: "s", repo: "owner/repo", ref: "main", path_globs: ["skills/*"] } as unknown as SkillSourceRecord;

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function repoFetch(rejectToken: (auth: string | null) => number | null) {
  const seen: Array<string | null> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
    seen.push(auth);
    const status = rejectToken(auth);
    if (status) return respond({ message: "denied" }, status);
    if (url.includes("/commits/")) return respond({ sha: "c1" });
    if (url.includes("/git/trees/")) {
      return respond({ tree: [{ path: "skills/a/SKILL.md", type: "blob", sha: "b1", size: 5 }] });
    }
    if (url.includes("/git/blobs/")) return respond({ encoding: "base64", content: Buffer.from("hello").toString("base64") });
    return respond({}, 404);
  };
  return { fetchImpl, seen };
}

describe("github skill fetcher token fallback", () => {
  it("retries without the token when GitHub answers 403 to it", async () => {
    const { fetchImpl, seen } = repoFetch((auth) => (auth ? 403 : null));
    const snap = await createGitHubFetcher({ fetchImpl, token: "tok-secret" }).fetch(source);
    assert.equal(snap.commit_sha, "c1");
    assert.equal(snap.files.length, 1);
    assert.equal(seen[0], "Bearer tok-secret");
    assert.ok(seen.slice(1).every((auth) => auth === null));
  });

  it("does not retry without a token on 404", async () => {
    const { fetchImpl, seen } = repoFetch(() => 404);
    await assert.rejects(createGitHubFetcher({ fetchImpl, token: "tok-secret" }).fetch(source), /status 404/);
    assert.equal(seen.length, 1);
  });

  it("reports the authenticated error when the anonymous retry also fails", async () => {
    const { fetchImpl } = repoFetch((auth) => (auth ? 403 : 404));
    await assert.rejects(createGitHubFetcher({ fetchImpl, token: "tok-secret" }).fetch(source), /status 403/);
  });

  it("never leaks the token in an error", async () => {
    const { fetchImpl } = repoFetch(() => 403);
    await assert.rejects(createGitHubFetcher({ fetchImpl, token: "tok-secret" }).fetch(source), (err: Error) => !err.message.includes("tok-secret"));
  });
});
