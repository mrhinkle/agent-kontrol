/**
 * Proves instrumentation stays dormant: no Langfuse SDK import and no fetch
 * when the keys are unset. Spawned as its own process so a sibling test that
 * loads the SDK cannot hide an import.
 */
import fs from "node:fs";
import { registerHooks } from "node:module";

const sdk: string[] = [];
let sawConfig = false;
let fetches = 0;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const url = resolved.url ?? "";
    if (specifier.includes("langfuse-config") || url.includes("langfuse-config")) sawConfig = true;
    if (
      specifier.startsWith("@langfuse/") ||
      specifier.startsWith("@opentelemetry/") ||
      url.includes("/node_modules/@langfuse/") ||
      url.includes("/node_modules/@opentelemetry/")
    ) {
      sdk.push(specifier);
    }
    return resolved;
  },
});

for (const key of [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASEURL",
  "LANGFUSE_HOST",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_FLUSH_INTERVAL",
  "LANGFUSE_OTEL_COMPRESSION",
]) {
  delete process.env[key];
}
process.env.NEXT_RUNTIME = "nodejs";

const original = globalThis.fetch;
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  fetches += 1;
  return original(...args);
}) as typeof fetch;

async function main(): Promise<void> {
  const { register } = await import("../../src/instrumentation");
  await register();
  fs.writeSync(1, `${JSON.stringify({ sdk, sawConfig, fetches })}\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  const name = err instanceof Error ? err.name : "Error";
  fs.writeSync(2, `dormant child failed: ${name}\n`);
  process.exit(1);
});
