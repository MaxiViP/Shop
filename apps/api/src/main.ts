import { StandardSchemaValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { uploadRoot } from './admin/images.service.js';
import { allowedOrigin } from './auth/admin.config.js';
import { configureProxy } from './auth/proxy.js';
import { ImageRegistry } from './product/image-registry.js';
import { configureProductImageHttp } from './product/image-static.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureProxy(app);
  configureProductImageHttp(app, app.get(ImageRegistry), uploadRoot);

  app.use(cookieParser());

  app.useGlobalPipes(
    new StandardSchemaValidationPipe({
      transform: true,
    }),
  );

  app.setGlobalPrefix('api');

  app.enableCors({
    origin: (origin, callback) =>
      callback(null, !origin || allowedOrigin(origin)),
    credentials: true,
  });

  await app.listen(process.env.PORT ?? 4001, '127.0.0.1');
}

void bootstrap();
