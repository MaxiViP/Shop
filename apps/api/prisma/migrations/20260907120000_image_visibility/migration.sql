-- Existing images remain public; no records or image files are removed.
ALTER TABLE "ProductImage" ADD COLUMN "visible" BOOLEAN NOT NULL DEFAULT true;
