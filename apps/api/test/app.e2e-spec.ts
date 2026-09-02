import type { Server } from 'node:http';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';

describe('HealthCtrl (e2e)', () => {
  let app: INestApplication<Server>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<INestApplication<Server>>();
    await app.init();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ ok: true });
  });

  it('protects every favorites route from unauthenticated access', async () => {
    const server = app.getHttpServer();

    await request(server).get('/favorites').expect(401);
    await request(server).post('/favorites/1').expect(401);
    await request(server).delete('/favorites/1').expect(401);
    await request(server)
      .post('/favorites/sync')
      .send({ productIds: [1] })
      .expect(401);
  });

  afterEach(async () => {
    await app.close();
  });
});
