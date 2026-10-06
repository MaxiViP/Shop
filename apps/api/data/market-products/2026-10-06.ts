// Dated seller-price snapshot supplied for the first import. All amounts are kopecks.
// No third-party images; product slugs include the market point to distinguish sellers.
export const sourceCheckedAt = '2026-10-06T00:00:00.000Z';
export const expectedCounts = { 'cezoni-market': 34, 'grand-bazar': 6 } as const;
export const categories = [
  { slug: 'grocery', name: 'Бакалея', sort: 4 },
  { slug: 'oils', name: 'Масла', sort: 5 },
  { slug: 'sauces-spices', name: 'Соусы и приправы', sort: 6 },
  { slug: 'preserves-pickles', name: 'Консервы и соленья', sort: 7 },
  { slug: 'tea-coffee', name: 'Чай и кофе', sort: 8 },
  { slug: 'sweets-biscuits', name: 'Сладости и печенье', sort: 9 },
  { slug: 'pasta-grains', name: 'Макароны и крупы', sort: 10 },
] as const;

type Row = { slug: string; name: string; sellerPrice: number; categorySlug: typeof categories[number]['slug'] };
function products(marketPointSlug: keyof typeof expectedCounts, sourceUrl: string, rows: Row[]) {
  return rows.map(row => ({ ...row, slug: `${marketPointSlug}-${row.slug}`, marketPointSlug,
    sourceUrl, sourceCheckedAt, unit: 'PIECE' as const, priceQty: 1, step: 1, min: 1, portionQty: 1 }));
}

