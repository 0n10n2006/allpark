import type { z } from "zod";
import * as admin from "./admin";
import * as availability from "./availability";
import * as bookings from "./bookings";
import { AdminActionResponse, IdParams, PaginationQuery } from "./common";
import * as disputes from "./disputes";
import * as host from "./host";
import * as listings from "./listings";
import * as monthly from "./monthly";
import * as notifications from "./notifications";
import * as payments from "./payments";
import * as quotes from "./quotes";
import * as reports from "./reports";
import * as reviews from "./reviews";
import * as search from "./search";
import * as sessions from "./sessions";
import * as users from "./users";
import * as webhooks from "./webhooks";

// Every API endpoint, its auth mode, its contract schemas, and the plan task that
// implements it. tests/contracts checks each entry has a matching route file, and
// scripts/gen-api-doc.ts renders docs/API.md from this list.

export type Endpoint = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Express-style path; `:id` maps to the `[id]` folder. */
  path: string;
  auth: "public" | "user" | "admin";
  /** Plan task(s) that implement the handler. */
  task: string;
  /** Handler must wrap the mutation in withIdempotency (Idempotency-Key header). */
  idempotent?: boolean;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
};

export const endpoints: Endpoint[] = [
  // Listings and search
  {
    method: "GET",
    path: "/api/listings",
    auth: "public",
    task: "T2.4",
    query: search.SearchListingsQuery,
    response: search.SearchListingsResponse,
  },
  {
    method: "POST",
    path: "/api/listings",
    auth: "user",
    task: "T2.3",
    body: listings.CreateListingBody,
    response: listings.OwnedListing,
  },
  {
    method: "GET",
    path: "/api/listings/mine",
    auth: "user",
    task: "T2.3",
    query: PaginationQuery,
    response: listings.MyListingsResponse,
  },
  {
    method: "GET",
    path: "/api/listings/:id",
    auth: "public",
    task: "T2.3",
    params: IdParams,
    response: listings.PublicListing,
  },
  {
    method: "PATCH",
    path: "/api/listings/:id",
    auth: "user",
    task: "T2.3",
    params: IdParams,
    body: listings.UpdateListingBody,
    response: listings.OwnedListing,
  },
  {
    method: "GET",
    path: "/api/listings/:id/availability",
    auth: "public",
    task: "T2.1",
    params: IdParams,
    query: availability.GetAvailabilityQuery,
    response: availability.GetAvailabilityResponse,
  },
  {
    method: "POST",
    path: "/api/listings/:id/availability",
    auth: "user",
    task: "T2.3",
    params: IdParams,
    body: availability.UpdateAvailabilityBody,
    response: availability.GetAvailabilityResponse,
  },
  {
    method: "POST",
    path: "/api/listings/:id/photos/sign",
    auth: "user",
    task: "T2.3",
    params: IdParams,
    body: listings.SignPhotoUploadBody,
    response: listings.SignPhotoUploadResponse,
  },
  {
    method: "POST",
    path: "/api/listings/:id/photos",
    auth: "user",
    task: "T2.3",
    params: IdParams,
    body: listings.AddListingPhotoBody,
    response: listings.ListingPhoto,
  },
  {
    method: "POST",
    path: "/api/listings/:id/publish",
    auth: "user",
    task: "T2.3",
    params: IdParams,
    body: listings.PublishListingBody,
    response: listings.OwnedListing,
  },
  {
    method: "PATCH",
    path: "/api/listings/:id/photos",
    auth: "user",
    task: "T2.3",
    params: IdParams,
    body: listings.ReorderListingPhotosBody,
    response: listings.ListingPhotosResponse,
  },
  {
    method: "DELETE",
    path: "/api/listings/:id/photos",
    auth: "user",
    task: "T2.3",
    params: IdParams,
    query: listings.DeleteListingPhotoQuery,
    response: listings.ListingPhotosResponse,
  },
  {
    method: "POST",
    path: "/api/me/host",
    auth: "user",
    task: "T2.3",
    body: listings.BecomeHostBody,
    response: listings.HostStatusResponse,
  },

  // Quotes and bookings
  {
    method: "POST",
    path: "/api/quotes",
    auth: "user",
    task: "T2.2",
    body: quotes.CreateQuoteBody,
    response: quotes.Quote,
  },
  {
    method: "GET",
    path: "/api/bookings",
    auth: "user",
    task: "T2.1",
    query: bookings.ListBookingsQuery,
    response: bookings.ListBookingsResponse,
  },
  {
    method: "POST",
    path: "/api/bookings",
    auth: "user",
    task: "T2.1",
    idempotent: true,
    body: bookings.CreateBookingBody,
    response: bookings.BookingDetail,
  },
  {
    method: "POST",
    path: "/api/bookings/hold",
    auth: "user",
    task: "T2.1",
    idempotent: true,
    body: bookings.CreateHoldBody,
    response: bookings.BookingDetail,
  },
  {
    method: "GET",
    path: "/api/bookings/:id",
    auth: "user",
    task: "T2.1",
    params: IdParams,
    response: bookings.BookingDetail,
  },
  {
    method: "POST",
    path: "/api/bookings/:id/cancel",
    auth: "user",
    task: "T2.1, T4.4",
    idempotent: true,
    params: IdParams,
    body: bookings.CancelBookingBody,
    response: bookings.BookingDetail,
  },
  {
    method: "POST",
    path: "/api/bookings/:id/confirm-payment",
    auth: "user",
    task: "T4.1",
    idempotent: true,
    params: IdParams,
    body: payments.ConfirmPaymentBody,
    response: bookings.BookingDetail,
  },

  // Sessions and monthly
  {
    method: "POST",
    path: "/api/bookings/:id/check-in",
    auth: "user",
    task: "T4.2",
    params: IdParams,
    body: sessions.CheckInBody,
    response: bookings.BookingDetail,
  },
  {
    method: "POST",
    path: "/api/bookings/:id/check-out",
    auth: "user",
    task: "T4.2",
    params: IdParams,
    body: sessions.CheckOutBody,
    response: bookings.BookingDetail,
  },
  {
    method: "POST",
    path: "/api/bookings/:id/extend",
    auth: "user",
    task: "T4.2",
    idempotent: true,
    params: IdParams,
    body: sessions.ExtendBookingBody,
    response: sessions.ExtendBookingResponse,
  },
  {
    method: "POST",
    path: "/api/bookings/:id/incidents",
    auth: "user",
    task: "T4.2",
    params: IdParams,
    body: sessions.ReportIncidentBody,
    response: sessions.OverstayIncident,
  },
  {
    method: "POST",
    path: "/api/monthly/:id/renew",
    auth: "user",
    task: "T4.3",
    idempotent: true,
    params: IdParams,
    body: monthly.RenewMonthlyBody,
    response: monthly.RenewMonthlyResponse,
  },

  // Payments
  {
    method: "POST",
    path: "/api/payments/order",
    auth: "user",
    task: "T4.1",
    idempotent: true,
    body: payments.CreatePaymentOrderBody,
    response: payments.CreatePaymentOrderResponse,
  },
  {
    method: "POST",
    path: "/api/webhooks/razorpay",
    auth: "public",
    task: "T4.1",
    body: webhooks.RazorpayWebhookBody,
    response: webhooks.RazorpayWebhookResponse,
  },

  // Trust
  {
    method: "POST",
    path: "/api/disputes",
    auth: "user",
    task: "T4.4",
    body: disputes.CreateDisputeBody,
    response: disputes.Dispute,
  },
  {
    method: "POST",
    path: "/api/reviews",
    auth: "user",
    task: "T4.4",
    body: reviews.CreateReviewBody,
    response: reviews.Review,
  },
  {
    method: "POST",
    path: "/api/reports",
    auth: "user",
    task: "T4.4",
    body: reports.CreateReportBody,
    response: reports.CreateReportResponse,
  },

  // Host
  {
    method: "GET",
    path: "/api/host/earnings",
    auth: "user",
    task: "T4.5",
    query: host.HostEarningsQuery,
    response: host.HostEarningsResponse,
  },
  {
    method: "GET",
    path: "/api/host/payouts",
    auth: "user",
    task: "T4.5",
    query: PaginationQuery,
    response: host.ListHostPayoutsResponse,
  },

  // Me
  {
    method: "GET",
    path: "/api/me/profile",
    auth: "user",
    task: "T2.5",
    response: users.Profile,
  },
  {
    method: "PATCH",
    path: "/api/me/profile",
    auth: "user",
    task: "T2.5",
    body: users.UpdateProfileBody,
    response: users.Profile,
  },
  {
    method: "GET",
    path: "/api/me/vehicles",
    auth: "user",
    task: "T2.5",
    response: users.ListVehiclesResponse,
  },
  {
    method: "POST",
    path: "/api/me/vehicles",
    auth: "user",
    task: "T2.5",
    body: users.CreateVehicleBody,
    response: users.Vehicle,
  },
  {
    method: "PATCH",
    path: "/api/me/vehicles/:id",
    auth: "user",
    task: "T2.5",
    params: IdParams,
    body: users.UpdateVehicleBody,
    response: users.Vehicle,
  },
  {
    method: "DELETE",
    path: "/api/me/vehicles/:id",
    auth: "user",
    task: "T2.5",
    params: IdParams,
    response: users.DeleteVehicleResponse,
  },
  {
    method: "GET",
    path: "/api/me/preferences",
    auth: "user",
    task: "T2.5",
    response: users.Preferences,
  },
  {
    method: "PATCH",
    path: "/api/me/preferences",
    auth: "user",
    task: "T2.5",
    body: users.UpdatePreferencesBody,
    response: users.Preferences,
  },
  {
    method: "POST",
    path: "/api/me/deletion-request",
    auth: "user",
    task: "T2.5",
    body: users.DeletionRequestBody,
    response: users.DeletionRequestResponse,
  },
  {
    method: "GET",
    path: "/api/notifications",
    auth: "user",
    task: "T2.6",
    query: PaginationQuery,
    response: notifications.ListNotificationsResponse,
  },
  {
    method: "POST",
    path: "/api/notifications/:id/read",
    auth: "user",
    task: "T2.6",
    params: IdParams,
    response: notifications.MarkNotificationReadResponse,
  },

  // Admin
  {
    method: "GET",
    path: "/api/admin/users",
    auth: "admin",
    task: "T4.6",
    query: admin.AdminListUsersQuery,
    response: admin.AdminListUsersResponse,
  },
  {
    method: "POST",
    path: "/api/admin/users/:id/verify-host",
    auth: "admin",
    task: "T4.6",
    params: IdParams,
    body: admin.AdminVerifyHostBody,
    response: AdminActionResponse,
  },
  {
    method: "POST",
    path: "/api/admin/users/:id/suspend",
    auth: "admin",
    task: "T4.6",
    params: IdParams,
    body: admin.AdminSuspendUserBody,
    response: AdminActionResponse,
  },
  {
    method: "GET",
    path: "/api/admin/listings",
    auth: "admin",
    task: "T4.6",
    query: admin.AdminListListingsQuery,
    response: admin.AdminListListingsResponse,
  },
  {
    method: "POST",
    path: "/api/admin/listings/:id/suspend",
    auth: "admin",
    task: "T4.6",
    params: IdParams,
    body: admin.AdminSuspendListingBody,
    response: AdminActionResponse,
  },
  {
    method: "GET",
    path: "/api/admin/bookings",
    auth: "admin",
    task: "T4.6",
    query: admin.AdminListBookingsQuery,
    response: admin.AdminListBookingsResponse,
  },
  {
    method: "GET",
    path: "/api/admin/payments",
    auth: "admin",
    task: "T4.6",
    query: admin.AdminListPaymentsQuery,
    response: admin.AdminListPaymentsResponse,
  },
  {
    method: "GET",
    path: "/api/admin/jobs",
    auth: "admin",
    task: "T4.6",
    query: admin.AdminListJobsQuery,
    response: admin.AdminListJobsResponse,
  },
  {
    method: "GET",
    path: "/api/admin/disputes",
    auth: "admin",
    task: "T4.6",
    query: admin.AdminListDisputesQuery,
    response: admin.AdminListDisputesResponse,
  },
  {
    method: "POST",
    path: "/api/admin/disputes/:id/resolve",
    auth: "admin",
    task: "T4.6",
    params: IdParams,
    body: admin.AdminResolveDisputeBody,
    response: AdminActionResponse,
  },
  {
    method: "POST",
    path: "/api/admin/reviews/:id/moderate",
    auth: "admin",
    task: "T4.6",
    params: IdParams,
    body: admin.AdminModerateReviewBody,
    response: AdminActionResponse,
  },
  {
    method: "GET",
    path: "/api/admin/payouts",
    auth: "admin",
    task: "T4.5",
    query: admin.AdminListPayoutsQuery,
    response: admin.AdminListPayoutsResponse,
  },
  {
    method: "POST",
    path: "/api/admin/payouts",
    auth: "admin",
    task: "T4.5",
    idempotent: true,
    body: admin.AdminCreatePayoutBody,
    response: admin.AdminPayout,
  },
  {
    method: "POST",
    path: "/api/admin/payouts/:id/mark-paid",
    auth: "admin",
    task: "T4.5",
    idempotent: true,
    params: IdParams,
    body: admin.AdminMarkPayoutPaidBody,
    response: AdminActionResponse,
  },
  {
    method: "POST",
    path: "/api/admin/payouts/:id/mark-failed",
    auth: "admin",
    task: "T4.5",
    idempotent: true,
    params: IdParams,
    body: admin.AdminMarkPayoutFailedBody,
    response: AdminActionResponse,
  },
  {
    method: "GET",
    path: "/api/admin/payouts/reconciliation",
    auth: "admin",
    task: "T4.5",
    response: admin.AdminPayoutReconciliationResponse,
  },
];
