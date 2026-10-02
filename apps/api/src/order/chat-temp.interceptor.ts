import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { finalize } from 'rxjs';
import type { ChatUploadFile } from './chat-images.service.js';
import { ChatImagesService } from './chat-images.service.js';

@Injectable()
export class ChatTempCleanupInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ChatTempCleanupInterceptor.name);
  constructor(private readonly images: ChatImagesService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ file?: ChatUploadFile }>();
    return next.handle().pipe(finalize(() => {
      void this.images.removeTemp(request.file).catch((error: unknown) => {
        this.logger.error('Could not remove staged chat image', error);
      });
    }));
  }
}
