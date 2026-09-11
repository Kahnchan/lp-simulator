import {
  createTransport,
  http,
  HttpRequestError,
  type EIP1193RequestFn,
  type Transport,
} from "viem";
import { lookupRpcRoute, type RpcModule } from "./rpcRouting";
import { isRpcHistoricalStateUnavailable } from "./rpcErrors";
import { isRpcRateLimit } from "./rpcErrors";
import { rpcTransportUrl } from "./transport";

const BASE_PRIMARY = "https://mainnet.base.org/";
const BASE_BACKUP = "https://base-rpc.publicnode.com/";
const READ_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getCode",
  "eth_call",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
]);

/** Pending nonces describe one node's mempool, not interchangeable chain state. */
export function isPendingNonceRequest(
  method: string,
  params: unknown,
): boolean {
  return (
    method === "eth_getTransactionCount" &&
    Array.isArray(params) &&
    params[1] === "pending"
  );
}

export interface ReadRpcOptions {
  module?: RpcModule;
  signal?: AbortSignal;
  /** Total per-read deadline, including queueing, identity verification and retries. */
  timeout?: number;
  /** Pin direct reads to this endpoint when a verified fallback needs its archive capability. Browser relays own their upstream policy. */
  allowFallback?: boolean;
}

interface ReadRpcPolicy {
  fetchFn?: typeof fetch;
  resolveEndpoint?: (endpoint: string) => string;
  primaryIntervalMs?: number;
  backupIntervalMs?: number;
  cooldownMs?: number;
  backoffMs?: number;
}

interface QueueItem {
  run: () => Promise<unknown>;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
}

/** Shared by actual endpoint, not by a particular client or caller's abort signal. */
class EndpointQueue {
  private active = 0;
  private nextStartAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pending: QueueItem[] = [];

  constructor(private readonly interval: number) {}

  request(run: () => Promise<unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const item: QueueItem = {
        run,
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.pending.indexOf(item);
          if (index < 0) return;
          this.pending.splice(index, 1);
          reject(signal.reason);
          this.pump();
        },
      };
      signal.addEventListener("abort", item.abort, { once: true });
      this.pending.push(item);
      this.pump();
    });
  }

  private pump() {
    if (!this.pending.length) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    if (this.active >= 2 || this.timer) return;
    const delay = this.nextStartAt - Date.now();
    if (delay > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, delay);
      return;
    }
    const item = this.pending.shift()!;
    item.signal.removeEventListener("abort", item.abort);
    if (item.signal.aborted) {
      item.reject(item.signal.reason);
      this.pump();
      return;
    }
    this.active++;
    this.nextStartAt = Date.now() + this.interval;
    void Promise.resolve()
      .then(() => {
        item.signal.throwIfAborted();
        return item.run();
      })
      .then(item.resolve, item.reject)
      .finally(() => {
        this.active--;
        this.pump();
      });
    this.pump();
  }
}

class PrimaryCoolingDown extends Error {}

