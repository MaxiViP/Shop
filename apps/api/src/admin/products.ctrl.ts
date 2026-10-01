import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdminGuard } from '../auth/admin.guard.js';
import type { AuthRequest } from '../auth/auth.guard.js';
import { AdminProductsService } from './products.service.js';
import { ImagesService, type ImageFile } from './images.service.js';
import {
  idSchema,
  productSchema,
  productPatch,
  productQuery,
  imageSchema,
  type ProductInput,
  type ProductQuery,
  type ImageInput,
} from './schema.js';

@Controller('admin/products')
@UseGuards(AdminGuard)
export class AdminProductsCtrl {
  constructor(
    private readonly products: AdminProductsService,
    private readonly images: ImagesService,
  ) {}
  @Get()
  list(@Query({ schema: productQuery }) query: ProductQuery) {
    return this.products.list(query);
  }
  @Get(':id')
  get(@Param('id', { schema: idSchema }) id: number) {
    return this.products.get(id);
  }
  @Post()
  create(@Body({ schema: productSchema }) body: ProductInput, @Req() request: AuthRequest) {
    return this.products.create(body, request.user.id);
  }
  @Patch(':id')
  update(
    @Param('id', { schema: idSchema }) id: number,
    @Body({ schema: productPatch }) body: Partial<ProductInput>,
    @Req() request: AuthRequest,
  ) {
    return this.products.update(id, body, request.user.id);
  }
  @Delete(':id')
  remove(@Param('id', { schema: idSchema }) id: number) {
    return this.products.remove(id);
  }
  @Post(':id/images')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 2 },
    }),
  )
  upload(
    @Param('id', { schema: idSchema }) id: number,
    @UploadedFile() file?: ImageFile,
  ) {
    return this.images.upload(id, file);
  }
  @Patch(':id/images/:imageId')
  image(
    @Param('id', { schema: idSchema }) id: number,
    @Param('imageId', { schema: idSchema }) imageId: number,
    @Body({ schema: imageSchema }) body: ImageInput,
  ) {
    return this.images.update(id, imageId, body);
  }
  @Post(':id/images/:imageId/primary')
  primary(
    @Param('id', { schema: idSchema }) id: number,
    @Param('imageId', { schema: idSchema }) imageId: number,
  ) {
    return this.images.primary(id, imageId);
  }
  @Delete(':id/images/:imageId')
  removeImage(
    @Param('id', { schema: idSchema }) id: number,
    @Param('imageId', { schema: idSchema }) imageId: number,
  ) {
    return this.images.remove(id, imageId);
  }
}
