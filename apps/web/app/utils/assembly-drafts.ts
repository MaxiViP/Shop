import { reactive } from "vue";

type Row = { id: number; qty: number; actualQty: number | null };
export function assemblyDrafts() {
  const values = reactive<Record<number, number>>({});
  const saved = new Map<number, number>();
  function sync(rows: Row[]) {
    const ids = new Set(rows.map((row) => row.id));
    for (const key of saved.keys())
      if (!ids.has(key)) {
        saved.delete(key);
        Reflect.deleteProperty(values, key);
      }
    for (const row of rows) {
      const value = row.actualQty ?? row.qty;
      if (values[row.id] === undefined || values[row.id] === saved.get(row.id))
        values[row.id] = value;
      saved.set(row.id, value);
    }
  }
  function reset(id: number) {
    const value = saved.get(id);
    if (value !== undefined) values[id] = value;
  }
  return { values, sync, reset };
}
