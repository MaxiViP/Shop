import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';

@Injectable()
export class ProductService {
  constructor(private readonly db: DbService) {}

  list() {
    return this.db.product.findMany({
      where: { active: true },
      include: {
        category: true,
        images: true,
      },
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
    });
  }
}
