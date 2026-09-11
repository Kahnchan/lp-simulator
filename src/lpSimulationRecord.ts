import type { SimulationPosition } from "./lpSimulation";
export interface EntryRecord {
  entry: number | null;
  cost: number | null;
}
export function entryRecordKey(p: SimulationPosition, reverse: boolean) {
  const quote = reverse ? p.token0 : p.token1;
  return `range-pilot:lp-entry:v1:${p.chainId}:${p.manager.toLowerCase()}:${p.tokenId}:${quote.address.toLowerCase()}`;
}
export function parseEntryRecord(value: string | null): EntryRecord {
  if (!value) return { entry: null, cost: null };
  const record = JSON.parse(value);
  if (!record || typeof record !== "object")
    throw new Error("入场记录格式无效");
  const valid = (v: unknown) =>
    v === null || (typeof v === "number" && Number.isFinite(v) && v > 0);
  if (!valid(record.entry) || !valid(record.cost))
    throw new Error("入场记录数值无效");
  return { entry: record.entry, cost: record.cost };
}
