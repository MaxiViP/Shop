import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard, type AuthRequest } from '../auth/auth.guard.js';
import { OwnerGuard } from '../auth/owner.guard.js';
import { z } from 'zod';
import { DbService } from '../db/db.service.js';
import { AdminProductsService } from './products.service.js';
import { ImagesService, type ImageFile } from './images.service.js';
import { idSchema, imageSchema, ownerProductFields, ownerProductPatch, productQuery,
  type ImageInput, type OwnerProductInput, type ProductQuery } from './schema.js';

@Controller('owner')
@UseGuards(AuthGuard, OwnerGuard)
export class OwnerCtrl {
  constructor(private readonly db: DbService, private readonly products: AdminProductsService, private readonly images: ImagesService) {}

  @Get('points')
  points(@Req() request: AuthRequest) {
    return this.db.marketPoint.findMany({ where: { owners: { some: { userId: request.user.id } } }, orderBy: { name: 'asc' } });
  }
  // Owners choose existing categories; category mutations stay admin-only.
  @Get('categories')
  categories() {
    return this.db.category.findMany({ where: { active: true }, orderBy: [{ sort: 'asc' }, { id: 'asc' }] });
  }
  @Get('products')
  list(@Query({ schema: productQuery }) query: ProductQuery, @Req() request: AuthRequest) {
    return this.products.list(query, request.user.id);
  }
  @Get('products/:id')
  get(@Param('id', { schema: idSchema }) id: number, @Req() request: AuthRequest) {
    return this.products.get(id, request.user.id);
  }
  @Post('products')
  create(@Body({ schema: ownerProductFields }) data: OwnerProductInput, @Req() request: AuthRequest) {
    return this.products.create({ ...data, sort: 0, priceStatus: 'AUDITED', sourceCheckedAt: new Date().toISOString() }, request.user.id, request.user.id);
  }
  @Post('products/pricing')
  async pricing(@Body({ schema: z.strictObject({ price: z.number().int().positive().max(100_000_000), productId: idSchema.optional() }) }) data: { price: number; productId?: number }, @Req() request: AuthRequest) {
    const product = data.productId ? await this.products.get(data.productId, request.user.id) : null;
    return this.products.pricing(data.price, product?.serviceMarkupPercent);
  }
  @Patch('products/:id')
  update(@Param('id', { schema: idSchema }) id: number, @Body({ schema: ownerProductPatch }) data: Partial<OwnerProductInput>, @Req() request: AuthRequest) {
    return this.products.update(id, { ...data, ...(data.price === undefined ? {} : { priceStatus: 'AUDITED', sourceCheckedAt: new Date().toISOString() }) }, request.user.id, request.user.id);
  }
  @Post('products/:id/images')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 2 } }))
  upload(@Param('id', { schema: idSchema }) id: number, @Req() request: AuthRequest, @UploadedFile() file?: ImageFile) {
    return this.images.upload(id, file, request.user.id);
  }
  @Patch('products/:id/images/:imageId')
  image(@Param('id', { schema: idSchema }) id: number, @Param('imageId', { schema: idSchema }) imageId: number,
    @Body({ schema: imageSchema }) data: ImageInput, @Req() request: AuthRequest) {
    return this.images.update(id, imageId, data, request.user.id);
  }
  @Post('products/:id/images/:imageId/primary')
  primary(@Param('id', { schema: idSchema }) id: number, @Param('imageId', { schema: idSchema }) imageId: number, @Req() request: AuthRequest) {
    return this.images.primary(id, imageId, request.user.id);
  }
  @Delete('products/:id/images/:imageId')
  removeImage(@Param('id', { schema: idSchema }) id: number, @Param('imageId', { schema: idSchema }) imageId: number, @Req() request: AuthRequest) {
    return this.images.remove(id, imageId, request.user.id);
  }
}
