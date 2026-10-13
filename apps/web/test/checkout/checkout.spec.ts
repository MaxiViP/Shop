import { test as base, expect, type Page, type APIRequestContext, type Route } from '@playwright/test';

type Order = {
  publicId: string;
  checkoutRequestId: string;
  customerName: string;
  type: 'DELIVERY' | 'PICKUP';
  fulfillmentMode: 'ASAP' | 'SCHEDULED';
  scheduledFor: string | null;
  userId: number | null;
  guestSessionId: string | null;
  subtotal: number;
  total: number | null;
  deliveryPrice: number | null;
  city: string | null;
  items: { qty: number; price: number; total: number }[];
};
type State = { orders: Order[]; carts: { items: { qty: number }[] }[] };
type Shop = {
  control: (path: string, data?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  state: () => Promise<State>;
};
const apiBase = process.env.E2E_API_BASE ?? '';
const webBase = process.env.E2E_WEB_BASE ?? '';
const controlToken = process.env.E2E_CONTROL_TOKEN ?? '';
const phone = '+79990000001'; // Synthetic fixture; no SMS provider is loaded.
const checkoutPath = (user: boolean) => user ? '/cart/checkout' : '/orders';
const submit = (page: Page) => page.locator('.summary__submit button');
const cartItems = (page: Page) => page.locator('.cart-items article');
const customerOrders = (state: State) => state.orders.filter(order => order.customerName === 'E2E покупатель');

const test = base.extend<{ shop: Shop }>({
  shop: async ({ page, context }, use, testInfo) => {
    expect(new URL(apiBase).hostname).toBe('127.0.0.1');
    expect(new URL(webBase).hostname).toBe('127.0.0.1');
    expect(controlToken).toMatch(/^[a-f0-9]{64}$/);
    const log: string[] = [];
    const errors: string[] = [];
    page.on('console', message => log.push('console ' + message.type() + ' ' + message.text()));
    page.on('pageerror', error => { errors.push(error.message); log.push('pageerror ' + error.message); });
    page.on('response', response => log.push(response.status() + ' ' + new URL(response.url()).pathname));
    page.on('requestfailed', request => log.push('failed ' + new URL(request.url()).pathname + ' ' + request.failure()?.errorText));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (['data:', 'blob:', 'about:'].includes(url.protocol) || url.origin === new URL(apiBase).origin || url.origin === new URL(webBase).origin)
        await route.continue();
      else {
        log.push('blocked outbound ' + url.origin);
        await route.abort('blockedbyclient');
      }
    });
    const control = async (path: string, data?: Record<string, unknown>) => {
      const url = new URL('/__test' + path, apiBase).href;
      const response = data === undefined
        ? await context.request.get(url, { headers: { 'x-e2e-token': controlToken } })
        : await context.request.post(url, { headers: { 'x-e2e-token': controlToken }, data });
      expect(response.ok(), 'test control ' + path).toBeTruthy();
      return await response.json() as Record<string, unknown>;
    };
    await control('/reset', {});
    try {
      await use({ control, state: async () => await control('/state') as unknown as State });
      expect(errors, 'No uncaught browser exceptions').toEqual([]);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('browser-log', { body: log.join('\n'), contentType: 'text/plain' });
        await testInfo.attach('page', { body: await page.content().catch(() => 'Page unavailable'), contentType: 'text/html' });
        const state = await control('/state').catch(() => ({ unavailable: true }));
        await testInfo.attach('database-state', { body: JSON.stringify(state, null, 2), contentType: 'application/json' });
      }
    }
  },
});

async function login(request: APIRequestContext) {
  const response = await request.post(apiBase + '/auth/code', { data: { phone } });
  expect(response.ok()).toBeTruthy();
  const { devCode } = await response.json() as { devCode: string };
  expect(devCode).toMatch(/^\d{6}$/);
  const authenticated = await request.post(apiBase + '/auth/login', { data: { phone, code: devCode } });
  expect(authenticated.ok()).toBeTruthy();
}

