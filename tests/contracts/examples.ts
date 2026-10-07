// Minimal valid request/response examples for every registry entry, keyed "METHOD /path".
// Query values are strings, as they arrive from a URL.

const ID = "f4ee791f-7eb8-47ea-8966-74e6f446f489";
const ID2 = "4a929f40-a1d0-409b-bea9-8d5dbef95086";
const T0 = "2026-10-20T04:30:00Z";
const T1 = "2026-10-20T06:30:00Z";
const inr = (paise: number) => ({ paise, currency: "INR" });
const params = { id: ID };
const empty = { items: [], nextCursor: null };

const publicListing = {
  id: ID,
  title: "Covered spot near FC Road",
  description: "Gated society, covered stilt parking.",
  locality: "Shivajinagar",
  city: "Pune",
  approxLat: 18.53,
  approxLng: 73.84,
  spaceType: "STILT",
  vehicleTypes: ["HATCHBACK", "SEDAN"],
  maxHeightCm: 210,
  maxWidthCm: null,
  maxLengthCm: null,
  covered: true,
  lit: true,
  evCharging: false,
  security: true,
  hostRules: null,
  prices: { hourly: inr(5000), daily: inr(30000), weekly: null, monthly: null },
  minDurationMinutes: 60,
  cancellationPolicy: { key: "standard", summary: "Free cancellation up to 2 hours before start." },
  photos: [{ id: ID2, url: "https://res.cloudinary.com/demo/image/upload/a.jpg", position: 0 }],
  host: { id: ID2, name: "Asha", verified: true },
  rating: { average: 4.5, count: 12 },
};

const ownedListing = {
  ...publicListing,
  address: "12 FC Road, Shivajinagar, Pune 411005",
  lat: 18.5314,
  lng: 73.8446,
  accessInstructions: "Gate code 1234",
  turnoverBufferMinutes: 0,
  status: "PUBLISHED",
  suspendedReason: null,
  hostAttestedAt: T0,
  createdAt: T0,
  updatedAt: T0,
};

const listingCard = {
  id: ID,
  title: "Covered spot near FC Road",
  locality: "Shivajinagar",
  approxLat: 18.53,
  approxLng: 73.84,
  spaceType: "STILT",
  vehicleTypes: ["SEDAN"],
  maxHeightCm: null,
  covered: true,
  photoUrl: null,
  priceFrom: inr(5000),
  distanceMeters: 420,
  rating: { average: null, count: 0 },
};

const terms = {
  cancellation: "Free until 2 h before start.",
  overstay: "No overstay fee.",
  gracePeriodMinutes: 10,
};

const quote = {
  id: ID,
  listingId: ID2,
  vehicleId: null,
  rentalType: "HOURLY",
  startAt: T0,
  endAt: T1,
  lineItems: [{ code: "base", label: "2 hours × ₹50", kind: "charge", amount: inr(10000) }],
  subtotal: inr(10000),
  renterFee: inr(0),
  total: inr(10000),
  policyVersion: 1,
  terms,
  expiresAt: T1,
};

const bookingSummary = {
  id: ID,
  listing: { id: ID2, title: "Covered spot", locality: "Shivajinagar", photoUrl: null },
  rentalType: "HOURLY",
  startAt: T0,
  endAt: T1,
  status: "PENDING_PAYMENT",
  paymentStatus: null,
  refundStatus: null,
  total: inr(10000),
  holdExpiresAt: T0,
};

const booking = {
  ...bookingSummary,
  renterId: ID2,
  vehicle: null,
  subtotal: inr(10000),
  renterFee: inr(0),
  commission: null,
  hostEarnings: null,
  terms,
  gracePeriodEndsAt: T1,
  checkedInAt: null,
  checkedOutAt: null,
  cancelledAt: null,
  cancellationReason: null,
  monthlyAgreement: null,
  access: null,
  createdAt: T0,
};

const vehicle = {
  id: ID,
  registration: "MH12AB1234",
  type: "SEDAN",
  nickname: null,
  heightCm: null,
  widthCm: null,
  lengthCm: null,
};

const profile = {
  id: ID,
  name: null,
  email: "renter@example.com",
  phone: null,
  image: null,
  roles: ["RENTER"],
  hostVerificationStatus: "NOT_STARTED",
  deletionRequestedAt: null,
};

const preferences = {
  defaultVehicleId: null,
  notifications: { email: true, inApp: true, sessionReminders: true, marketing: false },
};

const dispute = {
  id: ID,
  bookingId: ID2,
  raisedById: ID2,
  category: "ACCESS_DENIED",
  description: "Gate was locked on arrival.",
  evidenceUrls: [],
  status: "OPEN",
  resolution: null,
  resolvedAt: null,
  createdAt: T0,
};

