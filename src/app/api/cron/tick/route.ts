import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { runOnce, type RunOnceResult } from "@/server/jobs";

function authorized(header: string | null): boolean {
  const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
  const received = Buffer.from(header ?? "");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export async function POST(request: Request) {
  if (!authorized(request.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workerId = `cron:${process.pid}`;
  const totals: RunOnceResult = { claimed: 0, succeeded: 0, retried: 0, dead: 0 };
  const deadline = Date.now() + 25_000;
  do {
    const result = await runOnce(workerId);
    totals.claimed += result.claimed;
    totals.succeeded += result.succeeded;
    totals.retried += result.retried;
    totals.dead += result.dead;
    if (result.claimed === 0) break;
  } while (Date.now() < deadline);

  return Response.json(totals);
}
