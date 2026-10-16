/**
 * Send one Langfuse observation per agent event. With the keys unset this is
 * a direct call to `fn` and the SDK is never loaded.
 *
 * Spans are batched by the OpenTelemetry processor (default: up to 512 spans,
 * about every 5 seconds). This module does not flush on each request: a flush
 * there would add a network round trip to every ingest and MCP call. The batch
 * is flushed on process shutdown (`beforeExit`, `SIGTERM`, `SIGINT`), which
 * Docker and Fly send. On serverless there is often no shutdown between
 * requests. A warm instance still exports on that interval. An instance frozen
 * or discarded first can delay the last batch until it wakes, or drop it if
 * the instance is thrown away. That lag is the cost of keeping those requests
 * off the Langfuse network path.
 */
import "server-only";
import { redactText } from "@/lib/traces";
import { formatLangfuseSetupError, isLangfuseEnabled, readLangfuseConfig, sanitizeLangfuseMeta } from "@/lib/langfuse-config";

interface LangfuseProcessor {
  forceFlush(): Promise<void>;
}

export interface LangfuseTraceRecord {
  name: string;
  metadata: Record<string, string | number | boolean>;
  level: "DEFAULT" | "ERROR";
}

type LangfuseEmitter = (event: LangfuseTraceRecord) => Promise<void> | void;

let processor: LangfuseProcessor | null = null;
let starting: Promise<LangfuseProcessor | null> | null = null;
let testEmitter: LangfuseEmitter | null = null;
let shutdownHooked = false;

/** Unit tests record events here instead of opening a tracer. */
export function setLangfuseEmitterForTests(emitter: LangfuseEmitter | null): void {
  testEmitter = emitter;
}

function responseStatus(result: unknown): number | undefined {
  return result instanceof Response ? result.status : undefined;
}

function hookShutdown(current: LangfuseProcessor): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const flush = () => {
    void current.forceFlush().catch(() => {
      console.error("[langfuse] shutdown flush failed");
    });
  };
  process.once("beforeExit", flush);
  process.on("SIGTERM", flush);
  process.on("SIGINT", flush);
}

export async function ensureLangfuse(): Promise<LangfuseProcessor | null> {
  if (!isLangfuseEnabled()) return null;
  if (processor) return processor;
  if (!starting) starting = startLangfuse();
  return starting;
}

async function startLangfuse(): Promise<LangfuseProcessor | null> {
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
      mediaUploadEnabled: false,
      mask: ({ data }) => (typeof data === "string" ? redactText(data, 500) : data),
    });
    // Isolated provider so the rest of the process keeps its own tracer.
    const provider = new NodeTracerProvider({ spanProcessors: [created] });
    setLangfuseTracerProvider(provider);
    hookShutdown(created);
    processor = created;
    return created;
  } catch (err) {
    console.error(`[langfuse] tracing disabled: setup failed (${formatLangfuseSetupError(err)})`);
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
  try {
    const ready = await ensureLangfuse();
    if (!ready) return fn();
  } catch {
    console.error("[langfuse] tracing skipped");
    return fn();
  }

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
