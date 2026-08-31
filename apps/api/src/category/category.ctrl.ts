import { Controller, Get } from '@nestjs/common';
import { CategoryService } from './category.service.js';

@Controller('categories')
export class CategoryCtrl {
  constructor(private readonly category: CategoryService) {}

  @Get()
  list() {
    return this.category.list();
  }
}
