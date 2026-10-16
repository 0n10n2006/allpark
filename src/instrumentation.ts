/** Runs once at server start: a bad or placeholder env fails the boot, not the first request (L5). */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("@/lib/env");
}
