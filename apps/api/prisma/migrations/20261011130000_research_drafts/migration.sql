-- Research drafts are separate from public MarketPoint/Product records.
-- No existing data is changed and no draft can be ordered through the storefront.
CREATE TABLE "ResearchStoreDraft" (
  "key" VARCHAR(180) NOT NULL,
  "datasetId" VARCHAR(100) NOT NULL,
  "source" JSONB NOT NULL,
  "review" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResearchStoreDraft_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "ResearchStoreDraft_datasetId_idx" ON "ResearchStoreDraft" ("datasetId");

CREATE TABLE "ResearchProductDraft" (
  "key" VARCHAR(180) NOT NULL,
  "datasetId" VARCHAR(100) NOT NULL,
  "source" JSONB NOT NULL,
  "review" JSONB NOT NULL,
  "sale" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResearchProductDraft_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "ResearchProductDraft_datasetId_idx" ON "ResearchProductDraft" ("datasetId");
