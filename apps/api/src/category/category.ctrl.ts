import { Controller, Get } from '@nestjs/common';
import { CategoryService } from './category.service.js';

@Controller('categories')
export class CategoryCtrl {
  constructor(private readonly category: CategoryService) {}

  @Get('points')
  points() { return this.category.points(); }

  @Get()
  list() {
    return this.category.list();
  }
}
