import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createLocalRpcMiddleware,
  LocalRpcError,
  localRpcPlugin,
  parseReadOnlyRpcBody,
  resolveLocalRpcTarget,
} from "./localRpc";

const rpc = (method = "eth_chainId", id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params: [],
});
const status = (expected: number) => (error: unknown) =>
  error instanceof LocalRpcError && error.status === expected;

test("only the two exact fixed-chain URLs are resolved", () => {
  assert.deepEqual(resolveLocalRpcTarget("/rpc/4663"), {
    chainId: 4663,
    upstream: "https://rpc.mainnet.chain.robinhood.com",
  });
  assert.deepEqual(resolveLocalRpcTarget("/rpc/8453"), {
    chainId: 8453,
    upstream: "https://mainnet.base.org",
  });
  for (const path of [
    "/rpc",
    "/rpc/1",
    "/rpc/8453/",
    "/rpc/8453?url=https://evil.example",
    "/rpc/https://evil.example",
    "https://evil.example/rpc/4663",
    "//rpc/8453",
    "/rpc/%38%34%35%33",
  ]) {
    assert.throws(() => resolveLocalRpcTarget(path), status(404));
  }
});

test("read-only allowlist accepts supported methods and rejects writes including inside an otherwise valid batch", () => {
  const methods = [
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
  ];
  const batch = methods.map((method, index) => rpc(method, index));
  assert.deepEqual(parseReadOnlyRpcBody(JSON.stringify(batch)), batch);
  for (const method of [
    "eth_sendTransaction",
    "eth_sendRawTransaction",
    "eth_sign",
    "personal_sign",
    "eth_signTypedData_v4",
    "wallet_switchEthereumChain",
    "wallet_sendCalls",
    "debug_traceCall",
    "eth_Call",
  ]) {
    assert.throws(
      () => parseReadOnlyRpcBody(JSON.stringify(rpc(method))),
      status(403),
    );
    assert.throws(
      () => parseReadOnlyRpcBody(JSON.stringify([rpc(), rpc(method, 2)])),
      status(403),
    );
  }
});

test("request validation enforces JSON-RPC envelope, byte limit and batch bounds before forwarding", () => {
  assert.equal(
    (
      parseReadOnlyRpcBody(
        JSON.stringify(
          Array.from({ length: 64 }, (_, index) => rpc("eth_chainId", index)),
        ),
      ) as unknown[]
    ).length,
    64,
  );
  for (const input of [
    [],
    Array.from({ length: 65 }, (_, index) => rpc("eth_chainId", index)),
    null,
    1,
    "hello",
    { ...rpc(), jsonrpc: "1.0" },
    { method: "eth_chainId", jsonrpc: "2.0" },
    { ...rpc(), id: {} },
    { ...rpc(), id: Number.MAX_SAFE_INTEGER + 1 },
    { ...rpc(), params: {} },
    { ...rpc(), target: "https://evil.example" },
    { ...rpc(), url: "http://127.0.0.1:9000" },
  ]) {
    assert.throws(
      () => parseReadOnlyRpcBody(JSON.stringify(input)),
      status(400),
    );
  }
  assert.throws(() => parseReadOnlyRpcBody("{"), status(400));
  assert.throws(
    () => parseReadOnlyRpcBody(" ".repeat(256 * 1024 + 1)),
    status(413),
  );
  assert.throws(
    () => parseReadOnlyRpcBody("界".repeat(100_000)),
    status(413),
    "measure UTF-8 bytes, not JavaScript code units",
  );
  assert.deepEqual(
    parseReadOnlyRpcBody(Buffer.from(JSON.stringify(rpc()))),
    rpc(),
  );
});

