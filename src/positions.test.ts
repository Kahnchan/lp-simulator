import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { createPositionMetadataCache } from "./positionMetadataCache";
import { createPositionGetterBatch } from "./positionReadBatch";
import { deriveV4PoolId } from "./chain";
import {
  decodeV4PositionInfo,
  getAmountsForLiquidity,
  getSqrtRatioAtTick,
  positionRangeStatus,
  readPositionsWithClient,
  type PositionReference,
} from "./positions";

const Q96 = 1n << 96n;
const L = 10n ** 18n;
const account = (n: number) =>
  getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const OWNER = account(1),
  MANAGER = account(2),
  FACTORY = account(3),
  POOL = account(4);
const TOKEN0 = account(5),
  TOKEN1 = account(6),
  STATE_VIEW = account(7),
  POOL_MANAGER = account(8);
const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");
const GETTER_TEST_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function factory() view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function getPool(address token0,address token1,uint24 fee) view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function poolManager() view returns (address)",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
]);

test("TickMath integer port matches Uniswap extrema and adjacent tick vectors", () => {
  assert.equal(getSqrtRatioAtTick(-887272), 4295128739n);
  assert.equal(
    getSqrtRatioAtTick(887272),
    1461446703485210103287273052203988822378723970342n,
  );
  assert.equal(getSqrtRatioAtTick(0), Q96);
  assert.equal(getSqrtRatioAtTick(-1), 79224201403219477170569942574n);
  assert.equal(getSqrtRatioAtTick(1), 79232123823359799118286999568n);
  assert.throws(() => getSqrtRatioAtTick(887273));
  assert.throws(() => getSqrtRatioAtTick(-0.1));
});

test("principal amounts are exact at either boundary and remain constant outside", () => {
  // Independent 100-digit decimal reference for sqrt(1.0001^+-60), floor(L*delta).
  const middle = getAmountsForLiquidity(Q96, -60, 60, L);
  assert.deepEqual(middle, {
    amount0Raw: 2995354955910780n,
    amount1Raw: 2995354955910780n,
  });
  const lower = getAmountsForLiquidity(getSqrtRatioAtTick(-60), -60, 60, L);
  const upper = getAmountsForLiquidity(getSqrtRatioAtTick(60), -60, 60, L);
  assert.deepEqual(lower, { amount0Raw: 5999709018652706n, amount1Raw: 0n });
  assert.deepEqual(upper, { amount0Raw: 0n, amount1Raw: 5999709018652706n });
  assert.deepEqual(
    getAmountsForLiquidity(getSqrtRatioAtTick(-120), -60, 60, L),
    lower,
  );
  assert.deepEqual(
    getAmountsForLiquidity(getSqrtRatioAtTick(120), -60, 60, L),
    upper,
  );
  assert.deepEqual(getAmountsForLiquidity(Q96, -60, 60, 0n), {
    amount0Raw: 0n,
    amount1Raw: 0n,
  });
  assert.throws(() => getAmountsForLiquidity(Q96, 60, -60, L));
  assert.throws(() => getAmountsForLiquidity(Q96, -60, 60, -1n));
});

test("range status uses inclusive lower and exclusive upper tick boundaries", () => {
  assert.equal(positionRangeStatus(-61, -60, 60, L), "below-range");
  assert.equal(positionRangeStatus(-60, -60, 60, L), "in-range");
  assert.equal(positionRangeStatus(59, -60, 60, L), "in-range");
  assert.equal(positionRangeStatus(60, -60, 60, L), "above-range");
  assert.equal(positionRangeStatus(0, -60, 60, 0n), "empty");
});

function packedInfo(
  poolId: string,
  lower: number,
  upper: number,
  subscriber = false,
) {
  const signedBits = (value: number) => BigInt(value) & 0xffffffn;
  return (
    ((BigInt(poolId) >> 56n) << 56n) |
    (signedBits(upper) << 32n) |
    (signedBits(lower) << 8n) |
    BigInt(subscriber)
  );
}

