/**
 * Installs the production shutdown hook and waits. The parent sends SIGTERM
 * or SIGINT. forceFlush prints a marker after a short delay so a test can
 * see that a second signal did not skip the flush. A flush that never
 * settles must still end the process.
 */
import fs from "node:fs";
import { installLangfuseShutdown } from "../../src/lib/langfuse";

const hang = process.env.LANGFUSE_TEST_HANG === "1";
installLangfuseShutdown({
  forceFlush() {
    fs.writeSync(1, "flush-start\n");
    if (hang) return new Promise<void>(() => {});
    return new Promise((resolve) => {
      setTimeout(() => {
        fs.writeSync(1, "flushed\n");
        resolve();
      }, 200);
    });
  },
});

fs.writeSync(1, "ready\n");
setInterval(() => {}, 60_000);
