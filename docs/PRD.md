**PARKSHARE**

Product Requirements Document  
& Implementation Specification

Version 1.0 • 16 October 2026

| **Product vision** Make finding and renting reliable parking as straightforward as booking a hotel room. |
|----|

| **Decision** | **Confirmed direction** |
|----|----|
| Launch market | Pune, Maharashtra, India |
| Platform | Mobile-first Progressive Web App (PWA) |
| Rental types | Hourly, daily, multi-day, weekly, monthly |
| Monthly payments | Manual renewal and payment each month; no automatic recurring charge in MVP |
| Parking access | Manual host instructions, gatekeeper, and check-in/check-out |
| Monetization | Commission per eligible booking |
| Marketplace | Public marketplace open to eligible hosts |
| Core stack | Next.js, TypeScript, Tailwind CSS, shadcn/ui, PostgreSQL, Prisma |
| Integrations | Razorpay, Google Maps or Mapbox, Cloudinary |
| Hosting | Vercel plus managed database and durable background-job service |

*Prepared as a source of truth for product design and Claude Code implementation.*

# Document guide

- 1\. Executive summary and goals

- 2\. Confirmed decisions, assumptions, and scope

- 3\. Personas and user journeys

- 4\. Functional requirements and acceptance criteria

- 5\. Booking lifecycle and inventory rules

- 6\. Payments, commission, refunds, and payouts

- 7\. Monthly rental specification

- 8\. Manual access, checkout, and overstay handling

- 9\. Technical architecture and API contract

- 10\. Data model

- 11\. Security, privacy, reliability, and accessibility

- 12\. Admin and operations

- 13\. Testing strategy and launch gates

- 14\. Milestones and roadmap

- 15\. Metrics, risks, and open decisions

- Appendix A. Claude Code implementation guidance

Note: This document defines product behavior and a proposed technical contract. Provider capabilities, applicable law, taxes, and operational policies must be validated before launch.

# 1. Executive summary and goals

ParkShare is a two-sided parking marketplace. Property owners, residents, businesses, and parking operators can list eligible parking spaces; renters can discover, reserve, and pay for those spaces in the app. The first market is Pune, Maharashtra. The initial product is a mobile-first PWA designed to work well on modern mobile browsers.

The core product challenge is trust and reservation reliability: the listed space must be usable, the requested time must genuinely be available, payment must be confirmed safely, and the end of the session must be managed through clear policies and reliable reminders.

## Product objectives

- Help renters find appropriate parking near a destination and book with confidence.

- Help eligible hosts earn revenue from unused parking spaces.

- Prevent double-bookings across hourly, daily, weekly, and monthly rental types.

- Provide reliable in-app payment, refund tracking, and host-earnings reconciliation.

- Reduce late departures using reminders, extensions, evidence, and a fair escalation workflow.

- Support monthly parking with manual renewal rather than automatic recurring charges.

- Build operational tooling to moderate a public marketplace and resolve disputes.

## North-star metric

Successfully completed parking sessions: reservations where access was provided, the session was completed or validly closed, and there is no unresolved material access or payment issue. Raw bookings or gross payment volume alone are insufficient measures of product quality.

# 2. Confirmed decisions, assumptions, and scope

| **Area** | **Decision / requirement** |
|----|----|
| City | Pune launch; support a configurable city boundary and expand later. |
| Platform | PWA first; responsive web app installable where browser support permits. |
| Monthly rental | Manual renewal/payment each month. No automatic monthly debit in MVP. |
| Access | Manual instructions, gatekeeper, host contact, and human check-in/out. |
| Revenue | Host-side commission is the recommended default; exact rate and refund treatment are configurable and must be approved. |
| Marketplace | Public listings by eligible hosts, subject to verification and moderation. |
| Payments | Razorpay integration after confirming merchant, marketplace, refund, and payout support for the intended model. |
| Excluded from MVP | Smart-gate hardware, automatic number-plate recognition, continuous GPS tracking, native mobile apps, dynamic pricing. |

