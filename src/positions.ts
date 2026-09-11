import { readRpcTransport } from "./readRpcTransport";
import { rpcErrorMessage } from "./rpcErrors";
import { createPositionGetterBatch } from "./positionReadBatch";
import {
  positionMetadataCache,
  type PositionMetadataCache,
} from "./positionMetadataCache";
import {
  createPublicClient,
  formatUnits,
  getAddress,
  isAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  CHAINS,
  MAX_TICK,
  MIN_TICK,
  assertChainId,
  deriveV4PoolId,
  sqrtPriceX96ToPrice,
  tickToPrice,
  validateRpcUrl,
  type TokenInfo,
  type V4PoolKey,
} from "./chain";

/** Expected owner is the actual NFT holder: the wallet or its verified Sickle. */
export interface PositionReference {
  protocol: "uniswap-v3" | "uniswap-v4" | "pancakeswap-v3";
  manager: Address;
  tokenId: bigint;
  expectedOwner: Address;
  factory?: Address;
  poolManager?: Address;
  stateView?: Address;
}

export interface UnifiedPosition {
  protocol: PositionReference["protocol"];
  chainId: number;
  manager: Address;
  tokenId: bigint;
  owner: Address;
  reference: PositionReference;
  blockNumber: bigint;
  token0: TokenInfo;
  token1: TokenInfo;
  /** Principal represented by active liquidity. Uncollected fees are separate. */
  amount0Raw: bigint;
  amount1Raw: bigint;
  amount0: string;
  amount1: string;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  tick: number;
  tickSpacing: number;
  feePips: number;
  status: "in-range" | "below-range" | "above-range" | "empty";
  /** All prices are token1 per token0, using each token's actual decimals. */
  priceLower: string;
  priceUpper: string;
  priceCurrent: string;
  poolAddress?: Address;
  factory?: Address;
  poolId?: Hex;
  poolKey?: V4PoolKey;
  stateView?: Address;
  poolManager?: Address;
  hasSubscriber?: boolean;
  /** V3 tokensOwed excludes fee growth since last update and may include withdrawn principal. */
  fees: {
    source: "crystallized-only" | "unavailable";
    amount0Raw?: bigint;
    amount1Raw?: bigint;
    amount0?: string;
    amount1?: string;
  };
  warnings: string[];
}

export interface PositionReadOptions {
  chainId: number;
  rpcUrl: string;
  position: PositionReference;
  blockNumber?: bigint;
  cacheMode?: PositionReadCacheMode;
}

export type PositionReadCacheMode = "observe" | "fresh";

export interface PositionReadResult {
  blockNumber: bigint;
  positions: UnifiedPosition[];
  failures: Array<{ reference: PositionReference; message: string }>;
}

const Q96 = 1n << 96n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

/** Mathematical constants floor/nearest(2^128 / sqrt(1.0001^(2^i))).
 * Integer operations match Uniswap TickMath including final rounding up.
 * Reference: https://github.com/Uniswap/v4-core/blob/main/src/libraries/TickMath.sol
 */
const TICK_FACTORS = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK)
    throw new Error("Tick 超出 Uniswap 有效范围。");
  let bits = Math.abs(tick);
  let ratio = 1n << 128n;
  for (const factor of TICK_FACTORS) {
    if (bits % 2 === 1) ratio = (ratio * factor) >> 128n;
    bits = Math.floor(bits / 2);
  }
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio + (1n << 32n) - 1n) >> 32n;
}

/** Exact principal amounts, rounded down as in LiquidityAmounts. */
export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): { amount0Raw: bigint; amount1Raw: bigint } {
  const lower = getSqrtRatioAtTick(tickLower);
  const upper = getSqrtRatioAtTick(tickUpper);
  if (lower >= upper) throw new Error("仓位下限必须小于上限。");
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 > MAX_SQRT_RATIO)
    throw new Error("池子价格超出有效范围。");
  if (liquidity < 0n || liquidity > MAX_UINT128)
    throw new Error("仓位流动性超出 uint128 范围。");
  const price =
    sqrtPriceX96 < lower ? lower : sqrtPriceX96 > upper ? upper : sqrtPriceX96;
  return {
    amount0Raw: ((liquidity << 96n) * (upper - price)) / upper / price,
    amount1Raw: (liquidity * (price - lower)) / Q96,
  };
}

