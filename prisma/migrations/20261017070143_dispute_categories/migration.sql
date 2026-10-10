-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DisputeCategory" ADD VALUE 'INCORRECT_LISTING';
ALTER TYPE "DisputeCategory" ADD VALUE 'DUPLICATE_CHARGE';
ALTER TYPE "DisputeCategory" ADD VALUE 'BOOKING_FAILURE';
