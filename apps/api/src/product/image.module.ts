import { Module } from '@nestjs/common';
import { productUploadRoot } from '../common/image.js';
import { IMAGE_OPTIONS, imageOptions } from './image-config.js';
import { ImageRegistry } from './image-registry.js';

@Module({
  providers: [
    {
      provide: IMAGE_OPTIONS,
      useFactory: () => imageOptions(productUploadRoot),
    },
    ImageRegistry,
  ],
  exports: [ImageRegistry],
})
export class ProductImageModule {}