export const marketProducts = [
  ...products('cezoni-market', 'https://cezoni.com/collection/all', [
    { slug: 'casa-rinaldi-carnaroli-500g', name: 'Рис Casa Rinaldi Карнароли 500 г', sellerPrice: 22000, categorySlug: 'pasta-grains' },
    { slug: 'casa-rinaldi-modena-spray-250ml', name: 'Уксус бальзамический Casa Rinaldi Modena спрей 250 мл', sellerPrice: 49500, categorySlug: 'sauces-spices' },
    { slug: 'black-olives-350g', name: 'Оливки CEZONI черные в рассоле 350 г', sellerPrice: 40600, categorySlug: 'preserves-pickles' },
    { slug: 'grilled-artichokes-350g', name: 'Артишоки CEZONI гриль 350 г', sellerPrice: 83100, categorySlug: 'preserves-pickles' },
    { slug: 'cantuccini-cherry-almond-180g', name: 'Печенье Кантуччини Вишня и миндаль CEZONI 180 г', sellerPrice: 39600, categorySlug: 'sweets-biscuits' },
    { slug: 'butter-biscuits-180g', name: 'Печенье CEZONI домашнее на сливочном масле 180 г', sellerPrice: 22700, categorySlug: 'sweets-biscuits' },
    { slug: 'dalla-costa-fast-races-250g', name: 'Паста детская Dalla Costa «Быстрые гонки» 250 г', sellerPrice: 29300, categorySlug: 'pasta-grains' },
    { slug: 'classic-grissini-150g', name: 'Гриссини классические CEZONI 150 г', sellerPrice: 14800, categorySlug: 'grocery' },
    { slug: 'nadawilli-wheat-germ-oil-250ml', name: 'Масло зародышей пшеницы Nadawilli 250 мл', sellerPrice: 31900, categorySlug: 'oils' },
    { slug: 'nadawilli-walnut-oil-250ml', name: 'Масло грецкого ореха Nadawilli 250 мл', sellerPrice: 61900, categorySlug: 'oils' },
    { slug: 'nadawilli-pumpkin-oil-250ml', name: 'Масло тыквенное Nadawilli 250 мл', sellerPrice: 72700, categorySlug: 'oils' },
    { slug: 'nadawilli-garlic-sunflower-oil-250ml', name: 'Масло подсолнечное чесночное Nadawilli 250 мл', sellerPrice: 35300, categorySlug: 'oils' },
    { slug: 'nadawilli-sunflower-oil-500ml', name: 'Масло подсолнечное Nadawilli 500 мл', sellerPrice: 27900, categorySlug: 'oils' },
    { slug: 'nadawilli-sunflower-oil-250ml', name: 'Масло подсолнечное Nadawilli 250 мл', sellerPrice: 21800, categorySlug: 'oils' },
    { slug: 'sun-dried-tomatoes-260ml', name: 'Томаты вяленые CEZONI в масле 260 мл', sellerPrice: 45500, categorySlug: 'preserves-pickles' },
    { slug: 'iori-satsebeli-bbq-270g', name: 'Соус сацебели шашлычный IORI 270 г', sellerPrice: 17500, categorySlug: 'sauces-spices' },
    { slug: 'iori-narsharab-350g', name: 'Соус Наршараб IORI 350 г', sellerPrice: 37800, categorySlug: 'sauces-spices' },
    { slug: 'iori-satsebeli-classic-265g', name: 'Соус сацебели классический IORI 265 г', sellerPrice: 20600, categorySlug: 'sauces-spices' },
    { slug: 'iori-tkemali-classic-285g', name: 'Соус ткемали классический IORI 285 г', sellerPrice: 22800, categorySlug: 'sauces-spices' },
    { slug: 'iori-tkemali-bbq-285g', name: 'Соус ткемали шашлычный IORI 285 г', sellerPrice: 19400, categorySlug: 'sauces-spices' },
    { slug: 'iori-tomato-basil-265g', name: 'Соус томатный с базиликом IORI 265 г', sellerPrice: 21500, categorySlug: 'sauces-spices' },
    { slug: 'iori-green-adjika-120g', name: 'Аджика абхазская зелёная IORI 120 г', sellerPrice: 28400, categorySlug: 'sauces-spices' },
    { slug: 'iori-classic-adjika-135g', name: 'Аджика абхазская классическая IORI 135 г', sellerPrice: 26000, categorySlug: 'sauces-spices' },
    { slug: 'nocellara-green-olives-350g', name: 'Оливки зеленые Ночеллара CEZONI 350 г', sellerPrice: 45500, categorySlug: 'preserves-pickles' },
    { slug: 'de-luca-linguine-012-500g', name: 'Паста De Luca Linguine №012 500 г', sellerPrice: 28700, categorySlug: 'pasta-grains' },
    { slug: 'de-luca-lasagna-129-500g', name: 'Паста De Luca Lasagna №129 500 г', sellerPrice: 42100, categorySlug: 'pasta-grains' },
    { slug: 'valgri-young-peas-350g', name: 'Горошек молодой Valgri 350 г', sellerPrice: 34900, categorySlug: 'preserves-pickles' },
    { slug: 'valgri-spanish-white-beans-350g', name: 'Фасоль белая испанская Valgri 350 г', sellerPrice: 27900, categorySlug: 'preserves-pickles' },
    { slug: 'valgri-cannellini-350g', name: 'Фасоль Cannellini Valgri 350 г', sellerPrice: 27900, categorySlug: 'preserves-pickles' },
    { slug: 'valgri-tondini-350g', name: 'Фасоль Tondini Valgri 350 г', sellerPrice: 27900, categorySlug: 'preserves-pickles' },
    { slug: 'valgri-borlotti-350g', name: 'Фасоль Borlotti Valgri 350 г', sellerPrice: 27900, categorySlug: 'preserves-pickles' },
    { slug: 'nonno-giovanni-dop-250ml', name: 'Оливковое масло Nonno Giovanni DOP 250 мл', sellerPrice: 164600, categorySlug: 'oils' },
    { slug: 'nonno-giovanni-dop-500ml', name: 'Оливковое масло Nonno Giovanni DOP 500 мл', sellerPrice: 306500, categorySlug: 'oils' },
    { slug: 'donna-carmela-igp-500ml', name: 'Оливковое масло Donna Carmela IGP 500 мл', sellerPrice: 272400, categorySlug: 'oils' },
  ]),
  ...products('grand-bazar', 'https://grandbazar.su/shop/', [
    { slug: 'koska-tahini-530g', name: 'Кунжутная паста Tahini Koska 530 г', sellerPrice: 71900, categorySlug: 'grocery' },
    { slug: 'cansa-yakan-biber-1200g', name: 'Перец острый маринованный Cansa Yakan Biber 1200 г', sellerPrice: 94900, categorySlug: 'preserves-pickles' },
    { slug: 'koska-pomegranate-tea-200g', name: 'Чай гранатовый растворимый Koska 200 г', sellerPrice: 58900, categorySlug: 'tea-coffee' },
    { slug: 'naturel-yellow-lentils-1000g', name: 'Чечевица жёлтая Grand Bazar by Naturel 1000 г', sellerPrice: 71900, categorySlug: 'pasta-grains' },
    { slug: 'as-whole-grain-bulgur-1000g', name: 'Булгур цельнозерновой AS 1000 г', sellerPrice: 30900, categorySlug: 'pasta-grains' },
    { slug: 'ulker-protein-chocolate-banana-280g', name: 'Сэндвич-печенье Ulker Protein шоколад-банан 280 г', sellerPrice: 42900, categorySlug: 'sweets-biscuits' },
  ]),
];
