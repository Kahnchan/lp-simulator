import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  getAddress,
  parseAbiItem,
  zeroAddress,
} from "viem";
import { readRpcTransport } from "./readRpcTransport";
import { assertChainId, validateRpcUrl } from "./chain";
import { V3_POSITION_ABI } from "./positions";
import { isRpcHistoricalStateUnavailable } from "./rpcErrors";
import {
  importSimulationPosition,
  type SimulationImport,
} from "./lpSimulationRead";
import { simulationModel, type SimulationPosition } from "./lpSimulation";

export interface HistoryPoint {
  block: string;
  time: string;
  price: number;
  transaction: string;
  method: string;
  logIndex?: number;
}
export interface EntryHistory {
  first: HistoryPoint;
  latest?: HistoryPoint;
  warning?: string;
}
// Event identity, not equal prices, determines whether a later deposit exists.
export function additionalDeposit(first: HistoryPoint, latest: HistoryPoint) {
  return first.logIndex !== undefined &&
    first.block === latest.block &&
    first.transaction.toLowerCase() === latest.transaction.toLowerCase() &&
    first.logIndex === latest.logIndex
    ? undefined
    : latest;
}
export async function firstExistingBlock(
  high: bigint,
  exists: (block: bigint) => Promise<boolean>,
) {
  if (!(await exists(high))) throw new Error("目标区块中 NFT 不存在。");
  let low = 0n;
  let distance = 1024n;
  const tip = high;
  while (high > 0n) {
    const probe = tip > distance ? tip - distance : 0n;
    if (!(await exists(probe))) {
      low = probe + 1n;
      break;
    }
    high = probe;
    if (probe === 0n) return 0n;
    distance *= 2n;
  }
  while (low < high) {
    const mid = (low + high) / 2n;
    if (await exists(mid)) high = mid;
    else low = mid + 1n;
  }
  return low;
}
// Never accept an older event if a newer window could not be read.
export function newestMatchingBatch<T>(
  batches: PromiseSettledResult<T[]>[],
  matches: (item: T) => boolean,
): T[] {
  for (const batch of batches) {
    if (batch.status === "rejected") throw batch.reason;
    if (batch.value.some(matches)) return batch.value;
  }
  return [];
}

const creationBlocks = new Map<string, bigint>();

