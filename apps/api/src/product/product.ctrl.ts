import { Controller, Get } from '@nestjs/common';
import { ProductService } from './product.service.js';

@Controller('products')
export class ProductCtrl {
  constructor(private readonly product: ProductService) {}

  @Get()
  list() {
    return this.product.list();
  }
}
