import { StandardSchemaValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { uploadRoot } from './admin/images.service.js';
import { allowedOrigin } from './auth/admin.config.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useStaticAssets(uploadRoot, {
    prefix: '/uploads/products/',
    dotfiles: 'deny',
    index: false,
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  });

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
