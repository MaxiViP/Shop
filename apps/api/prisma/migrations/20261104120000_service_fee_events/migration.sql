-- Additive integration upgrade. Do not rewrite the deployed event-center migration.
BEGIN;

CREATE OR REPLACE FUNCTION event_values(value JSONB, entity TEXT) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_object_agg(key,
    CASE
      WHEN jsonb_typeof(val)='string'
        THEN to_jsonb(left(val #>> '{}',240))
      WHEN jsonb_typeof(val) IN ('object','array')
        THEN jsonb_build_object(
          'type', jsonb_typeof(val),
          'bytes', octet_length(val::text),
          'fingerprint', md5(val::text))
      ELSE val
    END),'{}'::jsonb)
  FROM jsonb_each(CASE WHEN jsonb_typeof(value)='object' THEN value ELSE '{}'::jsonb END) AS fields(key,val)
  WHERE key = ANY(CASE WHEN entity='User' THEN ARRAY['role','adminPasswordChanged']
    WHEN entity='MarketPointOwner' THEN ARRAY['userId','marketPointId']
    WHEN entity='OrderChatMessage' THEN ARRAY['authorType','recipient','imageRevision','imageDeletedAt']
    WHEN entity='OrderChatImageRevision' THEN ARRAY['version','actorType']
    WHEN entity='ProductImage' THEN ARRAY['url','alt','sort','visible','productId']
    WHEN entity='HomeSlide' THEN ARRAY['key','type','content','title','text','eyebrow','buttonLabel','to','image','position','active','published','priority','sortOrder','startsAt','endsAt']
    WHEN entity='OrderNotification' THEN ARRAY['status','channel','type']
    WHEN entity='DeliveryAttempt' THEN ARRAY['state','provider','providerStatus']
    ELSE ARRAY['name','title','productName','productSlug','description','slug','role','status','type','active','published','price','actualPrice',
      'qty','actualQty','quantity','actualWeightGrams','estimatedWeightGrams','priceQty','unit',
      'total','actualTotal','subtotal','finalSubtotal','finalTotal','deliveryPrice','amount','unitPrice',
      'previousPrice','newPrice','sellerPrice','discount','promoDiscount','finalPromoDiscount','stock','available','sort','sortOrder','categoryId',
      'productId','marketPointId','serviceMarkupPercent','globalServiceMarkupPercent','serviceMarkupPercentOverride','serviceMarkupNeedsReview','settlementMode','basePrice','priceStatus',
      'min','step','portionQty','saleModel','priceUnit','floor','kind','enabled','weekday','openMinutes',
      'closeMinutes','date','closed','minDeliverySubtotal','maxOrderExtraUnitPrice','maxOrderExtrasTotal',
      'deliveryEnabled','pickupEnabled','freeDeliveryEnabled','freeDeliveryThreshold','weightToleranceBps',
      'customerResponseMinutes','queueThreshold','assemblyFallbackMinutes','assemblyConcurrency',
      'peakModeEnabled','peakAssemblyConcurrency','peakAssemblyMinutes','peakQueueThreshold',
      'peakSlotCapacity','peakModeStart','peakModeEnd','slotIntervalMinutes','slotCapacity',
      'hitPeriodDays','hitMinOrders','hitShareBps','seasonalMode','seasonalStartsAt','seasonalEndsAt',
      'hitMode','isHit','hitOrders','hitSoldUnits','hitRank','isSeasonal','wholeLabel','parentId',
      'startMonth','endMonth','group','unitNumber','mapX','mapY','mapWidth','mapHeight','mapColor',
      'cardColor','isOurPoint','ourLabel','isPublished','photoUrl','sampleAssortment','escalator',
      'seasonTemplateId','startsAt','endsAt','fulfillmentMode','scheduledFor','method','provider',
      'providerStatus','resolution','version','percentBps','minSubtotal','maxDiscount','expiresAt',
      'partner','paidAt','periodFrom','periodTo'] END)
$$;

CREATE OR REPLACE FUNCTION record_admin_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  context TEXT[]; actor_id INTEGER; actor_role TEXT; actor_name TEXT; source_name TEXT;
  operation_id UUID; before_value JSONB; after_value JSONB; old_row JSONB; new_row JSONB;
  changed_before JSONB; changed_after JSONB; row_key TEXT; order_id INTEGER; product_id INTEGER;
  category_name TEXT; event_title TEXT; private_event BOOLEAN := false; notify BOOLEAN := false;
  order_table BOOLEAN; system_problem BOOLEAN := false; fingerprint TEXT;
BEGIN
  context := regexp_match(current_query(), '^/\*km-admin:([0-9]+):(WEB|TELEGRAM):([0-9a-f-]{36}):(USER|SELLER|ADMIN|GUEST|SYSTEM):([01])\*/');
  old_row := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  new_row := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  IF old_row IS NOT DISTINCT FROM new_row THEN RETURN NULL; END IF;
  order_table := TG_TABLE_NAME IN ('Order','OrderItem','OrderPayment','OrderExtra','OrderCancellation',
    'OrderIssue','OrderItemPriceChange','Delivery','DeliveryAttempt','OrderChatMessage','OrderChatImageRevision');
  -- Outbox failures are real operational events, not invented payment/sale events.
  IF TG_TABLE_NAME='OrderNotification' THEN
    system_problem := TG_OP='UPDATE' AND new_row->>'status' IN ('FAILED','UNCONFIGURED','SENDING')
      AND (new_row->>'status'<>'SENDING' OR new_row->>'error' IS NOT NULL)
      AND (new_row->>'status' IS DISTINCT FROM old_row->>'status' OR
        new_row->>'error' IS DISTINCT FROM old_row->>'error');
    IF NOT system_problem THEN RETURN NULL; END IF;
  ELSIF TG_TABLE_NAME='AdminChange' THEN
    system_problem := TG_OP='UPDATE' AND new_row->>'status' IN ('FAILED','UNKNOWN')
      AND new_row->>'status' IS DISTINCT FROM old_row->>'status';
    IF NOT system_problem THEN RETURN NULL; END IF;
    private_event := true;
  END IF;
  private_event := private_event OR TG_TABLE_NAME='MarketPointOwner' OR
    (TG_TABLE_NAME='User' AND TG_OP='UPDATE' AND (old_row->>'role' IS DISTINCT FROM new_row->>'role'
      OR old_row->>'adminPasswordHash' IS DISTINCT FROM new_row->>'adminPasswordHash'));
  IF context IS NULL AND NOT order_table AND NOT system_problem AND NOT private_event THEN RETURN NULL; END IF;
  actor_id := nullif(context[1],'0')::integer;
  source_name := coalesce(context[2],'SYSTEM');
  operation_id := coalesce(context[3]::uuid,md5('event:' || pg_current_xact_id()::text)::uuid);
  IF actor_id IS NOT NULL THEN
    SELECT role::text, coalesce(nullif(name,''),'Сотрудник #' || id::text)
      INTO actor_role,actor_name FROM "User" WHERE id=actor_id FOR SHARE;
    IF actor_role IS NULL OR actor_role <> context[4] THEN
      RAISE EXCEPTION 'Actor role has been revoked' USING ERRCODE='42501';
    END IF;
    IF actor_role='USER' AND EXISTS(SELECT 1 FROM "MarketPointOwner" WHERE "userId"=actor_id)
      THEN actor_role := 'SELLER'; END IF;
    notify := actor_role='ADMIN' AND context[5]='1';
  ELSE
    actor_role := CASE WHEN context[4]='GUEST' THEN 'CUSTOMER' ELSE 'SYSTEM' END;
    actor_name := CASE WHEN context[4]='GUEST' THEN 'Покупатель' ELSE 'Система' END;
    IF TG_TABLE_NAME='Order' AND TG_OP='INSERT' THEN
      actor_id := (new_row->>'userId')::integer;
      actor_role := 'CUSTOMER'; actor_name := 'Покупатель';
    END IF;
  END IF;
  IF actor_role='USER' THEN actor_role := 'CUSTOMER'; actor_name := 'Покупатель'; END IF;
  -- Catalogue background recalculations and read-receipt counters are not activity.
  IF NOT order_table AND NOT system_problem AND actor_role NOT IN ('ADMIN','SELLER') AND NOT private_event THEN RETURN NULL; END IF;
  row_key := coalesce(new_row->>'id',old_row->>'id',new_row->>'orderId',old_row->>'orderId',
    nullif(concat_ws(':',coalesce(new_row->>'userId',old_row->>'userId'),coalesce(new_row->>'marketPointId',old_row->>'marketPointId')),''),
    new_row->>'weekday',old_row->>'weekday','settings');
  order_id := CASE WHEN TG_TABLE_NAME='Order' THEN row_key::integer
    WHEN order_table OR TG_TABLE_NAME='OrderNotification' THEN coalesce(new_row->>'orderId',old_row->>'orderId')::integer END;
  IF TG_TABLE_NAME='OrderChatImageRevision' THEN
    SELECT "orderId" INTO order_id FROM "OrderChatMessage" WHERE id=coalesce(new_row->>'messageId',old_row->>'messageId')::integer;
  END IF;
  product_id := CASE WHEN TG_TABLE_NAME='Product' THEN row_key::integer
    ELSE coalesce(new_row->>'productId',old_row->>'productId')::integer END;
  before_value := event_values(old_row,TG_TABLE_NAME); after_value := event_values(new_row,TG_TABLE_NAME);
  -- Fee policy changes are financial settings visible only to the primary admin.
  -- The existing row trigger/outbox remains the sole event projection; AdminAudit
  -- continues to store the domain operation and its durable bulk requestId.
  private_event := private_event OR
    (TG_TABLE_NAME='ShopSettings' AND
      old_row->'globalServiceMarkupPercent' IS DISTINCT FROM new_row->'globalServiceMarkupPercent') OR
    (TG_TABLE_NAME='Product' AND TG_OP='UPDATE' AND (
      old_row->'serviceMarkupPercent' IS DISTINCT FROM new_row->'serviceMarkupPercent' OR
      old_row->'serviceMarkupPercentOverride' IS DISTINCT FROM new_row->'serviceMarkupPercentOverride' OR
      old_row->'serviceMarkupNeedsReview' IS DISTINCT FROM new_row->'serviceMarkupNeedsReview'));
  IF TG_TABLE_NAME='User' THEN
    IF TG_OP='UPDATE' AND old_row->>'adminPasswordHash' IS DISTINCT FROM new_row->>'adminPasswordHash' THEN
      before_value := before_value || '{"adminPasswordChanged":false}';
      after_value := after_value || '{"adminPasswordChanged":true}';
    END IF;
    private_event := true;
  ELSIF TG_TABLE_NAME IN ('MarketPointOwner','PartnerPayout') THEN private_event := true; END IF;
  IF TG_OP='UPDATE' THEN
    SELECT coalesce(jsonb_object_agg(key,before_value->key),'{}'),coalesce(jsonb_object_agg(key,after_value->key),'{}')
      INTO changed_before,changed_after FROM jsonb_object_keys(before_value || after_value) AS keys(key)
      WHERE before_value->key IS DISTINCT FROM after_value->key;
    IF changed_before='{}' AND changed_after='{}' AND NOT system_problem THEN RETURN NULL; END IF;
    before_value := changed_before; after_value := changed_after;
  END IF;
  category_name := CASE WHEN system_problem OR TG_TABLE_NAME='DeliveryAttempt' AND new_row->>'state'='NEEDS_REVIEW' THEN 'SYSTEM'
    WHEN TG_TABLE_NAME='OrderPayment' OR TG_TABLE_NAME='Order' AND new_row->>'status'='COMPLETED' THEN 'SALES'
    WHEN TG_TABLE_NAME IN ('OrderItem','OrderExtra','OrderItemPriceChange') THEN 'RECEIPTS'
    WHEN order_table THEN 'ORDERS' WHEN actor_role='SELLER' THEN 'SELLERS' ELSE 'ADMINISTRATORS' END;
  event_title := CASE WHEN TG_TABLE_NAME='AdminChange' THEN 'Проблема уведомления владельцу'
    WHEN system_problem THEN 'Проблема доставки уведомления'
    WHEN TG_TABLE_NAME='DeliveryAttempt' AND new_row->>'state'='NEEDS_REVIEW' THEN 'Доставка требует проверки'
    WHEN TG_TABLE_NAME='Order' AND TG_OP='INSERT' THEN 'Заказ создан'
    WHEN TG_TABLE_NAME='Order' AND old_row->>'status' IS DISTINCT FROM new_row->>'status' THEN CASE new_row->>'status'
      WHEN 'CONFIRMED' THEN 'Заказ подтверждён' WHEN 'ASSEMBLING' THEN 'Сборка начата'
      WHEN 'READY' THEN 'Заказ готов' WHEN 'DELIVERING' THEN 'Заказ передан в доставку'
      WHEN 'COMPLETED' THEN 'Заказ завершён' WHEN 'CANCELED' THEN 'Заказ отменён' ELSE 'Заказ изменён' END
    WHEN TG_TABLE_NAME='Order' THEN 'Заказ изменён'
    WHEN TG_TABLE_NAME='OrderChatMessage' THEN 'Сообщение по заказу'
    WHEN TG_TABLE_NAME='OrderChatImageRevision' THEN 'Обновление фото по заказу'
    WHEN TG_TABLE_NAME='OrderPayment' AND new_row->>'status'='PAID' AND old_row->>'status' IS DISTINCT FROM new_row->>'status' THEN 'Оплата подтверждена'
    WHEN TG_TABLE_NAME='OrderPayment' THEN 'Состояние оплаты изменено'
    WHEN TG_TABLE_NAME IN ('OrderItem','OrderExtra','OrderItemPriceChange') THEN 'Состав и сумма заказа'
    WHEN private_event THEN 'Права и закрытые изменения'
    WHEN category_name='SELLERS' THEN 'Изменения продавца' ELSE 'Изменения магазина' END;
  IF system_problem THEN actor_id := NULL; actor_role := 'SYSTEM'; actor_name := 'Система'; source_name := 'SYSTEM'; notify := false; END IF;
  fingerprint := md5(pg_current_xact_id()::text || operation_id::text || TG_TABLE_NAME || row_key || TG_OP || before_value::text || after_value::text);
  INSERT INTO "AdminChange"("requestId","actorId","actorName","actorRole",source,entity,"entityId",operation,
    "beforeValue","afterValue",category,title,"ownerOnly","notifyOwner","orderId","productId",status,"dedupeKey")
    VALUES(operation_id,actor_id,actor_name,actor_role,source_name,TG_TABLE_NAME,left(row_key,160),TG_OP,
      nullif(before_value,'{}'),nullif(after_value,'{}'),category_name,event_title,private_event,notify,order_id,product_id,
      CASE WHEN notify THEN 'PENDING' ELSE 'SENT' END,fingerprint) ON CONFLICT ("dedupeKey") DO NOTHING;
  RETURN NULL;
END;
$$;

COMMIT;
