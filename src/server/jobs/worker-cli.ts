import { randomUUID } from "node:crypto";
import { runOnce } from "./index";

const workerId = `worker:${process.pid}:${randomUUID()}`;

async function tick() {
  try {
    const result = await runOnce(workerId);
    console.log(JSON.stringify({ event: "jobs.tick", workerId, ...result }));
  } catch {
    console.error(JSON.stringify({ event: "jobs.error", workerId, error: "runOnce failed" }));
  }
}

// Reschedule after each run so slow batches never overlap. The DB is the
// source of truth; this timer only decides when to poll it next.
async function loop() {
  await tick();
  setTimeout(() => void loop(), 5_000);
}

void loop();
