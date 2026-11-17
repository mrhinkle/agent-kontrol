/** Server configuration. Never pass keys or this configuration object to a client component. */
export interface LangfuseConfig {
  endpoint: string;
  publicKey: string;
  secretKey: string;
  projectUrl: string | null;
  environment: string;
}

type Environment = Record<string, string | undefined>;

function baseUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url;
  } catch {
    return null;
  }
}

function projectUrl(value: string | undefined, base: URL | null): string | null {
  if (!value || !base) return null;
  try {
    const url = new URL(value);
    if (url.origin !== base.origin || url.username || url.password || url.search || url.hash) return null;
    return /^\/project\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

export function langfuseStatus(env: Environment = process.env) {
  const base = baseUrl(env.LANGFUSE_BASE_URL);
  const enabled = env.LANGFUSE_ENABLED === "true";
  const missing = [
    ...(!base ? ["LANGFUSE_BASE_URL"] : []),
    ...(!env.LANGFUSE_PUBLIC_KEY?.trim() ? ["LANGFUSE_PUBLIC_KEY"] : []),
    ...(!env.LANGFUSE_SECRET_KEY?.trim() ? ["LANGFUSE_SECRET_KEY"] : []),
  ];
  return {
    state: !enabled ? "disabled" : missing.length ? "incomplete" : "ready",
    missing,
    projectUrl: projectUrl(env.LANGFUSE_PROJECT_URL, base),
  } as const;
}

export function langfuseConfig(env: Environment = process.env): LangfuseConfig | null {
  const status = langfuseStatus(env);
  if (status.state !== "ready") return null;
  return {
    endpoint: `${baseUrl(env.LANGFUSE_BASE_URL)!.origin}/api/public/otel/v1/traces`,
    publicKey: env.LANGFUSE_PUBLIC_KEY!.trim(),
    secretKey: env.LANGFUSE_SECRET_KEY!.trim(),
    projectUrl: status.projectUrl,
    environment: ["production", "preview", "development"].includes(env.VERCEL_ENV ?? "")
      ? env.VERCEL_ENV!
      : "default",
  };
}
