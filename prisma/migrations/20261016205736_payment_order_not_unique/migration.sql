-- DropIndex
DROP INDEX "Payment_providerOrderId_key";

-- CreateIndex
CREATE INDEX "Payment_providerOrderId_idx" ON "Payment"("providerOrderId");
