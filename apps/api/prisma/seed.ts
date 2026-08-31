import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Unit } from '../src/db/gen/client.js';

const url = process.env.DATABASE_URL;

if (!url) throw new Error('DATABASE_URL is not set');

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});

const categories = [
  { name: 'Овощи', slug: 'vegetables', sort: 1 },
  { name: 'Фрукты', slug: 'fruits', sort: 2 },
  { name: 'Зелень', slug: 'greens', sort: 3 },
];

const products = [
  {
    name: 'Томаты розовые',
    slug: 'pink-tomatoes',
    price: 45000,
    priceQty: 1000,
    unit: Unit.GRAM,
    step: 100,
    min: 300,
    category: 'vegetables',
    sort: 1,
  },
  {
    name: 'Картофель',
    slug: 'potato',
    price: 9000,
    priceQty: 1000,
    unit: Unit.GRAM,
    step: 100,
    min: 500,
    category: 'vegetables',
    sort: 2,
  },
  {
    name: 'Авокадо',
    slug: 'avocado',
    price: 14900,
    priceQty: 1,
    unit: Unit.PIECE,
    step: 1,
    min: 1,
    category: 'fruits',
    sort: 1,
  },
  {
    name: 'Манго',
    slug: 'mango',
    price: 39900,
    priceQty: 1,
    unit: Unit.PIECE,
    step: 1,
    min: 1,
    category: 'fruits',
    sort: 2,
  },
  {
    name: 'Кинза',
    slug: 'cilantro',
    price: 8900,
    priceQty: 1,
    unit: Unit.BUNCH,
    step: 1,
    min: 1,
    category: 'greens',
    sort: 1,
  },
  {
    name: 'Укроп',
    slug: 'dill',
    price: 7900,
    priceQty: 1,
    unit: Unit.BUNCH,
    step: 1,
    min: 1,
    category: 'greens',
    sort: 2,
  },
];

async function main() {
  for (const category of categories) {
    await db.category.upsert({
      where: { slug: category.slug },
      update: category,
      create: category,
    });
  }

  for (const { category, ...product } of products) {
    await db.product.upsert({
      where: { slug: product.slug },
      update: {
        ...product,
        category: { connect: { slug: category } },
      },
      create: {
        ...product,
        category: { connect: { slug: category } },
      },
    });
  }
}

main().finally(() => db.$disconnect());
