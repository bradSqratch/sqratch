-- CreateTable
CREATE TABLE "CommerceOrderReconciliationState" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "reconciledThrough" TIMESTAMP(3),
    "targetThrough" TIMESTAMP(3),
    "lastAttemptedAt" TIMESTAMP(3),
    "lastRunOutcome" TEXT,
    "lastRunError" TEXT,
    "customRangeFrom" TIMESTAMP(3),
    "customRangeTo" TIMESTAMP(3),
    "customRangeCursor" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceOrderReconciliationState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommerceOrderReconciliationState_connectionId_key" ON "CommerceOrderReconciliationState"("connectionId");

-- CreateIndex
CREATE INDEX "CommerceOrderReconciliationState_brandId_idx" ON "CommerceOrderReconciliationState"("brandId");

-- AddForeignKey
ALTER TABLE "CommerceOrderReconciliationState" ADD CONSTRAINT "CommerceOrderReconciliationState_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "CommerceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderReconciliationState" ADD CONSTRAINT "CommerceOrderReconciliationState_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

