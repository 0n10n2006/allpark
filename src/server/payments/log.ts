/** One-line JSON log, like src/server/http/route.ts. Never pass request bodies or secrets. */
export function log(
  level: "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown> = {},
) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
}
