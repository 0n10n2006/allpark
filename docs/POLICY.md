# ParkShare: Policy Configuration & Versioning Guide

This document defines all configurable business policies in ParkShare, their placeholder default values, the Product Requirements Document (PRD) open decisions they map to, and the versioning mechanism used to update them without breaking in-flight transactions.

---

## 1. Configurable Policy Values (`src/config/policy.ts`)

All business policy parameters are centralized in `src/config/policy.ts` as `POLICY_DEFAULTS`.

| Policy Key | Placeholder Default | PRD Section & Open Decision | Operational Impact & Rationale |
|---|---|---|---|
| `commissionBps` | `1000` (10.00%) | PRD §13 Open Decisions / PRD §6 / Plan §2.2 | Platform marketplace fee deducted from host gross earnings upon booking completion. Stored in basis points ($100\text{ bps} = 1\%$). |
| `renterFeeBps` | `0` (0.00%) | PRD §6 / PRD §13 Open Decisions | Additional service fee charged to the renter at checkout. Set to `0` initially to reduce consumer friction during the Pune launch. |
| `holdTtlMinutes` | `10` minutes | PRD §5 / FR-04 / Plan §2.1 | Time window an inventory hold (`PENDING_PAYMENT`) remains valid while a renter completes Razorpay checkout. Sweeper expires holds after this duration. |
| `gracePeriodMinutes` | `10` minutes | PRD §5 / FR-07 / PRD §13 Open Decisions | Grace period following scheduled `booking.endAt` before a session moves into `OVERSTAY`. |
| `reminderOffsetsMinutes` | `[30, 10]` minutes | PRD §5 / FR-12 | Offsets in minutes before session start and before session end when reminder notifications are sent to the renter. |
| `overstayFeeEnabled` | `false` | PRD §5 / FR-07 / PRD §13 Open Decisions | **Disabled.** PRD §5 strictly prohibits undisclosed fees. Automatic penalties cannot be levied without clear upfront disclosure and formal legal review. |
| `cancellationPolicy` | Tiered table (see below) | PRD §5 / FR-10 / PRD §13 Open Decisions | Refund percentages based on notice provided before booking start time. Specific to each `rentalType`. |
| `monthlyRenewalReminderDays` | `7` days | PRD §5 / FR-09 / PRD §13 Open Decisions | Advance notification sent to monthly renters prompting them to confirm and renew their agreement for the next term. |
| `unpaidGraceDays` | `0` days | PRD §5 / FR-09 / PRD §13 Open Decisions | Number of grace days after monthly term expiration before the space is automatically released to other drivers. |
| `payoutMode` | `"MANUAL"` | PRD §6 / PRD §13 Open Decisions / Plan §2 | Payout execution mechanism. Set to `MANUAL` (admin offline bank transfer batching) until provider marketplace routing (Razorpay Route) is verified. |
| `payoutHoldbackHours` | `24` hours | PRD §6 / Plan §2.2 | Cooldown window after booking completion before earnings transition from `HELD` to `PAYABLE`, allowing time for dispute filing or evidence review. |
| `cityBoundary` | Pune bbox:<br>`minLat: 18.4`<br>`maxLat: 18.7`<br>`minLng: 73.7`<br>`maxLng: 74.05` | PRD §1 / PRD §13 Open Decisions | Geospatial bounding box defining allowable listing creation coordinates for the Pune pilot. |

---

## 2. Cancellation Refund Tiers Table

Cancellation refund tiers are keyed by listing cancellation policy name (default `"standard"`), then by `rentalType`:

