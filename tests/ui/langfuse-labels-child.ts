/**
 * Proves the Langfuse processor does not stamp raw LANGFUSE_TRACING_ENVIRONMENT
 * or LANGFUSE_RELEASE onto an exported span. An in-memory exporter stands in
 * for the network. LANGFUSE_LABEL_ATTACK_ENV overrides the hostile environment
 * so reserved "langfuse" prefixes can be checked in their own process.
 */
import fs from "node:fs";

const ATTACK_ENV = "prod/attacker";
const ATTACK_RELEASE = "release with secret";
const AMOUNT = "999999.99";

async function main(): Promise<void> {
  const requested = process.env.LANGFUSE_LABEL_ATTACK_ENV?.trim();
  const attackEnv = requested && requested.length > 0 ? requested : ATTACK_ENV;
  process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
  process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
  process.env.LANGFUSE_BASEURL = "http://127.0.0.1:9";
  delete process.env.LANGFUSE_HOST;
  delete process.env.LANGFUSE_BASE_URL;
  process.env.LANGFUSE_TRACING_ENVIRONMENT = attackEnv;
  process.env.LANGFUSE_RELEASE = ATTACK_RELEASE;
  process.env.LANGFUSE_OTEL_COMPRESSION = "none";

  const { InMemorySpanExporter } = await import("@opentelemetry/sdk-trace-base");
  const exporter = new InMemorySpanExporter();
  const { flushLangfuseForTests, setLangfuseExporterForTests, traceAgentEvent } = await import("../../src/lib/langfuse");
  setLangfuseExporterForTests(exporter);
  await traceAgentEvent(
    "task.create",
    { platform: "codex", cost_usd: 999999.99, note: ATTACK_RELEASE, environment: attackEnv },
    async () => 1,
  );
  await flushLangfuseForTests();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const spans = exporter.getFinishedSpans();
  const text = spans
    .map((span) =>
      JSON.stringify({
        name: span.name,
        attributes: span.attributes,
        resource: span.resource.attributes,
        status: span.status,
      }),
    )
    .join("\n");
  const report = {
    spans: spans.length,
    environments: spans.map((span) => span.attributes["langfuse.environment"] ?? null),
    releases: spans.map((span) => span.attributes["langfuse.release"] ?? null),
    attackEnv,
    sawAttackEnv: text.includes(attackEnv),
    sawAttackRelease: text.includes(ATTACK_RELEASE),
    sawAmount: text.includes(AMOUNT),
    sawPlatform: text.includes("codex"),
    sawBucket: text.includes("gte_100"),
    sawSecret: text.includes("sk-lf-test-secret"),
  };
  fs.writeSync(1, `${JSON.stringify(report)}\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  const name = err instanceof Error ? err.name : "Error";
  fs.writeSync(2, `labels child failed: ${name}\n`);
  process.exit(1);
});
