import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import {
  StandardSchemaValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AdminProductsCtrl } from '../src/admin/products.ctrl.js';
import { AdminCategoriesCtrl } from '../src/admin/categories.ctrl.js';
import { AdminUsersCtrl } from '../src/admin/users.ctrl.js';
import { AdminProductsService } from '../src/admin/products.service.js';
import { AdminCategoriesService } from '../src/admin/categories.service.js';
import { AdminUsersService } from '../src/admin/users.service.js';
import { ImagesService } from '../src/admin/images.service.js';
import { AdminGuard } from '../src/auth/admin.guard.js';
import { AuthService, SID } from '../src/auth/auth.service.js';

describe('Admin HTTP boundaries', () => {
  let app: INestApplication<Server>;
  const products = {
    list: vi.fn().mockResolvedValue({ items: [] }),
    create: vi.fn(),
    update: vi.fn(),
    get: vi.fn(),
    remove: vi.fn(),
  };
  const users = {
    list: vi.fn().mockResolvedValue({ items: [] }),
    get: vi.fn(),
    role: vi.fn(),
  };
  const categories = {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  };
  const images = {
    upload: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    primary: vi.fn(),
  };
  beforeAll(async () => {
    vi.stubEnv('ADMIN_PHONE', '+79990000001');
    const module = await Test.createTestingModule({
      controllers: [AdminProductsCtrl, AdminCategoriesCtrl, AdminUsersCtrl],
      providers: [
        AdminGuard,
        {
          provide: AuthService,
          useValue: {
            me: async (token: string) =>
              ['USER', 'SELLER', 'ADMIN'].includes(token)
                ? { id: 1, phone: '+79990000001', role: token }
                : null,
          },
        },
        { provide: AdminProductsService, useValue: products },
        { provide: AdminCategoriesService, useValue: categories },
        { provide: AdminUsersService, useValue: users },
        { provide: ImagesService, useValue: images },
      ],
    }).compile();
    app = module.createNestApplication<INestApplication<Server>>();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });
  it.each(['USER', 'SELLER', 'missing'])(
    'blocks every admin route for %s',
    async (role) => {
      const server = app.getHttpServer();
      const cookie = `${SID}=${role}`;
      for (const path of [
        'products',
        'products/1',
        'categories',
        'users',
        'users/1',
      ])
        await request(server)
          .get(`/api/admin/${path}`)
          .set('Cookie', cookie)
          .expect(403);
      for (const path of [
        'products',
        'categories',
        'products/1/images',
        'products/1/images/1/primary',
      ])
        await request(server)
          .post(`/api/admin/${path}`)
          .set('Cookie', cookie)
          .send({ role: 'ADMIN' })
          .expect(403);
      for (const path of [
        'products/1',
        'categories/1',
        'users/1/role',
        'products/1/images/1',
      ])
        await request(server)
          .patch(`/api/admin/${path}`)
          .set('Cookie', cookie)
          .send({ role: 'ADMIN' })
          .expect(403);
      for (const path of ['products/1', 'categories/1', 'products/1/images/1'])
        await request(server)
          .delete(`/api/admin/${path}`)
          .set('Cookie', cookie)
          .expect(403);
    },
  );
  it('allows ADMIN lists', async () => {
    for (const path of ['products', 'categories', 'users'])
      await request(app.getHttpServer())
        .get(`/api/admin/${path}`)
        .set('Cookie', `${SID}=ADMIN`)
        .expect(200);
  });
  it('cannot assign ADMIN through HTTP', async () => {
    await request(app.getHttpServer())
      .patch('/api/admin/users/2/role')
      .set('Cookie', `${SID}=ADMIN`)
      .send({ role: 'ADMIN' })
      .expect(400);
    expect(users.role).not.toHaveBeenCalled();
  });
  it('validates query and money before service', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/products?limit=100000')
      .set('Cookie', `${SID}=ADMIN`)
      .expect(400);
    await request(app.getHttpServer())
      .patch('/api/admin/products/1')
      .set('Cookie', `${SID}=ADMIN`)
      .send({ price: 0.3 })
      .expect(400);
    expect(products.update).not.toHaveBeenCalled();
  });
  it('enforces multipart size before service', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/products/1/images')
      .set('Cookie', `${SID}=ADMIN`)
      .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: 'test.png',
        contentType: 'image/png',
      })
      .expect(413);
    expect(images.upload).not.toHaveBeenCalled();
  });

  it('accepts a normal single-file multipart upload for ADMIN', async () => {
    images.upload.mockResolvedValue({ id: 1 });
    await request(app.getHttpServer())
      .post('/api/admin/products/1/images')
      .set('Cookie', `${SID}=ADMIN`)
      .attach('file', Buffer.from('fixture'), {
        filename: 'test.png',
        contentType: 'image/png',
      })
      .expect(201);
    expect(images.upload).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ mimetype: 'image/png', size: 7 }),
    );
  });
});
