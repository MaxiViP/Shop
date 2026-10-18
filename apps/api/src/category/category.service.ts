import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';

@Injectable()
export class CategoryService {
  constructor(private readonly db: DbService) {}

  points() {
    return this.db.marketPoint.findMany({ where: { isPublished: true, OR: [{ isOurPoint: true }, { cardColor: { not: null } }] },
      select: { id: true, slug: true, name: true, cardColor: true, isOurPoint: true },
      orderBy: [{ isOurPoint: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }] });
  }

  list() {
    return this.db.category.findMany({
      where: { active: true },
      select: {
        id: true,
        name: true,
        slug: true,
      },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    });
  }
}
