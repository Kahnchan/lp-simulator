import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  toFunctionSelector,
  type Address,
} from "viem";
import {
  assertChainId,
  FEE_DESCRIPTORS,
  getNetworkSnapshot,
  inspectStrategyFees,
  rationalToDecimal,
  sqrtPriceX96ToPrice,
  strategyFeeHash,
  tickToPrice,
  validateRpcUrl,
} from "./chain";

test("sqrt price accounts for unequal token decimals without floating point", () => {
  const q96 = 1n << 96n;
  assert.equal(sqrtPriceX96ToPrice(q96, 18, 6), "1000000000000");
  assert.equal(sqrtPriceX96ToPrice(q96, 6, 18), "0.000000000001");
  assert.equal(sqrtPriceX96ToPrice(q96 * 2n, 18, 18), "4");
  assert.equal(sqrtPriceX96ToPrice(q96 / 2n, 18, 18), "0.25");
  assert.equal(sqrtPriceX96ToPrice(q96, 0, 255), `0.${"0".repeat(254)}1`);
});

test("price conversion rejects unusable values and uint/decimal overflows", () => {
  for (const bad of [0n, -1n, 1n << 160n]) {
    assert.throws(() => sqrtPriceX96ToPrice(bad, 18, 6));
  }
  for (const bad of [-1, 256, 1.5, NaN]) {
    assert.throws(() => sqrtPriceX96ToPrice(1n << 96n, bad, 6));
  }
});

test("tick price keeps direction, decimals and endpoints", () => {
  assert.equal(tickToPrice(0, 18, 6), "1000000000000");
  assert.equal(tickToPrice(1, 18, 18), "1.0001");
  assert.equal(tickToPrice(2, 18, 18), "1.00020001");
  assert.equal(
    tickToPrice(-1, 18, 18),
    "0.999900009999000099990000999900009999",
  );
  const min = Number(tickToPrice(-887272, 18, 18));
  const max = Number(tickToPrice(887272, 18, 18));
  assert.ok(Math.abs(min * max - 1) < 1e-14);
  assert.ok(max > 3.4e38 && max < 3.5e38);
  assert.notEqual(tickToPrice(-887272, 0, 255), "0");
  for (const tick of [-887273, 887273, 0.5, NaN, Infinity]) {
    assert.throws(() => tickToPrice(tick, 18, 18));
  }
});

test("decimal display preserves small positives and truncates recurring fractions", () => {
  assert.equal(rationalToDecimal(1n, 3n), `0.${"3".repeat(36)}`);
  assert.equal(rationalToDecimal(1n, 10n ** 300n), `0.${"0".repeat(299)}1`);
  assert.equal(rationalToDecimal(0n, 1n), "0");
  assert.equal(rationalToDecimal(1234500n, 10000n), "123.45");
  assert.throws(() => rationalToDecimal(1n, 0n));
  assert.throws(() => rationalToDecimal(1n, 10n ** 600n));
});

test("read adapter stops at a mismatched chain before reading any state", async (t) => {
  const methods: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      const request = JSON.parse(String(options.body));
      methods.push(request.method);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x2105" }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  );
  await assert.rejects(
    getNetworkSnapshot(4663, "http://127.0.0.1:8545"),
    /4663.*8453/,
  );
  assert.deepEqual(methods, ["eth_chainId"]);
});

test("RPC errors surface without falling back to demo values", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      const request = JSON.parse(String(options.body));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message: "fixture RPC unavailable" },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  );
  await assert.rejects(
    getNetworkSnapshot(4663, "http://127.0.0.1:8545"),
    /fixture RPC unavailable/,
  );
});

test("fee keys match strategy plus bytes4 packed encoding, not ABI padding", () => {
  const strategy = "0x0000000000000000000000000000000000000123";
  const selector = "0x12345678";
  assert.equal(
    strategyFeeHash(strategy, selector),
    keccak256(encodePacked(["address", "bytes4"], [strategy, selector])),
  );
  assert.notEqual(
    strategyFeeHash(strategy, selector),
    strategyFeeHash(strategy, "0x12345679"),
  );
  assert.throws(() => strategyFeeHash(strategy, "0x1234"));
  assert.throws(() =>
    strategyFeeHash("0x0000000000000000000000000000000000000000", selector),
  );
});

