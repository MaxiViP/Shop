import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';

@Injectable()
export class CategoryService {
  constructor(private readonly db: DbService) {}

  list() {
    return this.db.category.findMany({
      where: { active: true },
      select: {
        id: true,
        name: true,
        slug: true,
      },
      orderBy: {
        sort: 'asc',
      },
    });
  }
}
