# Telegram UX 3.1 — compact paired gallery

Category pages use the native paired Rich Collage layout from 1eb41ee: up to 8 products, two separate photographs per collage followed immediately by the matching row of product-name/price buttons. A final odd product keeps its own row. Selection uses the existing direct product ID and category/page callback. No text or prices are drawn onto images. Missing/invalid gallery media degrades to the same named buttons without shifting products.

Only gallery JPEG derivatives change aspect ratio: 640x480 (4:3), fit contain, white padding, quality 85. The whole product remains in frame and original files/full product-card photos are unchanged. At the same displayed width, 4:3 is 25% lower than a square; reducing JPEG resolution alone would not achieve that. Telegram controls final Collage layout, spacing, cropping and screen dimensions, so this is not a measured client-height guarantee. Native blocks expose no height or fixed-column parameter: https://core.telegram.org/bots/api#inputrichblockcollage . Each block contains at most two photographs to retain the paired layout.

Contact-sheet rendering, its in-memory cache, alternate numbered keyboard and bundled font were removed. Existing local-photo preparation and bot-scoped Telegram file_id reuse remain. Prices are refreshed from the server on the named buttons independently of image reuse.

Cart headers contain the title and distinct product count. Whole-cart discounts, preliminary total and checkout now follow all visible items. Rich uses a native divider, size3 label, bold size2 amount and immediate checkout row. HTML/text puts the total last and the checkout row first beneath the message, since Telegram cannot interleave HTML paragraphs and inline keyboard rows. Pricing, promotion calculations, revision checks and min/step rules remain unchanged.

Visual acceptance: inspect paired landscape photos and named/priced controls on Desktop/Android; open a product and return to its original page. Confirm the cart still shows its prominent total directly before checkout after quantity changes and on all pages. Actual client height must be confirmed visually.
