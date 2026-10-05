import { randomUUID } from "node:crypto";
import { runOnce } from "./index";

const workerId = `worker:${process.pid}:${randomUUID()}`;

async function tick() {
  try {
    const result = await runOnce(workerId);
    console.log(JSON.stringify({ event: "jobs.tick", workerId, ...result }));
  } catch (error) {
    console.error(JSON.stringify({ event: "jobs.error", workerId, error: "runOnce failed" }));
  }
}

await tick();
setInterval(() => void tick(), 5_000);
