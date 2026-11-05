import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';

type Activity = {
  actorId: number;
  requestId: string;
  source: 'WEB' | 'TELEGRAM';
  role: 'USER' | 'SELLER' | 'ADMIN' | 'GUEST' | 'SYSTEM';
  notifyOwner: boolean;
};
export const adminActivity = new AsyncLocalStorage<Activity>();
export function withAdminActivity<T>(
  actorId: number,
  source: Activity['source'],
  run: () => T | PromiseLike<T>,
  notifyOwner = true,
  role: Activity['role'] = 'ADMIN',
): Promise<T> {
  // Adopt lazy Prisma promises while the actor context is active.
  return adminActivity.run(
    { actorId, source, role, notifyOwner, requestId: randomUUID() },
    async () => await run(),
  );
}
type Adapter = Awaited<ReturnType<PrismaPg['connect']>>;
type Query = Parameters<Adapter['queryRaw']>[0];
function tagged(query: Query): Query {
  const context = adminActivity.getStore();
  if (!context) return query;
  // A query-local comment also works for pooled, nontransactional writes. Values
  // remain parameters; no connection/session setting can leak to another actor.
  return {
    ...query,
    sql: `/*km-admin:${context.actorId}:${context.source}:${context.requestId}:${context.role}:${context.notifyOwner ? 1 : 0}*/\n${query.sql}`,
  };
}
function instrument<T extends Pick<Adapter, 'queryRaw' | 'executeRaw'>>(
  adapter: T,
): T {
  const queryRaw = adapter.queryRaw.bind(adapter),
    executeRaw = adapter.executeRaw.bind(adapter);
  adapter.queryRaw = (query) => queryRaw(tagged(query));
  adapter.executeRaw = (query) => executeRaw(tagged(query));
  return adapter;
}
export class ActivityPrismaPg extends PrismaPg {
  override async connect(): Promise<Adapter> {
    const adapter = instrument(await super.connect());
    const startTransaction = adapter.startTransaction.bind(adapter);
    adapter.startTransaction = async (isolation) =>
      instrument(await startTransaction(isolation));
    return adapter;
  }
}