test("V4 packed PositionInfo sign-extends each negative int24 independently", () => {
  const hash = `0x${"ab".repeat(32)}`;
  const result = decodeV4PositionInfo(packedInfo(hash, -887200, -60, true));
  assert.equal(result.tickLower, -887200);
  assert.equal(result.tickUpper, -60);
  assert.equal(result.hasSubscriber, true);
  assert.equal(result.truncatedPoolId, BigInt(hash) >> 56n);
  assert.throws(() => decodeV4PositionInfo(-1n));
  assert.throws(() => decodeV4PositionInfo(1n << 256n));
});

const v3Ref: PositionReference = {
  protocol: "uniswap-v3",
  manager: MANAGER,
  factory: FACTORY,
  tokenId: 1n,
  expectedOwner: OWNER,
};
const v4Ref: PositionReference = {
  protocol: "uniswap-v4",
  manager: MANAGER,
  poolManager: POOL_MANAGER,
  stateView: STATE_VIEW,
  tokenId: 1n,
  expectedOwner: OWNER,
};
interface FakeCall {
  address: Address;
  functionName?: string;
  blockNumber: bigint;
  args?: unknown[];
}
function fakeReader(
  options: {
    protocol?: "uniswap-v3" | "uniswap-v4";
    noCode?: Address;
    factory?: Address;
    poolToken0?: Address;
    viewManager?: Address;
    owner?: Address;
    brokenTokenId?: bigint;
    decimalsFailure?: boolean;
    corruptPoolInfo?: boolean;
    nativeToken0?: boolean;
    chainId?: number;
    symbolFailure?: boolean;
    token0Decimals?: number;
    liquidity?: bigint;
    tick?: number;
    multicall?: "supported" | "revert" | "malformed" | "partial" | "rate-limit";
  } = {},
) {
  const calls: FakeCall[] = [];
  const rpcMethods: string[] = [];
  const key = {
    currency0: options.nativeToken0 ? zeroAddress : TOKEN0,
    currency1: TOKEN1,
    fee: 3000,
    tickSpacing: 60,
    hooks: zeroAddress,
  };
  const reader = {
    getChainId: async () => {
      rpcMethods.push("eth_chainId");
      return options.chainId ?? 8453;
    },
    getBlockNumber: async () => {
      rpcMethods.push("eth_blockNumber");
      return 12345n;
    },
    getCode: async (call: FakeCall) => {
      rpcMethods.push("eth_getCode");
      calls.push(call);
      if (call.address === MULTICALL3 && !options.multicall) return "0x";
      return call.address === options.noCode ? "0x" : "0x6000";
    },
    readContract: async (call: FakeCall) => {
      rpcMethods.push("eth_call");
      calls.push(call);
      if (call.functionName !== "aggregate3") return answer(call);
      if (options.multicall === "revert")
        throw new Error("aggregate unsupported");
      if (options.multicall === "rate-limit")
        throw Object.assign(new Error("too many requests"), { code: -32016 });
      if (options.multicall === "malformed") return [];
      const getters = call.args![0] as { target: Address; callData: Hex }[];
      return getters.map(({ target, callData }) => {
        const decoded = decodeFunctionData({
          abi: GETTER_TEST_ABI,
          data: callData,
        });
        if (
          options.multicall === "partial" &&
          decoded.functionName === "ownerOf"
        )
          return { success: false, returnData: "0x" };
        try {
          const result = answer({
            address: target,
            functionName: decoded.functionName,
            args: decoded.args ? [...decoded.args] : undefined,
            blockNumber: call.blockNumber,
          });
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: GETTER_TEST_ABI,
              functionName: decoded.functionName,
              result: result as never,
            }),
          };
        } catch {
          return { success: false, returnData: "0x" };
        }
      });
    },
  };
  function answer(call: FakeCall) {
    switch (call.functionName) {
      case "ownerOf":
        return call.args?.[0] === options.brokenTokenId
          ? account(99)
          : (options.owner ?? OWNER);
      case "factory":
        return options.factory ?? FACTORY;
      case "positions":
        return [
          0n,
          zeroAddress,
          TOKEN0,
          TOKEN1,
          3000,
          -60,
          60,
          options.liquidity ?? L,
          0n,
          0n,
          123n,
          456n,
        ];
      case "getPool":
        return POOL;
      case "slot0":
        return [Q96, options.tick ?? 0, 0, 1, 1, 0, true];
      case "token0":
        return options.poolToken0 ?? TOKEN0;
      case "token1":
        return TOKEN1;
      case "fee":
        return 3000;
      case "tickSpacing":
        return 60;
      case "decimals":
        if (options.decimalsFailure)
          throw new Error("metadata RPC unavailable");
        return call.address === TOKEN0 ? (options.token0Decimals ?? 18) : 6;
      case "symbol":
        if (options.symbolFailure) throw new Error("symbol unavailable");
        return call.address === TOKEN0 ? "TOKEN0" : "TOKEN1";
      case "poolManager":
        return call.address === STATE_VIEW
          ? (options.viewManager ?? POOL_MANAGER)
          : POOL_MANAGER;
      case "getPoolAndPositionInfo":
        return [
          key,
          packedInfo(
            options.corruptPoolInfo
              ? `0x${"ff".repeat(32)}`
              : deriveV4PoolId(key),
            -60,
            60,
          ),
        ];
      case "getPositionLiquidity":
        return options.liquidity ?? L;
      case "getSlot0":
        return [Q96, options.tick ?? 0, 0, 3000];
      default:
        throw new Error(`Unexpected read ${call.functionName}`);
    }
  }
  return {
    client: reader as unknown as Parameters<typeof readPositionsWithClient>[0],
    calls,
    rpcMethods,
  };
}