| **Important limitation** Software cannot physically force a vehicle to leave. ParkShare can provide clear terms, reminders, extension requests, documented incidents, host escalation, and support review. |
|----|

## Assumptions to validate

- Hosts can demonstrate or attest that they are authorized to rent the space.

- The chosen payment-provider arrangement supports the intended host onboarding and payout flow.

- A defined cancellation, refund, commission, tax, and overstay policy will be approved before public launch.

- The first pilot will concentrate on Pune rather than launching nationwide on day one.

- Initial support operations can investigate listing, access, payment, and overstay disputes manually.

# 3. Personas and user journeys

## Primary personas

| **Persona** | **Needs** | **Success outcome** |
|----|----|----|
| Short-term renter | Find parking near a destination for a defined time window; know the price and access rules. | Gets the reserved space and leaves without an unresolved issue. |
| Monthly renter | Predictable monthly cost, a reliable recurring space, clear renewal and notice rules. | Can manually renew and pay without losing track of the term. |
| Host | Monetize unused space with manageable availability, bookings, rules, and payouts. | Receives valid bookings, clear earnings records, and support for incidents. |
| Parking operator / society manager | Manage several spaces, operating hours, access rules, and occupancy. | Can keep inventory accurate and handle arrivals consistently. |

## Renter journey

1.  Open Explore and search by destination, address, landmark, or neighborhood.

2.  Choose arrival/departure times or select monthly rental.

3.  Compare map pins and listing cards by price, distance, vehicle compatibility, amenities, and rules.

4.  Select a listing, enter vehicle details, review terms, and obtain a server-calculated quote.

5.  Create a temporary hold and pay through Razorpay.

6.  Receive confirmation and precise access instructions when appropriate.

7.  Check in, receive end-time reminders, and request an extension if available.

8.  Confirm departure, obtain a receipt, and optionally leave a review.

## Host journey

9.  Register, verify contact information, and complete required host checks.

10. Create a listing with photos, map location, access instructions, rules, vehicle limits, prices, and availability.

11. Publish the listing after required validation and moderation checks.

12. Receive booking notifications and prepare the space.

13. Provide manual access and confirm arrival/departure when appropriate.

14. Review booking history, commission, earnings, and payout status.

15. Handle reports or disputes through a documented process.

# 4. Functional requirements and acceptance criteria

## FR-01 — Accounts and identity

- Support registration and verification by phone or email, secure sessions, logout, and account recovery.

- Allow one account to act as both renter and host.

- Support profiles, vehicles, preferences, notification settings, and account-deletion requests.

- Require additional verification for hosts before listings become bookable.

- Enforce access permissions on the server; hiding a UI control is not authorization.

Acceptance criteria:

- Unauthenticated users may browse public listings but cannot complete a booking.

- Unverified hosts cannot publish bookable listings.

- Users can add multiple vehicles and select a vehicle at checkout.

- A user cannot view another user's private booking or access instructions without authorization.

## FR-02 — Listing management

Each listing must contain:

- Title, description, and at least one photo; two or more photos are recommended.

- Coordinates and address; the public pre-booking view may show an approximate pin.

- Space type, vehicle compatibility, and relevant height/width/length limits.

- Rental durations offered, prices, availability rules, date exceptions, and blackout periods.

- Entry/exit instructions, operating hours, and host rules.

- Optional attributes such as covered parking, lighting, EV charging, and security.

- Cancellation policy, host authorization attestation, and verification/moderation status.

Acceptance criteria:

- A listing cannot be published without required fields, a valid location, and at least one image.

- The host must attest to authority to rent the space.

- Changes to a listing do not silently invalidate confirmed bookings.

- Suspended listings are excluded from new-booking results while historical records remain available.

## FR-03 — Map-based discovery

- Provide an interactive map with price markers and a synchronized list view.

- Support destination/address/landmark search and current-location search when permission is granted.

- Support filters for dates, time, rental type, price, vehicle type, covered parking, dimensions/clearance, and amenities.

