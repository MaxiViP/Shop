// Preparation only. Default --plan never imports an application or opens a DB.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const mode = process.argv[2] ?? '--plan';
assert.equal(process.argv.length <= 3, true);
assert.ok(['--plan', '--close', '--signal'].includes(mode));
const directory = '/run/korzina-db-fixture';
if (mode === '--plan') {
  console.log(JSON.stringify({ status: 'PREPARED_NOT_RUN', fixtureOnly: true,
    transport: 'private Unix socket, no TCP', database: 'korzina_pool_fixture',
    sql: ['SELECT 1', 'SELECT pg_backend_pid()', 'SELECT count(*) FROM pg_stat_activity WHERE pid = $1'],
    migrations: false, schemaChanges: false, productionApply: 'SANDBOX_UNVERIFIED' }));
} else {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), 55000);
  if (mode === '--signal') assert.equal(process.pid, 1);
  for (const name of Object.keys(process.env)) {
    assert.equal(name === 'DATABASE_URL' || name.startsWith('PG') || name.startsWith('DOTENV_') ||
      ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(name), false,
      'inherited DB/loader configuration refused: ' + name);
  }
  assert.equal(readFileSync(directory + '/owned', 'utf8'), 'korzina-db-pool-disposable-v1\n');
  const owner = lstatSync(directory);
  assert.equal(owner.uid, process.getuid());
  assert.equal(owner.mode & 0o777, 0o700);
  assert.equal(owner.isSymbolicLink(), false);
  assert.equal(lstatSync(directory + '/.s.PGSQL.5432').isSocket(), true);
  const api = '/artifact/apps/api';
  assert.equal(existsSync(api + '/.env'), false);
  assert.equal(existsSync('/artifact/.env'), false);
  process.chdir(api);
  const require = createRequire(api + '/package.json');
  const pg = require('pg');
  const connectionString = 'postgresql://fixture@localhost/korzina_pool_fixture?host=%2Frun%2Fkorzina-db-fixture&application_name=korzina_pool_subject';
  const parameters = new pg.Client({ connectionString }).connectionParameters;
  assert.equal(parameters.host, directory);
  assert.equal(parameters.database, 'korzina_pool_fixture');
  process.env.DATABASE_URL = connectionString;
  const pools = new Set();
  const ended = new Set();
  const connect = pg.Pool.prototype.connect;
  const end = pg.Pool.prototype.end;
  pg.Pool.prototype.connect = function (...args) {
    pools.add(this);
    return Reflect.apply(connect, this, args);
  };
  pg.Pool.prototype.end = function (...args) {
    ended.add(this);
    return Reflect.apply(end, this, args);
  };
  // No DbService/adapter replacement: these are the actual compiled classes.
  const { DbService } = await import(api + '/dist/db/db.service.js');
  const { Module } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  let db;
  let backend;
  class Observer {
    async onApplicationShutdown(signal) {
      const snapshot = [...pools].map(pool => ({ total: pool.totalCount, idle: pool.idleCount,
        waiting: pool.waitingCount, endCalled: ended.has(pool) }));
      const productHookEndedPool = snapshot.length === 1 && snapshot.every(pool =>
        pool.endCalled && pool.total === 0 && pool.waiting === 0);
      console.log('DB_POOL_BEFORE_FIXTURE_CLEANUP=' + JSON.stringify({ signal: signal ?? 'close',
        productHookEndedPool, pools: snapshot }));
      // Cleanup is recorded separately; it must never turn a missing product hook green.
      await db.$disconnect();
      const observer = new pg.Client({ host: directory, port: 5432, user: 'fixture',
        database: 'korzina_pool_fixture', application_name: 'korzina_pool_observer' });
      try {
        await observer.connect();
        const remaining = await observer.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = $1', [backend]);
        assert.equal(remaining.rows[0].count, 0);
        console.log('DB_POOL_RESULT=' + JSON.stringify({
          status: productHookEndedPool ? 'PASSED' : 'FAILED: DB_LIFECYCLE_HOOK_MISSING',
          productHookEndedPool, manualFixtureCleanupClosedBackend: true,
          productionApply: 'SANDBOX_UNVERIFIED' }));
        if (!productHookEndedPool) process.exitCode = 1;
      } finally {
        await observer.end();
      }
    }
  }
  class FixtureModule {}
  Module({ providers: [DbService, Observer] })(FixtureModule);
  const app = await NestFactory.createApplicationContext(FixtureModule, { logger: false });
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  db = app.get(DbService);
  try {
    const rows = await db.$queryRawUnsafe("SELECT 1 AS ok, pg_backend_pid() AS pid, current_database() AS db, current_setting('default_transaction_read_only') AS readonly, inet_server_addr() AS address");
    assert.equal(rows[0].ok, 1);
    assert.equal(rows[0].db, 'korzina_pool_fixture');
    assert.equal(rows[0].readonly, 'on');
    assert.equal(rows[0].address, null);
    backend = rows[0].pid;
    console.log('DB_POOL_READY=' + JSON.stringify({ realDbService: true, realAdapter: true,
      transport: 'private Unix socket', mode, productionApply: 'SANDBOX_UNVERIFIED' }));
    if (mode === '--close') await app.close();
  } catch (error) {
    await db.$disconnect();
    throw error;
  }
}
