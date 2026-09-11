import { readRpcTransport } from "./readRpcTransport";
import {
  createPublicClient,
  defineChain,
  encodeAbiParameters,
  encodePacked,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

export type ChainId = 4663 | 8453;

export const CHAINS = [
  {
    id: 4663 as const,
    name: "Robinhood",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorerUrl: "https://robinhoodchain.blockscout.com",
  },
  {
    id: 8453 as const,
    name: "Base",
    rpcUrl: "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
  },
] as const;

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

export interface NetworkSnapshot {
  chainId: ChainId;
  networkName: string;
  blockNumber: bigint;
  gasPriceWei: bigint;
  gasPriceGwei: string;
  checkedAt: string;
}

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface V3PoolSnapshot {
  chainId: ChainId;
  blockNumber: bigint;
  address: Address;
  protocol: "uniswap-v3";
  token0: TokenInfo;
  token1: TokenInfo;
  feePips: number;
  tickSpacing: number;
  tick: number;
  sqrtPriceX96: bigint;
  /** Uniswap's raw active L; this is neither a token balance nor USD TVL. */
  liquidity: bigint;
  /** Human token1 units per human token0 unit, computed with bigint arithmetic. */
  priceToken1PerToken0: string;
  tickPriceToken1PerToken0: string;
}

export interface V4PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

export interface V4PoolSnapshot
  extends Omit<V3PoolSnapshot, "address" | "protocol"> {
  protocol: "uniswap-v4";
  poolId: Hex;
  stateView: Address;
  poolManager: Address;
  key: V4PoolKey;
  /** Packed directional protocol-fee fields; not a standalone percentage. */
  protocolFee: number;
}

export interface SickleInspection {
  chainId: ChainId;
  blockNumber: bigint;
  factory: Address;
  requestedOwner: Address;
  sickle: Address;
  exists: boolean;
  owner?: Address;
  approved?: Address;
  ownerMatches?: boolean;
}

export interface StrategyFeeInspection {
  chainId: ChainId;
  blockNumber: bigint;
  registry: Address;
  strategy: Address;
  checks: Array<{
    selector: Hex;
    hash: Hex;
    feeBps: bigint;
    descriptorName?: string;
  }>;
  /** Only these descriptors at this block, in this user-supplied registry. */
  zeroFeesForCheckedSelectors: boolean;
}

/** Fee descriptors from NftFarmStrategyFees, not external function selectors. */
const FEE_DESCRIPTOR_NAMES = [
  "FarmDepositFee",
  "FarmHarvestFee",
  "FarmCompoundFee",
  "FarmWithdrawFee",
  "FarmHarvestForFee",
  "FarmCompoundForFee",
  "RebalanceLowFee",
  "RebalanceMidFee",
  "RebalanceHighFee",
] as const;
export type FeeDescriptorName = (typeof FEE_DESCRIPTOR_NAMES)[number];
export const FEE_DESCRIPTORS = Object.fromEntries(
  FEE_DESCRIPTOR_NAMES.map((name) => [
    name,
    keccak256(toBytes(name)).slice(0, 10) as Hex,
  ]),
) as Record<FeeDescriptorName, Hex>;

export interface LinkedStrategyFeeInspection extends StrategyFeeInspection {
  feesLib: Address;
  /** Value of strategy.strategyAddress(), the key passed to chargeFee. */
  feeStrategy: Address;
  registryLinkVerified: true;
}

/** Local RPC endpoints are intentionally allowed; never embed a private key here. */
export function validateRpcUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("RPC 地址必须是完整的 HTTP 或 HTTPS URL。");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new Error("RPC 地址只支持 HTTP 或 HTTPS。");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("RPC 地址不能包含用户名、密码或 URL fragment。");
  }
  return url.toString();
}

export function assertChainId(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new Error(
      `RPC 网络不匹配：选择的是 ${expected}，节点返回 ${actual}。`,
    );
  }
}

function chainInfo(chainId: number) {
  const info = CHAINS.find((item) => item.id === chainId);
  if (!info) throw new Error(`暂不支持网络 ${chainId}。`);
  return info;
}

function contractAddress(value: string, label: string): Address {
  if (
    !isAddress(value, { strict: true }) ||
    value.toLowerCase() === zeroAddress
  ) {
    throw new Error(`${label}必须是非零 EVM 合约地址。`);
  }
  return getAddress(value);
}

function accountAddress(value: string): Address {
  if (
    !isAddress(value, { strict: true }) ||
    value.toLowerCase() === zeroAddress
  ) {
    throw new Error("钱包地址必须是非零 EVM 地址。");
  }
  return getAddress(value);
}