- Provide 'Search this area' after map panning, plus loading, empty, error, and denied-location states.

- Show listing previews with photos, price, approximate distance, and relevant restrictions.

- Provide a directions handoff to the selected maps provider.

- Do not expose precise addresses or private access instructions before appropriate authorization.

Acceptance criteria:

- Search results are checked against the requested time interval, not merely listing publication status.

- Monthly reservations block conflicting short-term inventory.

- Panning the map and choosing 'Search this area' refreshes results.

- Location denial does not make search unusable.

- A map marker is not a reservation; availability is revalidated during checkout and booking confirmation.

## FR-04 — Availability, holds, and booking integrity

Use half-open time intervals \[startAt, endAt): the start is inclusive and the end is exclusive. Adjacent reservations may touch at the same instant only when host turnover rules permit. All booking types must share one conflict-checking service.

- Validate the interval against the listing's schedule, exceptions, operating hours, and confirmed reservations.

- Create a short-lived hold before payment; store its expiry and status.

- Revalidate inventory when processing the verified payment result.

- Confirm the booking atomically and release expired holds through durable background jobs.

- Prevent overlap between active holds and confirmed bookings where the policy requires it.

- Use a PostgreSQL exclusion constraint on listing and time range for conflicting active reservations where practical; include a migration and concurrency tests.

Acceptance criteria:

- Two simultaneous requests cannot both reserve the same space for overlapping times.

- Expired holds release inventory even if the user's browser is closed.

- Failed payments do not create confirmed bookings.

- Duplicate webhook delivery cannot create duplicate reservations.

- Monthly and short-term reservations use the same conflict logic.

## FR-05 — Pricing and commission

- Support hourly, daily, multi-day, weekly, and monthly pricing.

- Support configurable minimum duration, discounts, platform commission, and approved tax treatment.

- Calculate all totals server-side; never trust client-submitted amounts.

- Use integer paise for INR amounts.

- Persist a price quote with line items, currency, pricing version, and expiry.

- Show all applicable charges and cancellation/overstay terms before payment.

Recommended initial model: host-side commission deducted from eligible booking revenue. The commission rate, its treatment on cancellations/refunds, and whether any renter fee exists are configurable decisions that must be approved before launch.

| **Illustrative calculation**                | **Amount** |
|---------------------------------------------|------------|
| Parking price                               | ₹500       |
| Assumed host commission (10%, example only) | ₹50        |
| Host earnings before other adjustments      | ₹450       |

Acceptance criteria:

- Changing a browser request cannot change the server-calculated total.

- Each quote has a defined expiry and is revalidated before booking.

- Commission and host earnings reconcile with payment and refund records.

- All financial values use integer paise and an explicit currency.

## FR-06 — Payments, refunds, and host payouts

- Create payment orders server-side through the supported Razorpay integration.

- Verify payment signatures and process provider webhooks idempotently.

- Track order creation, payment pending/success/failure, refund pending/success/failure, and reconciliation states.

- Confirm bookings only after the required verified payment state.

- Maintain a ledger for gross amount, commission, adjustments, refunds, and host earnings.

- Support refund requests and reconciliation against provider references.

- Track host onboarding, payout eligibility, payout attempts, failures, and settlement status.

| **Provider validation required** Do not assume an ordinary payment gateway account provides marketplace split payments or escrow. Confirm Razorpay's current product, onboarding, payout, refund, and compliance requirements for the intended marketplace model before implementation. |
|----|

Acceptance criteria:

- Client-side success callbacks alone cannot confirm payment or booking.

- Invalid signatures and unverified events are rejected.

- Duplicate webhook events are harmless.

- Failed or delayed payments are recoverable and auditable.

- Host earnings cannot be paid out twice.

- Financial records can be reconciled to provider references.

## FR-07 — Manual access, check-in, and checkout

### Check-in

- Send booking confirmation, address, access instructions, booking times, vehicle details, and host contact options.

- Provide a 'Start parking' action during the permitted arrival window.

