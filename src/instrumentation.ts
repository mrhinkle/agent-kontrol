/**
 * Next.js loads this file when the server starts. Langfuse is registered only
 * when both API keys are set; otherwise this returns without loading the SDK.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { isLangfuseEnabled } = await import("./lib/langfuse-config");
  if (!isLangfuseEnabled()) return;
  const { ensureLangfuse } = await import("./lib/langfuse");
  await ensureLangfuse();
}
