-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "readAt" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");
