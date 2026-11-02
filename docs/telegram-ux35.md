# Telegram CUSTOMER UX 3.5

The category renderer sends one server-generated JPEG per ordered pair of products.
Each 960×556 JPEG contains two independent 480×360 (4:3) photo regions and two
information regions. Sharp uses `contain`, leaving the whole product visible.
Missing photos affect only their own panel; the final odd slot remains empty.
Original uploads and the product image runner are unchanged.

Titles use the system Arial font on Windows and DejaVu Sans on Linux. Linux needs
`fonts-dejavu-core` and `fontconfig`. No fonts are bundled with the application.
Pango measures every line; Unicode grapheme boundaries preserve Cyrillic and
combining characters. Titles have at most three lines, with an ellipsis when
necessary. Prices have their own bold line and shrink to fit without truncation.
Untrusted names are escaped before rendering. The full name remains in the product
card and in the media/HTML fallbacks.

After each image there are two actual native `buttons` blocks: one row of
`Открыть товар` buttons, then one row of `Добавить в ` buttons. Both rows preserve
the image's left-to-right product order and carry explicit product IDs. Existing
quantity controls keep the category, page and cart revision. No primary action is
inside a photo caption or an interactive table cell.

The [official Bot API](https://core.telegram.org/bots/api) exposes no callback on
`InputRichBlockPhoto`, no fixed column contract for `InputRichBlockCollage`, and
no per-button width or flex layout for `InputRichBlockButtons`. A single raster
therefore guarantees the two photographic panels stay together. Native buttons
remain client-sized: exact pixel alignment with each half cannot be promised.
Raster/transport tests are not evidence of actual Android/Desktop rendering.

Pair identity includes the format version, ordered product IDs, names, integer
server prices, price quantities/units/statuses, formatted prices, source URLs and
local file revisions. The recipe LRU holds 64 entries; the JPEG LRU holds at most
16 entries / 4 MiB. At most eight distinct requests wait for one rasterizer, with
concurrent requests for the same pair sharing work. A JPEG is limited to 256 KiB.
Existing Telegram file-ID caching remains bot-specific and keyed by pair identity.
No remote URLs are downloaded while generating the pair.

Cart names and quantity/cost paragraphs are ordinary left-aligned Rich text.
Each product has a separate right-aligned native `−`, `+`, `✕` row, using existing
callbacks and disabled states. The name is intentionally not an interactive table
button; HTML retains its product-opening callback. The total of the entire cart,
discount/promo information and checkout action remain at the bottom.

Confirmed media rejection uses a media-free Rich screen with each product's full
name, price and its own opening/adding actions. Confirmed Rich rejection uses HTML.
Unknown delivery outcomes never trigger a repeated cart mutation or automatic
message resend. Global Rich configuration and the existing emergency HTML switch
are unchanged.
