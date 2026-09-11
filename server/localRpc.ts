import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite";
import { isPendingNonceRequest } from "../src/readRpcTransport";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_BATCH_SIZE = 64;
const UPSTREAM_TIMEOUT_MS = 20_000;
/** Fixed destinations only. Never accept an upstream URL from the request. */
const UPSTREAMS = Object.freeze({
  4663: "https://rpc.mainnet.chain.robinhood.com",
  8453: "https://mainnet.base.org",
});
// Only this fixed Base backup is used, and only for public-node rate limits.
const BASE_RATE_LIMIT_BACKUP = "https://base-rpc.publicnode.com";
function rateLimited(value: unknown): boolean {
  const items = Array.isArray(value) ? value : [value];
  return items.some((item) => {
    const error =
      item && typeof item === "object"
        ? (item as { error?: { code?: number; message?: string } }).error
        : undefined;
    return (
      !!error &&
      ([-32016, -32005, 429].includes(error.code ?? 0) ||
        /rate.?limit|too many requests/i.test(error.message ?? ""))
    );
  });
}
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
  "eth_getBalance",
]);
export interface ReadRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown[];
}
export class LocalRpcError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function resolveLocalRpcTarget(path: string): {
  chainId: 4663 | 8453;
  upstream: string;
} {
  const match = /^\/rpc\/(4663|8453)$/.exec(path);
  if (!match)
    throw new LocalRpcError(
      404,
      "Only /rpc/4663 and /rpc/8453 are supported; query parameters and upstream overrides are not accepted.",
    );
  const chainId = Number(match[1]) as 4663 | 8453;
  return { chainId, upstream: UPSTREAMS[chainId] };
}

/** Validate the entire batch before forwarding any request. */
export function parseReadOnlyRpcBody(
  body: string | Uint8Array,
): ReadRpcRequest | ReadRpcRequest[] {
  const bytes =
    typeof body === "string"
      ? Buffer.byteLength(body, "utf8")
      : body.byteLength;
  if (bytes > MAX_BODY_BYTES)
    throw new LocalRpcError(413, "JSON-RPC request exceeds 256 KB.");
  let payload: unknown;
  try {
    payload = JSON.parse(
      typeof body === "string" ? body : Buffer.from(body).toString("utf8"),
    );
  } catch {
    throw new LocalRpcError(400, "Request body must be valid JSON.");
  }
  const requests = Array.isArray(payload) ? payload : [payload];
  if (requests.length === 0 || requests.length > MAX_BATCH_SIZE)
    throw new LocalRpcError(
      400,
      "JSON-RPC batches must contain between 1 and 64 requests.",
    );
  const normalized = requests.map((request): ReadRpcRequest => {
    if (!request || typeof request !== "object" || Array.isArray(request))
      throw new LocalRpcError(400, "Invalid JSON-RPC request.");
    const item = request as Record<string, unknown>;
    if (
      Object.keys(item).some(
        (key) => !["jsonrpc", "id", "method", "params"].includes(key),
      )
    )
      throw new LocalRpcError(
        400,
        "Unexpected JSON-RPC property; upstream overrides are not accepted.",
      );
    if (item.jsonrpc !== "2.0" || !Object.hasOwn(item, "id"))
      throw new LocalRpcError(
        400,
        "JSON-RPC 2.0 and a request id are required.",
      );
    if (
      !(
        item.id === null ||
        (typeof item.id === "string" && item.id.length <= 128) ||
        (typeof item.id === "number" && Number.isSafeInteger(item.id))
      )
    )
      throw new LocalRpcError(
        400,
        "JSON-RPC id must be a string, safe integer, or null.",
      );
    if (typeof item.method !== "string" || !READ_METHODS.has(item.method))
      throw new LocalRpcError(
        403,
        "This local gateway accepts read-only RPC methods only. Wallet signing and transaction submission are not supported.",
      );
    if (item.params !== undefined && !Array.isArray(item.params))
      throw new LocalRpcError(400, "JSON-RPC params must be an array.");
    return {
      jsonrpc: "2.0",
      id: item.id as number | string | null,
      method: item.method,
      ...(item.params === undefined
        ? {}
        : { params: item.params as unknown[] }),
    };
  });
  return Array.isArray(payload) ? normalized : normalized[0];
}

