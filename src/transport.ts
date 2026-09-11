/** Local Vite dev/preview serves a read-only relay for the two public defaults.
 * Custom RPCs, CLI consumers and deployments on other hosts keep direct HTTP.
 * Wallet sends never use this helper: they go to the selected wallet provider.
 */
declare const __LOCAL_RPC_PROXY__: boolean;
export function rpcTransportUrl(endpoint: string): string {
  if (
    typeof __LOCAL_RPC_PROXY__ === "undefined" ||
    !__LOCAL_RPC_PROXY__ ||
    typeof window === "undefined"
  )
    return endpoint;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname))
    return endpoint;
  const routes: Record<string, string> = {
    "https://rpc.mainnet.chain.robinhood.com/": "/rpc/4663",
    "https://mainnet.base.org/": "/rpc/8453",
  };
  const route = routes[new URL(endpoint).toString()];
  return route ? `${window.location.origin}${route}` : endpoint;
}