test("known fee descriptors use source fee names, not transaction function selectors", () => {
  assert.deepEqual(FEE_DESCRIPTORS, {
    FarmDepositFee: "0xab273376",
    FarmHarvestFee: "0xe400534d",
    FarmCompoundFee: "0x1d5b8de5",
    FarmWithdrawFee: "0xdfa64d37",
    FarmHarvestForFee: "0x139f6e66",
    FarmCompoundForFee: "0x6b277b6f",
    RebalanceLowFee: "0xcb922c4d",
    RebalanceMidFee: "0xc552bcd8",
    RebalanceHighFee: "0xa7e26cbd",
  });
  assert.notEqual(
    FEE_DESCRIPTORS.FarmDepositFee,
    toFunctionSelector("deposit()"),
  );
});

test("fee inspection resolves strategy library and registry at a single block", async (t) => {
  const strategy = "0x1111111111111111111111111111111111111111";
  const feesLib = "0x2222222222222222222222222222222222222222";
  const registry = "0x3333333333333333333333333333333333333333";
  const feeStrategy = "0x4444444444444444444444444444444444444444";
  const calls: Array<{ method: string; params: any[] }> = [];
  const encodeAddress = (address: Address) =>
    encodeAbiParameters([{ type: "address" }], [address]);
  const lowHash = keccak256(
    encodePacked(
      ["address", "bytes4"],
      [feeStrategy, FEE_DESCRIPTORS.RebalanceLowFee],
    ),
  );
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      const request = JSON.parse(String(options.body));
      calls.push(request);
      let result: string;
      if (request.method === "eth_chainId") result = "0x1237";
      else if (request.method === "eth_blockNumber") result = "0x123";
      else if (request.method === "eth_getCode") result = "0x6000";
      else if (request.method === "eth_call") {
        const { to, data } = request.params[0];
        if (to === strategy && data === toFunctionSelector("feesLib()"))
          result = encodeAddress(feesLib);
        else if (
          to === strategy &&
          data === toFunctionSelector("strategyAddress()")
        )
          result = encodeAddress(feeStrategy);
        else if (to === feesLib && data === toFunctionSelector("registry()"))
          result = encodeAddress(registry);
        else if (
          to === registry &&
          data.startsWith(toFunctionSelector("feeRegistry(bytes32)"))
        ) {
          result = encodeAbiParameters(
            [{ type: "uint256" }],
            [data.slice(10) === lowHash.slice(2) ? 5n : 0n],
          );
        } else throw new Error(`Unexpected contract read: ${to} ${data}`);
      } else throw new Error(`Unexpected RPC method: ${request.method}`);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  );
  const inspection = await inspectStrategyFees(
    4663,
    "http://127.0.0.1:8545",
    strategy,
  );
  assert.equal(inspection.feesLib, feesLib);
  assert.equal(inspection.registry, registry);
  assert.equal(inspection.feeStrategy, feeStrategy);
  assert.equal(inspection.registryLinkVerified, true);
  assert.equal(inspection.zeroFeesForCheckedSelectors, false);
  assert.equal(inspection.checks.length, 9);
  assert.equal(
    inspection.checks.find((row) => row.descriptorName === "RebalanceLowFee")
      ?.feeBps,
    5n,
  );
  for (const call of calls.filter((call) =>
    ["eth_getCode", "eth_call"].includes(call.method),
  )) {
    assert.equal(
      call.params[1],
      "0x123",
      "all contract reads must use the snapshot block",
    );
  }
});

test("RPC chain mismatch is rejected; URL supports local RPC but rejects other protocols", () => {
  assert.doesNotThrow(() => assertChainId(4663, 4663));
  assert.throws(() => assertChainId(4663, 8453), /4663.*8453/);
  assert.equal(
    validateRpcUrl(" http://127.0.0.1:8545 "),
    "http://127.0.0.1:8545/",
  );
  assert.equal(
    validateRpcUrl("https://mainnet.base.org"),
    "https://mainnet.base.org/",
  );
  for (const value of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "ws://localhost:8545",
    "https://user:secret@rpc.example",
    "https://rpc.example/#secret",
    "localhost",
  ]) {
    assert.throws(() => validateRpcUrl(value));
  }
});

import { deriveV4PoolId, loadV4Pool, type V4PoolKey } from "./chain";

const v4FixtureKey: V4PoolKey = {
  currency0: "0x0000000000000000000000000000000000000000",
  currency1: "0x3333333333333333333333333333333333333333",
  fee: 3000,
  tickSpacing: 60,
  hooks: "0x0000000000000000000000000000000000000000",
};