test("V3 reads a fixed-block ownership and pool snapshot, accounting for unequal decimals", async () => {
  const { client, calls } = fakeReader();
  const result = await readPositionsWithClient(client, {
    chainId: 8453,
    positions: [v3Ref],
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.positions.length, 1);
  const position = result.positions[0];
  assert.equal(position.amount0, "0.00299535495591078");
  assert.equal(position.amount1, "2995354955.91078");
  assert.equal(position.priceCurrent, "1000000000000");
  assert.equal(position.fees.source, "crystallized-only");
  assert.equal(position.fees.amount1, "0.000456");
  assert.equal(position.poolAddress, POOL);
  assert.equal(position.status, "in-range");
  assert.ok(calls.length > 12);
  assert.ok(calls.every((call) => call.blockNumber === 12345n));
});

test("Sickle-owned NFTs validate against holder without pretending wallet custody", async () => {
  const sickle = account(42);
  const { client } = fakeReader({ owner: sickle });
  const result = await readPositionsWithClient(client, {
    chainId: 8453,
    positions: [{ ...v3Ref, expectedOwner: sickle }],
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.positions[0].owner, sickle);
});

test("a failed or transferred NFT is surfaced separately without replacing it with mock amounts", async () => {
  const { client, calls } = fakeReader({ brokenTokenId: 2n });
  const result = await readPositionsWithClient(client, {
    chainId: 8453,
    blockNumber: 999n,
    positions: [v3Ref, { ...v3Ref, tokenId: 2n }],
  });
  assert.equal(result.positions.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].reference.tokenId, 2n);
  assert.match(result.failures[0].message, /持有人已变化/);
  assert.ok(calls.every((call) => call.blockNumber === 999n));
});

test("reader rejects RPC chain mismatch before reading any NFT", async () => {
  const { client, calls } = fakeReader();
  await assert.rejects(
    readPositionsWithClient(client, { chainId: 4663, positions: [v3Ref] }),
    /RPC 网络不匹配/,
  );
  assert.equal(calls.length, 0);
});

test("position read failures retain rate-limit diagnostics without RPC credentials", async () => {
  const { client } = fakeReader();
  const cause = Object.assign(new Error("over rate limit"), { code: -32016 });
  const error = Object.assign(new Error("RPC Request failed", { cause }), {
    shortMessage: "RPC Request failed.",
    details: "over rate limit https://rpc.example/private-key",
  });
  client.getCode = async () => {
    throw error;
  };
  const result = await readPositionsWithClient(client, {
    chainId: 8453,
    positions: [v3Ref],
  });
  assert.equal(result.positions.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /限流|请求过于频繁/);
  assert.doesNotMatch(result.failures[0].message, /private-key|rpc\.example/);
});

test("missing contract code, unexpected factory and wrong pool token fail closed", async () => {
  for (const options of [
    { noCode: MANAGER },
    { noCode: POOL },
    { noCode: TOKEN0 },
    { factory: account(20) },
    { poolToken0: account(21) },
  ]) {
    const { client } = fakeReader(options);
    const result = await readPositionsWithClient(client, {
      chainId: 8453,
      positions: [v3Ref],
    });
    assert.equal(result.positions.length, 0);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, /没有合约代码|不匹配/);
  }
});

