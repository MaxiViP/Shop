// Runs against a disposable PostgreSQL schema, never the shop's existing data.
// Run after pnpm build: pnpm --filter api exec node test/admin.smoke.mjs
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import pg from 'pg';
import sharp from 'sharp';
import { PrismaPg } from '@prisma/adapter-pg';
import { Test } from '@nestjs/testing';
import { StandardSchemaValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';

const schema = `admin_smoke_${randomUUID().replaceAll('-', '')}`;
assert.match(schema, /^admin_smoke_[a-f0-9]{32}$/);
const directory = await mkdtemp(join(tmpdir(), 'shop-admin-smoke-'));
process.env.NODE_ENV = 'development';
process.env.ADMIN_PHONE = '+79990000001';
process.env.ADMIN_PASSWORD = randomBytes(32).toString('hex');
process.env.AUTH_SECRET = randomBytes(32).toString('hex');
process.env.UPLOAD_DIR = directory;
const connection = new pg.Client({
  connectionString: process.env.DATABASE_URL,
});
let db, app, frontend;
let created = false;
try {
  await connection.connect();
  await connection.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await connection.query(`SET search_path TO "${schema}"`);
  const migrations = resolve('prisma/migrations');
  for (const entry of (await readdir(migrations, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '20260907120000_image_visibility') {
      await connection.query(`
        INSERT INTO "Category" (id, name, slug, "updatedAt") VALUES (-1, 'Migration fixture', 'migration-fixture', NOW());
        INSERT INTO "Product" (id, name, slug, price, unit, "categoryId", "updatedAt") VALUES (-1, 'Migration fixture', 'migration-fixture', 100, 'PIECE', -1, NOW());
        INSERT INTO "ProductImage" (id, url, "productId") VALUES (-1, '/old-image', -1);
      `);
    }
    await connection.query(
      await readFile(join(migrations, entry.name, 'migration.sql'), 'utf8'),
    );
    if (entry.name === '20260907120000_image_visibility') {
      const old = await connection.query(
        'SELECT visible FROM "ProductImage" WHERE id = -1',
      );
      assert.equal(old.rows[0].visible, true);
      await connection.query(
        'DELETE FROM "Product" WHERE id = -1; DELETE FROM "Category" WHERE id = -1',
      );
      console.log('PASS migration preserves existing images with visible=true');
    }
  }
  const { PrismaClient } = await import('../dist/db/gen/client.js');
  db = new PrismaClient({
    adapter: new PrismaPg(
      {
        connectionString: process.env.DATABASE_URL,
        options: `-c search_path=${schema}`,
      },
      { schema },
    ),
  });
  const { DbService } = await import('../dist/db/db.service.js');
  const { AppModule } = await import('../dist/app.module.js');
  const { allowedOrigin } = await import('../dist/auth/admin.config.js');
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DbService)
    .useValue(db)
    .compile();
  app = module.createNestApplication({ logger: ['error'] });
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
  app.useStaticAssets(directory, { prefix: '/uploads/products/' });
  app.enableCors({
    origin: (origin, callback) =>
      callback(null, !origin || allowedOrigin(origin)),
    credentials: true,
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  let cookie = '';
  async function api(
    path,
    method = 'GET',
    body,
    expected = 200,
    session = cookie,
  ) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(session ? { Cookie: session } : {}),
        ...(body && !(body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
      },
      ...(method !== 'GET' && body
        ? { body: body instanceof FormData ? body : JSON.stringify(body) }
        : {}),
    });
    const data = await response.json();
    assert.equal(
      response.status,
      expected,
      `${method} ${path}: ${JSON.stringify(data)}`,
    );
    return { data, response };
  }
  assert.deepEqual(
    (await api('/auth/method', 'POST', { phone: process.env.ADMIN_PHONE }, 201))
      .data,
    { method: 'PASSWORD' },
  );
  const login = await api(
    '/auth/admin/login',
    'POST',
    { phone: process.env.ADMIN_PHONE, password: process.env.ADMIN_PASSWORD },
    201,
  );
  cookie = login.response.headers.getSetCookie()[0].split(';')[0];
  assert.equal(login.data.role, 'ADMIN');
  assert.equal((await api('/auth/me')).data.role, 'ADMIN');
  await api(
    '/auth/login',
    'POST',
    { phone: process.env.ADMIN_PHONE, code: '123456' },
    401,
  );
  console.log('PASS admin login, ordinary Session, admin OTP blocked');
  const category = (
    await api(
      '/admin/categories',
      'POST',
      {
        name: 'Smoke фрукты',
        slug: 'smoke-fruits',
        active: true,
        sort: 0,
        parentId: null,
      },
      201,
    )
  ).data;
  const product = (
    await api(
      '/admin/products',
      'POST',
      {
        name: 'Smoke яблоки',
        slug: 'smoke-apples',
        description: 'Описание smoke-товара отдельным блоком.',
        price: 19950,
        priceQty: 1000,
        unit: 'GRAM',
        min: 500,
        step: 100,
        active: true,
        sort: 0,
        categoryId: category.id,
      },
      201,
    )
  ).data;
  const buffer = await sharp({
    create: { width: 8, height: 8, channels: 3, background: 'green' },
  })
    .png()
    .toBuffer();
  const body = new FormData();
  body.append('file', new Blob([buffer], { type: 'image/png' }), 'test.png');
  const image = (
    await api(`/admin/products/${product.id}/images`, 'POST', body, 201)
  ).data;
  assert.equal((await fetch(`${base}${image.url}`)).status, 200);
  const temporaryBody = new FormData();
  temporaryBody.append(
    'file',
    new Blob([buffer], { type: 'image/png' }),
    'second.png',
  );
  const temporaryImage = (
    await api(
      `/admin/products/${product.id}/images`,
      'POST',
      temporaryBody,
      201,
    )
  ).data;
  const thirdBody = new FormData();
  thirdBody.append(
    'file',
    new Blob([buffer], { type: 'image/png' }),
    'third.png',
  );
  const third = (
    await api(`/admin/products/${product.id}/images`, 'POST', thirdBody, 201)
  ).data;
  const imagePath = `/admin/products/${product.id}/images`;
  await api(`${imagePath}/${image.id}`, 'PATCH', { visible: false }, 409);
  await api(`${imagePath}/${third.id}`, 'PATCH', { visible: false });
  await api(`${imagePath}/${third.id}/primary`, 'POST', undefined, 201);
  assert.equal(
    (await api(`/admin/products/${product.id}`)).data.images[0].visible,
    true,
  );
  await api(
    `${imagePath}/${temporaryImage.id}/primary`,
    'POST',
    undefined,
    201,
  );
  await api(`${imagePath}/${third.id}`, 'PATCH', { visible: false });
  await api(`${imagePath}/${third.id}`, 'PATCH', { visible: true });
  await api(`${imagePath}/${third.id}`, 'PATCH', { visible: false });
  await api(
    `/admin/products/${product.id + 999}/images/${image.id}/primary`,
    'POST',
    undefined,
    404,
  );
  const savedImages = (await api(`/admin/products/${product.id}`)).data.images;
  assert.deepEqual(
    savedImages.map((item) => [item.id, item.sort, item.visible]),
    [
      [temporaryImage.id, 0, true],
      [third.id, 1, false],
      [image.id, 2, true],
    ],
  );
  const publicImages = (await api(`/products/${product.slug}`)).data.images;
  assert.deepEqual(
    publicImages.map((item) => item.url),
    [temporaryImage.url, image.url],
  );
  const publicList = (await api('/products')).data;
  assert.equal(publicList.items[0].images[0].url, temporaryImage.url);
  assert.equal(JSON.stringify(publicList).includes(third.url), false);
  console.log(
    'PASS three uploads, primary transaction/order, visibility restore, admin reload, hidden-image exclusion and public main image',
  );
  const cors = await fetch(`${base}/api/admin/products`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://127.0.0.1:3003',
      'Access-Control-Request-Method': 'GET',
    },
  });
  assert.equal(
    cors.headers.get('access-control-allow-origin'),
    'http://127.0.0.1:3003',
  );
  await api(`/admin/products/${product.id}/images/${image.id}`, 'PATCH', {
    alt: 'Тестовые яблоки',
    sort: 2,
  });
  await api(`/admin/products/${product.id}`, 'PATCH', {
    name: 'Smoke яблоки обновлены',
    price: 14900,
  });
  await api(`/admin/categories/${category.id}`, 'DELETE', undefined, 409);
  await api(`/admin/categories/${category.id}`, 'PATCH', {
    name: 'Smoke категория обновлена',
  });
  console.log(
    'PASS category selection, create, upload, static image, edit, image metadata, unsafe category delete',
  );
  assert.deepEqual(
    (await api('/auth/method', 'POST', { phone: '+79990000002' }, 201)).data,
    { method: 'OTP' },
  );
  const otp = (await api('/auth/code', 'POST', { phone: '+79990000002' }, 201))
    .data;
  const shopper = await api(
    '/auth/login',
    'POST',
    { phone: '+79990000002', code: otp.devCode },
    201,
  );
  const userCookie = shopper.response.headers.getSetCookie()[0].split(';')[0];
  await api('/admin/products', 'GET', undefined, 403, userCookie);
  await api(`/admin/users/${shopper.data.id}/role`, 'PATCH', {
    role: 'SELLER',
  });
  assert.deepEqual(
    (await api('/auth/method', 'POST', { phone: shopper.data.phone }, 201))
      .data,
    { method: 'OTP' },
  );
  const sellerCode = (
    await api('/auth/code', 'POST', { phone: shopper.data.phone }, 201)
  ).data;
  const sellerLogin = await api(
    '/auth/login',
    'POST',
    { phone: shopper.data.phone, code: sellerCode.devCode },
    201,
  );
  assert.equal(sellerLogin.data.role, 'SELLER');
  console.log(
    'PASS method PASSWORD → admin session; method OTP → USER and SELLER OTP login',
  );
  assert.equal(
    (await api('/auth/me', 'GET', undefined, 200, userCookie)).data.role,
    'SELLER',
  );
  await api('/staff/orders', 'GET', undefined, 200, userCookie);
  await api('/admin/products', 'GET', undefined, 403, userCookie);
  await api(`/admin/users/${shopper.data.id}/role`, 'PATCH', { role: 'USER' });
  await api(
    `/admin/users/${shopper.data.id}/role`,
    'PATCH',
    { role: 'ADMIN' },
    400,
  );
  await api(
    `/admin/users/${login.data.id}/role`,
    'PATCH',
    { role: 'USER' },
    403,
  );
  await api('/staff/orders', 'GET', undefined, 403, userCookie);
  console.log(
    'PASS USER / SELLER admin 403, USER ↔ SELLER, current staff rights, ADMIN promotion/demotion blocked',
  );
  const order = await db.order.create({
    data: {
      type: 'PICKUP',
      status: 'COMPLETED',
      customerName: 'Smoke',
      customerPhone: shopper.data.phone,
      userId: shopper.data.id,
      subtotal: 19950,
      deliveryPrice: 0,
      total: 19950,
      finalTotal: 14900,
      items: {
        create: {
          productId: product.id,
          productName: product.name,
          productSlug: product.slug,
          image: image.url,
          price: 19950,
          priceQty: 1000,
          unit: 'GRAM',
          qty: 1000,
          total: 19950,
        },
      },
    },
  });
  const users = (await api('/admin/users')).data;
  assert.equal(
    users.items.find((user) => user.id === shopper.data.id).spent,
    14900,
  );
  const details = (await api(`/admin/users/${shopper.data.id}`)).data;
  assert.equal(details.stats.completed, 1);
  assert.equal(JSON.stringify(details).includes('tokenHash'), false);
  console.log(
    'PASS real PostgreSQL user list, details, completed-order stats, no auth hashes',
  );
  const webRoot = resolve('../web');
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const webPort = String(probe.address().port);
  await new Promise((resolve) => probe.close(resolve));
  const webBase = `http://127.0.0.1:${webPort}`;
  frontend = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: webRoot,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: webPort,
      HOST: '127.0.0.1',
      NITRO_PORT: webPort,
      NITRO_HOST: '127.0.0.1',
      NUXT_PUBLIC_API_BASE: `${base}/api`,
    },
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await fetch(`${webBase}/admin/login`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  for (const path of [
    '/admin/products',
    `/admin/products/${product.id}`,
    '/admin/products/new',
    '/admin/users',
  ]) {
    const response = await fetch(`${webBase}${path}`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(response.status, 200, `SSR ${path}`);
    const html = await response.text();
    assert.ok(html.includes('Админка'));
    assert.equal(html.includes('Internal Server Error'), false);
  }
  const redirect = await fetch(`${webBase}/admin/login`, {
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  assert.equal(redirect.status, 302);
  const denied = await fetch(`${webBase}/admin/products`, {
    headers: { Cookie: userCookie },
    redirect: 'manual',
  });
  assert.equal(denied.status, 302);
  console.log(
    'PASS authenticated Nuxt SSR products, edit, create, users; login and USER redirects',
  );
  const productHtml = await (
    await fetch(`${webBase}/product/${product.slug}`)
  ).text();
  assert.ok(productHtml.includes('gallery__rail'));
  assert.ok(productHtml.includes('Показать фото 2'));
  assert.ok(productHtml.includes('product__description'));
  assert.ok(productHtml.includes('bottom-search'));
  assert.equal(productHtml.includes(third.url), false);
  for (const path of ['/admin/products', '/cart', '/checkout']) {
    const html = await (
      await fetch(`${webBase}${path}`, { headers: { Cookie: cookie } })
    ).text();
    assert.equal(html.includes('class="bottom-search"'), false, path);
  }
  await api(`${imagePath}/${temporaryImage.id}`, 'DELETE');
  assert.equal((await fetch(`${base}${temporaryImage.url}`)).status, 404);
  assert.equal((await api(`/products/${product.slug}`)).data.images.length, 1);
  await api(`${imagePath}/${image.id}`, 'DELETE');
  assert.deepEqual((await api(`/products/${product.slug}`)).data.images, []);
  const emptyHtml = await (
    await fetch(`${webBase}/product/${product.slug}`)
  ).text();
  assert.ok(emptyHtml.includes('gallery__empty'));
  assert.equal(emptyHtml.includes('class="gallery__rail"'), false);
  console.log(
    'PASS storefront SSR gallery/description/search; operational pages without search; one/no visible images and managed file removal',
  );
  await api(`/admin/products/${product.id}`, 'PATCH', { active: false });
  assert.equal(
    (await api('/admin/products?active=false')).data.items.length,
    1,
  );
  await api(`/products/${product.slug}`, 'GET', undefined, 404);
  await api(`/admin/products/${product.id}`, 'DELETE');
  const snapshot = await db.orderItem.findFirst({
    where: { orderId: order.id },
  });
  assert.equal(snapshot.productId, null);
  assert.equal(snapshot.productName, product.name);
  assert.equal((await fetch(`${base}${image.url}`)).status, 200);
  await api(`/admin/categories/${category.id}`, 'DELETE');
  console.log(
    'PASS hide, permanent delete, OrderItem SetNull and historical photo preservation',
  );
} finally {
  if (frontend && frontend.exitCode === null) {
    const done = new Promise((resolve) => frontend.once('exit', resolve));
    frontend.kill();
    await done;
  }
  if (app) await app.close();
  if (db) await db.$disconnect();
  if (created) {
    await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
    console.log('CLEANUP disposable schema and test records removed');
  }
  await connection.end();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  assert.ok(
    rel && !rel.startsWith('..') && directory.includes('shop-admin-smoke-'),
  );
  await rm(directory, { recursive: true });
  console.log('CLEANUP temporary images and smoke servers removed');
}
