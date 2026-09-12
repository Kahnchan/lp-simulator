import assert from "node:assert/strict";
import test from "node:test";
import {
  simulationModel,
  validateNftId,
  type SimulationPosition,
} from "./lpSimulation";
const p: SimulationPosition = {
  chainId: 8453,
  manager: "0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53",
  tokenId: "5923247",
  owner: "0xa51b654b482b702760f3d3d11badde5e86b322e2",
  blockNumber: "51158113",
  blockTime: "2026-09-11T05:46:13Z",
  token0: {
    address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    symbol: "USDC",
    decimals: 6,
  },
  token1: {
    address: "0xb095274743941e953c746f9c228da9c18bb6ec29",
    symbol: "LAPTOP",
    decimals: 18,
  },
  liquidity: "813882677826104",
  tickLower: 278400,
  tickUpper: 291800,
  sqrtPriceX96: "120065976465402831990354366291465907",
  amount0: "161.634231",
  amount1: "330.496875180450127427",
  warnings: [],
};
test("real asymmetric LAPTOP position preserves liquidity and known boundary values", () => {
  const m = simulationModel(p, true);
  assert.equal(m.quote.symbol, "USDC");
  assert.ok(Math.abs(m.at(m.lower).value - 183.3099167) < 0.00001);
  assert.ok(Math.abs(m.at(m.upper).value - 358.2190807) < 0.00001);
  assert.equal(m.at(m.upper * 2).base, 0);
  assert.ok(Math.abs(m.at(m.lower / 2).value - m.at(m.lower).value / 2) < 1e-8);
  assert.ok(Math.abs(m.at(m.price).value - m.currentValue) < 0.00001);
});
test("quote inversion conserves token quantities and reverses boundaries", () => {
  const a = simulationModel(p, false),
    b = simulationModel(p, true);
  for (const price of [a.lower / 2, a.price, a.upper * 2]) {
    const x = a.at(price),
      y = b.at(1 / price);
    assert.ok(Math.abs(x.base - y.quote) < 1e-6);
    assert.ok(Math.abs(x.quote - y.base) < 1e-6);
    assert.ok(Math.abs(x.value / price - y.value) < 1e-6);
  }
});
test("cost comparison does not resize an imported position", () => {
  const m = simulationModel(p, true),
    v = m.at(m.upper).value;
  assert.ok(Math.abs(v - 300 - 58.2190807) < 0.00001);
  assert.ok(Math.abs(v - 1000 + 641.7809193) < 0.00001);
});
test("reject empty positions, invalid prices and invalid NFT identifiers", () => {
  assert.throws(() => simulationModel({ ...p, liquidity: "0" }, true));
  assert.throws(() => simulationModel(p, true).at(0));
  assert.throws(() => simulationModel(p, true).at(NaN));
  for (const id of ["-1", "1.2", "1e4", "", String(2n ** 256n)])
    assert.throws(() => validateNftId(id));
  assert.equal(validateNftId("9007199254740993123"), 9007199254740993123n);
});

test("entry records isolate chain, manager, NFT and quote currency and reject invalid saved values", async () => {
  const { entryRecordKey, parseEntryRecord } = await import(
    "./lpSimulationRecord"
  );
  assert.notEqual(entryRecordKey(p, false), entryRecordKey(p, true));
  assert.notEqual(
    entryRecordKey(p, false),
    entryRecordKey({ ...p, chainId: 1 }, false),
  );
  assert.notEqual(
    entryRecordKey(p, false),
    entryRecordKey({ ...p, tokenId: "7" }, false),
  );
  assert.deepEqual(parseEntryRecord('{"entry":0.4,"cost":300}'), {
    entry: 0.4,
    cost: 300,
  });
  assert.deepEqual(parseEntryRecord(null), { entry: null, cost: null });
  assert.throws(() => parseEntryRecord('{"entry":-1,"cost":300}'));
  assert.throws(() => parseEntryRecord('{"entry":"0.4","cost":300}'));
});

test("historical NFT discovery finds the exact first block and never treats RPC failures as absence", async () => {
  const { firstExistingBlock } = await import("./lpSimulationHistory");
  let calls = 0;
  assert.equal(
    await firstExistingBlock(51_000_000n, async (b) => {
      calls++;
      return b >= 50_123_456n;
    }),
    50_123_456n,
  );
  assert.ok(calls < 45);
  await assert.rejects(
    firstExistingBlock(100n, async (b) => {
      if (b === 0n) throw new Error("RPC unavailable");
      return true;
    }),
    /RPC unavailable/,
  );
  await assert.rejects(
    firstExistingBlock(100n, async () => false),
    /不存在/,
  );
});