- Record renter check-in and optionally host confirmation.

- Provide an access-problem report and support path.

### Checkout and reminders

- Display end time and remaining duration prominently.

- Schedule reminders, initially 30 minutes and 10 minutes before expiry, subject to configurable preferences.

- Allow extension requests only after a fresh availability check and verified payment where required.

- At end time, enter the configured grace period; initial proposed default is 10 minutes.

- If the grace period expires, notify renter and host and create an incident workflow.

- Close the session when departure is confirmed or support resolves the incident.

Acceptance criteria:

- Notifications use durable scheduled jobs, not in-memory timers or an open browser tab.

- Extensions cannot conflict with another reservation.

- Check-in, checkout, and incident events are timestamped and auditable.

- A missing checkout button press alone is not treated as conclusive proof of an overstay.

## FR-08 — Overstay policy and disputes

ParkShare cannot physically force a vehicle to leave. It must prevent avoidable overruns and provide fair escalation when they occur.

- Show booking end time, grace period, any overstay charge, calculation method, and dispute path before payment.

- Allow hosts to report blocked access and attach permitted evidence.

- Notify the renter and host of incident status changes.

- Support extensions when inventory and policy permit.

- Support manual support review for disputed or ambiguous incidents.

- Do not charge an undisclosed fee or automatically charge a saved payment method without appropriate authorization and provider support.

- Do not automatically penalize renters solely because a host forgot to confirm departure.

| **Legal/payment review** Any overstay fee must be clearly disclosed, consented to in advance, and reviewed for applicable legal and payment-provider feasibility before launch. |
|----|

## FR-09 — Monthly rentals and manual renewal

- Support a monthly price, start/end date, cancellation notice period, and renewal terms.

- Require an explicit renter action to renew; no automatic monthly charge in MVP.

- Send a reminder before expiry and show renewal/payment status in the renter dashboard.

- On renewal, revalidate listing status and future availability before accepting payment.

- Treat renewal as paid only after verified payment.

- Define a policy for unpaid expiry and any grace period; release future inventory only when that policy permits.

- Maintain a history of agreements, payments, renewals, cancellations, and notices.

Acceptance criteria:

- A monthly agreement blocks conflicting short-term bookings for its confirmed term.

- A renewal cannot be confirmed if the space is no longer available.

- Expiry and inventory release follow a defined policy and are auditable.

- The renter is never charged automatically for monthly renewal in the MVP.

## FR-10 — Cancellation, refunds, and disputes

- Display the applicable cancellation policy before payment.

- Support renter cancellation, host cancellation, unavailable space, access failure, duplicate charge, payment-success/booking-failure, incorrect listing, and overstay dispute cases.

- Track booking cancellation separately from refund processing.

- Store refund amount, reason, provider reference, timestamps, and status.

- Allow support to inspect relevant booking, payment, notification, and incident history.

- Require a reason and audit record for administrative decisions.

## FR-11 — Reviews, reports, and trust

- Only eligible completed bookings can be reviewed.

- Allow reporting of listings, reviews, users, access problems, and suspicious behavior.

- Support moderation, evidence review, listing suspension, and documented decisions.

- Verification badges must state what was verified and must not imply guarantees beyond the actual checks.

## FR-12 — Notifications

| **Trigger** | **Recipient(s) and action** |
|----|----|
| Booking confirmed | Renter and host receive confirmation; renter receives access details. |
| Upcoming arrival | Renter receives reminder. |
| Session ending soon | Renter receives scheduled reminders. |
| Grace period expired | Renter and host receive overstay alert. |
| Extension request | Host receives request; renter receives outcome. |
| Cancellation/refund update | Affected user receives policy and status details. |
| Monthly renewal approaching | Renter receives reminder and renewal action. |
| Monthly booking expired | Renter and host receive status update. |
| Payout failure | Host and admin receive actionable status. |

Start with in-app and email notifications. SMS or WhatsApp may be added later with appropriate consent and provider review. Use Asia/Kolkata for displayed booking times. Jobs and notification sends must be retry-safe.

