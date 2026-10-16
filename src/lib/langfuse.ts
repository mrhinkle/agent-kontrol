/**
 * Send one Langfuse observation per agent event. With the keys unset this is
 * a direct call to `fn` and the SDK is never loaded.
 *
 * Spans are batched by the OpenTelemetry processor (default: up to 512 spans,
 * about every 5 seconds). This module does not flush on each request: a flush
 * there would add a network round trip to every ingest and MCP call. The batch
 * is flushed on process shutdown (`beforeExit`, `SIGTERM`, `SIGINT`), which
 * Docker and Fly send. The signal handlers flush, then exit once, so the process
 * does not stay up waiting on the batch. A second signal during the flush is ignored.
 * On serverless there is often no shutdown between
 * requests. A warm instance still exports on that interval. An instance frozen
 * or discarded first can delay the last batch until it wakes, or drop it if
 * the instance is thrown away. That lag is the cost of keeping those requests
 * off the Langfuse network path.
 */
import "server-only";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { redactText } from "@/lib/traces";
import {
  formatLangfuseSetupError,
  gateLangfuseExport,
  isLangfuseEnabled,
  langfuseErrorFields,
  langfuseSpanName,
  readLangfuseConfig,
  readLangfuseMeta,
  readLangfuseTraceLabels,
} from "@/lib/langfuse-config";

interface LangfuseProcessor {
  forceFlush(): Promise<void>;
}

export interface LangfuseTraceRecord {
  name: string;
  metadata: Record<string, string | number | boolean>;
  level: "DEFAULT" | "ERROR";
  /** Closed error kind. Set only when `fn` throws. Never an exception message. */
  statusMessage?: string;
}

type LangfuseEmitter = (event: LangfuseTraceRecord) => Promise<void> | void;

let processor: LangfuseProcessor | null = null;
let starting: Promise<LangfuseProcessor | null> | null = null;
let testEmitter: LangfuseEmitter | null = null;
let testExporter: SpanExporter | null = null;
let shutdownHooked = false;

/** How long a shutdown flush may block SIGTERM or SIGINT before the process exits. */
const SHUTDOWN_FLUSH_MS = 1000;

const SIGNAL_EXIT: Partial<Record<NodeJS.Signals, number>> = {
  SIGTERM: 143,
  SIGINT: 130,
};

/** Unit tests record events here instead of opening a tracer. */
export function setLangfuseEmitterForTests(emitter: LangfuseEmitter | null): void {
  testEmitter = emitter;
}

/** Unit tests capture spans in memory instead of sending them to Langfuse. Set this before the first span. */
export function setLangfuseExporterForTests(exporter: SpanExporter | null): void {
  testExporter = exporter;
}

function responseStatus(result: unknown): number | undefined {
  return result instanceof Response ? result.status : undefined;
}

function flushQuiet(current: LangfuseProcessor): Promise<void> {
  return Promise.resolve()
    .then(() => current.forceFlush())
    .catch(() => {
      console.error("[langfuse] shutdown flush failed");
    });
}

/**
 * Flush the batch on shutdown, then exit once. The listener stays installed
 * so a second SIGTERM or SIGINT during the flush does not fall through to
 * Node's default termination and drop the batch. That second signal is
 * ignored. The flush and the timeout share one exit.
 */
export function installLangfuseShutdown(current: LangfuseProcessor): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  process.once("beforeExit", () => {
    void flushQuiet(current);
  });
  let flushing = false;
  let exited = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (flushing || exited) return;
    flushing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (exited) return;
      exited = true;
      clearTimeout(timer);
      process.exit(SIGNAL_EXIT[signal] ?? 1);
    };
    timer = setTimeout(finish, SHUTDOWN_FLUSH_MS);
    void flushQuiet(current).finally(finish);
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
}

/** Tests flush the real processor without waiting for the batch interval. */
export async function flushLangfuseForTests(): Promise<void> {
  await processor?.forceFlush();
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
    const labels = readLangfuseTraceLabels();
    const created = new LangfuseSpanProcessor({
      publicKey: cfg.publicKey,
      secretKey: cfg.secretKey,
      baseUrl: cfg.baseUrl,
      exportMode: "batched",
      mediaUploadEnabled: false,
      environment: labels.environment,
      // "" blocks the SDK from reading LANGFUSE_RELEASE when the value was rejected.
      release: labels.release,
      ...(testExporter ? { exporter: testExporter } : {}),
      mask: ({ data }) => (typeof data === "string" ? redactText(data, 500) : data),
    });
    // Isolated provider so the rest of the process keeps its own tracer.
    const provider = new NodeTracerProvider({ spanProcessors: [created] });
    setLangfuseTracerProvider(provider);
    installLangfuseShutdown(created);
    processor = created;
    return created;
  } catch (err) {
    console.error(`[langfuse] tracing disabled: setup failed (${formatLangfuseSetupError(err)})`);
    return null;
  }
}

type LangfuseMeta = Record<string, string | number | boolean>;

/**
 * Closed span name plus scrubbed metadata. Null means sanitizing failed:
 * the caller runs `fn` and records no span.
 */
function prepareLangfuseSpan(name: string, metadata: Record<string, unknown> | undefined): { name: string; meta: LangfuseMeta } | null {
  try {
    const meta = readLangfuseMeta(metadata);
    if (!meta) return null;
    return { name: langfuseSpanName(name), meta };
  } catch {
    return null;
  }
}

interface SpanHandoff {
  metadata: LangfuseMeta;
  level: "DEFAULT" | "ERROR";
  statusMessage?: string;
  tags: string[];
}