test("unavailable decimals do not silently fall back to 18", async () => {
  const { client } = fakeReader({ decimalsFailure: true });
  const result = await readPositionsWithClient(client, {
    chainId: 8453,
    positions: [v3Ref],
  });
  assert.equal(result.positions.length, 0);
  assert.match(result.failures[0].message, /metadata RPC unavailable/);
});

test("V4 reads the full pool key, verifies packed pool id and decodes negative ticks", async () => {
  const { client, calls } = fakeReader({ protocol: "uniswap-v4" });
  const result = await readPositionsWithClient(client, {
    chainId: 8453,
    positions: [v4Ref],
  });
  assert.deepEqual(result.failures, []);
  const position = result.positions[0];
  assert.equal(position.tickLower, -60);
  assert.equal(position.tickUpper, 60);
  assert.equal(position.poolManager, POOL_MANAGER);
  assert.equal(position.stateView, STATE_VIEW);
  assert.equal(position.fees.source, "unavailable");
  assert.equal(position.fees.amount0Raw, undefined);
  assert.equal(position.amount0Raw, 2995354955910780n);
  assert.ok(calls.every((call) => call.blockNumber === result.blockNumber));
});

test("V4 native currency is ETH and does not require ERC20 contract code", async () => {
  const { client, calls } = fakeReader({ nativeToken0: true });
  const result = await readPositionsWithClient(client, {
    chainId: 8453,
    positions: [v4Ref],
  });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.positions[0].token0, {
    address: zeroAddress,
    decimals: 18,
    symbol: "ETH",
  });
  assert.ok(calls.every((call) => call.address !== zeroAddress));
});

test("V4 mismatched StateView linkage and packed pool id are rejected", async () => {
  for (const options of [
    { viewManager: account(22) },
    { corruptPoolInfo: true },
    { noCode: STATE_VIEW },
    { noCode: POOL_MANAGER },
  ]) {
    const { client } = fakeReader(options);
    const result = await readPositionsWithClient(client, {
      chainId: 8453,
      positions: [v4Ref],
    });
    assert.equal(result.positions.length, 0);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, /不匹配|没有合约代码/);
  }
});

test("fixed-block Multicall reduces V3/V4 reads without changing position results", async () => {
  for (const reference of [v3Ref, v4Ref]) {
    const direct = fakeReader();
    const batched = fakeReader({ multicall: "supported" });
    const options = {
      chainId: 8453,
      blockNumber: 999n,
      positions: [reference],
    };
    const baseline = await readPositionsWithClient(direct.client, options);
    const result = await readPositionsWithClient(batched.client, {
      ...options,
      cacheMode: "observe",
    });
    assert.deepEqual(result, baseline);
    assert.ok(batched.rpcMethods.length < direct.rpcMethods.length);
    assert.ok(batched.calls.every((call) => call.blockNumber === 999n));
    const aggregates = batched.calls.filter(
      (call) => call.functionName === "aggregate3",
    );
    assert.ok(aggregates.length > 0);
    for (const call of aggregates) {
      const getters = call.args![0] as { target: Address }[];
      // Arbitrary ERC20 metadata keeps direct caller semantics.
      assert.ok(
        getters.every(({ target }) => target !== TOKEN0 && target !== TOKEN1),
      );
      assert.ok(getters.length <= 64);
    }
    if (reference.protocol === "uniswap-v3") {
      assert.equal(direct.rpcMethods.length, 20);
      assert.equal(batched.rpcMethods.length, 14);
    }
  }
});

test("unsupported or partial Multicall falls back at the same block and preserves failures", async () => {
  for (const multicall of ["revert", "malformed", "partial"] as const) {
    const { client, calls } = fakeReader({ multicall, brokenTokenId: 2n });
    const result = await readPositionsWithClient(client, {
      chainId: 8453,
      cacheMode: "observe",
      blockNumber: 987n,
      positions: [v3Ref, { ...v3Ref, tokenId: 2n }],
    });
    assert.equal(result.positions.length, 1);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, /持有人已变化/);
    assert.ok(calls.every((call) => call.blockNumber === 987n));
    assert.ok(calls.some((call) => call.functionName === "ownerOf"));
  }
});