async function fill(page: Page, type: 'DELIVERY' | 'PICKUP') {
  await page.locator('.type__item').filter({ hasText: type === 'DELIVERY' ? 'Доставка' : 'Самовывоз' }).click();
  await page.locator('input[autocomplete="name"]').fill('E2E покупатель');
  await page.locator('input[autocomplete="tel"]').fill(phone);
  if (type === 'DELIVERY') {
    await page.locator('[data-checkout-field="city"] input').fill('Москва');
    await page.locator('[data-checkout-field="street"] input').fill('E2E тестовая улица');
    await page.locator('[data-checkout-field="house"] input').fill('1');
  }
}

async function basket(page: Page, user: boolean, type: 'DELIVERY' | 'PICKUP') {
  if (user) await login(page.context().request);
  await page.goto('/catalog');
  const card = page.locator('article.card').filter({ hasText: 'E2E яблоки' });
  await expect(card.locator('.card__add')).toBeEnabled();
  await card.locator('.card__add').click();
  await expect(card.locator('.card__portion').first()).toBeVisible();
  await page.goto('/cart');
  await expect(cartItems(page)).toHaveCount(1);
  await expect(submit(page)).toBeEnabled();
  await fill(page, type);
  // Close to midnight, even an all-day calendar may require a next-day slot.
  // Explicitly choose a real server-provided slot if the market cannot prepare now.
  const slot = page.locator('.queue-offer__select');
  if (await slot.isVisible()) {
    const first = await slot.locator('option[value]:not([value=""])').first().getAttribute('value');
    expect(first).toBeTruthy();
    await slot.selectOption(first!);
  }
}

async function retained(page: Page, shop: Shop, user: boolean, expectedOrders = 0) {
  await expect(page).toHaveURL(/\/cart$/);
  await expect(cartItems(page)).toHaveCount(1);
  const state = await shop.state();
  expect(customerOrders(state)).toHaveLength(expectedOrders);
  if (user) expect(state.carts[0]?.items).toHaveLength(1);
  else expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cart') ?? '{}').items?.length)).toBe(1);
}

async function saved(page: Page, shop: Shop, user: boolean, type: 'DELIVERY' | 'PICKUP', subtotal = 11000) {
  await expect(page).toHaveURL(/\/order\/[a-f0-9-]{36}$/);
  const orders = customerOrders(await shop.state());
  expect(orders).toHaveLength(1);
  const order = orders[0]!;
  expect(page.url()).toContain(order.publicId);
  expect(order.type).toBe(type);
  expect(order.subtotal).toBe(subtotal);
  expect(order.items).toHaveLength(1);
  expect(order.items[0]).toMatchObject({ qty: 1000, price: subtotal, total: subtotal });
  // Delivery fixture qualifies for backend-calculated free delivery.
  expect(order.deliveryPrice).toBe(0);
  expect(order.total).toBe(subtotal);
  expect(user ? order.userId : order.guestSessionId).toBeTruthy();
  if (!user) expect(order.userId).toBeNull();
  expect(order.city).toBe(type === 'DELIVERY' ? 'Москва' : null);
  const cookie = (await page.context().cookies()).find(item => item.name === (user ? 'sid' : 'gid'));
  expect(cookie?.httpOnly).toBe(true);
  if (user) expect((await shop.state()).carts[0]?.items).toHaveLength(0);
  await page.goto('/cart');
  await expect(page.getByRole('heading', { name: 'Корзина пустая' })).toBeVisible();
  if (!user) expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cart') ?? '{}').items?.length ?? 0)).toBe(0);
  return order;
}

// Each mutation happens after the frontend's last refresh, before the real API POST.
async function interceptOnce(page: Page, user: boolean, handler: (route: Route) => Promise<void>) {
  const pattern = apiBase + checkoutPath(user);
  let intercepted = false;
  const callback = async (route: Route) => {
    if (route.request().method() !== 'POST' || intercepted) { await route.fallback(); return; }
    intercepted = true;
    await handler(route);
  };
  await page.route(pattern, callback);
}

