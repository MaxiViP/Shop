import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdminGuard } from '../auth/admin.guard.js';
import { MarketMapService } from '../market-map/market-map.service.js';
import { floorQuery, pointSchema, pointPatch, type PointInput } from '../market-map/schema.js';
import type { ImageFile } from '../common/image.js';
import { idSchema } from './schema.js';

@Controller('admin/market-map/points')
@UseGuards(AdminGuard)
export class AdminMarketMapCtrl {
  constructor(private readonly map: MarketMapService) {}

  @Get()
  list(@Query({ schema: floorQuery }) query: { floor: number }) {
    return this.map.list(query.floor);
  }

  @Get(':id')
  get(@Param('id', { schema: idSchema }) id: number) {
    return this.map.get(id);
  }

  @Post()
  create(@Body({ schema: pointSchema }) data: PointInput) {
    return this.map.create(data);
  }

  @Patch(':id')
  update(@Param('id', { schema: idSchema }) id: number,
    @Body({ schema: pointPatch }) data: Partial<PointInput>) {
    return this.map.update(id, data);
  }

  @Post(':id/photo')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 2 },
  }))
  photo(@Param('id', { schema: idSchema }) id: number, @UploadedFile() file?: ImageFile) {
    return this.map.upload(id, file);
  }

  @Delete(':id/photo')
  removePhoto(@Param('id', { schema: idSchema }) id: number) {
    return this.map.removePhoto(id);
  }
}
