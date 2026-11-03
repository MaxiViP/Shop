import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import pg from 'pg';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/db/gen/client.js';
import { DbService } from '../src/db/db.service.js';
import { AuthService, SID } from '../src/auth/auth.service.js';
import { AdminProductsCtrl } from '../src/admin/products.ctrl.js';
import { AdminProductsService } from '../src/admin/products.service.js';
import { SettingsCtrl } from '../src/admin/settings.ctrl.js';
import { SettingsService } from '../src/admin/settings.service.js';
import { OwnerCtrl } from '../src/admin/owner.ctrl.js';
import { ImagesService } from '../src/admin/images.service.js';
import { CartService } from '../src/cart/cart.service.js';
import { OrderService } from '../src/order/order.service.js';
import { ProductService } from '../src/product/product.service.js';
import { customerPrice } from '../src/product/pricing.js';
import type { TelegramService } from '../src/telegram/telegram.service.js';
import { importMarketProducts } from '../data/market-products/import.js';
import { importCatalog } from '../data/catalog-import/import.js';
import { readCatalog } from '../data/catalog-import/input.js';
import type { MarketDataset } from '../data/market-products/types.js';

const target = process.env.SERVICE_FEE_TEST_DATABASE_URL;
const schema = `fee_backend_${randomUUID().replaceAll('-', '')}`;
const adminPhone = '+79990000887';

