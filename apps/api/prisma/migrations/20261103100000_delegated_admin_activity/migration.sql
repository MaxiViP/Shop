ALTER TABLE "User" ADD COLUMN "adminPasswordHash" VARCHAR(256);

CREATE TABLE "AdminChange" (
  "id" SERIAL PRIMARY KEY,
  "requestId" UUID NOT NULL,
  "actorId" INTEGER NOT NULL,
  "actorName" TEXT NOT NULL,
  "source" VARCHAR(16) NOT NULL,
  "entity" VARCHAR(48) NOT NULL,
  "entityId" VARCHAR(160) NOT NULL,
  "operation" VARCHAR(16) NOT NULL,
  "beforeValue" JSONB,
  "afterValue" JSONB,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "claimToken" UUID,
  "leaseUntil" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminChange_status_check" CHECK ("status" IN ('PENDING','SENDING','SENT','UNKNOWN','FAILED'))
);
CREATE INDEX "AdminChange_status_nextAttemptAt_id_idx" ON "AdminChange"("status","nextAttemptAt","id");
CREATE INDEX "AdminChange_requestId_id_idx" ON "AdminChange"("requestId","id");

-- Audit and notification outbox commit with the business write, including raw SQL,
-- bulk changes and cascades. Only authenticated, delegated admin context is tagged.
CREATE FUNCTION "record_admin_change"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  context TEXT[];
  actor_name TEXT;
  before_value JSONB;
  after_value JSONB;
  changed_before JSONB;
  changed_after JSONB;
  row_key TEXT;
  secret_key TEXT;
BEGIN
  context := regexp_match(current_query(), '^/\*km-admin:([1-9][0-9]*):(WEB|TELEGRAM):([0-9a-f-]{36})\*/');
  IF context IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(nullif("name",''),"phone",'#' || id::text) INTO actor_name
    FROM "User" WHERE id=context[1]::integer AND role='ADMIN' FOR SHARE;
  IF actor_name IS NULL THEN RAISE EXCEPTION 'Admin role has been revoked' USING ERRCODE='42501'; END IF;
  IF TG_OP <> 'INSERT' THEN before_value := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN after_value := to_jsonb(NEW); END IF;
  IF before_value IS NOT DISTINCT FROM after_value THEN RETURN NULL; END IF;
  row_key := coalesce(after_value->>'id',before_value->>'id',
    nullif(concat_ws(':',coalesce(after_value->>'userId',before_value->>'userId'),coalesce(after_value->>'marketPointId',before_value->>'marketPointId')),''),
    after_value->>'weekday',before_value->>'weekday',after_value->>'floor',before_value->>'floor','settings');
  -- Authentication material never enters the audit journal or Telegram.
  FOREACH secret_key IN ARRAY ARRAY['adminPasswordHash','tokenHash','codeHash','publicToken','guestSessionId','checkoutRequestId','requestBody'] LOOP
    before_value := before_value - secret_key;
    after_value := after_value - secret_key;
  END LOOP;
  IF TG_TABLE_NAME='User' AND TG_OP='UPDATE' AND to_jsonb(OLD)->>'adminPasswordHash' IS DISTINCT FROM to_jsonb(NEW)->>'adminPasswordHash' THEN
    before_value := before_value || '{"adminPasswordChanged":false}'::jsonb;
    after_value := after_value || '{"adminPasswordChanged":true}'::jsonb;
  END IF;
  IF TG_OP='UPDATE' THEN
    SELECT coalesce(jsonb_object_agg(key,before_value->key),'{}'::jsonb),coalesce(jsonb_object_agg(key,after_value->key),'{}'::jsonb)
      INTO changed_before,changed_after FROM jsonb_object_keys(before_value || after_value) AS keys(key)
      WHERE key <> 'updatedAt' AND before_value->key IS DISTINCT FROM after_value->key;
    IF changed_before='{}'::jsonb AND changed_after='{}'::jsonb THEN RETURN NULL; END IF;
    before_value := changed_before; after_value := changed_after;
  END IF;
  INSERT INTO "AdminChange"("requestId","actorId","actorName","source","entity","entityId","operation","beforeValue","afterValue")
    VALUES(context[3]::uuid,context[1]::integer,actor_name,context[2],TG_TABLE_NAME,left(row_key,160),TG_OP,before_value,after_value);
  RETURN NULL;
END;
$$;

DO $$
DECLARE entity TEXT;
BEGIN
  FOREACH entity IN ARRAY ARRAY[
    'User','MarketPointOwner','Product','ProductImage','Category','MarketPoint','MarketLayout',
    'SeasonTemplate','HomeSlide','ShopSettings','ShopHours','ShopHoursException','PromoCode','PartnerPayout',
    'Order','OrderItem','OrderPayment','OrderExtra','OrderCancellation','OrderIssue',
    'OrderItemPriceChange','Delivery','DeliveryAttempt','OrderChatMessage','OrderChatImageRevision'
  ] LOOP
    EXECUTE format('CREATE TRIGGER admin_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION record_admin_change()',entity);
  END LOOP;
END;
$$;
