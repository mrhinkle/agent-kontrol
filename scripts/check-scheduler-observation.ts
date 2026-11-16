import { readFileSync } from "node:fs";
import { checkSchedulerObservation } from "../src/lib/sweep-evidence";

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write("missing\n");
  process.exit(2);
}

for (const file of files) {
  const body = JSON.parse(readFileSync(file, "utf8")) as { observation?: unknown };
  const checked = checkSchedulerObservation(body.observation);
  if (!checked.ok) {
    process.stderr.write("rejected " + JSON.stringify(checked.fields) + "\n");
    process.exit(1);
  }
  if (checked.value.source !== "mini-launchd" || checked.value.stale_after_minutes !== 30) {
    process.stderr.write("rejected\n");
    process.exit(1);
  }
  if (!checked.value.job_id.startsWith("com.")) {
    process.stderr.write("rejected\n");
    process.exit(1);
  }
}

process.stdout.write(String(files.length) + "\n");