## FR-13 — Admin console

- Search and inspect users, listings, bookings, disputes, payment records, and payout states.

- Review host verification; suspend accounts or listings when needed.

- Moderate reviews and reports.

- Inspect overstay evidence and dispute timelines.

- Track refund and payout reconciliation, notification failures, and failed background jobs.

- Record actor, action, target, timestamp, and reason for sensitive operations.

# 5. Booking lifecycle and inventory rules

Recommended booking states:

| **State** | **Meaning / transition** |
|----|----|
| PENDING_PAYMENT | A hold exists while payment is attempted; it expires after a defined TTL. |
| CONFIRMED | Payment is verified and inventory is committed. |
| ACTIVE | The booking session has begun; renter may check in. |
| GRACE_PERIOD | The scheduled end time has passed; configured grace window is active. |
| OVERSTAY | Grace has expired and an incident workflow is open. |
| COMPLETED | Departure is confirmed or the session is validly closed. |
| CANCELLED | Booking cancelled under policy; refund handled as a separate state machine. |
| EXPIRED | Payment hold expired before confirmation. |
| PAYMENT_FAILED | Payment failed and booking is not confirmed. |
| DISPUTED | An incident requires support review; retain underlying booking/payment state as separate fields. |

Keep payment state separate from booking state. A cancelled booking may still have a refund pending; a completed booking may have a payout pending.

## Inventory rules

- Use one canonical availability service for all rental types.

- Represent recurring host availability separately from confirmed reservation intervals.

- Store time intervals in UTC; use Asia/Kolkata for Pune display and input.

- Use transactions and database constraints to protect against race conditions.

- Define turnover buffers explicitly if cleaning, gate access, or host handover requires them.

- Never let a client decide whether a hold has expired; use server/database time.

# 6. Payments, commission, refunds, and payouts

## Payment sequence

16. Backend validates listing, requested interval, user, vehicle compatibility, price quote, and availability.

17. Backend creates a temporary inventory hold and records its expiry.

18. Backend creates the provider order using the trusted total.

19. Renter completes provider checkout.

20. Backend verifies signature and provider status; webhook handling is idempotent.

21. Booking confirmation is committed atomically after the required verified payment state.

22. Ledger records gross amount, commission, host earnings, and any adjustments.

23. Refund and payout processes update separate state machines and reconcile against provider references.

## Financial invariants

- Never trust amount, commission, host ID, or booking status submitted by the client.

- Every provider event must be authenticated and deduplicated.

- Every financial transition must be auditable.

- Refunds must not exceed the eligible captured amount after accounting for previous refunds.

- Payout operations must be idempotent and reconcile with provider status.

- Do not advertise escrow or split settlement unless the selected provider arrangement explicitly supports it.

# 7. Technical architecture and API contract

## Recommended stack

| **Layer** | **Choice / responsibility** |
|----|----|
| Client | Next.js, TypeScript, Tailwind CSS, shadcn/ui; responsive, installable PWA. |
| Application server | Next.js server-side route handlers/services; validation, authorization, domain logic. |
| Database | Managed PostgreSQL and Prisma; transactions, constraints, indexed search. |
| Geospatial | PostGIS or equivalent indexed geographic querying for radius and viewport searches. |
| Payments | Razorpay; orders, verified webhooks, refunds, and supported payout arrangement. |
| Maps | Google Maps or Mapbox; select based on coverage, pricing, terms, and developer experience. |
| Images | Cloudinary; signed uploads, transformation, delivery, and moderation controls. |
| Hosting | Vercel for app; managed PostgreSQL; durable queue/worker or scheduled-job service. |
| Monitoring | Structured logs, error tracking, alerting, provider reconciliation, job-failure monitoring. |

## Backend domain modules

- auth — registration, sessions, roles, verification.

- users — profiles, vehicles, preferences.

- listings — creation, publication, moderation.

- availability — schedules, exceptions, holds, conflict checks.

