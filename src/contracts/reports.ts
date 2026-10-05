import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

// FR-11. There is no Report model in the schema yet; the implementing task adds it
// through a coordinator-owned migration.

export const ReportTargetType = z.enum(["LISTING", "REVIEW", "USER", "BOOKING"]);
export const ReportCategory = z.enum([
  "ACCESS_PROBLEM",
  "SUSPICIOUS",
  "INACCURATE_LISTING",
  "INAPPROPRIATE",
  "OTHER",
]);

/** POST /api/reports */
export const CreateReportBody = z.strictObject({
  targetType: ReportTargetType,
  targetId: Uuid,
  category: ReportCategory,
  description: z.string().trim().min(10).max(5000),
});
export type CreateReportBody = z.infer<typeof CreateReportBody>;

export const CreateReportResponse = z.object({
  id: Uuid,
  status: z.enum(["OPEN", "UNDER_REVIEW", "ACTIONED", "DISMISSED"]),
  createdAt: IsoDateTime,
});
export type CreateReportResponse = z.infer<typeof CreateReportResponse>;
