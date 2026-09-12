import type { SimulationPosition } from "./lpSimulation";

const chains: Record<number, string> = {
  1: "ethereum",
  56: "bsc",
  8453: "base",
  42161: "arbitrum",
  10: "optimism",
  137: "polygon",
  43114: "avax",
};
const usdc = "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export function capitalKey(p: SimulationPosition) {
  return `lp-simulator:usdc-capital:v1:${p.chainId}:${p.manager.toLowerCase()}:${p.tokenId}`;
}
export function referenceValue(
  base: number,
  quote: number,
  ratio: number,
  anchorIsBase: boolean,
  anchorUsdc: number,
) {
  if (
    ![base, quote, ratio, anchorUsdc].every(Number.isFinite) ||
    base < 0 ||
    quote < 0 ||
    ratio <= 0 ||
    anchorUsdc <= 0
  )
    return null;
  return anchorIsBase
    ? (base + quote / ratio) * anchorUsdc
    : (base * ratio + quote) * anchorUsdc;
}
export function validPrice(
  value: unknown,
  now = Date.now(),
): { price: number; timestamp: number } | null {
  const v = value as
    | { price?: number; timestamp?: number; confidence?: number }
    | undefined;
  if (
    !v ||
    typeof v.price !== "number" ||
    !Number.isFinite(v.price) ||
    v.price <= 0 ||
    typeof v.timestamp !== "number" ||
    !Number.isFinite(v.timestamp) ||
    now - v.timestamp * 1000 > 15 * 60_000 ||
    v.timestamp * 1000 > now + 60_000 ||
    (v.confidence !== undefined && !(v.confidence >= 0.9))
  )
    return null;
  return { price: v.price, timestamp: v.timestamp };
}
export async function fetchUsdcPrices(
  p: SimulationPosition,
  signal: AbortSignal,
  historicalTime?: number,
) {
  const chain = chains[p.chainId];
  const valuationTime =
    historicalTime === undefined ? Date.now() : historicalTime * 1000;
  if (!Number.isFinite(valuationTime) || valuationTime <= 0)
    throw new Error("time");
  if (!chain) throw new Error("unsupported");
  const ids = [p.token0, p.token1].map(
    (token) => `${chain}:${token.address.toLowerCase()}`,
  );
  const response = await fetch(
    `https://coins.llama.fi/prices/${historicalTime === undefined ? "current" : `historical/${historicalTime}`}/${[...ids, usdc].join(",")}`,
    { signal },
  );
  if (!response.ok) throw new Error("prices");
  const data = await response.json();
  const dollar = validPrice(data.coins?.[usdc], valuationTime);
  if (!dollar) throw new Error("usdc");
  return ids.map((id) => {
    const coin = validPrice(data.coins?.[id], valuationTime);
    return coin
      ? {
          price: coin.price / dollar.price,
          timestamp: Math.min(coin.timestamp, dollar.timestamp),
        }
      : null;
  });
}
