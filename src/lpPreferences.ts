import type { SimulationImport, SimulationProtocol } from "./lpSimulationRead";
import {
  simulationDeployment,
  simulationNetworks,
} from "./lpSimulationNetworks";

export const PREFERENCES_KEY = "lp-simulator:preferences:v1";
export const FAVORITES_KEY = "lp-simulator:favorites:v1";
export const defaultImport: SimulationImport = {
  chainId: 8453,
  protocol: "aerodrome",
  rpcUrl: "https://mainnet.base.org",
  ...simulationDeployment(8453, "aerodrome"),
  tokenId: "",
};
export interface Preferences {
  draft: SimulationImport;
  rpc: Record<string, string>;
  contracts: Record<string, { manager: string; stateView?: string }>;
}
export interface Favorite {
  chainId: number;
  protocol: SimulationProtocol;
  manager: string;
  tokenId: string;
  stateView?: string;
  pair: string;
}
const protocols = ["uniswap-v3", "uniswap-v4", "aerodrome", "pancakeswap-v3"];
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 4096;
function validSource(value: unknown): value is SimulationImport {
  return (
    object(value) &&
    Number.isSafeInteger(value.chainId) &&
    Number(value.chainId) >= 0 &&
    protocols.includes(String(value.protocol)) &&
    text(value.manager) &&
    text(value.tokenId) &&
    (value.stateView === undefined || text(value.stateView))
  );
}
export function parsePreferences(raw: string | null): Preferences {
  const empty: Preferences = {
    draft: { ...defaultImport },
    rpc: {},
    contracts: {},
  };
  if (!raw) return empty;
  try {
    const value: unknown = JSON.parse(raw);
    if (!object(value)) return empty;
    if (validSource(value.draft) && text(value.draft.rpcUrl))
      empty.draft = value.draft;
    if (object(value.rpc))
      for (const [key, url] of Object.entries(value.rpc)) {
        if (/^\d+$/.test(key) && text(url)) empty.rpc[key] = url;
      }
    if (object(value.contracts))
      for (const [key, entry] of Object.entries(value.contracts)) {
        if (
          /^\d+:(uniswap-v3|uniswap-v4|aerodrome|pancakeswap-v3)$/.test(key) &&
          object(entry) &&
          text(entry.manager) &&
          (entry.stateView === undefined || text(entry.stateView))
        )
          empty.contracts[key] = {
            manager: entry.manager,
            stateView: entry.stateView,
          };
      }
    return empty;
  } catch {
    return empty;
  }
}
export function rememberImport(
  preferences: Preferences,
  draft: SimulationImport,
): Preferences {
  return {
    draft,
    rpc: { ...preferences.rpc, [draft.chainId]: draft.rpcUrl },
    contracts: {
      ...preferences.contracts,
      [`${draft.chainId}:${draft.protocol}`]: {
        manager: draft.manager,
        stateView: draft.stateView,
      },
    },
  };
}
export function savedImport(
  preferences: Preferences,
  chainId: number,
  protocol: SimulationProtocol,
  tokenId = "",
): SimulationImport {
  return {
    chainId,
    protocol,
    tokenId,
    rpcUrl:
      preferences.rpc[chainId] ??
      simulationNetworks.find((n) => n.id === chainId)?.rpc ??
      "",
    ...(preferences.contracts[`${chainId}:${protocol}`] ??
      simulationDeployment(chainId, protocol)),
  };
}
export function favoriteKey(
  favorite: Pick<Favorite, "chainId" | "protocol" | "manager" | "tokenId">,
): string {
  return `${favorite.chainId}:${favorite.protocol}:${favorite.manager.toLowerCase()}:${BigInt(favorite.tokenId)}`;
}
export function parseFavorites(raw: string | null): Favorite[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(value)) return [];
    const unique = new Map<string, Favorite>();
    for (const item of value) {
      if (
        !validSource(item) ||
        !object(item) ||
        !text(item.pair) ||
        item.chainId <= 0 ||
        !/^0x[\da-f]{40}$/i.test(item.manager) ||
        !/^\d{1,78}$/.test(item.tokenId) ||
        BigInt(item.tokenId) >= 2n ** 256n
      )
        continue;
      const favorite: Favorite = {
        chainId: item.chainId,
        protocol: item.protocol,
        manager: item.manager,
        tokenId: BigInt(item.tokenId).toString(),
        pair: item.pair,
        stateView: item.stateView,
      };
      unique.set(favoriteKey(favorite), favorite);
    }
    return [...unique.values()];
  } catch {
    return [];
  }
}
export function importFavorite(
  favorite: Favorite,
  preferences: Preferences,
): SimulationImport {
  const { pair: _pair, ...source } = favorite;
  return {
    ...savedImport(preferences, favorite.chainId, favorite.protocol),
    ...source,
  };
}
