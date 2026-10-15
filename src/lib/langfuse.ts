/**
 * Send one Langfuse observation per agent event. With the keys unset this is
 * a direct call to `fn` and the SDK is never loaded.
 */
import { after } from "next/server";
import { redactText } from "@/lib/traces";
import { isLangfuseEnabled, readLangfuseConfig, sanitizeLangfuseMeta } from "@/lib/langfuse-config";

interface Flusher {
  forceFlush(): Promise<void>;
}

export interface LangfuseTraceRecord {
  name: string;
  metadata: Record<string, string | number | boolean>;
  level: "DEFAULT" | "ERROR";
}

type LangfuseEmitter = (event: LangfuseTraceRecord) => Promise<void> | void;

let processor: Flusher | null = null;
let starting: Promise<Flusher | null> | null = null;
let testEmitter: LangfuseEmitter | null = null;

/** Unit tests record events here instead of opening a tracer. */
export function setLangfuseEmitterForTests(emitter: LangfuseEmitter | null): void {
  testEmitter = emitter;
}

function responseStatus(result: unknown): number | undefined {
  return result instanceof Response ? result.status : undefined;
}

function scheduleFlush(current: Flusher): void {
  const run = () =>
    current.forceFlush().catch(() => {
      console.error("[langfuse] flush failed");
    });
  try {
    after(() => {
      void run();
    });
  } catch {
    void run();
  }
}

export async function ensureLangfuse(): Promise<Flusher | null> {
  if (!isLangfuseEnabled()) return null;
  if (processor) return processor;
  if (!starting) starting = startLangfuse();
  return starting;
}

async function startLangfuse(): Promise<Flusher | null> {
  const cfg = readLangfuseConfig();
  if (!cfg.enabled || !cfg.publicKey || !cfg.secretKey) return null;
  try {
    const [{ LangfuseSpanProcessor }, { NodeTracerProvider }, { setLangfuseTracerProvider }] = await Promise.all([
      import("@langfuse/otel"),
      import("@opentelemetry/sdk-trace-node"),
      import("@langfuse/tracing"),
    ]);
    const created = new LangfuseSpanProcessor({
      publicKey: cfg.publicKey,
      secretKey: cfg.secretKey,
      baseUrl: cfg.baseUrl,
      exportMode: "batched",
      flushAt: 1,
      mediaUploadEnabled: false,
      mask: ({ data }) => (typeof data === "string" ? redactText(data, 500) : data),
    });
    // Isolated provider so the rest of the process keeps its own tracer.
    const provider = new NodeTracerProvider({ spanProcessors: [created] });
    setLangfuseTracerProvider(provider);
    processor = created;
    return created;
  } catch {
    console.error("[langfuse] tracing disabled: setup failed");
    return null;
  }
}

async function traceWithEmitter<T>(name: string, metadata: Record<string, unknown> | undefined, fn: () => Promise<T>): Promise<T> {
  const safe = sanitizeLangfuseMeta(metadata);
  const emit = testEmitter;
  let level: LangfuseTraceRecord["level"] = "DEFAULT";
  try {
    const result = await fn();
    const status = responseStatus(result);
    if (status !== undefined) safe.http_status = status;
    if (status !== undefined && status >= 500) level = "ERROR";
    try {
      await emit?.({ name, metadata: safe, level });
    } catch {
      /* a test double must not change the result */
    }
    return result;
  } catch (err) {
    level = "ERROR";
    safe.error = redactText(err instanceof Error ? err.message : "error", 160);
    try {
      await emit?.({ name, metadata: safe, level });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

async function traceWithSdk<T>(name: string, metadata: Record<string, unknown> | undefined, fn: () => Promise<T>): Promise<T> {
  const safe = sanitizeLangfuseMeta(metadata);
  let current: Flusher | null = null;
  try {
    current = await ensureLangfuse();
  } catch {
    console.error("[langfuse] tracing skipped");
    return fn();
  }
  if (!current) return fn();

  let result!: T;
  let failure: unknown;
  let ran = false;
  try {
    const { propagateAttributes, startActiveObservation } = await import("@langfuse/tracing");
    const sessionId = typeof safe.session_id === "string" ? safe.session_id.slice(0, 200) : undefined;
    const userId = typeof safe.agent_id === "string" ? safe.agent_id.slice(0, 200) : undefined;
    await propagateAttributes(
      {
        traceName: name.slice(0, 200),
        userId,
        sessionId,
        metadata: safe,
        tags: ["agent-kontrol"],
      },
      async () => {
        await startActiveObservation(name.slice(0, 200), async (span) => {
          try {
            result = await fn();
            ran = true;
            const status = responseStatus(result);
            const level = status !== undefined && status >= 500 ? "ERROR" : "DEFAULT";
            try {
              span.update({
                metadata: status === undefined ? safe : { ...safe, http_status: status },
                level,
              });
            } catch {
              /* ignore */
            }
          } catch (err) {
            ran = true;
            failure = err;
            try {
              span.update({
                level: "ERROR",
                statusMessage: redactText(err instanceof Error ? err.message : "error", 160),
                metadata: safe,
              });
            } catch {
              /* ignore */
            }
          }
        });
      },
    );
  } catch {
    console.error("[langfuse] tracing skipped");
  } finally {
    scheduleFlush(current);
  }
  if (!ran) return fn();
  if (failure) throw failure;
  return result;
}

/**
 * Run `fn` and, when Langfuse is enabled, record one span named `name`.
 * Metadata is scrubbed. The span never includes the secret key, prompts, or
 * message bodies. A Langfuse failure still returns `fn`'s result.
 */
export async function traceAgentEvent<T>(name: string, metadata: Record<string, unknown> | undefined, fn: () => Promise<T>): Promise<T> {
  if (!isLangfuseEnabled()) return fn();
  if (testEmitter) return traceWithEmitter(name, metadata, fn);
  return traceWithSdk(name, metadata, fn);
}