function invoke(
  options: {
    path?: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string | undefined>;
    remoteAddress?: string;
    upstream?: typeof fetch;
  } = {},
) {
  let fetchCount = 0;
  const forwarded: Array<{ url: unknown; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    fetchCount++;
    forwarded.push({ url, init });
    if (options.upstream) return options.upstream(url, init);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const middleware = createLocalRpcMiddleware(fetcher);
  const request = Readable.from([
    Buffer.from(JSON.stringify(options.body ?? rpc())),
  ]) as IncomingMessage;
  request.url = options.path ?? "/rpc/4663";
  request.method = options.method ?? "POST";
  request.headers = {
    host: "127.0.0.1:5173",
    "content-type": "application/json",
    origin: "http://127.0.0.1:5173",
    ...options.headers,
  };
  Object.defineProperty(request, "socket", {
    value: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
  });
  const headers: Record<string, string> = {};
  const result = new Promise<{ status: number; body: any; next: boolean }>(
    (resolve, reject) => {
      const response = {
        statusCode: 200,
        headersSent: false,
        writableEnded: false,
        setHeader(key: string, value: string) {
          headers[key] = value;
        },
        end(data: string) {
          this.writableEnded = true;
          resolve({
            status: this.statusCode,
            body: JSON.parse(data),
            next: false,
          });
        },
      };
      try {
        middleware(request, response as unknown as ServerResponse, () =>
          resolve({ status: 0, body: null, next: true }),
        );
      } catch (error) {
        reject(error);
      }
    },
  );
  return {
    result,
    forwarded,
    headers,
    get fetchCount() {
      return fetchCount;
    },
  };
}

test("middleware proxies JSON-RPC batch to the fixed URL without forwarding cookies or origin", async () => {
  const response = [
    { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "busy" } },
    { jsonrpc: "2.0", id: 1, result: "0x2105" },
  ];
  const fixture = invoke({
    path: "/rpc/8453",
    body: [rpc(), rpc("eth_call", 2)],
    headers: {
      cookie: "private=do-not-forward",
      authorization: "Bearer do-not-forward",
    },
    upstream: async () =>
      new Response(JSON.stringify(response), { status: 429 }),
  });
  const result = await fixture.result;
  assert.equal(fixture.fetchCount, 2);
  assert.equal(fixture.forwarded[0].url, "https://mainnet.base.org");
  assert.equal(fixture.forwarded[1].url, "https://base-rpc.publicnode.com");
  assert.deepEqual(fixture.forwarded[0].init!.headers, {
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  assert.equal(fixture.forwarded[0].init!.redirect, "error");
  assert.ok(fixture.forwarded[0].init!.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(fixture.forwarded[0].init!.body)), [
    rpc(),
    rpc("eth_call", 2),
  ]);
  assert.equal(result.status, 429);
  assert.deepEqual(result.body, response);
  assert.equal(fixture.headers["Cache-Control"], "no-store");
});

test("Base rate limits retry one fixed backup, preserving batch IDs and ordinary RPC errors", async () => {
  const primary = [
    { jsonrpc: "2.0", id: 1, result: "0x2105" },
    {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32016, message: "over rate limit" },
    },
  ];
  const backup = [
    { jsonrpc: "2.0", id: 2, result: "0x" },
    { jsonrpc: "2.0", id: 1, result: "0x2105" },
  ];
  const fixture = invoke({
    path: "/rpc/8453",
    body: [rpc(), rpc("eth_call", 2)],
    upstream: async (url) =>
      new Response(
        JSON.stringify(url === "https://mainnet.base.org" ? primary : backup),
        { status: 200 },
      ),
  });
  assert.deepEqual((await fixture.result).body, backup);
  assert.equal(fixture.fetchCount, 2);
  assert.equal(fixture.headers["X-Range-Pilot-Rpc"], "base-publicnode-backup");
  assert.equal(
    fixture.forwarded[0].init!.body,
    fixture.forwarded[1].init!.body,
  );
  const reverted = {
    jsonrpc: "2.0",
    id: 1,
    error: { code: 3, message: "execution reverted" },
  };
  const ordinary = invoke({
    path: "/rpc/8453",
    upstream: async () => new Response(JSON.stringify(reverted)),
  });
  assert.deepEqual((await ordinary.result).body, reverted);
  assert.equal(ordinary.fetchCount, 1);
  const rh = invoke({
    path: "/rpc/4663",
    upstream: async () => new Response(JSON.stringify(primary)),
  });
  await rh.result;
  assert.equal(rh.fetchCount, 1);
});

