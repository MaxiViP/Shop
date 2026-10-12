import { reactive } from "vue";

type Row = { id: number; qty: number; actualQty: number | null; pieceWeights?: number[] | null };
export function assemblyDrafts() {
  const values = reactive<Record<number, number>>({});
  const saved = new Map<number, number>();
  const weights = reactive<Record<number, number[]>>({});
  const savedWeights = new Map<number, string>();
  function sync(rows: Row[]) {
    const ids = new Set(rows.map((row) => row.id));
    for (const key of saved.keys())
      if (!ids.has(key)) {
        saved.delete(key);
        Reflect.deleteProperty(values, key);
        Reflect.deleteProperty(weights, key);
        savedWeights.delete(key);
      }
    for (const row of rows) {
      const value = row.actualQty ?? row.qty;
      if (values[row.id] === undefined || values[row.id] === saved.get(row.id))
        values[row.id] = value;
      saved.set(row.id, value);
      const before = JSON.stringify(weights[row.id]);
      if (weights[row.id] === undefined || before === savedWeights.get(row.id))
        weights[row.id] = [...(row.pieceWeights ?? [])];
      savedWeights.set(row.id, JSON.stringify(row.pieceWeights ?? []));
    }
  }
  function reset(id: number) {
    const value = saved.get(id);
    if (value !== undefined) values[id] = value;
    if (savedWeights.has(id)) weights[id] = JSON.parse(savedWeights.get(id)!) as number[];
  }
  return { values, weights, sync, reset };
}