test("Multicall throttling does not fan out into individual retries", async () => {
  const { client, calls } = fakeReader({ multicall: "rate-limit" });
  const result = await readPositionsWithClient(client, {
    chainId: 8453,
    cacheMode: "observe",
    positions: [v3Ref],
  });
  assert.equal(result.positions.length, 0);
  assert.match(result.failures[0].message, /限流|请求过于频繁/);
  assert.equal(
    calls.filter((call) => call.functionName === "ownerOf").length,
    0,
  );
});

test("fresh reads and other networks never route through Multicall", async () => {
  for (const options of [
    { chainId: 8453 },
    { chainId: 8453, cacheMode: "fresh" as const },
    { chainId: 4663, cacheMode: "observe" as const },
  ]) {
    const { client, calls } = fakeReader({
      chainId: options.chainId,
      multicall: "supported",
    });
    const result = await readPositionsWithClient(client, {
      ...options,
      positions: [v3Ref],
    });
    assert.equal(result.positions.length, 1);
    assert.ok(calls.every((call) => call.address !== MULTICALL3));
    assert.ok(calls.some((call) => call.functionName === "ownerOf"));
  }
});

test("explicit callers and other block requests bypass the getter batch", async () => {
  const { client, calls } = fakeReader({ multicall: "supported" });
  const read = createPositionGetterBatch(client, 999n);
  const getter = {
    address: MANAGER,
    abi: GETTER_TEST_ABI,
    functionName: "ownerOf" as const,
    args: [1n] as const,
  };
  await Promise.all([
    read({ ...getter, blockNumber: 999n, account: OWNER }),
    read({ ...getter, blockNumber: 1000n }),
  ]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.functionName === "ownerOf"));
  assert.equal((calls[0] as FakeCall & { account: Address }).account, OWNER);
  assert.equal(calls[1].blockNumber, 1000n);
});

test("observe metadata cache reduces warm reads while ownership, liquidity and price stay fresh", async () => {
  const cache = createPositionMetadataCache();
  const fakeOptions = {
    multicall: "supported" as const,
    liquidity: L,
    tick: 0,
    owner: OWNER,
  };
  const { client, calls, rpcMethods } = fakeReader(fakeOptions);
  const options = {
    chainId: 8453,
    rpcUrl: "https://rpc.example",
    blockNumber: 999n,
    cacheMode: "observe" as const,
    positions: [v3Ref],
  };
  const cold = await readPositionsWithClient(client, options, cache);
  assert.equal(cold.positions.length, 1);
  assert.equal(rpcMethods.length, 14);
  calls.length = 0;
  rpcMethods.length = 0;
  fakeOptions.liquidity = 0n;
  fakeOptions.tick = 65;
  const warm = await readPositionsWithClient(
    client,
    { ...options, blockNumber: 1000n },
    cache,
  );
  assert.equal(warm.positions[0].liquidity, 0n);
  assert.equal(warm.positions[0].tick, 65);
  assert.equal(rpcMethods.length, 8);
  assert.equal(
    calls.filter(
      (call) =>
        call.functionName === "decimals" || call.functionName === "symbol",
    ).length,
    0,
  );
  assert.ok(calls.every((call) => call.blockNumber === 1000n));
  fakeOptions.owner = account(90);
  const transferred = await readPositionsWithClient(client, options, cache);
  assert.equal(transferred.positions.length, 0);
  assert.match(transferred.failures[0].message, /持有人已变化/);
});

test("fresh is the default and bypasses warm observation metadata", async () => {
  const cache = createPositionMetadataCache();
  const fakeOptions = { token0Decimals: 18 };
  const { client } = fakeReader(fakeOptions);
  const options = {
    chainId: 8453,
    rpcUrl: "https://rpc.example",
    positions: [v3Ref],
  };
  await readPositionsWithClient(
    client,
    { ...options, cacheMode: "observe" },
    cache,
  );
  fakeOptions.token0Decimals = 8;
  const cached = await readPositionsWithClient(
    client,
    { ...options, cacheMode: "observe" },
    cache,
  );
  assert.equal(cached.positions[0].token0.decimals, 18);
  for (const cacheMode of [undefined, "fresh"] as const) {
    const fresh = await readPositionsWithClient(
      client,
      { ...options, cacheMode },
      cache,
    );
    assert.equal(fresh.positions[0].token0.decimals, 8);
  }
});