export async function readEntryHistory(
  input: SimulationImport,
  currentBlock: bigint,
  reverse: boolean,
  progress: (s: string) => void,
  active: () => boolean,
  options: {
    snapshot?: SimulationPosition;
    onFirst?: (point: HistoryPoint) => void;
  } = {},
): Promise<EntryHistory> {
  const client = createPublicClient({
    transport: readRpcTransport(validateRpcUrl(input.rpcUrl), {
      timeout: 15000,
    }),
    cacheTime: 0,
  });
  const manager = getAddress(input.manager);
  const tokenId = BigInt(input.tokenId);
  const deadline = Date.now() + 180000;
  const check = () => {
    if (Date.now() > deadline)
      throw new Error("历史查询超过三分钟，请更换 RPC 或稍后重试。");
    if (!active()) throw new Error("历史读取已取消");
  };
  assertChainId(input.chainId, await client.getChainId());
  progress("正在定位 NFT 创建区块…");
  const locate = () =>
    firstExistingBlock(currentBlock, async (blockNumber) => {
      check();
      try {
        await client.readContract({
          address: manager,
          abi: V3_POSITION_ABI,
          functionName: "ownerOf",
          args: [tokenId],
          blockNumber,
        });
        return true;
      } catch (e) {
        if (isRpcHistoricalStateUnavailable(e))
          throw new Error("RPC 不提供所需历史状态，请更换归档 RPC 后重试。");
        const reverted =
          e instanceof BaseError &&
          e.walk((x) => x instanceof ContractFunctionRevertedError);
        if (reverted instanceof ContractFunctionRevertedError) return false;
        const empty =
          e instanceof BaseError &&
          e.walk((x) => x instanceof ContractFunctionZeroDataError);
        if (
          empty instanceof ContractFunctionZeroDataError &&
          !(await client.getCode({ address: manager, blockNumber }))
        )
          return false;
        throw e;
      }
    });
  const creationKey = JSON.stringify([
    input.chainId,
    input.rpcUrl,
    manager,
    String(tokenId),
  ]);
  let minted: bigint;
  try {
    const cached = creationBlocks.get(creationKey);
    minted =
      cached !== undefined && cached <= currentBlock ? cached : await locate();
  } catch (e) {
    if (input.chainId !== 8453) throw e;
    check();
    progress("RPC 历史状态不可用，正在查找 Base 索引中的创建交易…");
    const response = await fetch(
      `https://base.blockscout.com/api/v2/tokens/${manager}/instances/${tokenId}/transfers`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) throw e;
    const body = await response.json();
    const creation = body.items?.find(
      (item: { from?: { hash?: string }; block_number?: number }) =>
        item.from?.hash?.toLowerCase() === zeroAddress &&
        Number.isSafeInteger(item.block_number),
    );
    if (
      !creation ||
      creation.block_number < 0 ||
      BigInt(creation.block_number) > currentBlock
    )
      throw e;
    minted = BigInt(creation.block_number);
  }
  check();
  const transfers = await client.getLogs({
    address: manager,
    event: parseAbiItem(
      "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
    ),
    args: { from: zeroAddress, tokenId },
    fromBlock: minted,
    toBlock: minted,
  });
  const mint = transfers[0];
  if (!mint?.transactionHash)
    throw new Error("未验证到 NFT 创建事件，无法确定首次入场来源。");
  creationBlocks.set(creationKey, minted);
  while (creationBlocks.size > 50)
    creationBlocks.delete(creationBlocks.keys().next().value!);
  let snapshotPromise: Promise<SimulationPosition> | undefined;
  const point = async (
    block: bigint,
    transaction: string,
    logIndex?: number,
  ): Promise<HistoryPoint> => {
    check();
    if (input.protocol !== "uniswap-v4") {
      const deposits = await client.getLogs({
        address: manager,
        event: parseAbiItem(
          "event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
        ),
        args: { tokenId },
        fromBlock: block,
        toBlock: block,
      });
      const deposit = deposits.find(
        (d) =>
          d.transactionHash === transaction &&
          (logIndex === undefined || d.logIndex === logIndex),
      );
      logIndex = deposit?.logIndex ?? logIndex;
      if (
        deposit?.args.amount0 &&
        deposit.args.amount1 &&
        deposit.args.liquidity
      ) {
        const snapshot =
          options.snapshot ??
          (await (snapshotPromise ??= importSimulationPosition(
            input,
            currentBlock,
          )));
        const raw =
          (Math.sqrt(1.0001 ** snapshot.tickLower) +
            Number(deposit.args.amount1) / Number(deposit.args.liquidity)) **
            2 *
          10 ** (snapshot.token0.decimals - snapshot.token1.decimals);
        const price = reverse ? 1 / raw : raw;
        if (!Number.isFinite(price) || price <= 0)
          throw new Error("历史价格超出计算范围");
        const stamp = await client.getBlock({ blockNumber: block });
        return {
          block: String(block),
          time: new Date(Number(stamp.timestamp) * 1000).toISOString(),
          price,
          transaction,
          logIndex,
          method: "按加仓事件币量与流动性反推，含整数舍入误差",
        };
      }
    }
    const snapshot = await importSimulationPosition(input, block);
    return {
      block: String(block),
      time: snapshot.blockTime,
      price: simulationModel(snapshot, reverse).price,
      transaction,
      logIndex,
      method: "该区块结束时池价格近似值，同区块交易可能产生偏差",
    };
  };
  progress("正在读取首次入场区块价格…");
  const first = await point(minted, mint.transactionHash);
  check();
  options.onFirst?.(first);
  if (input.protocol === "uniswap-v4")
    return { first, warning: "V4 目前仅定位首次创建；最近加仓事件尚未解析。" };
  progress("正在查找最近一次加仓…");
  let end = currentBlock;
  let size = 50000n;
  try {
    for (let attempt = 0; attempt < 80 && end >= minted; attempt += 3) {
      check();
      try {
        // Scan three adjacent windows together, but inspect newest first.
        const windows = [];
        let cursor = end;
        for (let i = 0; i < 3 && cursor >= minted; i++) {
          const from =
            cursor - minted + 1n > size ? cursor - size + 1n : minted;
          windows.push({ fromBlock: from, toBlock: cursor });
          cursor = from - 1n;
        }
        const batches = await Promise.allSettled(
          windows.map((window) =>
            client.getLogs({
              address: manager,
              event: parseAbiItem(
                "event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
              ),
              args: { tokenId },
              ...window,
            }),
          ),
        );
        check();
        const logs = newestMatchingBatch(
          batches,
          (log) => !!log.args.liquidity && log.args.liquidity > 0n,
        );
        const last = logs
          .filter((l) => l.args.liquidity && l.args.liquidity > 0n)
          .sort(
            (a, b) =>
              Number(b.blockNumber! - a.blockNumber!) ||
              b.logIndex! - a.logIndex!,
          )[0];
        if (last?.blockNumber != null && last.transactionHash) {
          if (
            String(last.blockNumber) === first.block &&
            last.transactionHash === first.transaction &&
            last.logIndex === first.logIndex
          )
            return { first };
          return {
            first,
            latest: additionalDeposit(
              first,
              await point(
                last.blockNumber,
                last.transactionHash,
                last.logIndex!,
              ),
            ),
          };
        }
        if (cursor < minted) return { first };
        end = cursor;
      } catch (e) {
        if (size <= 1000n || isRpcHistoricalStateUnavailable(e)) throw e;
        size /= 2n;
      }
    }
    return {
      first,
      warning: "最近加仓未能在本次扫描限额内确认，未将首次价格冒充最近加仓价。",
    };
  } catch {
    check();
    return {
      first,
      warning: "首次入场已确认；RPC 未完成最近加仓查询，可稍后重试。",
    };
  }
}
