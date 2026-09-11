import { formatUnits } from "viem";
import type { TokenInfo } from "./chain";

export interface SimulationPosition {
  chainId: number;
  manager: string;
  tokenId: string;
  owner: string;
  blockNumber: string;
  blockTime: string;
  token0: TokenInfo;
  token1: TokenInfo;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  sqrtPriceX96: string;
  amount0: string;
  amount1: string;
  warnings: string[];
}
export function simulationModel(
  position: SimulationPosition,
  reverse: boolean,
) {
  const scale = 10 ** (position.token0.decimals - position.token1.decimals);
  const rawPrice = (Number(position.sqrtPriceX96) / 2 ** 96) ** 2 * scale;
  const rawLower = 1.0001 ** position.tickLower * scale;
  const rawUpper = 1.0001 ** position.tickUpper * scale;
  const lower = reverse ? 1 / rawUpper : rawLower;
  const upper = reverse ? 1 / rawLower : rawUpper;
  const price = reverse ? 1 / rawPrice : rawPrice;
  const liquidity =
    Number(position.liquidity) /
    10 ** ((position.token0.decimals + position.token1.decimals) / 2);
  if (
    ![lower, upper, price, liquidity].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    lower >= upper
  )
    throw new Error("仓位为空或数值超出模拟范围，无法绘制。");
  const base = reverse ? position.token1 : position.token0;
  const quote = reverse ? position.token0 : position.token1;
  const initialBase = Number(reverse ? position.amount1 : position.amount0);
  const initialQuote = Number(reverse ? position.amount0 : position.amount1);
  function at(target: number) {
    if (!Number.isFinite(target) || target <= 0)
      throw new Error("模拟价格必须大于 0。");
    const s = Math.sqrt(Math.max(lower, Math.min(upper, target)));
    const x = liquidity * (1 / s - 1 / Math.sqrt(upper));
    const y = liquidity * (s - Math.sqrt(lower));
    return {
      price: target,
      base: Math.max(0, x),
      quote: Math.max(0, y),
      value: Math.max(0, x) * target + Math.max(0, y),
      hold: initialBase * target + initialQuote,
    };
  }
  const currentValue = initialBase * price + initialQuote;
  return { lower, upper, price, base, quote, currentValue, at };
}
export function validateNftId(value: string): bigint {
  if (!/^\d+$/.test(value.trim())) throw new Error("NFT 编号必须为非负整数。");
  const id = BigInt(value.trim());
  if (id >= 2n ** 256n) throw new Error("NFT 编号超出 uint256 范围。");
  return id;
}
export function humanAmounts(
  a0: bigint,
  a1: bigint,
  t0: TokenInfo,
  t1: TokenInfo,
) {
  return {
    amount0: formatUnits(a0, t0.decimals),
    amount1: formatUnits(a1, t1.decimals),
  };
}

export function simulationEntryValue(
  model: ReturnType<typeof simulationModel> | null,
  entry: number | null,
  cost: number | null,
): number | null {
  if (cost !== null && Number.isFinite(cost) && cost > 0) return cost;
  if (model && entry !== null && Number.isFinite(entry) && entry > 0)
    return model.at(entry).value;
  return null;
}
