import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { DbService } from '../db/db.service.js';
import { AdminProductsService } from './products.service.js';
import { AdminCategoriesService } from './categories.service.js';
import { AdminUsersService } from './users.service.js';
import { ImagesService, managedPath, uploadRoot } from './images.service.js';
import { productSchema, categorySchema, roleSchema } from './schema.js';
import { relative } from 'node:path';

const product = {
  name: 'Яблоки',
  slug: 'yabloki',
  description: null,
  price: 19950,
  priceQty: 1000,
  unit: 'GRAM' as const,
  min: 500,
  step: 100,
  portionQty: 500,
  categoryId: 1,
  active: true,
  sort: 0,
};
function fixture() {
  const db = {
    product: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    category: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    productImage: { delete: vi.fn(), count: vi.fn(), update: vi.fn() },
    orderItem: { count: vi.fn() },
    user: {
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(
    (fn: ((value: typeof db) => unknown) | Promise<unknown>[]) =>
      typeof fn === 'function' ? fn(db) : Promise.all(fn),
  );
  return db;
}
describe('Admin validation', () => {
  it('accepts trimmed product and integer kopecks', () => {
    expect(productSchema.parse({ ...product, name: ' Яблоки ' }).name).toBe(
      'Яблоки',
    );
  });
  it.each([
    { price: 1.5 },
    { price: -1 },
    { price: '199.50' },
    { unit: 'LITER' },
    { min: 0 },
    { step: 1.5 },
    { priceQty: 0 },
    { slug: '../bad' },
  ])('rejects invalid product %j', (input) => {
    expect(productSchema.safeParse({ ...product, ...input }).success).toBe(
      false,
    );
  });
  it('rejects ADMIN and extra privilege fields', () => {
    expect(roleSchema.safeParse({ role: 'ADMIN' }).success).toBe(false);
    expect(roleSchema.safeParse({ role: 'USER', admin: true }).success).toBe(
      false,
    );
  });
  it('validates categories', () => {
    expect(
      categorySchema.safeParse({
        name: 'Фрукты',
        slug: 'frukty',
        sort: 0,
        active: true,
        parentId: null,
      }).success,
    ).toBe(true);
  });
});
describe('Admin products', () => {
  const db = fixture();
  const images = { cleanup: vi.fn() };
  const service = new AdminProductsService(
    db as unknown as DbService,
    images as unknown as ImagesService,
  );
  beforeEach(() => vi.clearAllMocks());
  it('creates product', async () => {
    db.product.create.mockResolvedValue({ id: 1, ...product });
    expect(await service.create(product)).toMatchObject({
      id: 1,
      price: 19950,
    });
  });
  it('updates and archives product without removing history', async () => {
    db.product.findUnique.mockResolvedValue(product);
    db.product.update.mockResolvedValue({ ...product, active: false });
    expect(await service.update(1, { active: false })).toMatchObject({
      active: false,
    });
    expect(db.product.delete).not.toHaveBeenCalled();
  });
  it.each([{ step: 300 }, { min: 600 }, { portionQty: 550 }, { portionQty: 0 }])(
    'validates a partial update against the current product: %j', async (patch) => {
      db.product.findUnique.mockResolvedValue(product);
      await expect(service.update(1, patch)).rejects.toBeInstanceOf(BadRequestException);
      expect(db.product.update).not.toHaveBeenCalled();
    },
  );
  it('accepts a compatible multi-field change in one update', async () => {
    db.product.findUnique.mockResolvedValue(product);
    const patch = { min: 600, step: 300, portionQty: 900 };
    db.product.update.mockResolvedValue({ ...product, ...patch });
    await expect(service.update(1, patch)).resolves.toMatchObject(patch);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });
  it('rejects an incompatible create before writing', async () => {
    await expect(service.create({ ...product, portionQty: 501 })).rejects.toBeInstanceOf(BadRequestException);
    expect(db.product.create).not.toHaveBeenCalled();
  });
  it('requires an edited legacy product to have a compatible quantity configuration', async () => {
    db.product.findUnique.mockResolvedValue({ ...product, step: 300 });
    await expect(service.update(1, { name: 'Новое название' })).rejects.toBeInstanceOf(BadRequestException);
    expect(db.product.update).not.toHaveBeenCalled();
    db.product.update.mockResolvedValue(product);
    await expect(service.update(1, { step: 100 })).resolves.toMatchObject(product);
  });
  it('includes inactive products admin-side', async () => {
    db.product.findMany.mockResolvedValue([{ ...product, active: false }]);
    db.product.count.mockResolvedValue(1);
    const result = await service.list({ page: 1, limit: 20 });
    expect(result.items[0]?.active).toBe(false);
    expect(db.product.findMany.mock.calls[0]?.[0].where.active).toBeUndefined();
  });
  it('translates duplicate slug conflict', async () => {
    db.product.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.create(product)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
  it('permanent delete cleans assets after successful deletion', async () => {
    db.product.delete.mockResolvedValue({
      images: [{ url: 'https://example.test/photo.jpg' }],
    });
    await service.remove(1);
    expect(images.cleanup).toHaveBeenCalledWith(
      'https://example.test/photo.jpg',
    );
  });
});
describe('Admin categories', () => {
  const db = fixture();
  const service = new AdminCategoriesService(db as unknown as DbService);
  beforeEach(() => vi.clearAllMocks());
  it('creates and updates', async () => {
    const category = {
      name: 'Фрукты',
      slug: 'frukty',
      active: true,
      sort: 0,
      parentId: null,
    };
    db.category.create.mockResolvedValue(category);
    db.category.update.mockResolvedValue({ ...category, active: false });
    expect(await service.create(category)).toEqual(category);
    expect(await service.update(1, { active: false })).toMatchObject({
      active: false,
    });
  });
  it.each([
    { products: 1, children: 0 },
    { products: 0, children: 1 },
  ])('blocks unsafe category delete %j', async (_count) => {
    db.category.findUniqueOrThrow.mockResolvedValue({ _count });
    await expect(service.remove(1)).rejects.toBeInstanceOf(ConflictException);
    expect(db.category.delete).not.toHaveBeenCalled();
  });
  it('blocks parent cycles', async () => {
    db.category.findUnique.mockResolvedValue({ parentId: 1 });
    await expect(service.update(1, { parentId: 2 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
describe('Admin users', () => {
  const db = fixture();
  const service = new AdminUsersService(db as unknown as DbService);
  afterEach(() => vi.unstubAllEnvs());
  it('lists only explicit business fields and statistics', async () => {
    db.user.findMany.mockResolvedValue([{ id: 1, role: 'USER' }]);
    db.user.count.mockResolvedValue(1);
    expect((await service.list({ page: 1, limit: 20 })).items[0]).toMatchObject(
      { id: 1, orders: 0, spent: 0 },
    );
    const select = db.user.findMany.mock.calls[0]?.[0].select;
    expect(select.sessions).toBeUndefined();
    expect(select.phone).toBe(true);
  });
  it.each(['USER', 'SELLER'] as const)('changes role to %s', async (role) => {
    db.user.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      role: role === 'USER' ? 'SELLER' : 'USER',
      phone: 'fixture',
    });
    db.user.update.mockResolvedValue({ id: 1, role });
    expect(await service.role(1, role)).toMatchObject({ role });
  });
  it('cannot demote any ADMIN', async () => {
    db.user.findUniqueOrThrow.mockResolvedValue({ role: 'ADMIN' });
    await expect(service.role(1, 'USER')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it('cannot change configured phone before bootstrap', async () => {
    vi.stubEnv('ADMIN_PHONE', '+79990000001');
    db.user.findUniqueOrThrow.mockResolvedValue({
      role: 'USER',
      phone: '+79990000001',
    });
    await expect(service.role(1, 'SELLER')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
describe('Images', () => {
  const db = fixture();
  const service = new ImagesService(db as unknown as DbService);
  it.each(['image/svg+xml', 'text/html'])('rejects %s', async (mimetype) => {
    await expect(
      service.upload(1, { buffer: Buffer.from('<svg/>'), size: 6, mimetype }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects oversized files before decoding', async () => {
    await expect(
      service.upload(1, {
        buffer: Buffer.alloc(0),
        size: 5 * 1024 * 1024 + 1,
        mimetype: 'image/png',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects false MIME and SVG contents', async () => {
    await expect(
      service.upload(1, {
        buffer: Buffer.from('<svg/>'),
        size: 6,
        mimetype: 'image/png',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const buffer = await sharp({
      create: { width: 2, height: 2, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    await expect(
      service.upload(1, {
        buffer,
        size: buffer.length,
        mimetype: 'image/jpeg',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('managed paths cannot escape upload root', () => {
    for (const url of [
      '/uploads/products/../../.env',
      '/uploads/products/%2e%2e/file',
      'https://example.test/photo.webp',
      '/uploads/products/a\\..\\secret',
      '/etc/passwd',
    ])
      expect(managedPath(url)).toBeNull();
    const path = managedPath(`/uploads/products/${randomUUID()}.webp`);
    expect(path).not.toBeNull();
    expect(relative(uploadRoot, path!).startsWith('..')).toBe(false);
  });
  it('external image deletion only removes DB row', async () => {
    db.productImage.delete.mockResolvedValue({
      url: 'https://example.test/photo.png',
    });
    await expect(service.remove(1, 2)).resolves.toEqual({ ok: true });
  });
  it('preserves assets referenced by order snapshots', async () => {
    db.orderItem.count.mockResolvedValue(1);
    await expect(
      service.cleanup(`/uploads/products/${randomUUID()}.webp`),
    ).resolves.toBeUndefined();
  });
});