test("observation metadata is isolated by normalized RPC and chain and still verifies client identity", async () => {
  const cache = createPositionMetadataCache();
  const fakeOptions = { token0Decimals: 18, chainId: 8453 };
  const { client } = fakeReader(fakeOptions);
  const options = {
    chainId: 8453,
    rpcUrl: "https://rpc.example",
    cacheMode: "observe" as const,
    positions: [v3Ref],
  };
  await readPositionsWithClient(client, options, cache);
  fakeOptions.token0Decimals = 8;
  const normalized = await readPositionsWithClient(
    client,
    { ...options, rpcUrl: "https://rpc.example/" },
    cache,
  );
  assert.equal(normalized.positions[0].token0.decimals, 18);
  const otherRpc = await readPositionsWithClient(
    client,
    { ...options, rpcUrl: "https://other.example" },
    cache,
  );
  assert.equal(otherRpc.positions[0].token0.decimals, 8);
  fakeOptions.chainId = 4663;
  const otherChain = await readPositionsWithClient(
    client,
    { ...options, chainId: 4663 },
    cache,
  );
  assert.equal(otherChain.positions[0].token0.decimals, 8);
  await assert.rejects(
    readPositionsWithClient(client, options, cache),
    /RPC 网络不匹配/,
  );
});

test("failed metadata and fallback symbols are not cached across observations", async () => {
  for (const failure of ["decimalsFailure", "symbolFailure"] as const) {
    const cache = createPositionMetadataCache();
    const fakeOptions = { [failure]: true };
    const { client, calls } = fakeReader(fakeOptions);
    const options = {
      chainId: 8453,
      rpcUrl: "https://rpc.example",
      cacheMode: "observe" as const,
      positions: [v3Ref],
    };
    const failed = await readPositionsWithClient(client, options, cache);
    if (failure === "decimalsFailure") assert.equal(failed.positions.length, 0);
    else assert.notEqual(failed.positions[0].token0.symbol, "TOKEN0");
    fakeOptions[failure] = false;
    calls.length = 0;
    const retry = await readPositionsWithClient(client, options, cache);
    assert.equal(retry.positions[0].token0.symbol, "TOKEN0");
    assert.equal(
      calls.filter((call) => call.functionName === "decimals").length,
      2,
    );
  }
});

test("metadata cache TTL, capacity, reset and rejected in-flight loads are bounded", async () => {
  let now = 0;
  const cache = createPositionMetadataCache({
    ttlMs: 100,
    maxEntries: 2,
    now: () => now,
  });
  let loads = 0;
  const load = async () => ({
    value: { address: TOKEN0, decimals: ++loads, symbol: "T" },
    cacheable: true,
  });
  const first = await cache.read("a", load);
  first.decimals = 255;
  assert.equal((await cache.read("a", load)).decimals, 1);
  now = 100;
  assert.equal((await cache.read("a", load)).decimals, 2);
  await cache.read("b", load);
  await cache.read("c", load);
  assert.equal((await cache.read("a", load)).decimals, 5);
  cache.clear();
  assert.equal((await cache.read("a", load)).decimals, 6);
  await assert.rejects(
    cache.read("bad", async () => {
      throw new Error("failed");
    }),
  );
  assert.equal((await cache.read("bad", load)).decimals, 7);
  cache.clear();
  type MetadataResult = {
    value: { address: Address; decimals: number; symbol: string };
    cacheable: boolean;
  };
  let resolvePending!: (value: MetadataResult) => void;
  const pending = new Promise<MetadataResult>((resolve) => {
    resolvePending = resolve;
  });
  const beforeReset = cache.read("a", () => pending);
  await Promise.resolve();
  cache.clear();
  const afterReset = await cache.read("a", load);
  resolvePending({
    value: { address: TOKEN0, decimals: 100, symbol: "old" },
    cacheable: true,
  });
  await beforeReset;
  assert.equal((await cache.read("a", load)).decimals, afterReset.decimals);
});
