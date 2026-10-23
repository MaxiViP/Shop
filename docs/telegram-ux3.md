# Telegram UX 3.0

The existing CUSTOMER/STAFF shopping and order flows remain in Telegram chat. No Mini App, pricing, authorization, schema or order transition changes.

## Cart

The cart separates the number of distinct products and preliminary total, the last acknowledged change, and each product's full requested quantity and preliminary line total. Quantity and line total use native bold RichText and bold HTML fallback. Rich dividers separate products. The existing four-button row, minimum/step rules, revisions and single-attempt mutation behavior are retained.

Receipts use the difference between acknowledged CartService quantities and integer kopeck line totals. A new product reports its actual first quantity; removal reports one removal notice. Changed pricing, unavailable lines or unknown totals produce a neutral recalculation notice. Notices are passed into one presentation, never persisted, so navigation and ordinary reopening clear them.

## Category gallery

Eight products per page, up to two images per native `InputRichBlockCollage`, followed by the corresponding named `InputRichBlockButtons` row. A one-page category has no page counter. There is no duplicate text product list. The HTML fallback uses the same named product selection buttons and prices.

The official [photo block](https://core.telegram.org/bots/api#inputrichblockphoto) has no callback field. [Collage blocks](https://core.telegram.org/bots/api#inputrichblockcollage) provide media layout; [button blocks](https://core.telegram.org/bots/api#inputrichblockbuttons) provide callbacks. No image callback or CSS fields are invented. Named controls make selection independent of client-specific collage ordering. Identical shortened names receive a stable product number. Callbacks contain the actual product ID, original category and page, rather than an array offset. Moving a product does not change its selection or the return category. Legacy callbacks remain supported; maximum category-bound quantity callbacks are 63 bytes.

The API does not specify an exact pixel grid on every client. Desktop/Android visual acceptance is required. No bare photograph numbers are used.

## Media and degradation

Use existing local optimized product photographs only. Gallery derivatives are in-memory, square 320px JPEGs (at most192KiB each); product cards retain the existing bounded1280px JPEG upload. Original images and the production image runner are unchanged. Preparation is cached and Telegram file IDs are cached for15minutes, scoped by bot token and thumbnail/full variant.

Gateway multipart remains limited to2MiB total and1MiB per JPEG, now allowing at most8 files. It validates JPEG signatures, unique names, exact attachment references and bounded block depth/count. JSON limits and single upstream attempt are unchanged.

If any gallery source is missing/invalid/unreadable, the entire media grid degrades to named selection controls; products never shift into another product's slot. A confirmed Telegram rejection permits cached-ID recovery, Rich without media, then escaped HTML. Timeouts/unknown outcomes never trigger a resend or business mutation replay. Product-card media failure does not prevent shopping.

## Orders

The common order renderer remains shared by CUSTOMER and STAFF. It highlights fulfillment, preliminary/final totals, payment, assembly and next action. `REPORTED` remains distinct from `PAID`. Assembly shows picked, pending and missing separately. STAFF details include persisted actual quantity/weight/line total. Canceled payment amounts are historical, not an active payment request. Existing decisions and critical-action confirmations remain unchanged.

## Release and visual acceptance

Keep Rich restricted to the existing test allowlists. Before release, verify the actual deployed version, backup database/uploads/runtime/configuration/systemd drop-ins, restore the database dump into an isolated verification database, and prepare rollback to the actual previous runtime. Rebuild API and gateway only; unchanged Web/Mini App do not require rebuilding. No migration is required.

Fresh local checks, isolated PostgreSQL results and actual Telegram transport evidence are recorded in `work/telegram-ux3/`. Transport acceptance is separate from visual acceptance.

On Telegram Desktop Windows and Android (Galaxy S25 Ultra), verify:

1. Categories show two buttons per row and no one-page pagination.
2. Fruits show a compact gallery without a duplicate text list; named selection opens the correct full product card and returns to the same category/page.
3. The product photograph appears on first opening. Quantity controls use minimum first, then one configured step.
4. Cart addition/reduction/removal each show only the last confirmed action. Reopening clears it. Distinct product count stays stable when weight increases.
5. Full requested weight/quantity and preliminary line cost are prominent, with a separately labeled cart total and one four-button row per item.
6. Empty/multiple/long-name/weight/piece/bunch/pack products and unavailable photos remain understandable.
7. CUSTOMER and STAFF orders show truthful NEW/CONFIRMED/ASSEMBLING/READY/DELIVERING/COMPLETED/CANCELED states; pending coordination shows requested/actual quantity and monetary difference.
8. Pickup/delivery, totals, picked/pending/missing progress and AWAITING/REPORTED/PAID/CANCELED payments are visually distinct, with the correct next action and no false paid/completed status.

Desktop and Android acceptance must be confirmed by the user, not inferred from API responses.
