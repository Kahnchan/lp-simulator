import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Abi,
  type Address,
  type PublicClient,
} from "viem";
import { isRpcRateLimit } from "./rpcErrors";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_ABI = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
]);
type Client = Pick<PublicClient, "getCode" | "readContract">;
interface Getter {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  blockNumber: bigint;
}
interface Pending {
  getter: Getter;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** Only SnapshotReader's caller-independent protocol getters enter this queue. */
export function createPositionGetterBatch(client: Client, blockNumber: bigint) {
  let pending: Pending[] = [];
  let supported: Promise<boolean> | undefined;
  let disabled = false;
  const direct = (item: Pending) => {
    void client
      .readContract(item.getter as never)
      .then(item.resolve, item.reject);
  };
  const flush = async () => {
    const group = pending.splice(0, 64);
    if (pending.length) queueMicrotask(() => void flush());
    if (group.length === 1 || disabled) {
      group.forEach(direct);
      return;
    }
    try {
      supported ??= client
        .getCode({ address: MULTICALL3, blockNumber })
        .then((code) => !!code && code !== "0x");
      if (!(await supported)) {
        disabled = true;
        group.forEach(direct);
        return;
      }
      const results = await client.readContract({
        address: MULTICALL3,
        abi: MULTICALL_ABI,
        functionName: "aggregate3",
        blockNumber,
        args: [
          group.map(({ getter }) => ({
            target: getter.address,
            allowFailure: true,
            callData: encodeFunctionData(getter),
          })),
        ],
      });
      if (results.length !== group.length)
        throw new Error("Multicall3 返回的仓位读取数量不匹配。");
      results.forEach((result, index) => {
        const item = group[index];
        if (!result.success) {
          direct(item);
          return;
        }
        try {
          item.resolve(
            decodeFunctionResult({
              ...item.getter,
              data: result.returnData,
            }),
          );
        } catch {
          direct(item);
        }
      });
    } catch (error) {
      // Do not multiply provider throttling into many individual retries.
      if (isRpcRateLimit(error)) group.forEach((item) => item.reject(error));
      else {
        disabled = true;
        group.forEach(direct);
      }
    }
  };
  return ((getter: Getter) => {
    if (Object.hasOwn(getter, "account") || getter.blockNumber !== blockNumber)
      return client.readContract(getter as never);
    return new Promise<unknown>((resolve, reject) => {
      pending.push({ getter, resolve, reject });
      if (pending.length === 1) queueMicrotask(() => void flush());
    });
  }) as Client["readContract"];
}
