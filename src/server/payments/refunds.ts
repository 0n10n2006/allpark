import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { log } from "./log";
import { getPaymentProvider } from "./provider";

// FR-06/FR-10, PRD §6. Refund state machine: PENDING → PROCESSING → SUCCEEDED | FAILED.
// The cancellation policy (how much) belongs to T4.4, which calls createRefund.

type Tx = Prisma.TransactionClient;
export const PROCESS_REFUND_JOB = "payments.processRefund";

/** Payment statuses that mean money was captured and can be refunded. */
const CAPTURED_STATUSES = ["SUCCEEDED", "CAPTURED_UNFULFILLED"] as const;

export type CreateRefundInput = {
  paymentId: string;
  amountPaise: number;
  reason: string;
  /** null for system actions. */
  actorId: string | null;
  /** Same key → same refund. Defaults to a fresh one (every call is a new refund). */
  idempotencyKey?: string;
};

/**
 * Inside the caller's transaction: validates amount ≤ captured − non-failed refunds
 * (PRD §6), inserts a PENDING Refund, audits it, and queues payments.processRefund.
 * The job row is written with `tx` (not enqueue()) so it commits or rolls back with the refund.
 */
export async function createRefundTx(tx: Tx, input: CreateRefundInput) {
  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  const prior = await tx.refund.findUnique({ where: { idempotencyKey } });
  if (prior) return prior;
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0)
    throw new HttpError(
      "validation_error",
      "Refund amount must be a positive whole number of paise",
    );

  // Row lock: two concurrent refunds on one payment can't both pass the balance check.
  const [payment] = await tx.$queryRaw<
    { id: string; bookingId: string; amountPaise: number; currency: string; status: string }[]
  >`SELECT id, "bookingId", "amountPaise", currency, status::text FROM "Payment"
    WHERE id = ${input.paymentId}::uuid FOR UPDATE`;
  if (!payment) throw new HttpError("not_found", "Payment not found");
  const captured = (CAPTURED_STATUSES as readonly string[]).includes(payment.status)
    ? payment.amountPaise
    : 0;
  const { _sum } = await tx.refund.aggregate({
    where: { paymentId: payment.id, status: { not: "FAILED" } },
    _sum: { amountPaise: true },
  });
  const refundable = captured - (_sum.amountPaise ?? 0);
  if (input.amountPaise > refundable)
    throw new HttpError("unprocessable", "Refund exceeds the refundable amount", {
      reason: "refund_exceeds_captured",
      refundablePaise: refundable,
    });

  const refund = await tx.refund.create({
    data: {
      paymentId: payment.id,
      amountPaise: input.amountPaise,
      currency: payment.currency,
      reason: input.reason,
      idempotencyKey,
    },
  });
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      action: "refund.create",
      targetType: "Refund",
      targetId: refund.id,
      reason: input.reason,
      metadata: {
        paymentId: payment.id,
        bookingId: payment.bookingId,
        amountPaise: refund.amountPaise,
      },
    },
  });
  await tx.job.create({
    data: {
      type: PROCESS_REFUND_JOB,
      payload: { refundId: refund.id },
      idempotencyKey: `${PROCESS_REFUND_JOB}:${refund.id}`,
    },
  });
  return refund;
}

export function createRefund(input: CreateRefundInput) {
  return db.$transaction((tx) => createRefundTx(tx, input));
}

/**
 * Applies a provider refund outcome once (job result or refund.processed/failed webhook).
 * A SUCCEEDED refund writes one REFUND ledger entry; terminal refunds never change again.
 */
export async function applyRefundOutcome(
  tx: Tx,
  refundId: string,
  outcome: "processed" | "failed" | "pending",
  providerRefundId: string,
  failureReason?: string | null,
) {
  const [refund] = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT id, status::text FROM "Refund" WHERE id = ${refundId}::uuid FOR UPDATE`;
  if (!refund || refund.status === "SUCCEEDED" || refund.status === "FAILED") return false;
  const status =
    outcome === "processed" ? "SUCCEEDED" : outcome === "failed" ? "FAILED" : "PROCESSING";
  const updated = await tx.refund.update({
    where: { id: refundId },
    data: {
      status,
      providerRefundId,
      failureReason: outcome === "failed" ? (failureReason ?? "provider_failed") : null,
    },
    include: { payment: { select: { bookingId: true } } },
  });
  if (status === "SUCCEEDED")
    await tx.ledgerEntry.create({
      data: {
        bookingId: updated.payment.bookingId,
        account: "REFUND",
        amountPaise: updated.amountPaise,
        currency: updated.currency,
        reference: providerRefundId,
        memo: updated.reason,
      },
    });
  if (status !== "PROCESSING")
    await tx.auditLog.create({
      data: {
        action: `refund.${status.toLowerCase()}`,
        targetType: "Refund",
        targetId: refundId,
        reason: updated.failureReason,
        metadata: { providerRefundId },
      },
    });
  return true;
}

/** Job handler: asks the provider to refund. Safe to retry; see PaymentProvider.refund. */
export async function processRefund(refundId: string) {
  const refund = await db.refund.findUnique({
    where: { id: refundId },
    include: { payment: true },
  });
  if (!refund || refund.status !== "PENDING") return;
  const provider = getPaymentProvider();
  if (!provider) throw new Error("payments_not_configured");
  if (!refund.payment.providerPaymentId) throw new Error("payment has no provider id");
  const r = await provider.refund({
    paymentId: refund.payment.providerPaymentId,
    amountPaise: refund.amountPaise,
    receipt: refund.id,
    notes: { refundId: refund.id, reason: refund.reason },
  });
  await db.$transaction((tx) => applyRefundOutcome(tx, refund.id, r.status, r.id));
  log("info", "refund.submitted", { refundId, providerRefundId: r.id, status: r.status });
}
