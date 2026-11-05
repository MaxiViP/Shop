BEGIN;

-- Additive only. No Product, settings, order or payment rows/columns are changed.
CREATE TABLE "ServiceFeeBulkOperation" (
    "requestId" UUID NOT NULL,
    "actorId" INTEGER NOT NULL,
    "previewHash" CHAR(64) NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ServiceFeeBulkOperation_pkey" PRIMARY KEY ("requestId"),
    CONSTRAINT "ServiceFeeBulkOperation_preview_hash_check" CHECK ("previewHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ServiceFeeBulkOperation_result_check" CHECK (jsonb_typeof("result") = 'object'),
    CONSTRAINT "ServiceFeeBulkOperation_actorId_fkey" FOREIGN KEY ("actorId")
      REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "ServiceFeeBulkOperation_actorId_createdAt_idx" ON "ServiceFeeBulkOperation"("actorId", "createdAt");
COMMIT;
