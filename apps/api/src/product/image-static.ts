import type { NestExpressApplication } from '@nestjs/platform-express';
import type { RequestHandler } from 'express';
import { posix } from 'node:path';
import { parseVariantUrl } from './image-manifest.js';
import type { ImageRegistry } from './image-registry.js';

function variantRequest(url: string) {
  const path = url.split('?')[0]!;
  try {
    // Decode for classification only. The actual request must match the exact
    // canonical parser, so aliases cannot fall through to the legacy static root.
    const decoded = decodeURIComponent(path).replaceAll('\\', '/');
    // Reserve Win32 trailing-dot/space aliases on every platform as well.
    const windows = decoded
      .split('/')
      .map((part) =>
        part === '.' || part === '..' ? part : part.replace(/[. ]+$/, ''),
      )
      .join('/');
    return [decoded, windows]
      .flatMap((value) => [value, posix.normalize(value)])
      .some((value) => /^\/uploads\/products\/variants(?:\/|$)/iu.test(value));
  } catch {
    return /^\/uploads\/products\/variants(?:\/|$)/iu.test(path);
  }
}

export function imageVariantHandler(registry: ImageRegistry): RequestHandler {
  return async (request, response, next) => {
    if (!variantRequest(request.originalUrl)) return next();
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    if (!registry.enabled) {
      response.status(404).end();
      return;
    }
    let id: string;
    try {
      id = parseVariantUrl(request.originalUrl).id;
    } catch {
      response.status(404).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      response.status(405).end();
      return;
    }
    try {
      const file = await registry.variant(request.originalUrl);
      if (file) {
        response.setHeader(
          'Cache-Control',
          'public, max-age=31536000, immutable',
        );
        response.setHeader('ETag', '"' + file.sha256 + '"');
        response.setHeader(
          'Last-Modified',
          new Date(Number(file.stat.mtimeMs)).toUTCString(),
        );
        response.type('image/webp').send(file.buffer);
      } else if (await registry.originalExists(id)) {
        response
          .status(307)
          .setHeader('Location', '/uploads/products/' + id + '.webp');
        response.end();
      } else response.status(404).end();
    } catch {
      // Never expose paths or allow unsafe requests to fall through.
      response.removeHeader('ETag');
      response.removeHeader('Last-Modified');
      response.setHeader('Cache-Control', 'no-store');
      response.status(404).end();
    }
  };
}

export function configureProductImageHttp(
  app: NestExpressApplication,
  registry: ImageRegistry,
  uploadRoot: string,
) {
  app.use(imageVariantHandler(registry));
  app.useStaticAssets(uploadRoot, {
    prefix: '/uploads/products/',
    dotfiles: 'deny',
    index: false,
    setHeaders: (response) =>
      response.setHeader('X-Content-Type-Options', 'nosniff'),
  });
}
