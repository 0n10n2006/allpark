import { z } from "zod";
import {
  BookingStatus,
  DisputeCategory,
  DisputeStatus,
  HostVerificationStatus,
  JobStatus,
  ListingStatus,
  NotificationStatus,
  PaymentStatus,
  PayoutStatus,
  RefundStatus,
  UserRole,
} from "../generated/prisma/enums";
import { AdminReason, Currency, IsoDateTime, Money, PaginationQuery, Uuid, page } from "./common";
import { BookingDetail } from "./bookings";
import { Dispute } from "./disputes";
import { HostPayout } from "./host";
import { OwnedListing } from "./listings";
import { ReportReason, ReportStatus, ReportTargetType } from "./reports";

// FR-13. Admin-only. Every mutating request carries a required `reason`, written to
// AuditLog with actor, action, target, and timestamp.

/** Free-text search over ids, names, emails, phones, titles, provider references. */
const q = z.string().trim().min(1).max(200).optional();

// ── Lookups ──

export const AdminUser = z.object({
  id: Uuid,
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  roles: z.array(z.enum(UserRole)),
  hostVerificationStatus: z.enum(HostVerificationStatus),
  deletionRequestedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type AdminUser = z.infer<typeof AdminUser>;

/** GET /api/admin/users */
export const AdminListUsersQuery = PaginationQuery.extend({
  q,
  role: z.enum(UserRole).optional(),
  hostVerificationStatus: z.enum(HostVerificationStatus).optional(),
});
export type AdminListUsersQuery = z.infer<typeof AdminListUsersQuery>;
export const AdminListUsersResponse = page(AdminUser);
export type AdminListUsersResponse = z.infer<typeof AdminListUsersResponse>;

export const AdminListing = z.object({ ...OwnedListing.shape, hostId: Uuid });
export type AdminListing = z.infer<typeof AdminListing>;

/** GET /api/admin/listings */
export const AdminListListingsQuery = PaginationQuery.extend({
  q,
  listingStatus: z.enum(ListingStatus).optional(),
  hostId: Uuid.optional(),
});
export type AdminListListingsQuery = z.infer<typeof AdminListListingsQuery>;
export const AdminListListingsResponse = page(AdminListing);
export type AdminListListingsResponse = z.infer<typeof AdminListListingsResponse>;

export const AdminBooking = z.object({ ...BookingDetail.shape, hostId: Uuid });
export type AdminBooking = z.infer<typeof AdminBooking>;

/** GET /api/admin/bookings */
export const AdminListBookingsQuery = PaginationQuery.extend({
  q,
  bookingStatus: z.enum(BookingStatus).optional(),
  listingId: Uuid.optional(),
  renterId: Uuid.optional(),
});
export type AdminListBookingsQuery = z.infer<typeof AdminListBookingsQuery>;
export const AdminListBookingsResponse = page(AdminBooking);
export type AdminListBookingsResponse = z.infer<typeof AdminListBookingsResponse>;

export const AdminRefund = z.object({
  id: Uuid,
  amount: Money,
  reason: z.string(),
  providerRefundId: z.string().nullable(),
  status: z.enum(RefundStatus),
  failureReason: z.string().nullable(),
  reconciledAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type AdminRefund = z.infer<typeof AdminRefund>;

export const AdminPayment = z.object({
  id: Uuid,
  bookingId: Uuid,
  provider: z.string(),
  providerOrderId: z.string(),
  providerPaymentId: z.string().nullable(),
  amount: Money,
  status: z.enum(PaymentStatus),
  failureReason: z.string().nullable(),
  signatureVerifiedAt: IsoDateTime.nullable(),
  reconciledAt: IsoDateTime.nullable(),
  refunds: z.array(AdminRefund),
  createdAt: IsoDateTime,
});
export type AdminPayment = z.infer<typeof AdminPayment>;

/** GET /api/admin/payments */
export const AdminListPaymentsQuery = PaginationQuery.extend({
  q,
  paymentStatus: z.enum(PaymentStatus).optional(),
  bookingId: Uuid.optional(),
  unreconciled: z.stringbool().optional(),
});
export type AdminListPaymentsQuery = z.infer<typeof AdminListPaymentsQuery>;
export const AdminListPaymentsResponse = page(AdminPayment);
export type AdminListPaymentsResponse = z.infer<typeof AdminListPaymentsResponse>;

export const AdminJob = z.object({
  id: Uuid,
  type: z.string(),
  status: z.enum(JobStatus),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(0),
  runAt: IsoDateTime,
  lastError: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type AdminJob = z.infer<typeof AdminJob>;

/** GET /api/admin/jobs: failed and dead jobs for ops (FR-13). */
export const AdminListJobsQuery = PaginationQuery.extend({
  jobStatus: z.enum(JobStatus).optional(),
  type: z.string().max(100).optional(),
});
export type AdminListJobsQuery = z.infer<typeof AdminListJobsQuery>;
export const AdminListJobsResponse = page(AdminJob);
export type AdminListJobsResponse = z.infer<typeof AdminListJobsResponse>;

/** Dispute with its booking for the support timeline. */
export const AdminDispute = z.object({ ...Dispute.shape, booking: AdminBooking });
export type AdminDispute = z.infer<typeof AdminDispute>;

/** GET /api/admin/disputes: the dispute queue. */
export const AdminListDisputesQuery = PaginationQuery.extend({
  disputeStatus: z.enum(DisputeStatus).optional(),
  category: z.enum(DisputeCategory).optional(),
  bookingId: Uuid.optional(),
});
export type AdminListDisputesQuery = z.infer<typeof AdminListDisputesQuery>;
export const AdminListDisputesResponse = page(AdminDispute);
export type AdminListDisputesResponse = z.infer<typeof AdminListDisputesResponse>;

/**
 * GET /api/admin/disputes/:id: one dispute with the booking's payments (and refunds),
 * notifications, and audit trail for the support timeline (FR-10, FR-13). Oldest first.
 */
export const AdminDisputeDetail = z.object({
  ...AdminDispute.shape,
  payments: z.array(AdminPayment),
  notifications: z.array(
    z.object({
      id: Uuid,
      userId: Uuid,
      type: z.string(),
      status: z.enum(NotificationStatus),
      scheduledAt: IsoDateTime,
      sentAt: IsoDateTime.nullable(),
    }),
  ),
  auditLog: z.array(
    z.object({
      id: Uuid,
      actorId: Uuid.nullable(),
      action: z.string(),
      targetType: z.string(),
      targetId: z.string().nullable(),
      reason: z.string().nullable(),
      createdAt: IsoDateTime,
    }),
  ),
});
export type AdminDisputeDetail = z.infer<typeof AdminDisputeDetail>;

// ── Decisions (all require `reason`) ──

/** POST /api/admin/users/:id/verify-host */
export const AdminVerifyHostBody = z.strictObject({
  decision: z.enum(["VERIFIED", "REJECTED"]),
  reason: AdminReason,
});
export type AdminVerifyHostBody = z.infer<typeof AdminVerifyHostBody>;

/** POST /api/admin/users/:id/suspend. `suspended: false` reinstates. */
export const AdminSuspendUserBody = z.strictObject({
  suspended: z.boolean(),
  reason: AdminReason,
});
export type AdminSuspendUserBody = z.infer<typeof AdminSuspendUserBody>;

/** POST /api/admin/listings/:id/suspend. Suspended listings leave search; history stays. */
export const AdminSuspendListingBody = z.strictObject({
  suspended: z.boolean(),
  reason: AdminReason,
});
export type AdminSuspendListingBody = z.infer<typeof AdminSuspendListingBody>;

/** POST /api/admin/reviews/:id/moderate */
export const AdminModerateReviewBody = z.strictObject({
  decision: z.enum(["APPROVED", "REJECTED"]),
  reason: AdminReason,
});
export type AdminModerateReviewBody = z.infer<typeof AdminModerateReviewBody>;

/** POST /api/admin/disputes/:id/resolve */
export const AdminResolveDisputeBody = z.strictObject({
  outcome: z.enum(["UNDER_REVIEW", "RESOLVED", "REJECTED"]),
  resolution: z.string().trim().min(3).max(5000),
  reason: AdminReason,
  /** Optional refund to the renter, capped at the refundable captured amount. */
  refundPaise: z.number().int().positive().optional(),
  /** Where a DISPUTED booking goes when the dispute closes; required then, ignored otherwise. */
  bookingOutcome: z.enum(["COMPLETED", "CANCELLED"]).optional(),
});
export type AdminResolveDisputeBody = z.infer<typeof AdminResolveDisputeBody>;

// ── Payouts (FR-06 AC5/AC6; payoutMode MANUAL: an admin pays, then records the reference) ──

export const AdminPayout = z.object({
  ...HostPayout.shape,
  hostId: Uuid,
  /** Bookings this payout claims. Empty once FAILED (marking failed releases them). */
  bookingIds: z.array(Uuid),
});
export type AdminPayout = z.infer<typeof AdminPayout>;

/** GET /api/admin/payouts */
export const AdminListPayoutsQuery = PaginationQuery.extend({
  hostId: Uuid.optional(),
  payoutStatus: z.enum(PayoutStatus).optional(),
});
export type AdminListPayoutsQuery = z.infer<typeof AdminListPayoutsQuery>;
export const AdminListPayoutsResponse = page(AdminPayout);
export type AdminListPayoutsResponse = z.infer<typeof AdminListPayoutsResponse>;

/** POST /api/admin/payouts. The amount is computed server-side from the ledger. */
export const AdminCreatePayoutBody = z.strictObject({
  hostId: Uuid,
  bookingIds: z
    .array(Uuid)
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate booking id"),
  reason: AdminReason,
});
export type AdminCreatePayoutBody = z.infer<typeof AdminCreatePayoutBody>;

/** POST /api/admin/payouts/:id/mark-paid. `providerReference` is the bank UTR or transfer id. */
export const AdminMarkPayoutPaidBody = z.strictObject({
  providerReference: z.string().trim().min(3).max(200),
  reason: AdminReason,
});
export type AdminMarkPayoutPaidBody = z.infer<typeof AdminMarkPayoutPaidBody>;

/** POST /api/admin/payouts/:id/mark-failed. Releases the bookings so they can be paid again. */
export const AdminMarkPayoutFailedBody = z.strictObject({ reason: AdminReason });
export type AdminMarkPayoutFailedBody = z.infer<typeof AdminMarkPayoutFailedBody>;

/** Signed paise: a refund after a payout can make these negative. */
const SignedPaise = z.number().int();

/** GET /api/admin/payouts/reconciliation */
export const AdminPayoutReconciliationResponse = z.object({
  currency: Currency,
  hosts: z.array(
    z.object({
      hostId: Uuid,
      hostEarningsPaise: SignedPaise,
      hostRefundsPaise: SignedPaise,
      /** HOST_PAYOUT ledger rows. */
      paidOutPaise: SignedPaise,
      /** hostEarnings − hostRefunds − paidOut, from the ledger. */
      outstandingPaise: SignedPaise,
      /** Net earnings of bookings not in a PAID payout (pending + payable + in payout). */
      unpaidBookingsPaise: SignedPaise,
      payablePaise: SignedPaise,
    }),
  ),
  discrepancies: z.array(
    z.object({
      kind: z.enum(["outstanding_mismatch", "payout_ledger_mismatch"]),
      hostId: Uuid,
      payoutId: Uuid.nullable(),
      expectedPaise: SignedPaise,
      actualPaise: SignedPaise,
    }),
  ),
});
export type AdminPayoutReconciliationResponse = z.infer<typeof AdminPayoutReconciliationResponse>;

export const AdminReport = z.object({
  id: Uuid,
  reporterId: Uuid,
  targetType: ReportTargetType,
  targetId: Uuid,
  reason: ReportReason,
  description: z.string(),
  evidenceUrls: z.array(z.url()),
  status: ReportStatus,
  resolution: z.string().nullable(),
  resolvedById: Uuid.nullable(),
  resolvedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type AdminReport = z.infer<typeof AdminReport>;

/** GET /api/admin/reports: the report moderation queue. */
export const AdminListReportsQuery = PaginationQuery.extend({
  status: ReportStatus.optional(),
  targetType: ReportTargetType.optional(),
});
export type AdminListReportsQuery = z.infer<typeof AdminListReportsQuery>;
export const AdminListReportsResponse = page(AdminReport);
export type AdminListReportsResponse = z.infer<typeof AdminListReportsResponse>;

/** POST /api/admin/reports/:id/resolve */
export const AdminResolveReportBody = z.strictObject({
  action: z.enum(["DISMISS", "ACTION"]),
  resolution: z.string().trim().min(3).max(5000),
  reason: AdminReason,
});
export type AdminResolveReportBody = z.infer<typeof AdminResolveReportBody>;
