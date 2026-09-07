import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { AdminCategoriesService } from './categories.service.js';
import {
  idSchema,
  categorySchema,
  categoryPatch,
  type CategoryInput,
} from './schema.js';
@Controller('admin/categories')
@UseGuards(AdminGuard)
export class AdminCategoriesCtrl {
  constructor(private readonly categories: AdminCategoriesService) {}
  @Get()
  list() {
    return this.categories.list();
  }
  @Post()
  create(@Body({ schema: categorySchema }) body: CategoryInput) {
    return this.categories.create(body);
  }
  @Patch(':id')
  update(
    @Param('id', { schema: idSchema }) id: number,
    @Body({ schema: categoryPatch }) body: Partial<CategoryInput>,
  ) {
    return this.categories.update(id, body);
  }
  @Delete(':id')
  remove(@Param('id', { schema: idSchema }) id: number) {
    return this.categories.remove(id);
  }
}