for (const user of [false, true]) {
  test.describe(user ? 'authenticated OTP customer' : 'guest customer', () => {
    for (const type of ['DELIVERY', 'PICKUP'] as const) {
      for (const preorder of [false, true]) {
        test(`${type} ${preorder ? 'preorder' : 'checkout'} uses server totals and empties cart`, async ({ page, shop }) => {
          if (preorder) await shop.control('/reset', { preorder: true });
          await basket(page, user, type);
          let payload: Record<string, unknown> = {};
          await interceptOnce(page, user, async route => {
            payload = route.request().postDataJSON() as Record<string, unknown>;
            // Deliberately spoof client amounts. The real schema/service must ignore them.
            const items = Array.isArray(payload.items)
              ? payload.items.map((item: Record<string, unknown>) => ({ ...item, price: 1, total: 1 })) : undefined;
            await route.continue({ postData: JSON.stringify({ ...payload, subtotal: 1, total: 1, deliveryPrice: 999999,
              ...(items ? { items } : {}) }) });
          });
          await submit(page).click();
          const order = await saved(page, shop, user, type);
          expect(payload).not.toHaveProperty('subtotal');
          expect(payload).not.toHaveProperty('total');
          expect(payload).not.toHaveProperty('deliveryPrice');
          if (preorder) {
            expect(order.fulfillmentMode).toBe('SCHEDULED');
            expect(order.scheduledFor).toBe(payload.scheduledFor);
          }
          // Concurrent HTTP replays of the actual browser request must return the same order.
          const replay = await Promise.all([0, 1].map(() => page.context().request.post(apiBase + checkoutPath(user), { data: payload })));
          for (const response of replay) {
            expect(response.ok()).toBeTruthy();
            const body = await response.json() as { publicId?: string; order?: { publicId: string } };
            expect(user ? body.order?.publicId : body.publicId).toBe(order.publicId);
          }
          expect(customerOrders(await shop.state())).toHaveLength(1);
        });
      }
    }

    test('price changes after final refresh: reject stale quote, retain cart, deliberate retry at new server price', async ({ page, shop }) => {
      await basket(page, user, 'PICKUP');
      await interceptOnce(page, user, async route => {
        await shop.control('/product', { price: 20000 });
        await route.continue();
      });
      const failed = page.waitForResponse(response => response.url() === apiBase + checkoutPath(user) && response.status() === 409);
      await submit(page).click();
      expect((await (await failed).json() as { code: string }).code).toBe('CART_CHANGED');
      await expect(page.getByText('Корзина изменилась. Проверьте актуальные товары и сумму.', { exact: true })).toBeVisible();
      await retained(page, shop, user);
      await expect(submit(page)).toBeEnabled();
      await submit(page).click();
      await saved(page, shop, user, 'PICKUP', 22000);
    });

    test('unavailable product blocks checkout without clearing the basket', async ({ page, shop }) => {
      await basket(page, user, 'PICKUP');
      await interceptOnce(page, user, async route => {
        await shop.control('/product', { active: false });
        await route.continue();
      });
      const failed = page.waitForResponse(response => response.url() === apiBase + checkoutPath(user) && response.status() === 409);
      await submit(page).click();
      await failed;
      await expect(submit(page)).toBeDisabled();
      await retained(page, shop, user);
      await page.reload();
      await expect(cartItems(page)).toHaveCount(1);
      await expect(submit(page)).toBeDisabled();
      expect(customerOrders(await shop.state())).toHaveLength(0);
    });

    test('slot occupied after final refresh: reject, keep basket, select another real slot', async ({ page, shop }) => {
      await shop.control('/reset', { preorder: true });
      await basket(page, user, 'PICKUP');
      const slot = page.locator('.queue-offer__select');
      await expect(slot).toBeVisible();
      const occupied = await slot.inputValue();
      expect(occupied).toBeTruthy();
      await interceptOnce(page, user, async route => {
        await shop.control('/occupy', { at: occupied });
        await route.continue();
      });
      const failed = page.waitForResponse(response => response.url() === apiBase + checkoutPath(user) && response.status() === 409);
      await submit(page).click();
      await failed;
      await expect(page.getByText('Это время уже занято. Выберите другое.', { exact: true })).toBeVisible();
      await retained(page, shop, user);
      await expect(slot.locator(`option[value="${occupied}"]`)).toHaveCount(0);
      const alternative = await slot.locator('option[value]:not([value=""])').first().getAttribute('value');
      expect(alternative).not.toBe(occupied);
      await slot.selectOption(alternative!);
      await submit(page).click();
      const order = await saved(page, shop, user, 'PICKUP');
      expect(order.scheduledFor).toBe(alternative);
    });

    test('API 500 preserves cart; deliberate retry uses the same request ID and creates one order', async ({ page, shop }) => {
      await basket(page, user, 'DELIVERY');
      let firstId: unknown;
      const requests: Record<string, unknown>[] = [];
      page.on('request', request => {
        if (request.url() === apiBase + checkoutPath(user) && request.method() === 'POST')
          requests.push(request.postDataJSON() as Record<string, unknown>);
      });
      await interceptOnce(page, user, async route => {
        firstId = (route.request().postDataJSON() as Record<string, unknown>).checkoutRequestId;
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'E2E API failure' }) });
      });
      await submit(page).click();
      await expect(page.getByText('E2E API failure', { exact: true })).toBeVisible();
      await retained(page, shop, user);
      expect(requests).toHaveLength(1); // No automatic POST retry.
      await expect(submit(page)).toBeEnabled();
      await submit(page).click();
      const order = await saved(page, shop, user, 'DELIVERY');
      expect(requests).toHaveLength(2);
      expect(requests[1]?.checkoutRequestId).toBe(firstId);
      expect(order.checkoutRequestId).toBe(firstId);
    });

    test('lost response after commit: replay resolves the same order without duplication', async ({ page, shop }) => {
      await basket(page, user, 'PICKUP');
      let payload: Record<string, unknown> = {};
      await interceptOnce(page, user, async route => {
        payload = route.request().postDataJSON() as Record<string, unknown>;
        const committed = await route.fetch();
        expect(committed.ok()).toBeTruthy();
        await route.abort('failed');
      });
      await submit(page).click();
      await expect.poll(async () => customerOrders(await shop.state()).length).toBe(1);
      // Authenticated cart is atomically emptied on commit, even if the response is lost.
      // Retry via the real API, retaining session and request ID; do not invent a UI recovery.
      const replay = await page.context().request.post(apiBase + checkoutPath(user), { data: payload });
      expect(replay.ok()).toBeTruthy();
      const body = await replay.json() as { publicId?: string; order?: { publicId: string } };
      const publicId = user ? body.order?.publicId : body.publicId;
      expect(customerOrders(await shop.state())).toHaveLength(1);
      if (!user) {
        await retained(page, shop, user, 1);
        await expect(submit(page)).toBeEnabled();
        await submit(page).click();
      } else {
        await expect(page.getByRole('heading', { name: 'Корзина пустая' })).toBeVisible();
        await page.goto('/order/' + publicId);
      }
      const order = await saved(page, shop, user, 'PICKUP');
      expect(order.publicId).toBe(publicId);
      expect(order.checkoutRequestId).toBe(payload.checkoutRequestId);
    });

    test('rapid double click submits once while the first request is pending', async ({ page, shop }) => {
      await basket(page, user, 'PICKUP');
      let posted = 0;
      let release: () => void = () => {};
      const pending = new Promise<void>(resolve => { release = resolve; });
      page.on('request', request => {
        if (request.url() === apiBase + checkoutPath(user) && request.method() === 'POST') posted++;
      });
      await interceptOnce(page, user, async route => { await pending; await route.continue(); });
      try {
        await submit(page).dblclick({ delay: 20 });
        await expect.poll(() => posted).toBe(1);
        await expect(submit(page)).toBeDisabled();
        expect(customerOrders(await shop.state())).toHaveLength(0);
      } finally { release(); }
      await saved(page, shop, user, 'PICKUP');
      expect(posted).toBe(1);
    });

    test('invalid recipient prevents POST and keeps cart', async ({ page, shop }) => {
      await basket(page, user, 'PICKUP');
      await page.locator('input[autocomplete="name"]').fill('');
      await page.locator('input[autocomplete="tel"]').fill('+7 999');
      let posted = 0;
      page.on('request', request => { if (request.url() === apiBase + checkoutPath(user) && request.method() === 'POST') posted++; });
      await submit(page).click();
      await expect(page.getByText('Введите имя', { exact: true })).toBeVisible();
      await expect(page.getByText('Введите корректный номер телефона', { exact: true })).toBeVisible();
      await retained(page, shop, user);
      expect(posted).toBe(0);
    });
  });
}
