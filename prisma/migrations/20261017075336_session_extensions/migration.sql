-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SessionEventType" ADD VALUE 'HOST_CONFIRMED_ARRIVAL';
ALTER TYPE "SessionEventType" ADD VALUE 'NO_SHOW_OR_UNCONFIRMED';

-- DropForeignKey
ALTER TABLE "OverstayIncident" DROP CONSTRAINT "OverstayIncident_reportedById_fkey";

-- AlterTable
ALTER TABLE "OverstayIncident" ALTER COLUMN "reportedById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "extensionQuoteId" UUID;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_extensionQuoteId_fkey" FOREIGN KEY ("extensionQuoteId") REFERENCES "PriceQuote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OverstayIncident" ADD CONSTRAINT "OverstayIncident_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
