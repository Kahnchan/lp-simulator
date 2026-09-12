import type { SimulationImport } from "./lpSimulationRead";
import type { SimulationPosition } from "./lpSimulation";

export const positionSourceKey = (v: SimulationImport) =>
  JSON.stringify([
    v.chainId,
    v.protocol,
    v.manager.toLowerCase(),
    v.tokenId.trim(),
    v.rpcUrl,
    v.stateView?.toLowerCase(),
  ]);

// Session-only snapshots: never persist changing chain data as a saved position.
export function createPositionCache(
  read: (source: SimulationImport) => Promise<SimulationPosition>,
  now = Date.now,
) {
  const snapshots = new Map<
    string,
    { value: SimulationPosition; time: number }
  >();
  const pending = new Map<string, Promise<SimulationPosition>>();
  return {
    load(source: SimulationImport, fresh = false): Promise<SimulationPosition> {
      const key = positionSourceKey(source);
      const running = pending.get(key);
      if (running) return running;
      const cached = snapshots.get(key);
      if (!fresh && cached && now() - cached.time < 30_000)
        return Promise.resolve(cached.value);
      const task = Promise.resolve()
        .then(() => read({ ...source }))
        .then((value) => {
          snapshots.delete(key);
          snapshots.set(key, { value, time: now() });
          while (snapshots.size > 30)
            snapshots.delete(snapshots.keys().next().value!);
          return value;
        })
        .finally(() => pending.delete(key));
      pending.set(key, task);
      return task;
    },
  };
}
