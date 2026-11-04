-- Read-only preflight for an explicitly selected local database. Contains no customer data.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';

SELECT "serviceMarkupPercent", count(*) AS products
FROM "Product"
GROUP BY "serviceMarkupPercent"
ORDER BY "serviceMarkupPercent";

SELECT count(*) AS invalid_percentages
FROM "Product"
WHERE "serviceMarkupPercent" IS NULL OR "serviceMarkupPercent" NOT BETWEEN 0 AND 100;

-- Absence of a change event is not proof that 10% was assigned automatically.
SELECT count(*) AS markup_change_events
FROM "AdminAudit"
WHERE action = 'PRODUCT_MARKUP_CHANGED' AND entity = 'PRODUCT';

ROLLBACK;