test("pending nonce requests and mixed batches never fall back to a different mempool", async () => {
  const nonce = {
    jsonrpc: "2.0",
    id: 2,
    method: "eth_getTransactionCount",
    params: ["0x2222222222222222222222222222222222222222", "pending"],
  };
  for (const status of [200, 429]) {
    for (const body of [nonce, [rpc(), nonce]]) {
      const primary = {
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32016, message: "over rate limit" },
      };
      const fixture = invoke({
        path: "/rpc/8453",
        body,
        upstream: async (url) =>
          new Response(
            JSON.stringify(
              url === "https://mainnet.base.org"
                ? primary
                : { jsonrpc: "2.0", id: 2, result: "0x1" },
            ),
            { status },
          ),
      });
      const result = await fixture.result;
      assert.equal(result.status, status);
      assert.deepEqual(result.body, primary);
      assert.equal(fixture.fetchCount, 1);
      assert.equal(fixture.forwarded[0].url, "https://mainnet.base.org");
      assert.deepEqual(
        JSON.parse(String(fixture.forwarded[0].init?.body)),
        body,
      );
      assert.equal(fixture.headers["X-Range-Pilot-Rpc"], undefined);
    }
  }
  // A confirmed nonce remains a chain-state read and can use the normal fallback.
  const confirmed = invoke({
    path: "/rpc/8453",
    body: { ...nonce, params: [nonce.params[0], "latest"] },
    upstream: async (url) =>
      new Response(
        JSON.stringify(
          url === "https://mainnet.base.org"
            ? {
                jsonrpc: "2.0",
                id: 2,
                error: { code: -32016, message: "over rate limit" },
              }
            : { jsonrpc: "2.0", id: 2, result: "0x3a5" },
        ),
      ),
  });
  assert.deepEqual((await confirmed.result).body, {
    jsonrpc: "2.0",
    id: 2,
    result: "0x3a5",
  });
  assert.equal(confirmed.fetchCount, 2);
});

test("middleware rejects signing, wrong routes, verbs, content types and remote origins without making an upstream request", async () => {
  for (const options of [
    { body: [rpc(), rpc("eth_sendRawTransaction", 2)] },
    { path: "/rpc/4663?target=https://evil.example" },
    { method: "GET" },
    { method: "OPTIONS" },
    { headers: { "content-type": "text/plain" } },
    { headers: { host: "evil.example" } },
    { headers: { origin: "https://evil.example" } },
    { remoteAddress: "192.168.1.10" },
    { headers: { "content-length": String(256 * 1024 + 1) } },
  ]) {
    const fixture = invoke(options);
    assert.ok((await fixture.result).status >= 400);
    assert.equal(fixture.fetchCount, 0);
  }
  const unrelated = invoke({ path: "/assets/main.js" });
  assert.equal((await unrelated.result).next, true);
  assert.equal(unrelated.fetchCount, 0);
});

test("upstream transport or non-JSON errors remain errors, and both Vite modes install middleware", async () => {
  const networkError = invoke({
    upstream: async () => {
      throw new Error("offline");
    },
  });
  assert.equal((await networkError.result).status, 502);
  const jsonError = invoke({
    upstream: async () => new Response("<html>failure</html>", { status: 503 }),
  });
  assert.equal((await jsonError.result).status, 503);
  const plugin = localRpcPlugin();
  let installed = 0;
  const server = {
    middlewares: {
      use(middleware: unknown) {
        assert.equal(typeof middleware, "function");
        installed++;
      },
    },
  };
  assert.equal(typeof plugin.configureServer, "function");
  assert.equal(typeof plugin.configurePreviewServer, "function");
  (plugin.configureServer as (server: unknown) => void)(server);
  (plugin.configurePreviewServer as (server: unknown) => void)(server);
  assert.equal(installed, 2);
});