/** Layout: poolId[200] | signed tickUpper[24] | signed tickLower[24] | flags[8].
 * https://github.com/Uniswap/v4-periphery/blob/main/src/libraries/PositionInfoLibrary.sol
 */
export function decodeV4PositionInfo(info: bigint) {
  if (info < 0n || info >= 1n << 256n)
    throw new Error("V4 positionInfo 必须是 uint256。");
  const signed24 = (value: bigint) => {
    const bits = value & 0xffffffn;
    return Number(bits >= 0x800000n ? bits - 0x1000000n : bits);
  };
  return {
    tickLower: signed24(info >> 8n),
    tickUpper: signed24(info >> 32n),
    hasSubscriber: (info & 0xffn) !== 0n,
    truncatedPoolId: info >> 56n,
  };
}

export function positionRangeStatus(
  tick: number,
  lower: number,
  upper: number,
  liquidity: bigint,
): UnifiedPosition["status"] {
  if (liquidity === 0n) return "empty";
  return tick < lower
    ? "below-range"
    : tick >= upper
      ? "above-range"
      : "in-range";
}

export const V3_POSITION_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function factory() view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);
const FACTORY_ABI = parseAbi([
  "function getPool(address token0, address token1, uint24 fee) view returns (address)",
]);
const POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
export const V4_POSITION_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function poolManager() view returns (address)",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
]);
const STATE_VIEW_ABI = parseAbi([
  "function poolManager() view returns (address)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
const TOKEN_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

type PositionReadClient = Pick<
  PublicClient,
  "getChainId" | "getBlockNumber" | "getCode" | "readContract"
>;
function address(value: string, label: string, allowNative = false): Address {
  if (
    !isAddress(value, { strict: true }) ||
    (!allowNative && value.toLowerCase() === zeroAddress)
  )
    throw new Error(`${label}必须是有效的非零地址。`);
  return getAddress(value);
}
function sameAddress(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function validateReference(reference: PositionReference): PositionReference {
  if (
    !["uniswap-v3", "uniswap-v4", "pancakeswap-v3"].includes(reference.protocol)
  )
    throw new Error("不支持的仓位协议。");
  if (
    typeof reference.tokenId !== "bigint" ||
    reference.tokenId < 0n ||
    reference.tokenId >= 1n << 256n
  )
    throw new Error("Token ID 必须是有效的 uint256。");
  return {
    ...reference,
    manager: address(reference.manager, "Position Manager"),
    expectedOwner: address(reference.expectedOwner, "NFT 持有人"),
  };
}

/** Fixed block, chain checks and memoized metadata/code shared by all NFTs in a batch. */
class SnapshotReader {
  readonly code = new Map<string, Promise<void>>();
  readonly tokens = new Map<string, Promise<TokenInfo>>();
  readonly readGetter: PositionReadClient["readContract"];
  constructor(
    readonly client: PositionReadClient,
    readonly chainId: number,
    readonly blockNumber: bigint,
    readonly metadataCache: PositionMetadataCache,
    readonly cacheScope?: string,
    batchGetters = false,
  ) {
    this.readGetter = batchGetters
      ? createPositionGetterBatch(client, blockNumber)
      : client.readContract;
  }

  requireCode(value: Address) {
    const key = value.toLowerCase();
    let pending = this.code.get(key);
    if (!pending) {
      pending = this.client
        .getCode({ address: value, blockNumber: this.blockNumber })
        .then((code) => {
          if (!code || code === "0x")
            throw new Error(
              `地址 ${value} 在区块 ${this.blockNumber} 没有合约代码。`,
            );
        });
      this.code.set(key, pending);
    }
    return pending;
  }

  token(value: Address, nativeAllowed: boolean): Promise<TokenInfo> {
    const tokenAddress = address(value, "Token", nativeAllowed);
    if (tokenAddress === zeroAddress)
      return Promise.resolve({
        address: tokenAddress,
        symbol: "ETH",
        decimals: 18,
      });
    const key = tokenAddress.toLowerCase();
    let pending = this.tokens.get(key);
    if (!pending) {
      const load = async () => {
        await this.requireCode(tokenAddress);
        const common = {
          address: tokenAddress,
          abi: TOKEN_ABI,
          blockNumber: this.blockNumber,
        } as const;
        const [decimals, symbolResult] = await Promise.all([
          this.client.readContract({ ...common, functionName: "decimals" }),
          this.client
            .readContract({ ...common, functionName: "symbol" })
            .catch(() => null),
        ]);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
          throw new Error("Token decimals 无效。");
        // Symbol is display-only and never used to identify assets or build calldata.
        const symbol =
          typeof symbolResult === "string" && symbolResult.trim()
            ? symbolResult.slice(0, 40)
            : `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}`;
        return {
          value: { address: tokenAddress, decimals, symbol },
          cacheable: typeof symbolResult === "string" && !!symbolResult.trim(),
        };
      };
      pending = this.cacheScope
        ? this.metadataCache.read(`${this.cacheScope}:${key}`, load)
        : load().then(({ value }) => value);
      this.tokens.set(key, pending);
    }
    return pending;
  }

  async read(value: PositionReference): Promise<UnifiedPosition> {
    const ref = validateReference(value);
    await this.requireCode(ref.manager);
    return ref.protocol === "uniswap-v4" ? this.v4(ref) : this.v3(ref);
  }

  finish(
    ref: PositionReference,
    values: Pick<
      UnifiedPosition,
      | "owner"
      | "token0"
      | "token1"
      | "liquidity"
      | "sqrtPriceX96"
      | "tickLower"
      | "tickUpper"
      | "tick"
      | "tickSpacing"
      | "feePips"
      | "fees"
    > &
      Partial<UnifiedPosition>,
  ): UnifiedPosition {
    if (!sameAddress(values.owner, ref.expectedOwner))
      throw new Error(
        "NFT 持有人已变化，当前仓位不属于所查询的钱包或 Sickle。",
      );
    if (BigInt(values.token0.address) >= BigInt(values.token1.address))
      throw new Error("池子代币地址顺序无效。");
    if (
      !Number.isInteger(values.tickSpacing) ||
      values.tickSpacing <= 0 ||
      values.tickSpacing > 32767 ||
      values.tickLower % values.tickSpacing !== 0 ||
      values.tickUpper % values.tickSpacing !== 0
    )
      throw new Error("仓位 Tick 不符合池子刻度。");
    if (
      !Number.isInteger(values.tick) ||
      values.tick < MIN_TICK ||
      values.tick > MAX_TICK ||
      values.sqrtPriceX96 < MIN_SQRT_RATIO ||
      values.sqrtPriceX96 >= MAX_SQRT_RATIO
    )
      throw new Error("池子尚未初始化，或当前价格/Tick 无效。");
    if (
      !Number.isInteger(values.feePips) ||
      values.feePips < 0 ||
      values.feePips > 1_000_000
    )
      throw new Error("池子交易费率无效。");
    const amounts = getAmountsForLiquidity(
      values.sqrtPriceX96,
      values.tickLower,
      values.tickUpper,
      values.liquidity,
    );
    return {
      ...values,
      ...amounts,
      protocol: ref.protocol,
      chainId: this.chainId,
      manager: ref.manager,
      tokenId: ref.tokenId,
      reference: ref,
      blockNumber: this.blockNumber,
      amount0: formatUnits(amounts.amount0Raw, values.token0.decimals),
      amount1: formatUnits(amounts.amount1Raw, values.token1.decimals),
      priceLower: tickToPrice(
        values.tickLower,
        values.token0.decimals,
        values.token1.decimals,
      ),
      priceUpper: tickToPrice(
        values.tickUpper,
        values.token0.decimals,
        values.token1.decimals,
      ),
      priceCurrent: sqrtPriceX96ToPrice(
        values.sqrtPriceX96,
        values.token0.decimals,
        values.token1.decimals,
      ),
      status: positionRangeStatus(
        values.tick,
        values.tickLower,
        values.tickUpper,
        values.liquidity,
      ),
      warnings: values.warnings ?? [],
    };
  }

  async v3(ref: PositionReference): Promise<UnifiedPosition> {
    const common = {
      address: ref.manager,
      abi: V3_POSITION_ABI,
      blockNumber: this.blockNumber,
    } as const;
    const [owner, data, actualFactory] = await Promise.all([
      this.readGetter({
        ...common,
        functionName: "ownerOf",
        args: [ref.tokenId],
      }),
      this.readGetter({
        ...common,
        functionName: "positions",
        args: [ref.tokenId],
      }),
      this.readGetter({ ...common, functionName: "factory" }),
    ]);
    if (!sameAddress(owner, ref.expectedOwner))
      throw new Error(
        "NFT 持有人已变化，当前仓位不属于所查询的钱包或 Sickle。",
      );
    const factory = address(actualFactory, "V3 Factory");
    if (ref.factory && !sameAddress(factory, ref.factory))
      throw new Error("Position Manager 的 Factory 与部署配置不匹配。");
    await this.requireCode(factory);
    const [
      ,
      ,
      token0Address,
      token1Address,
      feePips,
      tickLower,
      tickUpper,
      liquidity,
      ,
      ,
      owed0,
      owed1,
    ] = data;
    const poolAddress = address(
      await this.readGetter({
        address: factory,
        abi: FACTORY_ABI,
        functionName: "getPool",
        args: [token0Address, token1Address, feePips],
        blockNumber: this.blockNumber,
      }),
      "V3 Pool",
    );
    await this.requireCode(poolAddress);
    const slotAbi =
      ref.protocol === "pancakeswap-v3"
        ? parseAbi([
            "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
          ])
        : POOL_ABI;
    const pool = {
      address: poolAddress,
      abi: POOL_ABI,
      blockNumber: this.blockNumber,
    } as const;
    const [
      slot0,
      tickSpacing,
      poolToken0,
      poolToken1,
      poolFee,
      poolFactory,
      token0,
      token1,
    ] = await Promise.all([
      this.readGetter({ ...pool, abi: slotAbi, functionName: "slot0" }),
      this.readGetter({ ...pool, functionName: "tickSpacing" }),
      this.readGetter({ ...pool, functionName: "token0" }),
      this.readGetter({ ...pool, functionName: "token1" }),
      this.readGetter({ ...pool, functionName: "fee" }),
      this.readGetter({ ...pool, functionName: "factory" }),
      this.token(token0Address, false),
      this.token(token1Address, false),
    ]);
    if (
      !sameAddress(poolToken0, token0Address) ||
      !sameAddress(poolToken1, token1Address) ||
      !sameAddress(poolFactory, factory) ||
      poolFee !== feePips
    )
      throw new Error("Factory 返回的池子与 NFT 代币或费率不匹配。");
    return this.finish(ref, {
      owner,
      token0,
      token1,
      liquidity,
      tickLower,
      tickUpper,
      tickSpacing,
      feePips,
      tick: slot0[1],
      sqrtPriceX96: slot0[0],
      factory,
      poolAddress,
      fees: {
        source: "crystallized-only",
        amount0Raw: owed0,
        amount1Raw: owed1,
        amount0: formatUnits(owed0, token0.decimals),
        amount1: formatUnits(owed1, token1.decimals),
      },
      warnings: [
        "V3 待领取记账余额不是实时总手续费，可能包含已移除的本金；领取前会重新模拟。",
      ],
    });
  }

  async v4(ref: PositionReference): Promise<UnifiedPosition> {
    if (!ref.stateView || !ref.poolManager)
      throw new Error(
        "V4 仓位需要已核验的 StateView 和 PoolManager 部署配置。",
      );
    const stateView = address(ref.stateView, "StateView");
    const poolManager = address(ref.poolManager, "PoolManager");
    await Promise.all([
      this.requireCode(stateView),
      this.requireCode(poolManager),
    ]);
    const common = {
      address: ref.manager,
      abi: V4_POSITION_ABI,
      blockNumber: this.blockNumber,
    } as const;
    const [owner, actualManager, viewManager, pair, liquidity] =
      await Promise.all([
        this.readGetter({
          ...common,
          functionName: "ownerOf",
          args: [ref.tokenId],
        }),
        this.readGetter({ ...common, functionName: "poolManager" }),
        this.readGetter({
          address: stateView,
          abi: STATE_VIEW_ABI,
          functionName: "poolManager",
          blockNumber: this.blockNumber,
        }),
        this.readGetter({
          ...common,
          functionName: "getPoolAndPositionInfo",
          args: [ref.tokenId],
        }),
        this.readGetter({
          ...common,
          functionName: "getPositionLiquidity",
          args: [ref.tokenId],
        }),
      ]);
    if (!sameAddress(owner, ref.expectedOwner))
      throw new Error(
        "NFT 持有人已变化，当前仓位不属于所查询的钱包或 Sickle。",
      );
    if (
      !sameAddress(actualManager, poolManager) ||
      !sameAddress(viewManager, poolManager)
    )
      throw new Error(
        "Position Manager / StateView 的 PoolManager 与部署配置不匹配。",
      );
    const [poolKey, info] = pair;
    const poolId = deriveV4PoolId(poolKey);
    const decoded = decodeV4PositionInfo(info);
    if (decoded.truncatedPoolId !== BigInt(poolId) >> 56n)
      throw new Error("V4 positionInfo 与完整 PoolKey 不匹配。");
    const [slot0, token0, token1] = await Promise.all([
      this.readGetter({
        address: stateView,
        abi: STATE_VIEW_ABI,
        functionName: "getSlot0",
        args: [poolId],
        blockNumber: this.blockNumber,
      }),
      this.token(poolKey.currency0, true),
      this.token(poolKey.currency1, true),
    ]);
    return this.finish(ref, {
      owner,
      token0,
      token1,
      liquidity,
      tickLower: decoded.tickLower,
      tickUpper: decoded.tickUpper,
      tickSpacing: poolKey.tickSpacing,
      feePips: slot0[3],
      tick: slot0[1],
      sqrtPriceX96: slot0[0],
      stateView,
      poolManager,
      poolKey,
      poolId,
      hasSubscriber: decoded.hasSubscriber,
      fees: { source: "unavailable" },
      warnings: [
        "V4 未领取手续费未计入余额；领取前会单独模拟。",
        ...(poolKey.hooks !== zeroAddress
          ? ["此 V4 池带有 Hook，执行操作还需对应 Hook 支持。"]
          : []),
      ],
    });
  }
}

function clientFor(options: {
  chainId: number;
  rpcUrl: string;
}): PositionReadClient {
  if (!CHAINS.some((chain) => chain.id === options.chainId))
    throw new Error(`暂不支持网络 ${options.chainId}。`);
  return createPublicClient({
    transport: readRpcTransport(validateRpcUrl(options.rpcUrl), {
      module: "portfolio",
      timeout: 15_000,
    }),
    cacheTime: 0,
  });
}

/** Reuses an existing client/block, but always verifies this client's network. */
export async function readPositionsWithClient(
  client: PositionReadClient,
  options: {
    chainId: number;
    positions: readonly PositionReference[];
    blockNumber?: bigint;
    rpcUrl?: string;
    cacheMode?: PositionReadCacheMode;
  },
  metadataCache: PositionMetadataCache = positionMetadataCache,
): Promise<PositionReadResult> {
  assertChainId(options.chainId, await client.getChainId());
  const blockNumber = options.blockNumber ?? (await client.getBlockNumber());
  if (blockNumber < 0n) throw new Error("区块号不能为负数。");
  const cacheScope =
    options.cacheMode === "observe" && options.rpcUrl
      ? JSON.stringify([options.chainId, validateRpcUrl(options.rpcUrl)])
      : undefined;
  const reader = new SnapshotReader(
    client,
    options.chainId,
    blockNumber,
    metadataCache,
    cacheScope,
    // Fresh execution validation stays direct; only Base observation getters aggregate.
    options.cacheMode === "observe" && options.chainId === 8453,
  );
  const positions: UnifiedPosition[] = [];
  const failures: PositionReadResult["failures"] = [];
  // Bound RPC concurrency so larger wallets do not overwhelm public providers.
  for (let offset = 0; offset < options.positions.length; offset += 4) {
    const group = options.positions.slice(offset, offset + 4);
    const results = await Promise.allSettled(
      group.map((reference) => reader.read(reference)),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled") positions.push(result.value);
      else
        failures.push({
          reference: group[index],
          message: rpcErrorMessage(result.reason),
        });
    });
  }
  return { blockNumber, positions, failures };
}

export async function readPositions(options: {
  chainId: number;
  rpcUrl: string;
  positions: readonly PositionReference[];
  blockNumber?: bigint;
  cacheMode?: PositionReadCacheMode;
}): Promise<PositionReadResult> {
  return readPositionsWithClient(clientFor(options), options);
}

export async function readPosition(
  options: PositionReadOptions,
): Promise<UnifiedPosition> {
  const result = await readPositions({
    ...options,
    positions: [options.position],
  });
  if (result.failures.length) throw new Error(result.failures[0].message);
  return result.positions[0];
}
