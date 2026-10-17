import { spawn, execSync } from "node:child_process";

process.env.DEMO_MODE = "1";
process.env.NEXT_PUBLIC_DEMO_MODE = "1";

console.log("=== ParkShare Demo Mode Setup ===");
console.log("Ensuring database migrations are up to date...");
execSync("npx prisma migrate deploy", { stdio: "inherit", env: process.env, shell: true });

console.log("Seeding demo data...");
execSync("node --env-file-if-exists=.env --import tsx scripts/seed-demo.mjs", {
  stdio: "inherit",
  env: process.env,
  shell: true,
});

console.log(`
========================================================================
  ParkShare Local Demo Mode Active
========================================================================
  Web App URL:       http://localhost:3000
  Demo Sign-In:      http://localhost:3000/dev/sign-in

  Demo Accounts:
    1. Renter:        riya@parkshare.local       (Riya Sen)
    2. Verified Host: harsh@parkshare.local      (Harsh Vardhan)
    3. New Host:      newhost@parkshare.local    (Naveen Host - Pending)
    4. Admin:         asha@parkshare.local       (Asha Sharma)

  Simulated Payments:
    - Active when RAZORPAY_* keys are absent.
    - Zero real money charged; full settlement and ledger verification.

  Local Photo Uploads:
    - Active when CLOUDINARY_* keys are absent.
    - Files stored in public/uploads/ (gitignored).
========================================================================
Starting Next.js dev server and background job worker...
`);

const nextProc = spawn("npx", ["next", "dev"], {
  stdio: "inherit",
  env: process.env,
  shell: true,
});

const workerProc = spawn(
  process.execPath,
  ["--env-file-if-exists=.env", "--import", "tsx", "src/server/jobs/worker-cli.ts"],
  {
    stdio: "inherit",
    env: process.env,
    shell: true,
  },
);

function cleanup() {
  try {
    nextProc.kill("SIGTERM");
  } catch {}
  try {
    workerProc.kill("SIGTERM");
  } catch {}
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("exit", cleanup);

nextProc.on("exit", (code) => {
  if (code !== 0 && code !== null) {
    console.error(`Next.js dev server exited with code ${code}`);
  }
  cleanup();
});

workerProc.on("exit", (code) => {
  if (code !== 0 && code !== null) {
    console.error(`Worker process exited with code ${code}`);
  }
});