async function checkedClient(chainId: number, rpcUrl: string) {
  const info = chainInfo(chainId);
  const endpoint = validateRpcUrl(rpcUrl);
  const client = createPublicClient({
    chain: defineChain({
      id: info.id,
      name: info.name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [endpoint] } },
    }),
    transport: readRpcTransport(endpoint, {
      timeout: 12_000,
    }),
    cacheTime: 0,
  });
  assertChainId(chainId, await client.getChainId());
  return client;
}

type ReadClient = Awaited<ReturnType<typeof checkedClient>>;

async function requireCode(
  client: ReadClient,
  address: Address,
  blockNumber: bigint,
) {
  const code = await client.getCode({ address, blockNumber });
  if (!code || code === "0x")
    throw new Error(`地址 ${address} 在所选网络没有合约代码。`);
}

/** Gas price is a price per gas unit, not a total rebalance/transaction cost. */
export async function getNetworkSnapshot(
  chainId: number,
  rpcUrl: string,
): Promise<NetworkSnapshot> {
  const client = await checkedClient(chainId, rpcUrl);
  const [blockNumber, gasPriceWei] = await Promise.all([
    client.getBlockNumber(),
    client.getGasPrice(),
  ]);
  return {
    chainId: chainInfo(chainId).id,
    networkName: chainInfo(chainId).name,
    blockNumber,
    gasPriceWei,
    gasPriceGwei: formatUnits(gasPriceWei, 9),
    checkedAt: new Date().toISOString(),
  };
}

function validateDecimals(decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Token decimals 必须是 0 至 255 的整数。");
  }
}

/**
 * Decimal display of a positive rational, truncated to 36 significant fractional
 * digits (all integer digits are preserved). No Number conversion or underflow.
 */
export function rationalToDecimal(
  numerator: bigint,
  denominator: bigint,
): string {
  if (numerator < 0n || denominator <= 0n)
    throw new Error("价格分数必须为非负数且分母大于零。");
  if (numerator === 0n) return "0";
  const whole = numerator / denominator;
  let remainder = numerator % denominator;
  if (remainder === 0n) return whole.toString();
  let significant = whole > 0n ? whole.toString().length : 0;
  let fraction = "";
  let hasSignificant = whole > 0n;
  while (remainder !== 0n && significant < 36 && fraction.length < 512) {
    remainder *= 10n;
    const digit = remainder / denominator;
    remainder %= denominator;
    fraction += digit.toString();
    if (digit !== 0n) hasSignificant = true;
    if (hasSignificant) significant++;
  }
  if (!hasSignificant) throw new Error("价格过小，超出当前小数显示精度。");
  fraction = fraction.replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): string {
  validateDecimals(decimals0);
  validateDecimals(decimals1);
  if (sqrtPriceX96 <= 0n || sqrtPriceX96 >= 1n << 160n) {
    throw new Error("sqrtPriceX96 必须是大于零的 uint160。");
  }
  return rationalToDecimal(
    sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(decimals0),
    (1n << 192n) * 10n ** BigInt(decimals1),
  );
}

/**
 * Display price for the mathematical tick boundary: 1.0001^tick * 10^(d0-d1).
 * Independent fixed-point exponentiation uses 120 decimal places internally.
 * It does not replicate contract sqrt-ratio rounding and is not swap calldata math.
 */
export function tickToPrice(
  tick: number,
  decimals0: number,
  decimals1: number,
): string {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`Tick 必须是 ${MIN_TICK} 至 ${MAX_TICK} 的整数。`);
  }
  validateDecimals(decimals0);
  validateDecimals(decimals1);
  const scale = 10n ** 120n;
  let exponent = Math.abs(tick);
  let factor = (scale * 10001n) / 10000n;
  let result = scale;
  while (exponent > 0) {
    if (exponent % 2 === 1) result = (result * factor) / scale;
    exponent = Math.floor(exponent / 2);
    if (exponent > 0) factor = (factor * factor) / scale;
  }
  const numerator = tick < 0 ? scale : result;
  const denominator = tick < 0 ? result : scale;
  return rationalToDecimal(
    numerator * 10n ** BigInt(decimals0),
    denominator * 10n ** BigInt(decimals1),
  );
}

const POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
const TOKEN_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/** Standard Uniswap V3 pool interface only. V4 uses a PoolId and cannot be imported here. */
export async function loadV3Pool(
  chainId: number,
  rpcUrl: string,
  value: string,
): Promise<V3PoolSnapshot> {
  const address = contractAddress(value, "Pool 地址");
  const client = await checkedClient(chainId, rpcUrl);
  const blockNumber = await client.getBlockNumber();
  await requireCode(client, address, blockNumber);
  const common = { address, abi: POOL_ABI, blockNumber } as const;
  const [token0Address, token1Address, feePips, tickSpacing, liquidity, slot0] =
    await Promise.all([
      client.readContract({ ...common, functionName: "token0" }),
      client.readContract({ ...common, functionName: "token1" }),
      client.readContract({ ...common, functionName: "fee" }),
      client.readContract({ ...common, functionName: "tickSpacing" }),
      client.readContract({ ...common, functionName: "liquidity" }),
      client.readContract({ ...common, functionName: "slot0" }),
    ]);
  const [sqrtPriceX96, tick] = slot0;
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new Error("池子尚未初始化，或 sqrtPriceX96 超出 Uniswap V3 范围。");
  }
  if (
    tick < MIN_TICK ||
    tick > MAX_TICK ||
    tickSpacing <= 0 ||
    tickSpacing > 32767 ||
    feePips >= 1_000_000
  ) {
    throw new Error(
      "池子返回的 Tick、tickSpacing 或费率不符合标准 Uniswap V3。",
    );
  }
  if (token0Address.toLowerCase() === token1Address.toLowerCase()) {
    throw new Error("池子的两种代币地址相同。");
  }
  async function token(value: Address): Promise<TokenInfo> {
    const address = contractAddress(value, "Token 地址");
    await requireCode(client, address, blockNumber);
    const [symbol, decimals] = await Promise.all([
      client.readContract({
        address,
        abi: TOKEN_ABI,
        functionName: "symbol",
        blockNumber,
      }),
      client.readContract({
        address,
        abi: TOKEN_ABI,
        functionName: "decimals",
        blockNumber,
      }),
    ]);
    validateDecimals(decimals);
    return { address, symbol, decimals };
  }
  const [token0, token1] = await Promise.all([
    token(token0Address),
    token(token1Address),
  ]);
  return {
    chainId: chainInfo(chainId).id,
    blockNumber,
    address,
    protocol: "uniswap-v3",
    token0,
    token1,
    feePips,
    tickSpacing,
    tick,
    sqrtPriceX96,
    liquidity,
    priceToken1PerToken0: sqrtPriceX96ToPrice(
      sqrtPriceX96,
      token0.decimals,
      token1.decimals,
    ),
    tickPriceToken1PerToken0: tickToPrice(
      tick,
      token0.decimals,
      token1.decimals,
    ),
  };
}

const FACTORY_ABI = parseAbi([
  "function sickles(address owner) view returns (address)",
]);
const SICKLE_ABI = parseAbi([
  "function owner() view returns (address)",
  "function approved() view returns (address)",
]);

/** Reads only. Finding a Sickle does not authorize this app or an automation runner. */
export async function inspectSickle(
  chainId: number,
  rpcUrl: string,
  factoryValue: string,
  ownerValue: string,
): Promise<SickleInspection> {
  const factory = contractAddress(factoryValue, "Factory 地址");
  const requestedOwner = accountAddress(ownerValue);
  const client = await checkedClient(chainId, rpcUrl);
  const blockNumber = await client.getBlockNumber();
  await requireCode(client, factory, blockNumber);
  const sickle = await client.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: "sickles",
    args: [requestedOwner],
    blockNumber,
  });
  const base = {
    chainId: chainInfo(chainId).id,
    blockNumber,
    factory,
    requestedOwner,
    sickle,
  };
  if (sickle.toLowerCase() === zeroAddress) return { ...base, exists: false };
  await requireCode(client, sickle, blockNumber);
  const [owner, approved] = await Promise.all([
    client.readContract({
      address: sickle,
      abi: SICKLE_ABI,
      functionName: "owner",
      blockNumber,
    }),
    client.readContract({
      address: sickle,
      abi: SICKLE_ABI,
      functionName: "approved",
      blockNumber,
    }),
  ]);
  return {
    ...base,
    exists: true,
    owner,
    approved,
    ownerMatches: owner.toLowerCase() === requestedOwner.toLowerCase(),
  };
}

/** Matches sickle-public/contracts/libraries/FeesLib.sol, chargeFee. */
export function strategyFeeHash(strategyValue: string, selector: string): Hex {
  const strategy = contractAddress(strategyValue, "Strategy 地址");
  if (!/^0x[0-9a-fA-F]{8}$/.test(selector))
    throw new Error("Fee descriptor 必须是 4 字节十六进制值（0x 加 8 位）。");
  return keccak256(
    encodePacked(["address", "bytes4"], [strategy, selector as Hex]),
  );
}

const REGISTRY_ABI = parseAbi([
  "function feeRegistry(bytes32 hash) view returns (uint256)",
]);