test("entry PnL is anchored to entry price or explicit cost, never refreshed current value", async () => {
  const { simulationEntryValue } = await import("./lpSimulation");
  const model = simulationModel(p, true);
  const entry = 0.4175104394078837;
  const baseline = simulationEntryValue(model, entry, null)!;
  assert.equal(model.at(entry).value - baseline, 0);
  assert.ok(model.at(entry * 1.1).value - baseline > 0);
  assert.equal(simulationEntryValue(model, entry, 300), 300);
  assert.equal(simulationEntryValue(model, null, null), null);
  assert.equal(simulationEntryValue(model, NaN, null), null);
});

test("network presets isolate deployments and clear contracts for unsupported combinations", async () => {
  const { simulationNetworks, simulationDeployment } = await import(
    "./lpSimulationNetworks"
  );
  assert.equal(new Set(simulationNetworks.map((n) => n.id)).size, 7);
  for (const n of simulationNetworks)
    assert.match(
      simulationDeployment(n.id, "uniswap-v3").manager,
      /^0x[0-9a-fA-F]{40}$/,
    );
  assert.notEqual(
    simulationDeployment(56, "uniswap-v3").manager,
    simulationDeployment(1, "uniswap-v3").manager,
  );
  assert.equal(simulationDeployment(1, "aerodrome").manager, "");
  assert.equal(simulationDeployment(1, "uniswap-v4").stateView, undefined);
  assert.equal(simulationDeployment(999999, "uniswap-v3").manager, "");
});

test("latest deposit excludes mint itself but preserves later events at the same price", async () => {
  const { additionalDeposit } = await import("./lpSimulationHistory");
  const first = {
    block: "100",
    transaction: "0xabc",
    logIndex: 2,
    price: 0.42,
    time: "",
    method: "",
  };
  assert.equal(additionalDeposit(first, { ...first }), undefined);
  const sameTransaction = { ...first, logIndex: 3 };
  assert.equal(additionalDeposit(first, sameTransaction), sameTransaction);
  const later = { ...first, block: "101", transaction: "0xdef" };
  assert.equal(additionalDeposit(first, later), later);
});

test("PancakeSwap BSC preset uses its own NFT manager and clears unsupported chains", async () => {
  const { simulationDeployment } = await import("./lpSimulationNetworks");
  assert.equal(
    simulationDeployment(56, "pancakeswap-v3").manager,
    "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
  );
  assert.notEqual(
    simulationDeployment(56, "pancakeswap-v3").manager,
    simulationDeployment(56, "uniswap-v3").manager,
  );
  assert.equal(simulationDeployment(8453, "pancakeswap-v3").manager, "");
});

test("saved settings restore per-network RPCs and per-protocol contracts", async () => {
  const { parsePreferences, rememberImport, savedImport } = await import(
    "./lpPreferences"
  );
  let prefs = parsePreferences(null);
  const base = {
    ...prefs.draft,
    rpcUrl: "https://example.com/base",
    manager: "0x1111111111111111111111111111111111111111",
    tokenId: "123",
  };
  prefs = rememberImport(prefs, base);
  const bsc = {
    ...savedImport(prefs, 56, "pancakeswap-v3"),
    rpcUrl: "https://example.com/bsc",
    tokenId: "7413206",
  };
  prefs = parsePreferences(JSON.stringify(rememberImport(prefs, bsc)));
  assert.equal(prefs.draft.tokenId, "7413206");
  assert.equal(savedImport(prefs, 8453, "aerodrome").rpcUrl, base.rpcUrl);
  assert.equal(savedImport(prefs, 8453, "aerodrome").manager, base.manager);
  assert.equal(savedImport(prefs, 56, "pancakeswap-v3").rpcUrl, bsc.rpcUrl);
  assert.equal(parsePreferences("broken").draft.chainId, 8453);
});

test("favorites deduplicate NFT identity, isolate chains and reuse the latest saved RPC", async () => {
  const {
    parseFavorites,
    favoriteKey,
    importFavorite,
    parsePreferences,
    rememberImport,
  } = await import("./lpPreferences");
  const favorite = {
    chainId: 56,
    protocol: "pancakeswap-v3" as const,
    manager: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
    tokenId: "7413206",
    pair: "牛来 / USDT",
  };
  const values = parseFavorites(
    JSON.stringify([
      favorite,
      {
        ...favorite,
        manager: favorite.manager.toLowerCase(),
        tokenId: "07413206",
      },
      { ...favorite, chainId: 1 },
      { ...favorite, tokenId: "bad" },
    ]),
  );
  assert.equal(values.length, 2);
  assert.notEqual(favoriteKey(values[0]), favoriteKey(values[1]));
  let prefs = parsePreferences(null);
  prefs = rememberImport(prefs, {
    ...favorite,
    rpcUrl: "https://example.com/new-rpc",
  });
  assert.equal(
    importFavorite(values[0], prefs).rpcUrl,
    "https://example.com/new-rpc",
  );
  assert.equal(importFavorite(values[0], prefs).tokenId, "7413206");
  assert.deepEqual(parseFavorites('{"bad":1}'), []);
  assert.deepEqual(parseFavorites("broken"), []);
});

