import { Controller, Get, Param, Query } from '@nestjs/common';
import { ProductService } from './product.service.js';

@Controller('products')
export class ProductCtrl {
  constructor(private readonly product: ProductService) {}

  @Get()
  list(@Query('category') category?: string) {
    return this.product.list(category);
  }

  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.product.get(slug);
  }
}