function isLoopback(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}
function requireLocalRequest(request: IncomingMessage) {
  if (!isLoopback(request.socket.remoteAddress))
    throw new LocalRpcError(
      403,
      "The RPC gateway is available only on localhost.",
    );
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host))
    throw new LocalRpcError(403, "A localhost Host header is required.");
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new LocalRpcError(403, "Invalid request origin.");
    }
    if (
      !["http:", "https:"].includes(originUrl.protocol) ||
      originUrl.host.toLowerCase() !== host.toLowerCase()
    )
      throw new LocalRpcError(
        403,
        "Cross-origin RPC proxy requests are not allowed.",
      );
  }
}
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const declaredLength = request.headers["content-length"];
  if (
    declaredLength !== undefined &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)
  )
    throw new LocalRpcError(413, "JSON-RPC request exceeds 256 KB.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES)
      throw new LocalRpcError(413, "JSON-RPC request exceeds 256 KB.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}
function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(payload));
}

/** Server-side read-only fetch. Browser wallet transactions never use this path. */
export function createLocalRpcMiddleware(
  fetcher: typeof fetch = globalThis.fetch,
): Connect.NextHandleFunction {
  return (request, response, next) => {
    if (
      !request.url ||
      !(request.url === "/rpc" || request.url.startsWith("/rpc/"))
    ) {
      next();
      return;
    }
    void (async () => {
      try {
        requireLocalRequest(request);
        const { upstream, chainId } = resolveLocalRpcTarget(request.url!);
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          throw new LocalRpcError(405, "Only POST is supported.");
        }
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            request.headers["content-type"] ?? "",
          )
        )
          throw new LocalRpcError(
            415,
            "Content-Type must be application/json.",
          );
        const payload = parseReadOnlyRpcBody(await readBody(request));
        // Keep even a mixed batch on the configured node when it includes a
        // pending nonce; another node may not have the wallet's queued transactions.
        const canUseBackup =
          chainId === 8453 &&
          !(Array.isArray(payload) ? payload : [payload]).some(
            ({ method, params }) => isPendingNonceRequest(method, params),
          );
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          UPSTREAM_TIMEOUT_MS,
        );
        try {
          const forward = (endpoint: string) =>
            fetcher(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify(payload),
              signal: controller.signal,
              redirect: "error",
            });
          let upstreamResponse = await forward(upstream);
          let usedBackup = false;
          if (canUseBackup && upstreamResponse.status === 429) {
            upstreamResponse = await forward(BASE_RATE_LIMIT_BACKUP);
            usedBackup = true;
          }
          let result: unknown;
          try {
            result = await upstreamResponse.json();
          } catch {
            if (controller.signal.aborted)
              throw new LocalRpcError(504, "Upstream RPC timed out.");
            throw new LocalRpcError(
              upstreamResponse.ok ? 502 : upstreamResponse.status,
              "Upstream RPC did not return valid JSON.",
            );
          }
          if (canUseBackup && !usedBackup && rateLimited(result)) {
            upstreamResponse = await forward(BASE_RATE_LIMIT_BACKUP);
            result = await upstreamResponse.json();
            usedBackup = true;
          }
          if (usedBackup)
            response.setHeader("X-Range-Pilot-Rpc", "base-publicnode-backup");
          // Keep RPC error payloads and HTTP statuses intact for viem retry/error handling.
          sendJson(response, upstreamResponse.status, result);
        } catch (error) {
          if (error instanceof LocalRpcError) throw error;
          if (controller.signal.aborted)
            throw new LocalRpcError(504, "Upstream RPC timed out.");
          throw new LocalRpcError(
            502,
            "Unable to reach the configured upstream RPC.",
          );
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        if (!response.headersSent && !response.writableEnded)
          sendJson(
            response,
            error instanceof LocalRpcError ? error.status : 500,
            {
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32600,
                message:
                  error instanceof LocalRpcError
                    ? error.message
                    : "Local read-only RPC gateway failed.",
              },
            },
          );
      }
    })();
  };
}

export function localRpcPlugin(): Plugin {
  return {
    name: "range-pilot-local-read-only-rpc",
    configureServer(server) {
      server.middlewares.use(createLocalRpcMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createLocalRpcMiddleware());
    },
  };
}
