export const RPC_MODULES = {
  portfolio: "仓位查询",
  verification: "合约核验",
  manual: "手动交易预览",
  robot: "机器人执行",
} as const;
export type RpcModule = keyof typeof RPC_MODULES;
export type RpcRoute = { primary: string; backups: string[]; chainId: number };
const routes = new Map<string, RpcRoute>();
export function registerRpcRoute(module: RpcModule, route: RpcRoute) {
  routes.set(`${module}:${route.primary}`, route);
}
export function lookupRpcRoute(endpoint: string, module?: RpcModule) {
  return routes.get(`${module ?? "robot"}:${endpoint}`);
}