```typescript
cancellationPolicy: {
  standard: {
    HOURLY: [
      { minHoursBefore: 2, refundBps: 10000 },  // >= 2h: 100% refund
      { minHoursBefore: 0, refundBps: 0 },      // < 2h: 0% refund
    ],
    DAILY: [
      { minHoursBefore: 24, refundBps: 10000 }, // >= 24h: 100% refund
      { minHoursBefore: 2, refundBps: 5000 },   // 2h - 24h: 50% refund
      { minHoursBefore: 0, refundBps: 0 },      // < 2h: 0% refund
    ],
    MULTI_DAY: [
      { minHoursBefore: 48, refundBps: 10000 }, // >= 48h: 100% refund
      { minHoursBefore: 24, refundBps: 5000 },  // 24h - 48h: 50% refund
      { minHoursBefore: 0, refundBps: 0 },      // < 24h: 0% refund
    ],
    WEEKLY: [
      { minHoursBefore: 72, refundBps: 10000 }, // >= 72h: 100% refund
      { minHoursBefore: 24, refundBps: 5000 },  // 24h - 72h: 50% refund
      { minHoursBefore: 0, refundBps: 0 },      // < 24h: 0% refund
    ],
    MONTHLY: [
      { minHoursBefore: 168, refundBps: 10000 },// >= 7 days: 100% refund
      { minHoursBefore: 0, refundBps: 0 },      // < 7 days: 0% refund
    ],
  }
}
```

---

## 3. Policy Versioning & Immutability (`PolicyVersion`)

To avoid retroactively changing pricing or cancellation terms on existing reservations, ParkShare uses an immutable versioning system stored in the `PolicyVersion` table:

```prisma
model PolicyVersion {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  version     Int      @unique
  policy      Json
  effectiveAt DateTime @default(now()) @db.Timestamptz
  createdAt   DateTime @default(now()) @db.Timestamptz
  updatedAt   DateTime @updatedAt @db.Timestamptz

  quotes PriceQuote[]
}
```

### 3.1 How Active Policy is Resolved

When the application evaluates policy (`getActivePolicy(now = new Date())` in `src/config/policy.ts`):
1. Queries PostgreSQL for the latest policy version whose `effectiveAt <= now`:
   ```sql
   SELECT * FROM "PolicyVersion"
   WHERE "effectiveAt" <= now()
   ORDER BY version DESC
   LIMIT 1;
   ```
2. Merges the row's `policy` JSON over `POLICY_DEFAULTS` (allowing partial overrides).
3. If no row exists yet (e.g. fresh database), version 1 is automatically created from `POLICY_DEFAULTS`.

### 3.2 Quote Snapshotting Architecture

Every quote requested by a user (`POST /api/quotes`) creates a `PriceQuote` row that stores a foreign key to `policyVersionId`.

When a quote is converted into a confirmed `Booking`:
- The pricing, host commission, and cancellation terms are **permanently bound** to the `PolicyVersion` snapshot under which the quote was issued.
- If an administrator updates the platform commission from 10% to 15% tomorrow, existing bookings and quotes remain priced under their original 10% policy version.

---

## 4. Runbook: How to Update Policy Values

To introduce updated policies (e.g. changing commission or modifying cancellation tiers):

### Step 1: Prepare the New Policy JSON

Create a JSON payload containing only the modified keys or the full policy override.

*Example: Updating commission to 12% and setting monthly renewal notice to 10 days:*
```json
{
  "commissionBps": 1200,
  "monthlyRenewalReminderDays": 10
}
```

### Step 2: Insert a New `PolicyVersion` Row

Insert a new version row with an incremented version number and the desired `effectiveAt` timestamp. You can schedule the policy to take effect immediately or at a specific future UTC timestamp.

#### Using PostgreSQL Direct Query:
```sql
INSERT INTO "PolicyVersion" (version, policy, "effectiveAt", "updatedAt")
VALUES (
  2,
  '{"commissionBps": 1200, "monthlyRenewalReminderDays": 10}'::jsonb,
  '2026-11-01 00:00:00+00',
  now()
);
```

#### Using Node.js / Prisma Script:
```typescript
import { db } from "@/server/db";

async function publishPolicyV2() {
  await db.policyVersion.create({
    data: {
      version: 2,
      effectiveAt: new Date("2026-11-01T00:00:00Z"),
      policy: {
        commissionBps: 1200,
        monthlyRenewalReminderDays: 10,
      },
    },
  });
  console.log("Published Policy Version 2");
}
```

### Step 3: Verification

Verify that the active policy resolves correctly:
```bash
# Query effective policy in development / staging:
node --env-file=.env --import tsx -e 'import("@/config/policy").then(m => m.getActivePolicy()).then(console.log)'
```
*Quotes created after `effectiveAt` will automatically snapshot Version 2.*
