import { z } from "zod";
import {
  ReportReason as PrismaReportReason,
  ReportStatus as PrismaReportStatus,
  ReportTargetType as PrismaReportTargetType,
} from "../generated/prisma/enums";
import { IsoDateTime, Uuid } from "./common";

// FR-11. User reports of listings, reviews, users, or bookings.

export const ReportTargetType = z.enum(PrismaReportTargetType);
export type ReportTargetType = z.infer<typeof ReportTargetType>;

export const ReportReason = z.enum(PrismaReportReason);
export type ReportReason = z.infer<typeof ReportReason>;

export const ReportStatus = z.enum(PrismaReportStatus);
export type ReportStatus = z.infer<typeof ReportStatus>;

export const ReportCategory = z.enum([
  "ACCESS_PROBLEM",
  "SUSPICIOUS",
  "INACCURATE_LISTING",
  "INAPPROPRIATE",
  "OTHER",
]);
export type ReportCategory = z.infer<typeof ReportCategory>;

/** POST /api/reports */
export const CreateReportBody = z.strictObject({
  targetType: ReportTargetType,
  targetId: Uuid,
  category: ReportCategory.optional(),
  reason: ReportReason.optional(),
  description: z.string().trim().min(10).max(5000),
  evidenceUrls: z.array(z.url()).max(10).optional(),
});
export type CreateReportBody = z.infer<typeof CreateReportBody>;

export const CreateReportResponse = z.strictObject({
  id: Uuid,
  status: ReportStatus,
  createdAt: IsoDateTime,
});
export type CreateReportResponse = z.infer<typeof CreateReportResponse>;

