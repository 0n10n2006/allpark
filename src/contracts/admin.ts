import { z } from "zod";
import {
  BookingStatus,
  DisputeStatus,
  HostVerificationStatus,
  JobStatus,
  ListingStatus,
  PaymentStatus,
  RefundStatus,
  UserRole,
} from "../generated/prisma/enums";
import { AdminReason, IsoDateTime, Money, PaginationQuery, Uuid, page } from "./common";
import { BookingDetail } from "./bookings";
import { Dispute } from "./disputes";
import { OwnedListing } from "./listings";

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

/** Dispute with its booking for the support timeline. */
export const AdminDispute = z.object({ ...Dispute.shape, booking: AdminBooking });
export type AdminDispute = z.infer<typeof AdminDispute>;

/** GET /api/admin/disputes: the dispute queue. */
export const AdminListDisputesQuery = PaginationQuery.extend({
  disputeStatus: z.enum(DisputeStatus).optional(),
});
export type AdminListDisputesQuery = z.infer<typeof AdminListDisputesQuery>;
export const AdminListDisputesResponse = page(AdminDispute);

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
});
export type AdminResolveDisputeBody = z.infer<typeof AdminResolveDisputeBody>;