- search — geographic queries, filters, result ranking.

- pricing — quotes, commission, taxes/fees, cancellation terms.

- bookings — reservation lifecycle and state transitions.

- payments — provider orders, webhooks, refunds, reconciliation.

- payouts — host earnings and payout status.

- monthly-rentals — manual renewal, notice periods, expiry.

- sessions — check-in/out, extensions, overstay incidents.

- notifications — templates, schedules, delivery states.

- reviews — ratings, moderation, reports.

- admin — support, moderation, audit tools.

## Proposed API contract

| **Method** | **Endpoint** | **Purpose** |
|----|----|----|
| GET | /api/listings | Search and filter listings. |
| GET | /api/listings/:id | Get public listing details. |
| POST | /api/listings | Create a listing. |
| PATCH | /api/listings/:id | Update an owned listing. |
| POST | /api/listings/:id/availability | Update availability rules/exceptions. |
| POST | /api/quotes | Calculate a server-side price quote. |
| POST | /api/bookings/hold | Create temporary inventory hold. |
| POST | /api/bookings | Create booking against a valid hold. |
| GET | /api/bookings/:id | Retrieve an authorized booking. |
| POST | /api/bookings/:id/cancel | Request cancellation. |
| POST | /api/bookings/:id/extend | Request session extension. |
| POST | /api/bookings/:id/check-in | Record check-in. |
| POST | /api/bookings/:id/check-out | Record departure. |
| POST | /api/monthly/:id/renew | Begin a manual renewal. |
| POST | /api/payments/order | Create a payment order. |
| POST | /api/webhooks/razorpay | Process authenticated provider events. |
| POST | /api/disputes | Open a dispute. |
| GET | /api/host/earnings | Get host financial summary. |
| GET | /api/admin/disputes | Admin-only dispute queue. |

All applicable endpoints require request validation, authentication, authorization, rate limiting, consistent errors, and auditability. Webhook endpoints require provider-specific signature verification and idempotent processing.

# 8. Data model

| **Entity** | **Key fields / purpose** |
|----|----|
| User | id, name, email, phone, verificationStatus, role/permissions. |
| Vehicle | id, userId, registration, type, dimensions. |
| Listing | id, hostId, title, coordinates, address, price configuration, status. |
| ListingPhoto | id, listingId, imageUrl, position, moderation state. |
| AvailabilityRule | listingId, weekday, startTime, endTime. |
| AvailabilityException | listingId, startAt, endAt, unavailable. |
| Booking | id, listingId, renterId, startAt, endAt, rentalType, status. |
| BookingHold | id, listingId, startAt, endAt, expiresAt, status. |
| PriceQuote | id, booking details, amount, fee breakdown, pricing version, expiresAt. |
| Payment | id, bookingId, providerReference, amount, status. |
| Refund | id, paymentId, amount, reason, providerReference, status. |
| LedgerEntry | id, bookingId, account type, amount, reference; append-only where practical. |
| HostPayout | id, hostId, amount, providerReference, status. |
| MonthlyAgreement | id, bookingId, renewal date, notice period, status. |
| SessionEvent | id, bookingId, event type, actorId, timestamp, metadata. |
| OverstayIncident | id, bookingId, reportedAt, evidence references, status, resolution. |
| Review | id, bookingId, authorId, rating, moderationStatus. |
| Dispute | id, bookingId, category, evidence references, resolution. |
| Notification | id, userId, type, scheduledAt, deliveryStatus, idempotency key. |
| AuditLog | id, actorId, action, targetId, reason, timestamp. |

## Data conventions

- Use UUID primary keys for primary domain entities.

- Store timestamps in UTC and display in Asia/Kolkata for Pune.

- Store INR in integer paise with an explicit currency field.

- Use indexed geographic coordinates and indexes for listing status and booking intervals.

- Separate booking state from payment, refund, payout, and dispute state.

- Retain the minimum necessary personal information and restrict identity/evidence access.

# 9. Security, privacy, reliability, and accessibility

