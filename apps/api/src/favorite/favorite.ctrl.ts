import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthRequest } from '../auth/auth.guard.js';
import { FavoriteService } from './favorite.service.js';
import { favoriteSyncSchema, type FavoriteSyncInput } from './schema.js';
import { ImageRegistry } from '../product/image-registry.js';

const idSchema = z.coerce.number().int().positive();

@Controller('favorites')
@UseGuards(AuthGuard)
export class FavoriteCtrl {
  constructor(
    @Inject(FavoriteService) private readonly favorite: FavoriteService,
    @Inject(ImageRegistry) private readonly images: ImageRegistry,
  ) {}

  @Get()
  async list(@Req() request: AuthRequest) {
    const page = await this.favorite.list(request.user.id);
    return { ...page, items: await this.images.enrich(page.items) };
  }

  @Post('sync')
  sync(
    @Req() request: AuthRequest,
    @Body({ schema: favoriteSyncSchema }) body: FavoriteSyncInput,
  ) {
    return this.favorite.sync(request.user.id, body);
  }

  @Post(':productId')
  add(
    @Req() request: AuthRequest,
    @Param('productId', { schema: idSchema }) productId: number,
  ) {
    return this.favorite.add(request.user.id, productId);
  }

  @Delete(':productId')
  remove(
    @Req() request: AuthRequest,
    @Param('productId', { schema: idSchema }) productId: number,
  ) {
    return this.favorite.remove(request.user.id, productId);
  }
}
