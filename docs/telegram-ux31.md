# Telegram UX3.1

Category pages use a Sharp contact sheet with three columns (up to8 products per page). Each tile contains its photograph, name and current server-formatted unit price on a contrasting bottom strip. Number badges correspond to compact numbered buttons carrying the same direct product IDs and original category/page callbacks. Telegram Photo has no callback and Collage exposes no fixed column setting; no unsupported API fields are used.

The original photographs remain unchanged. The sheet cache key includes layout, product IDs/order, captions/prices and hashes of the current optimized JPEGs. Local photo preparations also track file timestamps/size. Confirmed Telegram file IDs remain scoped by bot and sheet key. Missing/corrupt photos retain their numbered slots with a placeholder. Rich/media failure uses named/priced selection buttons; UNKNOWN never triggers a resend. Contact sheets are prepared only for the existing Rich allowlist.

Roboto is bundled under SIL OFL (`apps/api/assets/Roboto.OFL.txt`) so Cyrillic text works without server fonts. Source: https://github.com/google/fonts/tree/main/ofl/roboto . No new npm dependency is required.

Cart headers contain the title and distinct product count. Whole-cart discounts, preliminary total and checkout now follow all visible items. Rich uses a native divider, size3 label, bold size2 amount and immediate checkout row. HTML/text puts the total last and the checkout row first beneath the message, since Telegram cannot interleave HTML paragraphs and inline keyboard rows. Pricing, promotion calculations, revision checks and min/step rules remain unchanged.

Visual acceptance: inspect three-column tile readability and price strips on Desktop/Android; choose each numbered product and return to its page; check missing-photo slots; change quantities and inspect the bottom whole-cart total on every page, including promotions and unknown weight totals. Detailed release/checkpoint evidence is saved under `work/telegram-ux31/`.
