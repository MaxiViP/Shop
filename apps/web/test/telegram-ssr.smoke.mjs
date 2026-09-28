// Run after pnpm --filter web build: node apps/web/test/telegram-ssr.smoke.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const body = path === "/api/categories" ? []
    : path === "/api/products" ? { items: [], total: 0, page: 1, limit: 8, pages: 0 }
      : null;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
});
const reservation = createServer();
let child;

try {
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));

  child = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NITRO_HOST: "127.0.0.1",
      NITRO_PORT: String(port),
      NUXT_PUBLIC_API_BASE: "http://127.0.0.1:" + fixture.address().port + "/api",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let startup = "";
  child.stdout.on("data", chunk => { startup += chunk; });
  child.stderr.on("data", chunk => { startup += chunk; });

  const base = "http://127.0.0.1:" + port;
  const deadline = Date.now() + 20_000;
  while (!startup.includes("Listening on") && child.exitCode === null && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null, "Nitro exited before serving the route");
  assert.ok(startup.includes("Listening on"), "Nitro startup timed out");

  async function html(path) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, path + " HTTP status");
    return response.text();
  }

  const order = "/order/11111111-1111-4111-8111-111111111111";
  const telegram = await html("/telegram?returnTo=" + encodeURIComponent(order));
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(telegram)?.[1];
  assert.ok(head, "direct Telegram launch has SSR head");
  const sdk = /<script\b[^>]*src="https:\/\/telegram\.org\/js\/telegram-web-app\.js\?63"[^>]*><\/script>/gi;
  const scripts = [...telegram.matchAll(sdk)];
  assert.equal(scripts.length, 1, "SDK occurs exactly once in initial HTML");
  assert.ok(head.includes(scripts[0][0]), "SDK is in SSR head");
  // Nuxt emits an inert importmap first; the SDK must precede executable app code.
  const executable = [...telegram.matchAll(/<script\b[^>]*>/gi)]
    .map(match => match[0])
    .filter(tag => !/\btype="(?:importmap|application\/json|application\/ld\+json)"/i.test(tag));
  assert.equal(executable[0], scripts[0][0].split("></script>")[0] + ">",
    "SDK precedes every executable application script");
  assert.doesNotMatch(scripts[0][0], /\b(?:async|defer)\b/i, "SDK loads synchronously");

  const home = await html("/");
  assert.doesNotMatch(home, sdk, "normal storefront does not load Telegram SDK");
  console.log("Telegram SSR head: SDK before executable scripts, once, synchronous; storefront unaffected");
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
  if (reservation.listening) await new Promise(resolve => reservation.close(resolve));
  if (fixture.listening) await new Promise(resolve => fixture.close(resolve));
}
