import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const taskId = process.argv[2];
if (!taskId || !/^[a-z0-9_]+$/.test(taskId)) {
  console.error("Task ID must match ^[a-z0-9_]+$");
  process.exit(1);
}
const run = (command, args) =>
  execFileSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
run("npm", ["ci"]);
const adminPath = `${process.env.USERPROFILE}\\.parkshare\\pg-admin-url`;
const adminUrl =
  process.env.PARKSHARE_PG_ADMIN_URL ||
  (existsSync(adminPath) ? readFileSync(adminPath, "utf8").trim() : "");
if (!adminUrl) {
  console.warn("PARKSHARE_PG_ADMIN_URL is not configured; skipping database setup.");
  process.exit(0);
}
const dbName = `parkshare_${taskId}`;
const testName = `${dbName}_test`;
const { default: pg } = await import("pg"); // after npm ci, so fresh worktrees work
const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
for (const name of [dbName, testName]) {
  const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (result.rowCount === 0) await client.query(`CREATE DATABASE "${name}"`);
}
await client.end();
const toDatabaseUrl = (name) =>
  new URL(adminUrl).toString().replace(/\/[^/?]+(?=\?|$)/, `/${name}`);
writeFileSync(
  ".env",
  [
    `DATABASE_URL=${toDatabaseUrl(dbName)}`,
    `TEST_DATABASE_URL=${toDatabaseUrl(testName)}`,
    `AUTH_SECRET=${randomBytes(32).toString("hex")}`,
    "AUTH_URL=http://localhost:3000",
    "EMAIL_FROM=ParkShare <noreply@example.com>",
    `CRON_SECRET=${randomBytes(32).toString("hex")}`,
    "APP_TIMEZONE=Asia/Kolkata",
  ].join("\n") + "\n",
);
if (existsSync("prisma/migrations")) {
  run("npx", ["prisma", "migrate", "deploy"]);
  run("npm", ["run", "db:seed"]);
}