/**
 * A zero entry is not proof that a deployment is globally fee-free or immutable.
 * Callers must supply the actual registry used by that strategy's FeesLib and
 * every relevant descriptor; arbitrary/unconfigured keys also return zero.
 */
export async function checkStrategyFees(
  chainId: number,
  rpcUrl: string,
  registryValue: string,
  strategyValue: string,
  selectors: string[],
): Promise<StrategyFeeInspection> {
  const registry = contractAddress(registryValue, "Registry 地址");
  const strategy = contractAddress(strategyValue, "Strategy 地址");
  if (selectors.length === 0 || selectors.length > 32)
    throw new Error("请提供 1 至 32 个明确的 fee descriptor。");
  const hashes = [...new Set(selectors.map((s) => s.toLowerCase()))].map(
    (selector) => ({
      selector: selector as Hex,
      hash: strategyFeeHash(strategy, selector),
    }),
  );
  const client = await checkedClient(chainId, rpcUrl);
  const blockNumber = await client.getBlockNumber();
  await Promise.all([
    requireCode(client, registry, blockNumber),
    requireCode(client, strategy, blockNumber),
  ]);
  const checks = await Promise.all(
    hashes.map(async (item) => ({
      ...item,
      feeBps: await client.readContract({
        address: registry,
        abi: REGISTRY_ABI,
        functionName: "feeRegistry",
        args: [item.hash],
        blockNumber,
      }),
    })),
  );
  return {
    chainId: chainInfo(chainId).id,
    blockNumber,
    registry,
    strategy,
    checks,
    zeroFeesForCheckedSelectors: checks.every((item) => item.feeBps === 0n),
  };
}

const STRATEGY_ABI = parseAbi([
  "function feesLib() view returns (address)",
  "function strategyAddress() view returns (address)",
]);
const FEES_LIB_ABI = parseAbi(["function registry() view returns (address)"]);

/**
 * Resolve the strategy's actual fee library and registry, then read the named
 * descriptors from the public source. This proves values only at blockNumber;
 * registry admins may change them, and other strategies/actions may use other keys.
 */
export async function inspectStrategyFees(
  chainId: number,
  rpcUrl: string,
  strategyValue: string,
  descriptorNames: readonly FeeDescriptorName[] = FEE_DESCRIPTOR_NAMES,
): Promise<LinkedStrategyFeeInspection> {
  const strategy = contractAddress(strategyValue, "Strategy 地址");
  if (
    descriptorNames.length === 0 ||
    descriptorNames.length > FEE_DESCRIPTOR_NAMES.length
  ) {
    throw new Error("请选择至少一个已知费用项目。");
  }
  const names = [...new Set(descriptorNames)];
  if (names.some((name) => !FEE_DESCRIPTOR_NAMES.includes(name)))
    throw new Error("包含不受支持的费用项目。");
  const client = await checkedClient(chainId, rpcUrl);
  const blockNumber = await client.getBlockNumber();
  await requireCode(client, strategy, blockNumber);
  const [feesLibValue, feeStrategyValue] = await Promise.all([
    client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "feesLib",
      blockNumber,
    }),
    client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "strategyAddress",
      blockNumber,
    }),
  ]);
  const feesLib = contractAddress(feesLibValue, "FeesLib 地址");
  const feeStrategy = contractAddress(feeStrategyValue, "Fee strategy 地址");
  await requireCode(client, feesLib, blockNumber);
  const registryValue = await client.readContract({
    address: feesLib,
    abi: FEES_LIB_ABI,
    functionName: "registry",
    blockNumber,
  });
  const registry = contractAddress(registryValue, "实际 Registry 地址");
  await requireCode(client, registry, blockNumber);
  const checks = await Promise.all(
    names.map(async (descriptorName) => {
      const selector = FEE_DESCRIPTORS[descriptorName];
      const hash = strategyFeeHash(feeStrategy, selector);
      const feeBps = await client.readContract({
        address: registry,
        abi: REGISTRY_ABI,
        functionName: "feeRegistry",
        args: [hash],
        blockNumber,
      });
      return { descriptorName, selector, hash, feeBps };
    }),
  );
  return {
    chainId: chainInfo(chainId).id,
    blockNumber,
    strategy,
    feeStrategy,
    feesLib,
    registry,
    registryLinkVerified: true,
    checks,
    zeroFeesForCheckedSelectors: checks.every((item) => item.feeBps === 0n),
  };
}