test("V4 ID uses all five full ABI slots and rejects invalid currency ordering", () => {
  const rawEncoding =
    `0x${"0".repeat(64)}${"0".repeat(24)}${"3".repeat(40)}${"bb8".padStart(64, "0")}${"3c".padStart(64, "0")}${"0".repeat(64)}` as `0x${string}`;
  assert.equal(deriveV4PoolId(v4FixtureKey), keccak256(rawEncoding));
  assert.notEqual(
    deriveV4PoolId(v4FixtureKey),
    deriveV4PoolId({ ...v4FixtureKey, fee: 500 }),
  );
  assert.throws(() =>
    deriveV4PoolId({ ...v4FixtureKey, currency0: v4FixtureKey.currency1 }),
  );
  assert.throws(() =>
    deriveV4PoolId({
      ...v4FixtureKey,
      currency0: v4FixtureKey.currency1,
      currency1: v4FixtureKey.currency0,
    }),
  );
  for (const fee of [-1, 1.5, 1000001, 0x800001])
    assert.throws(() => deriveV4PoolId({ ...v4FixtureKey, fee }));
  assert.doesNotThrow(() => deriveV4PoolId({ ...v4FixtureKey, fee: 0x800000 }));
  assert.throws(() => deriveV4PoolId({ ...v4FixtureKey, tickSpacing: 0 }));
});

function v4RpcFixture(sqrtPriceX96: bigint) {
  const stateView = "0x1111111111111111111111111111111111111111";
  const manager = "0x2222222222222222222222222222222222222222";
  const calls: Array<{ method: string; params: any[] }> = [];
  const fetch = async (_url: unknown, options: RequestInit) => {
    const request = JSON.parse(String(options.body));
    calls.push(request);
    let result: string;
    if (request.method === "eth_chainId") result = "0x1237";
    else if (request.method === "eth_blockNumber") result = "0x456";
    else if (request.method === "eth_getCode") result = "0x6000";
    else if (request.method === "eth_call") {
      const { to, data } = request.params[0];
      if (to === stateView && data === toFunctionSelector("poolManager()")) {
        result = encodeAbiParameters([{ type: "address" }], [manager]);
      } else if (
        to === stateView &&
        data.startsWith(toFunctionSelector("getSlot0(bytes32)"))
      ) {
        assert.equal(`0x${data.slice(10)}`, deriveV4PoolId(v4FixtureKey));
        result = encodeAbiParameters(
          [
            { type: "uint160" },
            { type: "int24" },
            { type: "uint24" },
            { type: "uint24" },
          ],
          [sqrtPriceX96, 0, 0, 3000],
        );
      } else if (
        to === stateView &&
        data.startsWith(toFunctionSelector("getLiquidity(bytes32)"))
      ) {
        assert.equal(`0x${data.slice(10)}`, deriveV4PoolId(v4FixtureKey));
        result = encodeAbiParameters([{ type: "uint128" }], [123456n]);
      } else if (
        to === v4FixtureKey.currency1 &&
        data === toFunctionSelector("symbol()")
      ) {
        result = encodeAbiParameters([{ type: "string" }], ["USDG"]);
      } else if (
        to === v4FixtureKey.currency1 &&
        data === toFunctionSelector("decimals()")
      ) {
        result = encodeAbiParameters([{ type: "uint8" }], [6]);
      } else throw new Error(`Unexpected V4 read: ${to} ${data}`);
    } else throw new Error(`Unexpected RPC call ${request.method}`);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  return { stateView, manager, calls, fetch };
}

test("V4 reads use the derived key, native ETH and token decimals at one block", async (t) => {
  const fixture = v4RpcFixture(1n << 96n);
  t.mock.method(globalThis, "fetch", fixture.fetch);
  const snapshot = await loadV4Pool(
    4663,
    "http://127.0.0.1:8545",
    fixture.stateView,
    v4FixtureKey,
  );
  assert.equal(snapshot.poolManager, fixture.manager);
  assert.equal(snapshot.poolId, deriveV4PoolId(v4FixtureKey));
  assert.equal(snapshot.token0.symbol, "ETH");
  assert.equal(snapshot.token0.decimals, 18);
  assert.equal(snapshot.token1.symbol, "USDG");
  assert.equal(snapshot.priceToken1PerToken0, "1000000000000");
  assert.equal(snapshot.liquidity, 123456n);
  assert.equal(snapshot.feePips, 3000);
  for (const call of fixture.calls.filter((call) =>
    ["eth_call", "eth_getCode"].includes(call.method),
  )) {
    assert.equal(call.params[1], "0x456");
    assert.notEqual(
      call.params[0],
      v4FixtureKey.currency0,
      "native ETH must not receive ERC20 reads",
    );
  }
});

test("V4 rejects uninitialized pools instead of treating zero price as data", async (t) => {
  const fixture = v4RpcFixture(0n);
  t.mock.method(globalThis, "fetch", fixture.fetch);
  await assert.rejects(
    loadV4Pool(4663, "http://127.0.0.1:8545", fixture.stateView, v4FixtureKey),
    /尚未初始化/,
  );
});
