import { z } from "zod";
// The registry, not "@/server/jobs": that index imports builtins, which imports this file.
import { registerJob } from "@/server/jobs/registry";
import { graceExpired, startGrace } from "./service";

// FR-07 AC1: durable jobs, scheduled by scheduleSessionJobs. Type strings are literals
// (see service.ts) because this module is loaded mid-cycle from the jobs index.
const GraceJob = z.object({ bookingId: z.uuid(), endAt: z.iso.datetime() });
registerJob("sessions.startGrace", GraceJob, startGrace);
registerJob("sessions.graceExpired", GraceJob, graceExpired);
