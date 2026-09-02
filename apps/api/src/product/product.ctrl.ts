import { Controller, Get, Param, Query } from '@nestjs/common';
import { ProductService } from './product.service.js';
import { productQuerySchema, type ProductQuery } from './schema.js';

@Controller('products')
export class ProductCtrl {
  constructor(private readonly product: ProductService) {}

  @Get()
  list(@Query({ schema: productQuerySchema }) query: ProductQuery) {
    return this.product.list(query);
  }

  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.product.get(slug);
  }
}
