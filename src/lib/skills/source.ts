import type { SkillSourceRecord } from "./types";

/**
 * Read a skill source from GitHub without a git binary and without writing
 * the filesystem. The token is `GH_TOKEN` or `GITHUB_TOKEN`, the same names
 * the `gh` CLI used by the progress collector already reads. No new secret.
 */

export interface SnapshotFile {
  path: string;
  content: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface SkillSnapshot {
  commit_sha: string;
  files: SnapshotFile[];
  /** Binary or otherwise unreadable blobs. A skipped reference is not a removal. */
  skipped: SkippedFile[];
  /**
   * Skill directories whose SKILL.md could not be read (too large, or not text).
   * The sync keeps any stored row for that id. It does not treat the gap as a deletion.
   */
  preserved_dirs: string[];
}

export interface SkillSnapshotFetcher {
  fetch(source: SkillSourceRecord): Promise<SkillSnapshot>;
}

export class GitHubFetchError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`GitHub request failed with status ${status}`);
    this.name = "GitHubFetchError";
    this.status = status;
  }
}

export function githubToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || "";
  return token.length > 0 ? token : null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function createGitHubFetcher(opts: { fetchImpl?: FetchLike; token?: string | null } = {}): SkillSnapshotFetcher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = opts.token === undefined ? githubToken() : opts.token;
  return {
    async fetch(source) {
      try {
        return await fetchSnapshot(fetchImpl, token, source);
      } catch (err) {
        const message = err instanceof Error ? err.message : "GitHub request failed";
        throw new Error(redactToken(message, token));
      }
    },
  };
}

async function fetchSnapshot(
  fetchImpl: FetchLike,
  token: string | null,
  source: SkillSourceRecord,
): Promise<SkillSnapshot> {
  const [owner, repo, extra] = source.repo.split("/");
  if (!owner || !repo || extra) throw new GitHubFetchError(0);
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let ref = source.ref;
  if (!ref) {
    const meta = await ghJson(fetchImpl, token, root);
    const branch = typeof meta.default_branch === "string" ? meta.default_branch : "";
    if (!branch) throw new GitHubFetchError(0);
    ref = branch;
  }
  const commit = await ghJson(fetchImpl, token, `${root}/commits/${encodeURIComponent(ref)}`);
  const commitSha = typeof commit.sha === "string" ? commit.sha : "";
  if (!commitSha) throw new GitHubFetchError(0);
  const tree = await ghJson(fetchImpl, token, `${root}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`);
  if (tree.truncated === true) throw new Error("GitHub tree was truncated; refusing to treat the missing files as deletions");
  const entries = Array.isArray(tree.tree) ? tree.tree : [];
  const wanted = blobsToFetch(entries, source.path_globs);
  const skipped: SkippedFile[] = [];
  for (const skip of skippedBySize(entries, source.path_globs)) skipped.push(skip);
  const preserved = new Set(oversizedSkillDirs(entries, source.path_globs));
  for (const dir of preserved) skipped.push({ path: `${dir}/SKILL.md`, reason: "over 1 MB" });
  const loaded = await mapPool(wanted, 6, async (blob) => {
    const body = await ghJson(fetchImpl, token, `${root}/git/blobs/${encodeURIComponent(blob.sha)}`);
    if (body.encoding !== "base64" || typeof body.content !== "string") throw new GitHubFetchError(0);
    const bytes = Buffer.from(body.content, "base64");
    const text = decodeUtf8(bytes);
    return { path: blob.path, text };
  });
  const files: SnapshotFile[] = [];
  for (const item of loaded) {
    if (item.text == null) {
      skipped.push({ path: item.path, reason: "not utf-8 text" });
      if (item.path.endsWith("/SKILL.md")) {
        const dir = parentDir(item.path);
        if (dir) preserved.add(dir);
      }
      continue;
    }
    files.push({ path: item.path, content: item.text });
  }
  return { commit_sha: commitSha, files, skipped, preserved_dirs: [...preserved].sort() };
}

function skippedBySize(entries: unknown[], globs: string[]): SkippedFile[] {
  const out: SkippedFile[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { path?: unknown; type?: unknown; size?: unknown };
    if (row.type !== "blob" || typeof row.path !== "string") continue;
    const size = typeof row.size === "number" ? row.size : 0;
    if (row.path.endsWith("/SKILL.md")) continue;
    const dir = directoryUnderGlob(row.path, globs);
    if (!dir) continue;
    if (size > REFERENCE_MAX_BYTES) out.push({ path: row.path, reason: "over 256 KB" });
  }
  return out;
}

function directoryUnderGlob(path: string, globs: string[]): string | null {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join("/");
    if (globs.some((glob) => matchesGlob(dir, glob)) && path.startsWith(`${dir}/`)) return dir;
  }
  return null;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Math.min(limit, items.length);
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

function redactToken(message: string, token: string | null): string {
  if (!token || token.length < 4) return message;
  return message.split(token).join("[redacted]");
}

interface BlobRef {
  path: string;
  sha: string;
  size: number;
}

export const REFERENCE_MAX_BYTES = 256 * 1024;
export const SKILL_MD_MAX_BYTES = 1024 * 1024;

/** Which blobs a snapshot needs. Oversized SKILL.md files are omitted here; the caller preserves that skill. */
export function blobsToFetch(entries: unknown[], globs: string[]): BlobRef[] {
  const blobs: BlobRef[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { path?: unknown; type?: unknown; sha?: unknown; size?: unknown };
    if (row.type !== "blob" || typeof row.path !== "string" || typeof row.sha !== "string") continue;
    const size = typeof row.size === "number" ? row.size : 0;
    blobs.push({ path: row.path, sha: row.sha, size });
  }
  const roots = new Set<string>();
  for (const blob of blobs) {
    if (!blob.path.endsWith("/SKILL.md")) continue;
    const dir = parentDir(blob.path);
    if (dir && globs.some((glob) => matchesGlob(dir, glob))) roots.add(dir);
  }
  return blobs.filter((blob) => {
    const root = [...roots].find((dir) => blob.path === `${dir}/SKILL.md` || blob.path.startsWith(`${dir}/`));
    if (!root) return false;
    if (blob.path === `${root}/SKILL.md`) return blob.size <= SKILL_MD_MAX_BYTES;
    return blob.size <= REFERENCE_MAX_BYTES;
  });
}

export function oversizedSkillDirs(entries: unknown[], globs: string[]): string[] {
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { path?: unknown; type?: unknown; size?: unknown };
    if (row.type !== "blob" || typeof row.path !== "string" || !row.path.endsWith("/SKILL.md")) continue;
    const size = typeof row.size === "number" ? row.size : 0;
    if (size <= SKILL_MD_MAX_BYTES) continue;
    const dir = parentDir(row.path);
    if (dir && globs.some((glob) => matchesGlob(dir, glob))) dirs.push(dir);
  }
  return dirs;
}

export function parentDir(path: string): string | null {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return null;
  return path.slice(0, idx);
}

export function matchesGlob(path: string, glob: string): boolean {
  const parts = glob.split("/").map((part) => (part === "*" ? "[^/]+" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")));
  return new RegExp(`^${parts.join("/")}$`).test(path);
}

export function decodeUtf8(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function ghJson(fetchImpl: FetchLike, token: string | null, path: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "agent-kontrol",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetchImpl(`https://api.github.com${path}`, { headers });
  if (!response.ok) throw new GitHubFetchError(response.status);
  const body = (await response.json()) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new GitHubFetchError(response.status);
  return body as Record<string, unknown>;
}
