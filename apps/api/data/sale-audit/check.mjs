import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../../../../', import.meta.url);
const directory = new URL('docs/catalog-sale-audit/', root);
const read = async path => JSON.parse((await readFile(new URL(path, root), 'utf8')).replace(/^\uFEFF/, ''));
const audit = await read('docs/catalog-sale-audit/products.json');
const baseline = await read('docs/catalog-sale-audit/database.json');
const plan = await read('docs/catalog-sale-audit/plan.json');
const applied = await read('docs/catalog-sale-audit/apply.json');
const dryRun = await read('docs/catalog-sale-audit/dry-run.json');
const verification = await read('docs/catalog-sale-audit/verification.json');
const sources = await read('docs/catalog-sale-audit/sources.json');
const starter = await read('apps/api/data/catalog-drafts/moscow-market-2026-10-11/catalog-all.json');
const queue = await read('apps/api/data/imports/bagrationovsky-2026-10-11/prepared/import-queue.json');
const checks = [];
function check(name, verify) { verify(); checks.push({ name, passed: true }); }
const database = audit.products.filter(product => product.scope.startsWith('DATABASE_'));
const quantities = ['unit', 'priceQty', 'min', 'step', 'portionQty'];
check('Every local Product appears exactly once', () => {
  assert.equal(baseline.available, true);
  assert.equal(database.length, baseline.products.length);
  assert.deepEqual(database.map(product => product.productId).sort((a, b) => a - b), baseline.products.map(product => product.id).sort((a, b) => a - b));
  assert.equal(new Set(database.map(product => product.productId)).size, database.length);
});
check('Original quantities, identity, prices and activity are recorded', () => {
  for (const product of database) {
    const original = baseline.products.find(row => row.id === product.productId);
    assert.equal(product.slug, original.slug);
    assert.equal(product.active, original.active);
    assert.equal(product.sellerPriceKopecks, original.price);
    assert.equal(product.priceStatus, original.priceStatus);
    for (const key of quantities) assert.equal(product.old[key], original[key]);
  }
});
check('All source snapshots, starter rows and seed rows are included separately', () => {
  for (const [scope, count] of [['SOURCE_SNAPSHOT', 40], ['UNIMPORTED_SELLER_DRAFT', 146], ['STARTER_DRAFT', 114], ['SEED', 6]]) {
    assert.equal(audit.products.filter(product => product.scope === scope).length, count);
  }
  const rows = audit.products.filter(product => product.scope === 'STARTER_DRAFT');
  assert.deepEqual(rows.map(product => product.slug).sort(), starter.products.map(product => product.slug).sort());
  for (const product of rows) assert.ok(database.some(row => row.productId === product.productId && row.slug === product.actualProductSlug));
  assert.equal(rows.filter(product => product.slug !== product.actualProductSlug).length, 3);
  assert.equal(audit.summary.uniqueCatalogCandidates, 319);
});
check('Every research offer is recorded without importing it', () => {
  assert.deepEqual(audit.researchProducts.map(product => product.key).sort(), queue.products.map(product => product.key).sort());
  assert.equal(audit.researchProducts.length, 168);
  assert.ok(audit.researchProducts.every(product => product.productId === null && product.application === 'NOT_IMPORTED' && !product.changedFields.length));
  assert.equal(audit.summary.researchQueue.imported, false);
});
check('Unconfirmed statements never become applied product facts', () => {
  for (const product of audit.products.filter(row => row.sellerConfirmationRequired)) {
    assert.equal(product.status, 'NEEDS_SELLER_CONFIRMATION');
    assert.equal(product.chosenModel, null);
    assert.deepEqual(product.changedFields, []);
    assert.equal(product.application, 'UNCHANGED');
    for (const key of quantities) assert.equal(product.new[key], product.old[key]);
    assert.equal(product.new.saleModel, null);
    assert.equal(product.packWeightGrams, null);
  }
  assert.equal(database.filter(product => product.sellerConfirmationRequired).length, 139);
  assert.equal(new Set(audit.products.filter(product => product.recommendedModel === 'WHOLE_VARIABLE_WEIGHT').map(product => product.actualProductSlug ?? product.slug)).size, 23);
});
check('Every evidence reference resolves to a dated source', () => {
  assert.equal(sources.checkedOn, audit.summary.checkedOn);
  for (const product of audit.products) {
    assert.equal(product.checkedOn, sources.checkedOn);
    assert.ok(product.confidence);
    for (const [index, id] of product.evidenceIds.entries()) assert.equal(product.sourceUrls[index], sources.sources.find(source => source.id === id)?.url);
  }
});
check('The only database plan is an exact count-preserving pack correction', () => {
  assert.equal(plan.localOnly, true);
  assert.equal(plan.patches.length, 34);
  assert.equal(new Set(plan.patches.map(patch => patch.productId)).size, 34);
  for (const patch of plan.patches) {
    assert.equal(patch.status, 'CONFIRMED');
    assert.equal(patch.before.unit, 'PIECE');
    assert.equal(patch.after.unit, 'PACK');
    assert.equal(patch.after.saleModel, 'PACK');
    assert.equal(patch.after.priceUnit, 'PACK');
    assert.ok(sources.sources.find(source => source.id === 'cezoni').verifiedSkus.some(sku => sku.slug === patch.slug && sku.name === patch.name));
    assert.equal(patch.before.priceQty, 1);
    for (const key of quantities.filter(key => key !== 'unit')) assert.equal(patch.before[key], patch.after[key]);
  }
});
check('Applied IDs and fields match the plan; repeated dry-run is empty', () => {
  assert.equal(applied.localOnly, true);
  assert.equal(applied.changed, 34);
  assert.deepEqual(applied.changes.filter(row => row.action === 'APPLIED').map(row => row.productId).sort((a, b) => a - b), plan.patches.map(patch => patch.productId).sort((a, b) => a - b));
  assert.ok(applied.changes.every(row => Object.keys(row.fields).every(key => ['unit', 'saleModel', 'priceUnit'].includes(key))));
  assert.equal(dryRun.changed, 0);
  assert.equal(dryRun.skipped, 0);
  assert.equal(dryRun.unchanged, 34);
  assert.equal(audit.summary.appliedDatabaseChanges, 34);
  assert.equal(audit.summary.appliedSourceChanges, 34);
});
check('All protected database columns and legacy orders match the backup', () => {
  assert.equal(verification.passed, true);
  assert.equal(verification.checks.length, 10);
  assert.ok(verification.checks.every(row => row.preserved && row.beforeHash === row.afterHash && row.beforeCount === row.afterCount));
  assert.equal(verification.unitChecks.filter(row => row.applied).length, 34);
});
for (const [file, expected] of Object.entries(audit.fileChecksums)) {
  const actual = createHash('sha256').update(await readFile(new URL(file, root))).digest('hex');
  check(`Source checksum: ${file}`, () => {
    assert.equal(actual, expected);
  });
}
const result = { checkedAt: new Date().toISOString(), passed: true, databaseProducts: database.length, active: audit.summary.databaseActive, inactive: audit.summary.databaseInactive, catalogSourceRows: audit.products.length, uniqueCatalogCandidates: audit.summary.uniqueCatalogCandidates, researchOffers: audit.researchProducts.length, productionInventoryCompleted: false, checks };
await writeFile(new URL('catalog-check.json', directory), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, checks: checks.length }, null, 2));