import { createPositionCache } from "./lpPositionCache";

test("position snapshots share preloads, expire, and permit explicit refresh", async () => {
  let time = 0;
  let calls = 0;
  const source = {
    chainId: 8453,
    protocol: "aerodrome" as const,
    manager: p.manager,
    tokenId: p.tokenId,
    rpcUrl: "https://mainnet.base.org",
  };
  const cache = createPositionCache(
    async () => {
      calls++;
      return p;
    },
    () => time,
  );
  const preload = cache.load(source);
  assert.equal(cache.load(source), preload);
  assert.equal(await preload, p);
  await cache.load(source);
  assert.equal(calls, 1);
  time = 30_000;
  await cache.load(source);
  assert.equal(calls, 2);
  await cache.load(source, true);
  assert.equal(calls, 3);
  await cache.load({ ...source, rpcUrl: "https://another.example" });
  assert.equal(calls, 4);
});

test("failed position preloads can be retried", async () => {
  let calls = 0;
  const cache = createPositionCache(async () => {
    if (++calls === 1) throw new Error("offline");
    return p;
  });
  const source = {
    chainId: 8453,
    protocol: "aerodrome" as const,
    manager: p.manager,
    tokenId: p.tokenId,
    rpcUrl: "https://mainnet.base.org",
  };
  await assert.rejects(cache.load(source), /offline/);
  assert.equal(await cache.load(source), p);
  assert.equal(calls, 2);
});

test("parallel history windows preserve newest-event ordering and do not skip failed windows", async () => {
  const { newestMatchingBatch } = await import("./lpSimulationHistory");
  const ok = (value: number[]): PromiseFulfilledResult<number[]> => ({
    status: "fulfilled",
    value,
  });
  const failed: PromiseRejectedResult = {
    status: "rejected",
    reason: new Error("RPC failed"),
  };
  assert.deepEqual(
    newestMatchingBatch([ok([]), ok([5]), ok([3])], (n) => n > 0),
    [5],
  );
  assert.throws(
    () => newestMatchingBatch([failed, ok([3])], (n) => n > 0),
    /RPC failed/,
  );
  assert.deepEqual(
    newestMatchingBatch([ok([5]), failed], (n) => n > 0),
    [5],
  );
  assert.deepEqual(
    newestMatchingBatch([ok([]), ok([])], (n) => n > 0),
    [],
  );
});

// USDC conversion must preserve the selected reference token across quote reversal.
import { referenceValue, validPrice, fetchUsdcPrices } from "./lpUsdcPricing";
test("USDC valuation handles both reference orientations and rejects invalid ratios", () => {
  assert.equal(referenceValue(1, 40000, 40000, true, 600), 1200);
  assert.equal(referenceValue(40000, 1, 1 / 40000, false, 600), 1200);
  assert.equal(referenceValue(0, 40000, 40000, true, 300), 300);
  assert.equal(referenceValue(1, 40000, 0, true, 600), null);
  assert.equal(referenceValue(1, 40000, 40000, true, NaN), null);
});
test("USDC price feed rejects stale, low-confidence and invalid quotes", () => {
  const now = 1800000000000;
  const quote = { price: 600, timestamp: now / 1000, confidence: 0.99 };
  assert.ok(validPrice(quote, now));
  assert.equal(
    validPrice({ ...quote, timestamp: now / 1000 - 901 }, now),
    null,
  );
  assert.equal(validPrice({ ...quote, confidence: 0.5 }, now), null);
  assert.equal(validPrice({ ...quote, price: 0 }, now), null);
  assert.equal(validPrice({ ...quote, timestamp: NaN }, now), null);
});

test("entry USDC conversion requests historical quotes rather than today's prices", async (context) => {
  const stamp = 1700000000;
  let requested = "";
  context.mock.method(globalThis, "fetch", async (url: string) => {
    requested = String(url);
    return {
      ok: true,
      json: async () => ({
        coins: {
          "bsc:0xaaa": { price: 600, timestamp: stamp, confidence: 0.99 },
          "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
            price: 0.999,
            timestamp: stamp,
            confidence: 0.99,
          },
        },
      }),
    };
  });
  const result = await fetchUsdcPrices(
    {
      ...p,
      chainId: 56,
      token0: { ...p.token0, address: "0xAAA" },
      token1: { ...p.token1, address: "0xBBB" },
    },
    new AbortController().signal,
    stamp,
  );
  assert.ok(requested.includes("/historical/1700000000/"));
  assert.equal(result[0]?.price, 600 / 0.999);
  assert.equal(result[1], null);
});
