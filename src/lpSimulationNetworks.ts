import {
  base,
  mainnet,
  arbitrum,
  optimism,
  polygon,
  bsc,
  avalanche,
} from "viem/chains";
import type { SimulationProtocol } from "./lpSimulationRead";

// Deployment sources: https://developers.uniswap.org/docs/protocols/v3/deployments
const commonV3 = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
export const simulationNetworks = [
  base,
  mainnet,
  arbitrum,
  optimism,
  polygon,
  bsc,
  avalanche,
].map((chain) => ({
  id: chain.id,
  name: chain.name,
  rpc: chain.rpcUrls.default.http[0],
}));
const v3: Record<number, string> = {
  8453: "0x03a520b32c04bf3beef7beb72e919cf822ed34f1",
  1: commonV3,
  42161: commonV3,
  10: commonV3,
  137: commonV3,
  56: "0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613",
  43114: "0x655C406EBFa14EE2006250925e54ec43AD184f8B",
};
export function simulationDeployment(
  chainId: number,
  protocol: SimulationProtocol,
) {
  if (protocol === "uniswap-v3")
    return { manager: v3[chainId] ?? "", stateView: undefined };
  if (chainId === 8453 && protocol === "aerodrome")
    return {
      manager: "0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53",
      stateView: undefined,
    };
  if (chainId === 8453 && protocol === "uniswap-v4")
    return {
      manager: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
      stateView: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
    };
  return { manager: "", stateView: undefined };
}
