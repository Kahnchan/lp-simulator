import {
  createPublicClient,
  getAddress,
  parseAbi,
  zeroAddress,
  type Address,
} from "viem";
import { assertChainId, validateRpcUrl } from "./chain";
import { readRpcTransport } from "./readRpcTransport";
import {
  getAmountsForLiquidity,
  readPositionsWithClient,
  V3_POSITION_ABI,
} from "./positions";
import {
  humanAmounts,
  validateNftId,
  type SimulationPosition,
} from "./lpSimulation";

export type SimulationProtocol =
  | "uniswap-v3"
  | "uniswap-v4"
  | "aerodrome"
  | "pancakeswap-v3";
export interface SimulationImport {
  chainId: number;
  rpcUrl: string;
  protocol: SimulationProtocol;
  manager: string;
  tokenId: string;
  stateView?: string;
}
const aeroFactory = parseAbi([
  "function getPool(address,address,int24) view returns (address)",
]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160,int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function tickSpacing() view returns (int24)",
]);
const tokenAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
export async function importSimulationPosition(
  input: SimulationImport,
  historicalBlock?: bigint,
): Promise<SimulationPosition> {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0)
    throw new Error("网络 Chain ID 无效。");
  const tokenId = validateNftId(input.tokenId);
  const manager = getAddress(input.manager);
  if (manager === zeroAddress) throw new Error("请填写 NFT 管理合约地址。");
  const client = createPublicClient({
    transport: readRpcTransport(validateRpcUrl(input.rpcUrl), {
      timeout: 25_000,
    }),
    cacheTime: 0,
  });
  const [chainId, blockNumber] = await Promise.all([
    client.getChainId(),
    historicalBlock === undefined
      ? client.getBlockNumber()
      : Promise.resolve(historicalBlock),
  ]);
  assertChainId(input.chainId, chainId);
  const [owner, block] = await Promise.all([
    client.readContract({
      address: manager,
      abi: V3_POSITION_ABI,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber,
    }),
    client.getBlock({ blockNumber }),
  ]);
  let data: Omit<SimulationPosition, "blockTime">;
  if (input.protocol !== "aerodrome") {
    const result = await readPositionsWithClient(client, {
      chainId: input.chainId,
      rpcUrl: input.rpcUrl,
      cacheMode: historicalBlock === undefined ? "observe" : "fresh",
      blockNumber,
      positions: [
        {
          protocol: input.protocol,
          manager,
          tokenId,
          expectedOwner: owner,
          ...(input.protocol === "uniswap-v4"
            ? { stateView: getAddress(input.stateView ?? "") }
            : {}),
        },
      ],
    });
    if (result.failures.length) throw new Error(result.failures[0].message);
    const p = result.positions[0];
    if (!p) throw new Error("未读取到仓位。");
    if (p.poolKey && p.poolKey.hooks !== zeroAddress)
      throw new Error("该 V4 仓位包含自定义 Hook，暂不支持通用收益模拟。");
    data = {
      chainId: p.chainId,
      manager,
      tokenId: String(tokenId),
      owner,
      blockNumber: String(blockNumber),
      token0: p.token0,
      token1: p.token1,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      liquidity: String(p.liquidity),
      sqrtPriceX96: String(p.sqrtPriceX96),
      amount0: p.amount0,
      amount1: p.amount1,
      warnings: p.warnings,
    };
  } else {
    const [p, factory] = await Promise.all([
      client.readContract({
        address: manager,
        abi: V3_POSITION_ABI,
        functionName: "positions",
        args: [tokenId],
        blockNumber,
      }),
      client.readContract({
        address: manager,
        abi: V3_POSITION_ABI,
        functionName: "factory",
        blockNumber,
      }),
    ]);
    const pool = await client.readContract({
      address: factory,
      abi: aeroFactory,
      functionName: "getPool",
      args: [p[2], p[3], p[4]],
      blockNumber,
    });
    if (pool === zeroAddress) throw new Error("未找到 Aerodrome 兼容池。");
    const [slot, t0, t1, pf, spacing] = await Promise.all([
      client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "slot0",
        blockNumber,
      }),
      client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "token0",
        blockNumber,
      }),
      client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "token1",
        blockNumber,
      }),
      client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "factory",
        blockNumber,
      }),
      client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "tickSpacing",
        blockNumber,
      }),
    ]);
    if (
      t0.toLowerCase() !== p[2].toLowerCase() ||
      t1.toLowerCase() !== p[3].toLowerCase() ||
      pf.toLowerCase() !== factory.toLowerCase() ||
      spacing !== p[4]
    )
      throw new Error("NFT 与池子参数不匹配。");
    const token = async (address: Address) => {
      const [decimals, symbol] = await Promise.all([
        client.readContract({
          address,
          abi: tokenAbi,
          functionName: "decimals",
          blockNumber,
        }),
        client
          .readContract({
            address,
            abi: tokenAbi,
            functionName: "symbol",
            blockNumber,
          })
          .catch(() => address.slice(0, 8)),
      ]);
      return { address, decimals, symbol };
    };
    const [token0, token1] = await Promise.all([token(t0), token(t1)]);
    const amounts = getAmountsForLiquidity(slot[0], p[5], p[6], p[7]);
    data = {
      chainId: input.chainId,
      manager,
      tokenId: String(tokenId),
      owner,
      blockNumber: String(blockNumber),
      token0,
      token1,
      tickLower: p[5],
      tickUpper: p[6],
      liquidity: String(p[7]),
      sqrtPriceX96: String(slot[0]),
      ...humanAmounts(amounts.amount0Raw, amounts.amount1Raw, token0, token1),
      warnings: [],
    };
  }
  return {
    ...data,
    blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
  };
}