function sleep(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Isolated policy/fetch injection for tests. Public fallback destinations stay fixed. */
export function createReadRpcTransport(policy: ReadRpcPolicy = {}) {
  const queues = new Map<string, EndpointQueue>();
  const primaryInterval = policy.primaryIntervalMs ?? 250;
  const backupInterval = policy.backupIntervalMs ?? 100;
  const cooldownMs = policy.cooldownMs ?? 60_000;
  const backoffMs = policy.backoffMs ?? 250;
  for (const delay of [primaryInterval, backupInterval, cooldownMs, backoffMs])
    if (!Number.isFinite(delay) || delay < 0)
      throw new Error("只读 RPC 的调度间隔无效。");
  let primaryCooldownUntil = 0;
  let backupVerified = false;

  const queueFor = (endpoint: string) => {
    let queue = queues.get(endpoint);
    if (!queue) {
      queue = new EndpointQueue(
        endpoint === BASE_BACKUP
          ? backupInterval
          : endpoint === BASE_PRIMARY
            ? primaryInterval
            : 0,
      );
      queues.set(endpoint, queue);
    }
    return queue;
  };

  return function readRpcTransport(
    endpoint: string,
    options: ReadRpcOptions = {},
  ): Transport {
    const resolved = (policy.resolveEndpoint ?? rpcTransportUrl)(endpoint);
    const actual = new URL(resolved);
    if (!["http:", "https:"].includes(actual.protocol))
      throw new Error("只读 RPC 必须使用 HTTP 或 HTTPS 地址。");
    const primary = actual.href;
    const relayed = resolved !== endpoint;
    const canUseBackup =
      !relayed &&
      primary === BASE_PRIMARY &&
      !lookupRpcRoute(endpoint, options.module);

    return ({ timeout: transportTimeout }) => {
      const timeout = options.timeout ?? transportTimeout ?? 20_000;
      if (!Number.isFinite(timeout) || timeout <= 0)
        throw new Error("只读 RPC 超时时间必须为正数。");
      const requestHttp = async (
        target: string,
        method: string,
        params: unknown,
        signal: AbortSignal,
      ) => {
        signal.throwIfAborted();
        // Keep response metadata per request: concurrent calls must not share it.
        // viem otherwise drops HTTP 429 when its body is a valid JSON-RPC error.
        let responseStatus: number | undefined;
        let responseHeaders: Headers | undefined;
        const body = { method, ...(params === undefined ? {} : { params }) };
        const transport = http(target, {
          batch: false,
          timeout,
          retryCount: 0,
          fetchFn: policy.fetchFn,
          fetchOptions: { redirect: "error" },
          onFetchResponse: (response) => {
            responseStatus = response.status;
            responseHeaders = response.headers;
          },
        })({});
        const rateLimitError = (cause?: Error) =>
          new HttpRequestError({
            body,
            cause,
            details: "HTTP 429: Too many requests.",
            headers: responseHeaders,
            status: 429,
            url: target,
          });
        let result: unknown;
        try {
          result = await transport.request(body as never, {
            signal,
            retryCount: 0,
          });
        } catch (error) {
          signal.throwIfAborted();
          if (responseStatus === 429)
            throw rateLimitError(error instanceof Error ? error : undefined);
          throw error;
        }
        signal.throwIfAborted();
        if (responseStatus === 429) throw rateLimitError();
        return result;
      };
      const requestQueued = (
        target: string,
        method: string,
        params: unknown,
        signal: AbortSignal,
        checkCooldown = false,
      ) =>
        queueFor(target).request(() => {
          // Another queued request may have discovered the rate limit while
          // this one waited. Do not send its stale choice to the cooling node.
          if (checkCooldown && Date.now() < primaryCooldownUntil)
            throw new PrimaryCoolingDown();
          return requestHttp(target, method, params, signal);
        }, signal);

      const request = async (
        { method, params }: { method: string; params?: unknown },
        requestOptions?: { signal?: AbortSignal },
      ): Promise<unknown> => {
        if (!READ_METHODS.has(method))
          throw new Error(`只读 RPC 不允许 ${method}，未发送请求。`);
        const canFallback =
          canUseBackup &&
          options.allowFallback !== false &&
          // PublicNode requires archive access for receipts, including recent
          // ones. Keep reconciliation on the configured primary, even in cooldown.
          method !== "eth_getTransactionReceipt" &&
          !isPendingNonceRequest(method, params);
        const deadline = new AbortController();
        const timer = setTimeout(
          () =>
            deadline.abort(
              new DOMException(
                "Read-only RPC request timed out.",
                "TimeoutError",
              ),
            ),
          timeout,
        );
        const signal = AbortSignal.any([
          deadline.signal,
          ...(options.signal ? [options.signal] : []),
          ...(requestOptions?.signal ? [requestOptions.signal] : []),
        ]);
        try {
          signal.throwIfAborted();
          // The browser relay owns upstream retries; still cap concurrent
          // requests so removing batches does not turn them into a burst.
          if (relayed)
            return await requestQueued(primary, method, params, signal);
          for (let attempt = 0; attempt < 3; attempt++) {
            signal.throwIfAborted();
            const target =
              canFallback && Date.now() < primaryCooldownUntil
                ? BASE_BACKUP
                : primary;
            if (target === BASE_BACKUP && canFallback && !backupVerified) {
              const chainId = await requestQueued(
                target,
                "eth_chainId",
                undefined,
                signal,
              );
              if (
                typeof chainId !== "string" ||
                !/^0x[0-9a-f]+$/i.test(chainId) ||
                BigInt(chainId) !== 8453n
              )
                throw new Error(
                  "备用 RPC 的网络不是 Base，未发送后续读取请求。",
                );
              backupVerified = true;
            }
            try {
              return await requestQueued(
                target,
                method,
                params,
                signal,
                canFallback && target === BASE_PRIMARY,
              );
            } catch (error) {
              signal.throwIfAborted();
              if (error instanceof PrimaryCoolingDown) {
                attempt--;
                continue;
              }
              if (!isRpcRateLimit(error)) throw error;
              if (target === BASE_PRIMARY && canUseBackup)
                primaryCooldownUntil = Date.now() + cooldownMs;
              if (attempt === 2) throw error;
              await sleep(backoffMs * 2 ** attempt, signal);
            }
          }
          throw new Error("只读 RPC 请求未完成。");
        } finally {
          clearTimeout(timer);
        }
      };
      const configuredRequest: typeof request = async (
        args,
        requestOptions,
      ) => {
        try {
          return await request(args, requestOptions);
        } catch (error) {
          const route =
            options.allowFallback === false
              ? undefined
              : lookupRpcRoute(endpoint, options.module);
          const retryable =
            isRpcRateLimit(error) ||
            isRpcHistoricalStateUnavailable(error) ||
            /timeout|timed out|fetch failed|HTTP request failed|network error/i.test(
              error instanceof Error ? error.message : "",
            );
          if (
            !route?.backups.length ||
            !retryable ||
            args.method === "eth_getTransactionReceipt" ||
            isPendingNonceRequest(args.method, args.params)
          )
            throw error;
          const deadline = AbortSignal.timeout(timeout);
          const signal = AbortSignal.any([
            deadline,
            ...(options.signal ? [options.signal] : []),
            ...(requestOptions?.signal ? [requestOptions.signal] : []),
          ]);
          const params = args.params as unknown[] | undefined;
          const block = [
            "eth_call",
            "eth_getCode",
            "eth_getBalance",
            "eth_getTransactionCount",
          ].includes(args.method)
            ? params?.[1]
            : undefined;
          let lastError = error;
          for (const target of route.backups) {
            signal.throwIfAborted();
            try {
              const network = await requestQueued(
                target,
                "eth_chainId",
                [],
                signal,
              );
              if (
                typeof network !== "string" ||
                BigInt(network) !== BigInt(route.chainId)
              )
                throw new Error("备用 RPC 网络不匹配。");
              if (typeof block === "string" && /^0x[0-9a-f]+$/i.test(block)) {
                const [a, b] = (await Promise.all(
                  [primary, target].map((node) =>
                    requestQueued(
                      node,
                      "eth_getBlockByNumber",
                      [block, false],
                      signal,
                    ),
                  ),
                )) as Array<{ hash?: string } | null>;
                if (!a?.hash || !b?.hash || a.hash !== b.hash)
                  throw new Error("备用 RPC 区块不匹配。");
              }
              return await requestQueued(
                target,
                args.method,
                args.params,
                signal,
              );
            } catch (next) {
              lastError = next;
              if (
                !(
                  isRpcRateLimit(next) ||
                  isRpcHistoricalStateUnavailable(next) ||
                  /timeout|timed out|fetch failed|HTTP request failed|network error|备用 RPC/i.test(
                    next instanceof Error ? next.message : "",
                  )
                )
              )
                throw next;
            }
          }
          throw lastError;
        }
      };
      const transport = createTransport({
        key: "read-rpc",
        name: "Read-only RPC",
        type: "read-rpc",
        retryCount: 0,
        timeout,
        // JSON-RPC response typing comes from viem's caller-selected method.
        request: configuredRequest as EIP1193RequestFn,
      });
      // Never multiply the bounded transport retry policy with viem overrides.
      return {
        ...transport,
        request: (args, requestOptions) =>
          transport.request(args, { ...requestOptions, retryCount: 0 }),
      };
    };
  };
}

/** Process-wide queues and Base cooldown are shared by all read clients. */
export const readRpcTransport = createReadRpcTransport();