const availability = {
  listingId: ID,
  timezone: "Asia/Kolkata",
  rules: [{ weekday: 1, startMinute: 480, endMinute: 1200 }],
  exceptions: [],
  busy: [{ startAt: T0, endAt: T1 }],
};

const adminAction = { ok: true, auditLogId: ID2 };
const reason = "Checked documents";

export const examples: Record<
  string,
  { params?: unknown; query?: unknown; body?: unknown; response: unknown }
> = {
  "GET /api/listings": {
    query: {
      lat: "18.52",
      lng: "73.85",
      radiusMeters: "2000",
      covered: "false",
      spaceTypes: "STILT,OPEN",
    },
    response: { items: [listingCard], nextCursor: null },
  },
  "POST /api/listings": {
    body: {
      title: "Covered spot",
      description: "Covered stilt parking in a gated society.",
      address: "12 FC Road, Pune",
      locality: "Shivajinagar",
      lat: 18.53,
      lng: 73.84,
      spaceType: "STILT",
      vehicleTypes: ["SEDAN"],
      hourlyPaise: 5000,
    },
    response: ownedListing,
  },
  "GET /api/listings/mine": { query: {}, response: { items: [ownedListing], nextCursor: null } },
  "GET /api/listings/:id": { params, response: publicListing },
  "PATCH /api/listings/:id": { params, body: { title: "New title" }, response: ownedListing },
  "GET /api/listings/:id/availability": { params, query: {}, response: availability },
  "POST /api/listings/:id/availability": {
    params,
    body: {
      rules: availability.rules,
      exceptions: [{ startAt: T0, endAt: T1, unavailable: true }],
    },
    response: availability,
  },
  "POST /api/listings/:id/photos/sign": {
    params,
    body: {},
    response: {
      cloudName: "demo",
      apiKey: "123",
      timestamp: 1760000000,
      signature: "abc",
      folder: "listings",
      publicId: "listings/x",
    },
  },
  "POST /api/listings/:id/photos": {
    params,
    body: { publicId: "listings/x" },
    response: { id: ID2, url: "https://res.cloudinary.com/demo/image/upload/x.jpg", position: 0 },
  },
  "POST /api/listings/:id/publish": {
    params,
    body: { attestAuthority: true },
    response: ownedListing,
  },
  "PATCH /api/listings/:id/photos": {
    params,
    body: { photoIds: [ID2] },
    response: { items: publicListing.photos },
  },
  "DELETE /api/listings/:id/photos": {
    params,
    query: { photoId: ID2 },
    response: { items: [] },
  },
  "POST /api/me/host": {
    body: { attestAuthority: true },
    response: { roles: ["RENTER", "HOST"], hostVerificationStatus: "PENDING" },
  },
  "POST /api/quotes": {
    body: { listingId: ID, rentalType: "HOURLY", startAt: T0, endAt: T1 },
    response: quote,
  },
  "GET /api/bookings": {
    query: { as: "host", scope: "upcoming" },
    response: { items: [bookingSummary], nextCursor: null },
  },
  "POST /api/bookings": { body: { holdId: ID }, response: booking },
  "POST /api/bookings/hold": { body: { quoteId: ID }, response: booking },
  "GET /api/bookings/:id": {
    params,
    response: {
      ...booking,
      status: "CONFIRMED",
      paymentStatus: "SUCCEEDED",
      access: {
        address: "12 FC Road, Pune",
        lat: 18.5314,
        lng: 73.8446,
        accessInstructions: "Gate code 1234",
        hostContact: { name: "Asha", phone: "+919812345678", email: null },
      },
    },
  },
  "POST /api/bookings/:id/cancel": {
    params,
    body: {},
    response: { ...booking, status: "CANCELLED", refundStatus: "PENDING" },
  },
  "POST /api/bookings/:id/confirm-payment": {
    params,
    body: { razorpayOrderId: "order_1", razorpayPaymentId: "pay_1", razorpaySignature: "sig" },
    response: booking,
  },
  "POST /api/bookings/:id/check-in": { params, body: {}, response: booking },
  "POST /api/bookings/:id/check-out": { params, body: {}, response: booking },
  "POST /api/bookings/:id/extend": {
    params,
    body: { newEndAt: T1 },
    response: { booking, quote, requiresPayment: true },
  },
  "POST /api/monthly/:id/renew": { params, body: {}, response: { hold: booking, quote } },
  "POST /api/payments/order": {
    body: { bookingId: ID },
    response: {
      bookingId: ID,
      provider: "razorpay",
      orderId: "order_1",
      keyId: "rzp_test_x",
      amount: inr(10000),
    },
  },
  "POST /api/webhooks/razorpay": {
    body: {
      entity: "event",
      event: "payment.captured",
      payload: {},
      created_at: 1760000000,
      extra: 1,
    },
    response: { received: true },
  },
  "POST /api/disputes": {
    body: { bookingId: ID, category: "ACCESS_DENIED", description: "Gate was locked on arrival." },
    response: dispute,
  },
  "POST /api/reviews": {
    body: { bookingId: ID, rating: 5 },
    response: {
      id: ID2,
      bookingId: ID,
      listingId: ID2,
      rating: 5,
      comment: null,
      moderationStatus: "PENDING",
      createdAt: T0,
    },
  },
  "POST /api/reports": {
    body: {
      targetType: "LISTING",
      targetId: ID,
      category: "INACCURATE_LISTING",
      description: "Photos show a different place.",
    },
    response: { id: ID2, status: "OPEN", createdAt: T0 },
  },
  "GET /api/host/earnings": {
    query: {},
    response: {
      from: null,
      to: null,
      gross: inr(50000),
      commission: inr(5000),
      refunds: inr(0),
      hostEarnings: inr(45000),
      paidOut: inr(0),
      pendingPayout: inr(45000),
      bookingCount: 1,
    },
  },
  "GET /api/host/payouts": {
    query: { limit: "10" },
    response: {
      items: [
        {
          id: ID,
          amount: inr(45000),
          status: "PAID",
          providerReference: "UTR123",
          failureReason: null,
          bookingCount: 1,
          paidAt: T1,
          createdAt: T0,
        },
      ],
      nextCursor: null,
    },
  },
  "GET /api/me/profile": { response: profile },
  "PATCH /api/me/profile": { body: { name: "Asha", phone: "+919812345678" }, response: profile },
  "GET /api/me/vehicles": { response: { items: [vehicle] } },
  "POST /api/me/vehicles": {
    body: { registration: "mh 12 ab 1234", type: "SEDAN" },
    response: vehicle,
  },
  "PATCH /api/me/vehicles/:id": { params, body: { nickname: "Blue car" }, response: vehicle },
  "DELETE /api/me/vehicles/:id": { params, response: { deleted: true } },
  "GET /api/me/preferences": { response: preferences },
  "PATCH /api/me/preferences": {
    body: { notifications: { marketing: true } },
    response: preferences,
  },
  "POST /api/me/deletion-request": { body: {}, response: { deletionRequestedAt: T0 } },
  "GET /api/notifications": {
    query: {},
    response: {
      items: [
        {
          id: ID,
          type: "booking.confirmed",
          channel: "IN_APP",
          status: "SENT",
          title: "Booking confirmed",
          body: "See your booking.",
          href: `/bookings/${ID2}`,
          createdAt: T0,
        },
      ],
      nextCursor: null,
      unreadCount: 1,
    },
  },
  "POST /api/notifications/:id/read": { params: { id: ID }, response: { ok: true } },
  "GET /api/admin/users": {
    query: { q: "asha" },
    response: {
      items: [
        {
          id: ID,
          name: "Asha",
          email: "asha@example.com",
          phone: null,
          roles: ["RENTER", "HOST"],
          hostVerificationStatus: "PENDING",
          deletionRequestedAt: null,
          createdAt: T0,
        },
      ],
      nextCursor: null,
    },
  },
  "POST /api/admin/users/:id/verify-host": {
    params,
    body: { decision: "VERIFIED", reason },
    response: adminAction,
  },
  "POST /api/admin/users/:id/suspend": {
    params,
    body: { suspended: true, reason },
    response: adminAction,
  },
  "GET /api/admin/listings": {
    query: { listingStatus: "PUBLISHED" },
    response: { items: [{ ...ownedListing, hostId: ID2 }], nextCursor: null },
  },
  "POST /api/admin/listings/:id/suspend": {
    params,
    body: { suspended: true, reason },
    response: adminAction,
  },
  "GET /api/admin/bookings": {
    query: {},
    response: { items: [{ ...booking, hostId: ID2 }], nextCursor: null },
  },
  "GET /api/admin/payments": {
    query: { unreconciled: "true" },
    response: {
      items: [
        {
          id: ID,
          bookingId: ID2,
          provider: "razorpay",
          providerOrderId: "order_1",
          providerPaymentId: null,
          amount: inr(10000),
          status: "ORDER_CREATED",
          failureReason: null,
          signatureVerifiedAt: null,
          reconciledAt: null,
          refunds: [],
          createdAt: T0,
        },
      ],
      nextCursor: null,
    },
  },
  "GET /api/admin/jobs": { query: { jobStatus: "DEAD" }, response: empty },
  "GET /api/admin/disputes": {
    query: {},
    response: { items: [{ ...dispute, booking: { ...booking, hostId: ID2 } }], nextCursor: null },
  },
  "POST /api/admin/disputes/:id/resolve": {
    params,
    body: { outcome: "RESOLVED", resolution: "Refund issued to renter.", reason },
    response: adminAction,
  },
  "POST /api/admin/reviews/:id/moderate": {
    params,
    body: { decision: "REJECTED", reason },
    response: adminAction,
  },
};
