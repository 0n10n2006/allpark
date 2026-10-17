// Run prisma seed in demo mode cross-platform
process.env.DEMO_MODE = "1";
process.env.NEXT_PUBLIC_DEMO_MODE = "1";
await import("../prisma/seed.ts");
