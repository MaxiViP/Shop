export function pageInfo(total: number, requested: number, size: number) {
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(0, requested), pages - 1);
  return { page, pages, skip: page * size, first: total ? page * size + 1 : 0,
    last: Math.min(total, (page + 1) * size), label: `Страница ${page + 1} из ${pages}` };
}