## Security

- Enforce host ownership and renter authorization on the server.

- Keep provider credentials and webhook secrets in server-side environment variables/secret management.

- Verify webhook signatures against the raw request body and deduplicate provider event IDs.

- Use idempotency keys for booking/payment operations.

- Rate-limit authentication, booking, reporting, and payment endpoints.

- Validate and sanitize inputs; protect against IDOR, CSRF where applicable, SQL injection, XSS, replay attacks, and unsafe uploads.

- Use role-based admin access and audit sensitive actions.

## Privacy

- Do not continuously track renter GPS in the MVP.

- Reveal precise location and access instructions only when necessary and authorized.

- Set retention and deletion rules for identity documents, financial records, evidence, and account data.

- Avoid putting sensitive information in logs, analytics, or notification previews.

## Reliability and accessibility

- Target typical indexed map-search API responses under 1 second at the 95th percentile, excluding third-party map rendering.

- Use durable jobs for hold expiry, reminders, monthly renewal reminders, and overstay workflows.

- Back up the database and test restoration.

- Monitor payment discrepancies, failed jobs, and booking conflicts.

- Support keyboard navigation, screen readers, readable contrast, and accessible validation errors.

- Test mobile layouts, slow networks, interrupted checkout, and browser refresh/recovery.

# 10. Admin and operations

The admin console is required for MVP because the marketplace is public and manual access introduces operational edge cases.

- Account and host verification review.

- Listing moderation, suspension, and removal.

- Booking and payment lookup.

- Refund request review and provider status.

- Host earnings and payout reconciliation.

- Overstay incident and dispute review.

- Review/report moderation.

- Notification delivery and background-job failures.

- Audit logs for all sensitive admin operations.

Financial changes, account suspensions, and dispute outcomes must include an actor, timestamp, reason, and supporting record.

# 11. Testing strategy and launch gates

## Required automated tests

- Unit tests for pricing, commission, cancellation, grace periods, and monthly renewal rules.

- Integration tests for availability checks, holds, booking transactions, and database overlap constraints.

- Concurrency tests proving that overlapping requests cannot both confirm.

- Payment tests for invalid signatures, duplicate webhooks, delayed payments, failures, refunds, and reconciliation.

- End-to-end tests for renter search-to-booking and host listing-to-earnings journeys.

- Background-job tests for hold expiry, reminders, monthly renewal notifications, and overstay escalation.

- Authorization tests for listing ownership, booking privacy, admin roles, and access instructions.

- Accessibility, responsive-layout, and performance tests.

## Launch gates

- Payment-provider marketplace and payout arrangements are confirmed.

- Booking concurrency and webhook idempotency tests pass.

- Cancellation, refund, commission, tax, and overstay terms are visible before checkout.

- Host verification and reporting workflows are operational.

- Support can handle access failures, payment failures, and disputes.

- Privacy, terms, tax treatment, and fee policies receive required review.

- Backups, monitoring, and payment reconciliation have been tested.

# 12. Milestones and roadmap

| **Milestone** | **Scope** | **Exit condition** |
|----|----|----|
| 1\. Foundation | App shell, auth, schema, environment configuration, deployment. | Secure registration and deployment work. |
| 2\. Marketplace | Host profiles, listing creation/editing, image uploads, moderation. | Eligible hosts can publish valid listings. |
| 3\. Discovery | Map, filters, geospatial search, listing details. | Renters can find suitable spaces. |
| 4\. Booking engine | Quotes, availability, holds, booking state, concurrency safeguards. | Overlap and race-condition tests pass. |
| 5\. Payments | Razorpay checkout, verified webhooks, refunds, ledger, payout status. | Payment flows reconcile end-to-end. |
| 6\. Session reliability | Manual check-in/out, reminders, extensions, overstay workflow. | Scheduled workflows and incident paths pass. |
| 7\. Monthly rentals | Manual renewal, expiry, notice rules, conflict handling. | Renewal and inventory-release tests pass. |
| 8\. Operations | Admin console, reports, disputes, moderation, audit. | Support can resolve key incidents. |
| 9\. Pilot | Security, accessibility, load, and user testing in Pune. | Launch checklist is signed off. |