/**
 * The only path that hands metadata, status, level, and tags to the SDK or
 * the test emitter. Every span goes through the export gate here, so a new
 * call site cannot add a field the schema does not list.
 */
function handoffSpan(input: {
  metadata: Record<string, unknown>;
  level: "DEFAULT" | "ERROR";
  statusMessage?: string;
  tags?: readonly string[];
}): SpanHandoff {
  try {
    const gated = gateLangfuseExport({
      metadata: input.metadata,
      level: input.level,
      statusMessage: input.statusMessage,
      tags: input.tags ?? ["agent-kontrol"],
    });
    return {
      metadata: gated.metadata,
      level: gated.level,
      statusMessage: gated.statusMessage,
      tags: gated.tags,
    };
  } catch {
    return { metadata: {}, level: "DEFAULT", tags: [] };
  }
}

/** `error_kind` plus a fingerprint of the message. The message is not copied. */
function withLangfuseError(safe: LangfuseMeta, err: unknown): { metadata: LangfuseMeta; statusMessage: string } {
  try {
    const fields = langfuseErrorFields(err);
    const metadata: LangfuseMeta = { ...safe, error_kind: fields.error_kind };
    if (fields.error_ref) metadata.error_ref = fields.error_ref;
    return { metadata, statusMessage: fields.error_kind };
  } catch {
    return { metadata: { ...safe, error_kind: "internal" }, statusMessage: "internal" };
  }
}

async function traceWithEmitter<T>(name: string, metadata: Record<string, unknown> | undefined, fn: () => Promise<T>): Promise<T> {
  const prepared = prepareLangfuseSpan(name, metadata);
  if (!prepared) return fn();
  const safe = prepared.meta;
  const emit = testEmitter;
  try {
    const result = await fn();
    const status = responseStatus(result);
    const handed = handoffSpan({
      metadata: status === undefined ? safe : { ...safe, http_status: status },
      level: status !== undefined && status >= 500 ? "ERROR" : "DEFAULT",
    });
    try {
      await emit?.({
        name: prepared.name,
        metadata: handed.metadata,
        level: handed.level,
        ...(handed.statusMessage ? { statusMessage: handed.statusMessage } : {}),
      });
    } catch {
      /* a test double must not change the result */
    }
    return result;
  } catch (err) {
    const recorded = withLangfuseError(safe, err);
    const handed = handoffSpan({
      metadata: recorded.metadata,
      level: "ERROR",
      statusMessage: recorded.statusMessage,
    });
    try {
      await emit?.({
        name: prepared.name,
        metadata: handed.metadata,
        level: handed.level,
        ...(handed.statusMessage ? { statusMessage: handed.statusMessage } : {}),
      });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

async function traceWithSdk<T>(name: string, metadata: Record<string, unknown> | undefined, fn: () => Promise<T>): Promise<T> {
  const prepared = prepareLangfuseSpan(name, metadata);
  if (!prepared) return fn();
  const safe = prepared.meta;
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
    const labels = readLangfuseTraceLabels();
    const opened = handoffSpan({ metadata: safe, level: "DEFAULT" });
    const sessionId = typeof opened.metadata.session_ref === "string" ? opened.metadata.session_ref : undefined;
    const userId = typeof opened.metadata.agent_ref === "string" ? opened.metadata.agent_ref : undefined;
    await propagateAttributes(
      {
        traceName: prepared.name,
        userId,
        sessionId,
        metadata: opened.metadata,
        tags: opened.tags,
        environment: labels.environment,
      },
      async () => {
        await startActiveObservation(prepared.name, async (span) => {
          try {
            result = await fn();
            ran = true;
            const status = responseStatus(result);
            const handed = handoffSpan({
              metadata: status === undefined ? safe : { ...safe, http_status: status },
              level: status !== undefined && status >= 500 ? "ERROR" : "DEFAULT",
            });
            try {
              span.update({
                metadata: handed.metadata,
                level: handed.level,
                ...(handed.statusMessage ? { statusMessage: handed.statusMessage } : {}),
              });
            } catch {
              /* ignore */
            }
          } catch (err) {
            ran = true;
            failure = err;
            const recorded = withLangfuseError(safe, err);
            const handed = handoffSpan({
              metadata: recorded.metadata,
              level: "ERROR",
              statusMessage: recorded.statusMessage,
            });
            try {
              span.update({
                level: handed.level,
                metadata: handed.metadata,
                ...(handed.statusMessage ? { statusMessage: handed.statusMessage } : {}),
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

type LangfuseMetadata = Record<string, unknown> | undefined;

function resolveLangfuseMetadata(metadata: LangfuseMetadata | (() => LangfuseMetadata)): LangfuseMetadata {
  return typeof metadata === "function" ? metadata() : metadata;
}

/**
 * Run `fn` and, when Langfuse is enabled, record one span named `name`.
 * Metadata is scrubbed. The span never includes the secret key, prompts,
 * message bodies, or exception text. A Langfuse or sanitizer failure still
 * returns `fn`'s result and records no span.
 * Pass a function for `metadata` when building it is expensive: it is not
 * called while tracing is off.
 */
export async function traceAgentEvent<T>(
  name: string,
  metadata: LangfuseMetadata | (() => LangfuseMetadata),
  fn: () => Promise<T>,
): Promise<T> {
  if (!isLangfuseEnabled()) return fn();
  let resolved: LangfuseMetadata;
  try {
    resolved = resolveLangfuseMetadata(metadata);
  } catch {
    return fn();
  }
  if (testEmitter) return traceWithEmitter(name, resolved, fn);
  return traceWithSdk(name, resolved, fn);
}