describe.skipIf(!target)('global service fee backend / dedicated PostgreSQL', () => {
  let connection: pg.Client, db: PrismaClient, app: INestApplication<Server>;
  let created = false, adminId: number, buyerId: number, ownerId: number, categoryId: number, pointId: number;
  let products: AdminProductsService, settings: SettingsService, orders: OrderService, cart: CartService;
  let historical: unknown;
  const http = () => request(app.getHttpServer());
  const cookie = (role = 'ADMIN') => `${SID}=${role}`;
  const body = (extra: Record<string, unknown> = {}) => ({ name: 'Fee product', slug: `fee-${randomUUID()}`,
    description: null, price: 10005, priceQty: 1, unit: 'PIECE', min: 1, step: 1, portionQty: 1,
    categoryId, sort: 0, active: true, ...extra });
  const global = (percent: number) => http().patch('/api/admin/settings').set('Cookie', cookie())
    .send({ globalServiceMarkupPercent: percent });
  const create = async (extra: Record<string, unknown> = {}) =>
    (await http().post('/api/admin/products').set('Cookie', cookie()).send(body(extra)).expect(201)).body as
      { id: number; price: number; serviceMarkupPercent: number; serviceMarkupPercentOverride: number | null; customerPrice: number };

  beforeAll(async () => {
    const url = new URL(target!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/^\/service_fee_test_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Dedicated local test database required');
    if (!/^fee_backend_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    connection = new pg.Client({ connectionString: target }); await connection.connect();
    await connection.query(`CREATE SCHEMA "${schema}"`); created = true;
    await connection.query(`SET search_path TO "${schema}"`);
    const root = resolve('prisma/migrations');
    for (const entry of (await readdir(root, { withFileTypes: true })).filter(row => row.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name === '20261103150000_global_service_fee') {
        await connection.query(`
          INSERT INTO "Category" (id,name,slug,"updatedAt") VALUES (-1,'Legacy','fee-legacy',NOW());
          INSERT INTO "Product" (id,name,slug,price,unit,"portionQty","categoryId","updatedAt")
          SELECT -id,'Legacy '||id,'fee-legacy-'||id,10000+id,'PIECE',1,-1,'2026-10-20' FROM generate_series(1,173) id;
          INSERT INTO "Order" (id,type,status,"customerName","customerPhone",subtotal,"deliveryPrice",total,"finalSubtotal","finalTotal","updatedAt")
          VALUES (-1,'PICKUP','COMPLETED','Historical','+79990000000',11000,0,11000,11000,11000,'2026-10-20');
          INSERT INTO "OrderItem" (id,"productName","productSlug",price,"priceQty",unit,qty,total,"orderId","productId","serviceMarkupPercentSnapshot")
          VALUES (-1,'Historical','historical',11000,1,'PIECE',1,11000,-1,-1,NULL);
          INSERT INTO "OrderPayment" (id,"orderId",amount,status,"updatedAt") VALUES (-1,-1,11000,'PAID','2026-10-20');
        `);
      }
      await connection.query(await readFile(join(root, entry.name, 'migration.sql'), 'utf8'));
    }
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: target, options: `-c search_path=${schema}` }, { schema }) });
    historical = await history();
    adminId = (await db.user.create({ data: { role: 'ADMIN', phone: adminPhone } })).id;
    buyerId = (await db.user.create({ data: { role: 'USER', phone: '+79990000002' } })).id;
    ownerId = (await db.user.create({ data: { role: 'USER', phone: '+79990000003' } })).id;
    categoryId = (await db.category.create({ data: { name: 'Fee fixtures', slug: 'fee-fixtures' } })).id;
    pointId = (await db.marketPoint.findFirstOrThrow()).id;
    await db.marketPointOwner.create({ data: { userId: ownerId, marketPointId: pointId } });
    vi.stubEnv('ADMIN_PHONE', adminPhone);
    const database = db as unknown as DbService;
    const images = new ImagesService(database);
    products = new AdminProductsService(database, images); settings = new SettingsService(database);
    orders = new OrderService(database, { notifyNewOrder: vi.fn().mockResolvedValue(undefined) } as unknown as TelegramService);
    cart = new CartService(database, orders);
    const module = await Test.createTestingModule({ controllers: [AdminProductsCtrl, SettingsCtrl, OwnerCtrl], providers: [
      { provide: DbService, useValue: database }, { provide: AdminProductsService, useValue: products },
      { provide: SettingsService, useValue: settings }, { provide: ImagesService, useValue: images },
      { provide: AuthService, useValue: { me: async (token?: string) => {
        const id = token === 'ADMIN' ? adminId : token === 'OWNER' ? ownerId : token === 'USER' ? buyerId : null;
        if (id) return db.user.findUnique({ where: { id }, include: { ownedPoints: { select: { marketPointId: true } } } });
        return token === 'SELLER' || token === 'OTHER_ADMIN' ? { id: buyerId, role: token === 'SELLER' ? 'SELLER' : 'ADMIN', phone: '+79990000002' } : null;
      } } },
    ] }).compile();
    app = module.createNestApplication<INestApplication<Server>>({ logger: false }); app.use(cookieParser());
    app.setGlobalPrefix('api'); app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true })); await app.init();
    await db.shopHours.updateMany({ data: { enabled: true, openMinutes: 0, closeMinutes: 1440 } });
  }, 60000);

  beforeEach(async () => {
    await db.order.deleteMany({ where: { id: { gt: 0 } } });
    await db.cartItem.deleteMany(); await db.cart.deleteMany();
    await db.product.deleteMany({ where: { id: { gt: 0 } } });
    await db.shopSettings.update({ where: { id: 1 }, data: { globalServiceMarkupPercent: 10 } });
    await db.adminAudit.deleteMany();
  });
  afterAll(async () => {
    await app?.close(); await db?.$disconnect();
    if (created && /^fee_backend_[a-f0-9]{32}$/.test(schema)) await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
    await connection?.end(); vi.unstubAllEnvs();
  });

  async function history() {
    return { orders: await db.order.findMany({ where: { id: -1 } }),
      items: await db.orderItem.findMany({ where: { orderId: -1 } }), payments: await db.orderPayment.findMany({ where: { orderId: -1 } }) };
  }

  it.each([10,15,0,100])('inherits global %i, updates only global rows and keeps seller prices', async percent => {
    const p = await create();
    await global(percent).expect(200);
    expect((await http().get('/api/admin/settings').set('Cookie',cookie()).expect(200)).body.globalServiceMarkupPercent).toBe(percent);
    const saved = await products.get(p.id);
    expect(saved).toMatchObject({ price:10005, serviceMarkupPercentOverride:null, serviceMarkupPercent:percent,
      serviceMarkupNeedsReview:false, customerPrice:customerPrice(10005,percent) });
    const newer = await create(); expect(newer.serviceMarkupPercent).toBe(percent);
    expect((await db.product.findUniqueOrThrow({where:{id:p.id}})).normalizedPrice.toNumber()).toBe(customerPrice(10005,percent));
    expect(await history()).toEqual(historical);
  });

  it.each([0,10,20])('preserves individual %i across global changes and ordinary updates', async override => {
    const p=await create({serviceMarkupPercentOverride:override});
    await global(15).expect(200);
    await products.update(p.id,{price:20000},adminId);
    expect(await products.get(p.id)).toMatchObject({serviceMarkupPercentOverride:override,serviceMarkupPercent:override,
      customerPrice:customerPrice(20000,override)});
    await global(0).expect(200);
    expect((await products.get(p.id)).serviceMarkupPercent).toBe(override);
  });

  it('audits equal-percentage mode changes and clears the individual value', async () => {
    const p=await create();
    await http().patch(`/api/admin/products/${p.id}`).set('Cookie',cookie()).send({serviceMarkupPercentOverride:10}).expect(200);
    await http().patch(`/api/admin/products/${p.id}`).set('Cookie',cookie()).send({serviceMarkupPercentOverride:null}).expect(200);
    expect(await db.adminAudit.findMany({where:{action:'PRODUCT_MARKUP_CHANGED',entityId:String(p.id)},orderBy:{id:'asc'}})).toMatchObject([
      {actorId:adminId,oldValue:{serviceMarkupPercentOverride:null,serviceMarkupPercent:10},newValue:{serviceMarkupPercentOverride:10,serviceMarkupPercent:10}},
      {actorId:adminId,oldValue:{serviceMarkupPercentOverride:10,serviceMarkupPercent:10},newValue:{serviceMarkupPercentOverride:null,serviceMarkupPercent:10}},
    ]);
    expect(await products.get(p.id)).toMatchObject({serviceMarkupPercentOverride:null,serviceMarkupNeedsReview:false});
  });

  it('preserves all 173 migrated overrides and reviews without automatic classification', async () => {
    const before=await db.product.findMany({where:{id:{lt:0}},orderBy:{id:'asc'}});
    expect(before).toHaveLength(173);
    await global(15).expect(200);
    expect(await db.product.findMany({where:{id:{lt:0}},orderBy:{id:'asc'}})).toEqual(before);
    expect(await db.adminAudit.count({where:{action:'GLOBAL_MARKUP_CHANGED',actorId:adminId}})).toBe(1);
    await products.update(-1,{serviceMarkupPercentOverride:10},adminId);
    expect(await products.get(-1)).toMatchObject({serviceMarkupPercentOverride:10,serviceMarkupNeedsReview:false});
    await db.product.update({where:{id:-1},data:{serviceMarkupNeedsReview:true}});
  });

  it.each([-1,101,0.5,null,'15'])('rejects invalid global/override input %s', async percent => {
    await http().patch('/api/admin/settings').set('Cookie',cookie()).send({globalServiceMarkupPercent:percent}).expect(400);
    if(percent!==null) await http().post('/api/admin/products').set('Cookie',cookie()).send(body({serviceMarkupPercentOverride:percent})).expect(400);
  });

  it('rejects independent writes of derived percentages and review flags', async () => {
    const p=await create();
    for(const fields of [{serviceMarkupPercent:20},{serviceMarkupNeedsReview:false}]){
      await http().post('/api/admin/products').set('Cookie',cookie()).send(body(fields)).expect(400);
      await http().patch(`/api/admin/products/${p.id}`).set('Cookie',cookie()).send(fields).expect(400);
      await http().post('/api/admin/products/pricing').set('Cookie',cookie()).send({price:10005,...fields}).expect(400);
    }
  });

  it.each(['USER','OWNER','SELLER','OTHER_ADMIN','missing'])('denies percentage administration to %s', async role => {
    await http().get('/api/admin/settings').set('Cookie',cookie(role)).expect(403);
    await http().patch('/api/admin/settings').set('Cookie',cookie(role)).send({globalServiceMarkupPercent:15}).expect(403);
    await http().post('/api/admin/products').set('Cookie',cookie(role)).send(body({serviceMarkupPercentOverride:0})).expect(403);
  });

  it('creates owner products in global mode and keeps admin exceptions on owner updates', async () => {
    await global(15).expect(200);
    const input=body({marketPointId:pointId}); const {sort:_sort,...ownerBody}=input;
    const result=await http().post('/api/owner/products').set('Cookie',cookie('OWNER')).send(ownerBody).expect(201);
    const id=(result.body as {id:number}).id;
    expect(result.body).toMatchObject({serviceMarkupPercentOverride:null,serviceMarkupPercent:15});
    await products.update(id,{serviceMarkupPercentOverride:20},adminId);
    await http().patch(`/api/owner/products/${id}`).set('Cookie',cookie('OWNER')).send({price:20000}).expect(200);
    expect(await products.get(id)).toMatchObject({serviceMarkupPercentOverride:20,serviceMarkupPercent:20,customerPrice:24000});
    await http().patch(`/api/owner/products/${id}`).set('Cookie',cookie('OWNER')).send({serviceMarkupPercentOverride:null}).expect(400);
  });

  it('previews current policy without persisting or double charging', async () => {
    await global(15).expect(200);
    expect((await http().post('/api/admin/products/pricing').set('Cookie',cookie()).send({price:10005}).expect(201)).body)
      .toMatchObject({sellerPrice:10005,serviceMarkupPercent:15,serviceMarkupPercentOverride:null,customerPrice:11506});
    expect((await http().post('/api/admin/products/pricing').set('Cookie',cookie()).send({price:10005,serviceMarkupPercentOverride:0}).expect(201)).body.customerPrice).toBe(10005);
    const p=await create();
    for(let i=0;i<3;i++) await products.update(p.id,{price:10005},adminId);
    expect(await products.get(p.id)).toMatchObject({price:10005,customerPrice:11506});
  });

  it('sorts SQL normalized prices consistently with the public catalog', async () => {
    const a=await create({name:'A',price:10000}); const b=await create({name:'B',price:11000,serviceMarkupPercentOverride:0});
    await global(15).expect(200);
    const catalog=new ProductService(db as unknown as DbService);
    const list=await catalog.list({ids:undefined,page:1,limit:20,sort:'price_asc',category:'fee-fixtures'});
    expect(list.items.map(p=>[p.id,p.price])).toEqual([[b.id,11000],[a.id,11500]]);
    expect((await catalog.list({ids:[a.id,b.id],feed:'catalog',page:1,limit:20,sort:'price_asc'})).items.map(p=>[p.id,p.price]))
      .toEqual([[b.id,11000],[a.id,11500]]);
    await global(0).expect(200);
    expect((await catalog.list({ids:undefined,page:1,limit:20,sort:'price_asc',category:'fee-fixtures'})).items.map(p=>p.id)).toEqual([a.id,b.id]);
  });

  it('imports market products using the live global percentage and retains an existing exception', async () => {
    await global(15).expect(200);
    const dataset: MarketDataset = {categories:[{slug:'fee-import',name:'Fee import',sort:1}],expectedCounts:{'fee-point':1},
      marketPoints:[{slug:'fee-point',name:'Fee point',kind:'STALL'}],marketProducts:[{slug:'fee-point-import',name:'Import',
        sellerPrice:10005,priceStatus:'SOURCE',categorySlug:'fee-import',marketPointSlug:'fee-point',
        sourceUrl:'https://example.test/fee',sourceCheckedAt:'2026-10-20T00:00:00.000Z',unit:'PIECE',priceQty:1,min:1,step:1,portionQty:1}]};
    const preview=await importMarketProducts(db,true,dataset);
    expect(preview.products[0]).toMatchObject({serviceMarkupPercent:15,customerPrice:11506});
    await importMarketProducts(db,false,dataset);
    const imported=await db.product.findUniqueOrThrow({where:{slug:'fee-point-import'}});
    expect(imported).toMatchObject({price:10005,serviceMarkupPercentOverride:null,serviceMarkupPercent:15});
    await products.update(imported.id,{serviceMarkupPercentOverride:20},adminId);
    await importMarketProducts(db,false,{...dataset,marketProducts:dataset.marketProducts.map(row=>({...row,sellerPrice:20000}))});
    expect(await products.get(imported.id)).toMatchObject({price:20000,serviceMarkupPercentOverride:20,serviceMarkupPercent:20,customerPrice:24000});
    await db.product.update({where:{id:imported.id},data:{serviceMarkupPercent:30}});
    await expect(importMarketProducts(db,false,dataset)).rejects.toMatchObject({status:409});
    expect((await db.product.findUniqueOrThrow({where:{id:imported.id}})).serviceMarkupPercent).toBe(30);
  });

  it('imports catalog drafts at the live global percentage and preserves overrides on repeat import', async () => {
    await global(15).expect(200);
    const catalog=await readCatalog();
    await db.marketPoint.upsert({where:{slug:catalog.marketPointSlug},update:{},create:{slug:catalog.marketPointSlug,name:'Catalog fixture',kind:'STALL'}});
    for(const category of catalog.categories) await db.category.upsert({where:{slug:category.slug},update:{},create:category});
    await importCatalog(db,catalog,false);
    const imported=await db.product.findUniqueOrThrow({where:{slug:catalog.products[0].slug}});
    expect(imported).toMatchObject({serviceMarkupPercentOverride:null,serviceMarkupPercent:15,serviceMarkupNeedsReview:false});
    await products.update(imported.id,{serviceMarkupPercentOverride:0},adminId);
    const preview=await importCatalog(db,catalog,true);
    expect(preview.products.find(p=>p.id===imported.id)).toMatchObject({serviceMarkupPercent:0,customerPrice:imported.price});
    await importCatalog(db,catalog,false);
    expect(await db.product.findUniqueOrThrow({where:{id:imported.id}})).toMatchObject({serviceMarkupPercentOverride:0,serviceMarkupPercent:0,price:imported.price});
    await db.product.update({where:{id:imported.id},data:{serviceMarkupPercent:10}});
    await expect(importCatalog(db,catalog,false)).rejects.toMatchObject({status:409});
    expect((await db.product.findUniqueOrThrow({where:{id:imported.id}})).serviceMarkupPercent).toBe(10);
  });

  async function hold(lock:'Product'|'ShopSettings',work:()=>Promise<void>) {
    let release:()=>void=()=>{}, ready:()=>void=()=>{};
    const waiting=new Promise<void>(resolve=>{release=resolve}); const locked=new Promise<void>(resolve=>{ready=resolve});
    const transaction=db.$transaction(async tx=>{
      if(lock==='Product') await tx.$queryRaw`SELECT id FROM "Product" WHERE id = -2 FOR SHARE`;
      else await tx.$queryRaw`SELECT id FROM "ShopSettings" WHERE id = 1 FOR UPDATE`;
      ready(); await waiting;
    },{timeout:10000});
    await locked;
    try{await work()}finally{release();await transaction}
  }

  it.each(['Product','ShopSettings'] as const)('fails fast and rolls back atomically while %s is busy', async lock => {
    const p=await create(); const audits=await db.adminAudit.count();
    await hold(lock,async()=>{await global(15).expect(409)});
    expect((await settings.get()).globalServiceMarkupPercent).toBe(10);
    expect((await products.get(p.id)).serviceMarkupPercent).toBe(10);
    expect(await db.adminAudit.count()).toBe(audits);
    await global(15).expect(200);
  });

  it('serializes concurrent global changes, creates and individual overrides', async () => {
    for(let i=0;i<4;i++){
      const [createdProduct,response]=await Promise.all([create(),global(i%2?10:15)]);
      expect([200,409]).toContain(response.status);
      const current=await settings.get();
      expect((await products.get(createdProduct.id)).serviceMarkupPercent).toBe(current.globalServiceMarkupPercent);
      const [changed,globalResponse]=await Promise.all([products.update(createdProduct.id,{serviceMarkupPercentOverride:20},adminId),global(0)]);
      expect(changed.serviceMarkupPercent).toBe(20);expect([200,409]).toContain(globalResponse.status);
      expect((await products.get(createdProduct.id)).serviceMarkupPercent).toBe(20);
    }
  });

  it('serializes two concurrent global changes with one atomic audit per successful change', async () => {
    const p=await create();
    const responses=await Promise.all([global(15),global(0)]);
    expect(responses.some(response=>response.status===200)).toBe(true);
    for(const response of responses) expect([200,409]).toContain(response.status);
    const current=await settings.get();
    expect((await products.get(p.id)).serviceMarkupPercent).toBe(current.globalServiceMarkupPercent);
    expect(await db.adminAudit.count({where:{action:'GLOBAL_MARKUP_CHANGED'}})).toBe(responses.filter(response=>response.status===200).length);
  });

  it('does not rewrite products or duplicate pricing audit on an identical global retry', async () => {
    const p=await create();const before=await db.product.findUniqueOrThrow({where:{id:p.id}});
    const audits=await db.adminAudit.count();
    await global(10).expect(200);
    expect(await db.product.findUniqueOrThrow({where:{id:p.id}})).toEqual(before);
    expect(await db.adminAudit.count()).toBe(audits);
  });

  it('keeps unchanged cart and guest checkout prices consistent with snapshots during a global change', async () => {
    const p=await create();const basket=await cart.get(buyerId);
    const filled=await cart.change(buyerId,basket.revision,{kind:'set',productId:p.id,qty:2});
    const [checkout,response]=await Promise.all([cart.checkout(buyerId,filled.revision,{type:'PICKUP',customerName:'Buyer',customerPhone:'+79990000002',checkoutRequestId:randomUUID()}),global(15)]);
    expect([200,409]).toContain(response.status);
    const item=await db.orderItem.findFirstOrThrow({where:{orderId:checkout.order.id}});
    expect(item.price).toBe(customerPrice(10005,item.serviceMarkupPercentSnapshot!));
    expect(item.total).toBe(item.price*2);
    const [guest,again]=await Promise.all([orders.create(null,undefined,{type:'PICKUP',customerName:'Guest',customerPhone:'+79990000004',items:[{productId:p.id,qty:1}],checkoutRequestId:randomUUID()}),global(0)]);
    expect([200,409]).toContain(again.status);
    const guestItem=await db.orderItem.findFirstOrThrow({where:{orderId:guest.order.id}});
    expect(guestItem.price).toBe(customerPrice(10005,guestItem.serviceMarkupPercentSnapshot!));
    const before=await db.orderItem.findUniqueOrThrow({where:{id:item.id}});
    await global(100).expect(200);
    expect(await db.orderItem.findUniqueOrThrow({where:{id:item.id}})).toEqual(before);
    expect(await history()).toEqual(historical);
  });

  it('rolls back setting, all effective values and audits when auditing fails', async () => {
    const p=await create();
    await connection.query(`CREATE FUNCTION fee_audit_failure() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN IF NEW.action = 'PRODUCT_MARKUP_CHANGED' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fee_audit_failure BEFORE INSERT ON "AdminAudit" FOR EACH ROW EXECUTE FUNCTION fee_audit_failure()`);
    try { await expect(settings.update({globalServiceMarkupPercent:15},adminId)).rejects.toBeDefined(); }
    finally { await connection.query('DROP TRIGGER fee_audit_failure ON "AdminAudit"; DROP FUNCTION fee_audit_failure()'); }
    expect((await settings.get()).globalServiceMarkupPercent).toBe(10);
    expect((await products.get(p.id)).serviceMarkupPercent).toBe(10);
    expect(await db.adminAudit.count({where:{action:'GLOBAL_MARKUP_CHANGED'}})).toBe(0);
  });

  it('refuses ambiguous legacy drift instead of overwriting an individual percentage', async () => {
    await db.product.update({where:{id:-1},data:{serviceMarkupPercent:20}});
    try{await global(15).expect(409);expect((await settings.get()).globalServiceMarkupPercent).toBe(10)}
    finally{await db.product.update({where:{id:-1},data:{serviceMarkupPercent:10}})}
  });
});