## Suggested implementation order

Build inventory correctness before adding polish. Establish the data model, availability constraints, and booking lifecycle early; then integrate payments, followed by reliable background jobs and the monthly renewal workflow. Do not postpone payment reconciliation or admin support until after launch.

# 13. Metrics, risks, and open decisions

## Metrics

- Search-to-listing and listing-to-booking conversion.

- Successful payment rate and payment/booking reconciliation exceptions.

- Completed parking sessions and session completion without support.

- Double-booking incidents, cancellations, refunds, and access-failure rates.

- Overstay incidence per 100 completed bookings and resolution time.

- Monthly renewal rate and renter retention.

- Host repeat-listing rate and payout success rate.

- Dispute volume, support response time, and user satisfaction.

## Risk register

| **Risk** | **Mitigation** |
|----|----|
| Fake or unauthorized listings | Host checks, authorization attestation, evidence, reporting, moderation. |
| Double-booking | Database constraints, transactions, temporary holds, concurrency tests. |
| Payment inconsistency | Verified webhooks, idempotency, ledger, scheduled reconciliation. |
| Overstay or blocked access | Reminders, extensions, transparent terms, evidence, support escalation. |
| False overstay reports | Audit trail, evidence review, no automatic penalty based solely on missing checkout. |
| Monthly/short-term conflict | One inventory engine and explicit interval conflict rules. |
| Location privacy | Approximate pre-booking pins, restricted precise-location access, minimal tracking. |
| Low supply at launch | Concentrate launch operations in Pune and actively onboard eligible hosts. |
| Provider capability gap | Validate marketplace/payout product support before building the financial flow. |
| Legal/tax uncertainty | Review local terms, taxes, privacy, consumer obligations, and fee policies before launch. |

## Open decisions before public launch

- Final commission rate and whether the host-side commission is deducted from the parking price or handled separately.

- Final cancellation/refund policy by rental duration.

- Final grace period and whether any overstay charge will be used at all.

- Host verification requirements and the evidence needed to demonstrate authority to rent.

- Whether host payouts are automatic through a supported provider product or initially handled through another approved process.

- Map provider selection based on pricing, coverage, licensing terms, and implementation needs.

- Support hours, response-time targets, and escalation ownership.

- Retention periods and privacy policy for identity documents, payment records, and dispute evidence.

# Appendix A. Claude Code implementation guidance

Use this document as the product source of truth. Before coding, inspect the repository and report the current framework, folder structure, environment setup, existing database schema, and tests. Do not overwrite working code without understanding it.

- Propose a phased implementation plan and identify any contradictions between the existing repository and this specification.

- Implement a vertical slice at a time: schema and auth; listing creation; discovery; availability/booking; payment; session workflow; monthly renewals; admin.

- Create migrations, seed data for a local Pune development environment, and tests alongside each feature.

- Keep provider secrets in environment variables; provide an .env.example with placeholders only.

- Never use mock payment success in production paths. Keep sandbox/test-provider behavior explicitly separated.

- Use server-side validation and authorization for every mutation.

- Document local setup, migrations, tests, deployment, background-job configuration, webhook setup, and operational recovery.

- Do not implement undisclosed overstay fees, automatic monthly charges, continuous GPS tracking, or unsupported escrow behavior.

- Before declaring a milestone complete, run the relevant tests and summarize changed files, commands, results, and remaining risks.

# Appendix B. Definition of done

- Requirements and acceptance criteria for the feature are met.

- Relevant unit, integration, and end-to-end tests pass.

- Authorization, validation, idempotency, and error handling are implemented.

- Loading, empty, failure, and recovery states are covered in the UI.

- Logs and audit records are adequate without leaking sensitive data.

- Documentation and environment examples are updated.

- No secret keys, real personal data, or production payment credentials are committed.