function normalizeV4Key(key: V4PoolKey): V4PoolKey {
  for (const [label, value] of [
    ["currency0", key.currency0],
    ["currency1", key.currency1],
    ["hooks", key.hooks],
  ]) {
    if (!isAddress(value, { strict: true }))
      throw new Error(`V4 ${label} 必须是有效 EVM 地址。`);
  }
  if (BigInt(key.currency0) >= BigInt(key.currency1)) {
    throw new Error(
      "V4 currency0 必须按地址数值小于 currency1，不能重复或反序。",
    );
  }
  if (
    !Number.isInteger(key.fee) ||
    key.fee < 0 ||
    (key.fee > 1_000_000 && key.fee !== 0x800000)
  ) {
    throw new Error("V4 fee 必须为 0 至 1000000，动态费率使用 8388608。");
  }
  if (
    !Number.isInteger(key.tickSpacing) ||
    key.tickSpacing < 1 ||
    key.tickSpacing > 32767
  ) {
    throw new Error("V4 tickSpacing 必须为 1 至 32767 的整数。");
  }
  return {
    ...key,
    currency0: getAddress(key.currency0),
    currency1: getAddress(key.currency1),
    hooks: getAddress(key.hooks),
  };
}

/** Exact keccak256(abi.encode(PoolKey)): five 32-byte slots, never packed encoding. */
export function deriveV4PoolId(value: V4PoolKey): Hex {
  const key = normalizeV4Key(value);
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [
        key.currency0 as Address,
        key.currency1 as Address,
        key.fee,
        key.tickSpacing,
        key.hooks as Address,
      ],
    ),
  );
}

const STATE_VIEW_ABI = parseAbi([
  "function poolManager() view returns (address)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);

/**
 * Uses the upstream IStateView ABI and derives the pool ID from its complete key.
 * Reading poolManager() verifies the declared link, not authenticity of the
 * user-supplied StateView implementation. No deployment addresses are invented.
 */
export async function loadV4Pool(
  chainId: number,
  rpcUrl: string,
  stateViewValue: string,
  value: V4PoolKey,
): Promise<V4PoolSnapshot> {
  const stateView = contractAddress(stateViewValue, "StateView 地址");
  const key = normalizeV4Key(value);
  const poolId = deriveV4PoolId(key);
  const client = await checkedClient(chainId, rpcUrl);
  const blockNumber = await client.getBlockNumber();
  await requireCode(client, stateView, blockNumber);
  const common = {
    address: stateView,
    abi: STATE_VIEW_ABI,
    blockNumber,
  } as const;
  const [managerValue, slot0, liquidity] = await Promise.all([
    client.readContract({ ...common, functionName: "poolManager" }),
    client.readContract({
      ...common,
      functionName: "getSlot0",
      args: [poolId],
    }),
    client.readContract({
      ...common,
      functionName: "getLiquidity",
      args: [poolId],
    }),
  ]);
  const poolManager = contractAddress(managerValue, "PoolManager 地址");
  await requireCode(client, poolManager, blockNumber);
  const [sqrtPriceX96, tick, protocolFee, feePips] = slot0;
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new Error(
      "V4 池子尚未初始化，或价格超出有效范围；请核对完整 PoolKey 和 StateView。",
    );
  }
  if (tick < MIN_TICK || tick > MAX_TICK || feePips > 1_000_000) {
    throw new Error("StateView 返回了超出 V4 范围的 Tick 或 LP 费率。");
  }
  async function currency(value: string): Promise<TokenInfo> {
    const address = getAddress(value);
    if (address === zeroAddress)
      return { address, symbol: "ETH", decimals: 18 };
    await requireCode(client, address, blockNumber);
    const [symbol, decimals] = await Promise.all([
      client.readContract({
        address,
        abi: TOKEN_ABI,
        functionName: "symbol",
        blockNumber,
      }),
      client.readContract({
        address,
        abi: TOKEN_ABI,
        functionName: "decimals",
        blockNumber,
      }),
    ]);
    validateDecimals(decimals);
    return { address, symbol, decimals };
  }
  const [token0, token1] = await Promise.all([
    currency(key.currency0),
    currency(key.currency1),
  ]);
  return {
    chainId: chainInfo(chainId).id,
    blockNumber,
    protocol: "uniswap-v4",
    poolId,
    stateView,
    poolManager,
    key,
    token0,
    token1,
    feePips,
    protocolFee,
    tickSpacing: key.tickSpacing,
    tick,
    sqrtPriceX96,
    liquidity,
    priceToken1PerToken0: sqrtPriceX96ToPrice(
      sqrtPriceX96,
      token0.decimals,
      token1.decimals,
    ),
    tickPriceToken1PerToken0: tickToPrice(
      tick,
      token0.decimals,
      token1.decimals,
    ),
  };
}
