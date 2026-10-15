import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ProductService } from './product.service.js';
import { productQuerySchema, type ProductQuery } from './schema.js';
import { ImageRegistry } from './image-registry.js';

@Controller('products')
export class ProductCtrl {
  constructor(
    @Inject(ProductService) private readonly product: ProductService,
    @Inject(ImageRegistry) private readonly images: ImageRegistry,
  ) {}

  @Get()
  async list(@Query({ schema: productQuerySchema }) query: ProductQuery) {
    const page = await this.product.list(query);
    return { ...page, items: await this.images.enrich(page.items) };
  }

  @Get(':slug')
  async get(@Param('slug') slug: string) {
    const product = await this.product.get(slug);
    return (await this.images.enrich([product]))[0]!;
  }
}
