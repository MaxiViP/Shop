import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { CategoryInput } from './schema.js';
import { dbError } from './errors.js';

@Injectable()
export class AdminCategoriesService {
  constructor(private readonly db: DbService) {}
  list() {
    return this.db.category.findMany({
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      include: { _count: { select: { products: true, children: true } } },
    });
  }
  async create(data: CategoryInput) {
    try {
      return await this.db.category.create({ data });
    } catch (error) {
      return dbError(error);
    }
  }
  async update(id: number, data: Partial<CategoryInput>) {
    try {
      return await this.db.$transaction(
        async (db) => {
          let parent = data.parentId;
          const visited = new Set<number>([id]);
          while (parent) {
            if (visited.has(parent))
              throw new BadRequestException('Нельзя создавать цикл категорий');
            visited.add(parent);
            const row = await db.category.findUnique({
              where: { id: parent },
              select: { parentId: true },
            });
            if (!row)
              throw new BadRequestException(
                'Родительская категория не найдена',
              );
            parent = row.parentId;
          }
          return db.category.update({ where: { id }, data });
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      return dbError(error);
    }
  }
  async remove(id: number) {
    try {
      await this.db.$transaction(
        async (db) => {
          const row = await db.category.findUniqueOrThrow({
            where: { id },
            include: { _count: { select: { products: true, children: true } } },
          });
          if (row._count.products || row._count.children)
            throw new ConflictException(
              'Категория содержит товары или подкатегории. Сначала скройте её',
            );
          await db.category.delete({ where: { id } });
        },
        { isolationLevel: 'Serializable' },
      );
      return { ok: true };
    } catch (error) {
      return dbError(error);
    }
  }
}
