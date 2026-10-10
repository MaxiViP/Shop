import { Body, Controller, Delete, Get, Header, Param, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdminGuard } from '../auth/admin.guard.js';
import type { ImageFile } from '../common/image.js';
import { idSchema } from './schema.js';
import { SlidesService } from './slides.service.js';
import { reorderSchema, slidePatch, slideSchema, type SlideInput } from './slides.schema.js';

@Controller('admin/home-slides')
@UseGuards(AdminGuard)
export class AdminSlidesCtrl {
  constructor(private readonly slides: SlidesService) {}
  @Get()
  list() { return this.slides.list(); }
  @Post()
  create(@Body({ schema: slideSchema }) data: SlideInput) { return this.slides.create(data); }
  @Post('preview')
  preview(@Body({ schema: slideSchema }) data: SlideInput) { return this.slides.preview(data); }
  @Post('reorder')
  reorder(@Body({ schema: reorderSchema }) data: { ids: number[] }) { return this.slides.reorder(data.ids); }
  @Patch(':id')
  update(@Param('id', { schema: idSchema }) id: number, @Body({ schema: slidePatch }) data: Partial<SlideInput>) {
    return this.slides.update(id, data);
  }
  @Post(':id/copy')
  copy(@Param('id', { schema: idSchema }) id: number) { return this.slides.copy(id); }
  @Delete(':id')
  remove(@Param('id', { schema: idSchema }) id: number) { return this.slides.remove(id); }
  @Post(':id/image')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 2 } }))
  upload(@Param('id', { schema: idSchema }) id: number, @UploadedFile() file?: ImageFile) { return this.slides.upload(id, file); }
}

@Controller('home/slides')
export class PublicSlidesCtrl {
  constructor(private readonly slides: SlidesService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  get() { return this.slides.public(); }
}
