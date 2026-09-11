import { registerRpcRoute } from "./rpcRouting";
import test from "node:test";
import assert from "node:assert/strict";
import { createPublicClient } from "viem";
import { createReadRpcTransport } from "./readRpcTransport";

const PRIMARY = "https://mainnet.base.org/";
const BACKUP = "https://base-rpc.publicnode.com/";
const CUSTOM = "https://private-rpc.example/rpc";
interface Call {
  url: string;
  method: string;
  params?: unknown;
  at: number;
  signal: AbortSignal;
}
function fixture(
  reply: (call: Call) =>
    | Promise<{
        result?: unknown;
        error?: { code: number; message: string };
        status?: number;
      }>
    | {
        result?: unknown;
        error?: { code: number; message: string };
        status?: number;
      },
  policy: Omit<
    NonNullable<Parameters<typeof createReadRpcTransport>[0]>,
    "fetchFn"
  > = {},
) {
  const calls: Call[] = [];
  const transport = createReadRpcTransport({
    primaryIntervalMs: 0,
    backupIntervalMs: 0,
    backoffMs: 0,
    ...policy,
    fetchFn: async (input, init) => {
      const payload = JSON.parse(String(init?.body));
      assert.equal(
        Array.isArray(payload),
        false,
        "read transport never sends JSON batches",
      );
      assert.ok(init?.signal);
      const call = {
        url: String(input),
        method: payload.method as string,
        params: payload.params,
        at: Date.now(),
        signal: init.signal,
      };
      calls.push(call);
      const { status = 200, ...body } = await reply(call);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: payload.id, ...body }),
        {
          status,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  });
  const client = (
    endpoint = PRIMARY,
    options: Parameters<typeof transport>[1] = {},
  ) =>
    createPublicClient({
      transport: transport(endpoint, options),
      cacheTime: 0,
    });
  return { calls, transport, client };
}
const limited = () => ({ error: { code: -32016, message: "over rate limit" } });
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

test("default Base falls back after a rate limit, verifies chain, and shares cooldown across clients", async () => {
  const f = fixture((call) => {
    if (call.url === PRIMARY) return limited();
    return { result: call.method === "eth_chainId" ? "0x2105" : "0x123" };
  });
  assert.equal(await f.client().getBlockNumber(), 291n);
  assert.deepEqual(
    f.calls.map(({ url, method }) => [url, method]),
    [
      [PRIMARY, "eth_blockNumber"],
      [BACKUP, "eth_chainId"],
      [BACKUP, "eth_blockNumber"],
    ],
  );
  assert.equal(await f.client("https://mainnet.base.org").getGasPrice(), 291n);
  assert.equal(f.calls.at(-1)?.url, BACKUP);
  assert.equal(f.calls.filter((call) => call.url === PRIMARY).length, 1);
  assert.equal(
    f.calls.filter((call) => call.method === "eth_chainId").length,
    1,
  );
});

test("queued Base reads switch away from a newly cooled primary, then retry primary after cooldown", async () => {
  let primaryLimited = true;
  const f = fixture(
    (call) =>
      call.url === PRIMARY && primaryLimited
        ? limited()
        : { result: call.method === "eth_chainId" ? "0x2105" : "0x1" },
    { primaryIntervalMs: 15, cooldownMs: 80 },
  );
  await Promise.all([
    f.client().getBlockNumber(),
    f.client().getGasPrice(),
    f.client().request({ method: "eth_maxPriorityFeePerGas" }),
  ]);
  assert.equal(f.calls.filter((call) => call.url === PRIMARY).length, 1);
  primaryLimited = false;
  await pause(85);
  await f.client().getBlockNumber();
  assert.equal(f.calls.at(-1)?.url, PRIMARY);
});

test("HTTP 429 is a rate limit and backup business retries are bounded to three total attempts", async () => {
  const f = fixture((call) =>
    call.method === "eth_chainId"
      ? { result: "0x2105" }
      : { ...limited(), status: 429 },
  );
  await assert.rejects(
    f
      .transport(PRIMARY)({})
      .request({ method: "eth_blockNumber" }, { retryCount: 12 }),
    /rate limit/i,
  );
  assert.equal(
    f.calls.filter((call) => call.method === "eth_blockNumber").length,
    3,
  );
  assert.equal(
    f.calls.filter((call) => call.method === "eth_chainId").length,
    1,
  );
});

test("a custom RPC is retried in place and never replaced with a public endpoint", async () => {
  for (const endpoint of [CUSTOM, "https://mainnet.base.org/?project=custom"]) {
    const f = fixture(limited);
    await assert.rejects(f.client(endpoint).getBlockNumber(), /rate limit/i);
    assert.equal(f.calls.length, 3);
    assert.ok(f.calls.every((call) => call.url === endpoint));
  }
});

test("pending nonces retry only the configured node and never adopt a backup's different nonce", async () => {
  const address = "0x2222222222222222222222222222222222222222";
  const f = fixture((call) =>
    call.url === PRIMARY
      ? limited()
      : { result: call.method === "eth_chainId" ? "0x2105" : "0x1" },
  );
  await assert.rejects(
    f.client().getTransactionCount({ address, blockTag: "pending" }),
    /rate limit/i,
  );
  assert.equal(f.calls.length, 3);
  assert.ok(
    f.calls.every(
      ({ url, method, params }) =>
        url === PRIMARY &&
        method === "eth_getTransactionCount" &&
        JSON.stringify(params) === JSON.stringify([address, "pending"]),
    ),
  );
  // Confirmed chain state can still use the ordinary fallback policy.
  assert.equal(
    await f.client().getTransactionCount({ address, blockTag: "latest" }),
    1,
  );
  assert.equal(f.calls.at(-1)?.url, BACKUP);
});

test("pending nonces stay on a cooling primary and recover its value after bounded retry", async () => {
  let nonceCalls = 0;
  const f = fixture((call) => {
    if (call.url === BACKUP)
      return { result: call.method === "eth_chainId" ? "0x2105" : "0x1" };
    if (call.method !== "eth_getTransactionCount" || ++nonceCalls === 1)
      return limited();
    return { result: "0x3a5" };
  });
  await f.client().getBlockNumber();
  const previousReads = f.calls.length;
  assert.equal(
    await f.client().getTransactionCount({
      address: "0x2222222222222222222222222222222222222222",
      blockTag: "pending",
    }),
    933,
  );
  assert.deepEqual(
    f.calls.slice(previousReads).map(({ url, method }) => [url, method]),
    [
      [PRIMARY, "eth_getTransactionCount"],
      [PRIMARY, "eth_getTransactionCount"],
    ],
  );
});

test("queued pending nonce cannot switch nodes when another read starts the cooldown", async () => {
  const f = fixture(
    (call) => {
      if (call.url === BACKUP)
        return { result: call.method === "eth_chainId" ? "0x2105" : "0x1" };
      return call.method === "eth_getTransactionCount"
        ? { result: "0x3a5" }
        : limited();
    },
    { primaryIntervalMs: 15 },
  );
  const [block, nonce] = await Promise.all([
    f.client().getBlockNumber(),
    f.client().getTransactionCount({
      address: "0x2222222222222222222222222222222222222222",
      blockTag: "pending",
    }),
  ]);
  assert.equal(block, 1n);
  assert.equal(nonce, 933);
  assert.deepEqual(
    f.calls
      .filter(({ method }) => method === "eth_getTransactionCount")
      .map(({ url }) => url),
    [PRIMARY],
  );
});

test("receipt reconciliation stays on a cooling primary and retains bounded retries and the exact receipt", async () => {
  const hash = `0x${"1".repeat(64)}` as const;
  const receipt = {
    transactionHash: hash,
    status: "0x1",
    blockNumber: "0x123",
  };
  for (const result of [receipt, null, undefined]) {
    let attempts = 0;
    const f = fixture((call) => {
      if (call.url === BACKUP)
        return { result: call.method === "eth_chainId" ? "0x2105" : "0x1" };
      if (call.method === "eth_getTransactionReceipt") {
        attempts++;
        if (result !== undefined && attempts === 3) return { result };
      }
      return limited();
    });
    await f.client().getBlockNumber();
    const start = f.calls.length;
    const request = f
      .transport(PRIMARY)({})
      .request(
        { method: "eth_getTransactionReceipt", params: [hash] },
        { retryCount: 12 },
      );
    if (result === undefined) await assert.rejects(request, /rate limit/i);
    else assert.deepEqual(await request, result);
    assert.equal(attempts, 3);
    assert.deepEqual(
      f.calls
        .slice(start)
        .map(({ url, method, params }) => [url, method, params]),
      Array.from({ length: 3 }, () => [
        PRIMARY,
        "eth_getTransactionReceipt",
        [hash],
      ]),
    );
    await f.client().getGasPrice();
    assert.equal(
      f.calls.at(-1)!.url,
      BACKUP,
      "ordinary reads keep their existing fallback",
    );
  }
});

test("archive reads pinned to a cooling primary retain their exact historical block and bounded retries", async () => {
  let archiveAttempts = 0;
  const f = fixture((call) => {
    if (call.url === BACKUP)
      return { result: call.method === "eth_chainId" ? "0x2105" : "0x1" };
    if (call.method === "eth_getCode" && ++archiveAttempts === 2)
      return { result: "0x1234" };
    return limited();
  });
  await f.client().getBlockNumber();
  const start = f.calls.length;
  const address = "0x2222222222222222222222222222222222222222";
  assert.equal(
    await f
      .client(PRIMARY, { allowFallback: false })
      .getCode({ address, blockNumber: 123n }),
    "0x1234",
  );
  assert.deepEqual(
    f.calls
      .slice(start)
      .map(({ url, method, params }) => [url, method, params]),
    [
      [PRIMARY, "eth_getCode", [address, "0x7b"]],
      [PRIMARY, "eth_getCode", [address, "0x7b"]],
    ],
  );
  await f.client().getGasPrice();
  assert.equal(
    f.calls.at(-1)!.url,
    BACKUP,
    "ordinary reads still honor the shared cooldown",
  );

  const failed = fixture(limited);
  await assert.rejects(
    failed
      .transport(PRIMARY, { allowFallback: false })({})
      .request(
        { method: "eth_getCode", params: [address, "0x7b"] },
        { retryCount: 12 },
      ),
    /rate limit/i,
  );
  assert.equal(failed.calls.length, 3);
  assert(failed.calls.every(({ url }) => url === PRIMARY));
});

test("pinned archive reads share endpoint queues, cancellation and total deadlines with ordinary clients", async () => {
  const releases: (() => void)[] = [];
  const f = fixture(async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return { result: "0x1" };
  });
  const first = f.client().getBlockNumber();
  const second = f.client(PRIMARY, { allowFallback: false }).getBlockNumber();
  const controller = new AbortController();
  const cancelled = f
    .client(PRIMARY, { allowFallback: false, signal: controller.signal })
    .getGasPrice();
  const cancelledCheck = assert.rejects(cancelled, /abort|cancel/i);
  const expired = f
    .client(PRIMARY, { allowFallback: false, timeout: 15 })
    .getGasPrice();
  const expiredCheck = assert.rejects(expired, /超时|timed out|timeout/i);
  await pause(5);
  controller.abort();
  await Promise.all([cancelledCheck, expiredCheck]);
  assert.equal(f.calls.length, 2);
  releases.splice(0).forEach((release) => release());
  await Promise.all([first, second]);
  assert.equal(
    f.calls.length,
    2,
    "expired or cancelled queued reads must never fetch",
  );
});

test("HTTP 429 remains a rate limit with an otherwise ordinary JSON-RPC error body", async () => {
  const f = fixture((call) =>
    call.url === PRIMARY
      ? { status: 429, error: { code: -32000, message: "server busy" } }
      : { result: call.method === "eth_chainId" ? "0x2105" : "0x1" },
  );
  assert.equal(await f.client().getBlockNumber(), 1n);
  assert.deepEqual(
    f.calls.map(({ url, method }) => [url, method]),
    [
      [PRIMARY, "eth_blockNumber"],
      [BACKUP, "eth_chainId"],
      [BACKUP, "eth_blockNumber"],
    ],
  );
  const limitedCustom = fixture(() => ({
    status: 429,
    error: { code: -32000, message: "server busy" },
  }));
  await assert.rejects(
    limitedCustom.client(CUSTOM).getBlockNumber(),
    (error: unknown) => {
      let cursor = error as Error & { cause?: Error; status?: number };
      const causes: (typeof cursor)[] = [];
      while (cursor) {
        causes.push(cursor);
        cursor = cursor.cause as typeof cursor;
      }
      assert.ok(causes.some((cause) => cause.status === 429));
      assert.ok(causes.some((cause) => cause.message.includes("server busy")));
      return true;
    },
  );
  assert.equal(limitedCustom.calls.length, 3);
});

test("writes and unknown methods are rejected before any network request", async () => {
  const f = fixture(() => {
    throw new Error("unexpected fetch");
  });
  for (const [endpoint, options] of [
    [PRIMARY, {}],
    [CUSTOM, {}],
    [PRIMARY, { allowFallback: false }],
  ] as const) {
    const transport = f.transport(endpoint, options)({});
    for (const method of [
      "eth_sendRawTransaction",
      "eth_sendTransaction",
      "personal_sign",
      "eth_sign",
      "wallet_sendCalls",
      "debug_traceCall",
      "unknown",
    ]) {
      await assert.rejects(
        transport.request({ method } as never),
        /只读 RPC 不允许/,
      );
    }
  }
  assert.equal(f.calls.length, 0);
});

test("a wrong-chain backup is rejected before sending the requested contract read", async () => {
  const f = fixture((call) =>
    call.url === PRIMARY ? limited() : { result: "0x1" },
  );
  await assert.rejects(
    f.client().request({
      method: "eth_getCode",
      params: ["0x2222222222222222222222222222222222222222", "latest"],
    }),
    /备用 RPC 的网络不是 Base/,
  );
  assert.deepEqual(
    f.calls.map(({ url, method }) => [url, method]),
    [
      [PRIMARY, "eth_getCode"],
      [BACKUP, "eth_chainId"],
    ],
  );
});

test("contract reverts and other business errors preserve their cause and are not retried", async () => {
  for (const error of [
    { code: 3, message: "execution reverted: UnsafePrice" },
    { code: -32000, message: "header not found" },
    { code: -32005, message: "eth_getLogs block range exceeds limit" },
  ]) {
    const f = fixture(() => ({ error }));
    await assert.rejects(f.client().getBlockNumber(), (received: unknown) => {
      const value = received as Error & { cause?: unknown };
      assert.ok(value.cause, "viem's RPC cause remains available");
      assert.ok(String(value).includes(error.message));
      return true;
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, PRIMARY);
  }
});

test("endpoint queues share concurrency across clients and queued cancellation never fetches", async () => {
  const releases: (() => void)[] = [];
  let concurrent = 0,
    maximum = 0;
  const f = fixture(async () => {
    concurrent++;
    maximum = Math.max(maximum, concurrent);
    await new Promise<void>((resolve) => releases.push(resolve));
    concurrent--;
    return { result: "0x1" };
  });
  const a = f.client(CUSTOM).getBlockNumber();
  const b = f.client(CUSTOM).getGasPrice();
  const cancelled = new AbortController();
  const queued = f
    .client(CUSTOM, { signal: cancelled.signal })
    .getBlockNumber();
  const rejected = assert.rejects(queued, /abort|cancel/i);
  await pause(5);
  assert.equal(f.calls.length, 2);
  cancelled.abort();
  await rejected;
  releases.splice(0).forEach((release) => release());
  await Promise.all([a, b]);
  assert.equal(maximum, 2);
  assert.equal(f.calls.length, 2);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    f.client(CUSTOM, { signal: alreadyAborted.signal }).getBlockNumber(),
    /abort/i,
  );
  assert.equal(f.calls.length, 2);
});

test("total deadline expires in the queue and does not send the expired request", async () => {
  const releases: (() => void)[] = [];
  const f = fixture(async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return { result: "0x1" };
  });
  const first = f.client(CUSTOM).getBlockNumber();
  const second = f.client(CUSTOM).getBlockNumber();
  const expired = f.client(CUSTOM, { timeout: 15 }).getGasPrice();
  await assert.rejects(expired, /超时|timed out|timeout/i);
  assert.equal(f.calls.length, 2);
  releases.splice(0).forEach((release) => release());
  await Promise.all([first, second]);
  assert.equal(f.calls.length, 2);
});

test("one caller's cancellation does not abort another active read", async () => {
  const releases: (() => void)[] = [];
  const f = fixture(async (call) => {
    await new Promise<void>((resolve, reject) => {
      releases.push(resolve);
      call.signal.addEventListener("abort", () => reject(call.signal.reason), {
        once: true,
      });
    });
    return { result: "0x1" };
  });
  const obsolete = new AbortController();
  const old = f.client(CUSTOM, { signal: obsolete.signal }).getBlockNumber();
  const rejected = assert.rejects(old, /abort/i);
  const current = f.client(CUSTOM).getGasPrice();
  await pause(5);
  obsolete.abort();
  await rejected;
  assert.equal(f.calls[1].signal.aborted, false);
  releases.splice(0).forEach((release) => release());
  assert.equal(await current, 1n);
});

test("default public endpoint pacing is shared while custom RPCs are not artificially delayed", async () => {
  const f = fixture(() => ({ result: "0x1" }), { primaryIntervalMs: 250 });
  await Promise.all([
    f.client().getBlockNumber(),
    f.client().getGasPrice(),
    f.client().getBlockNumber(),
  ]);
  for (let i = 1; i < f.calls.length; i++)
    assert.ok(f.calls[i].at - f.calls[i - 1].at >= 245);
  const custom = fixture(() => ({ result: "0x1" }), { primaryIntervalMs: 250 });
  await Promise.all([
    custom.client(CUSTOM).getBlockNumber(),
    custom.client(CUSTOM).getGasPrice(),
  ]);
  assert.ok(custom.calls[1].at - custom.calls[0].at < 100);
});

test("a browser-rewritten relay uses ordinary read HTTP without a second fallback policy", async () => {
  const relay = "http://127.0.0.1:5173/rpc/8453";
  const f = fixture(limited, { resolveEndpoint: () => relay });
  await assert.rejects(f.client().getBlockNumber(), /rate limit/i);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, relay);
  await assert.rejects(
    f
      .transport(PRIMARY)({})
      .request({ method: "eth_sendRawTransaction" } as never),
    /只读 RPC 不允许/,
  );
  assert.equal(f.calls.length, 1);
});

test("backup identity verification and business requests share the backup pacing queue", async () => {
  const f = fixture(
    (call) =>
      call.url === PRIMARY
        ? limited()
        : { result: call.method === "eth_chainId" ? "0x2105" : "0x1" },
    { backupIntervalMs: 100 },
  );
  await f.client().getBlockNumber();
  await Promise.all([f.client().getGasPrice(), f.client().getBlockNumber()]);
  const backup = f.calls.filter((call) => call.url === BACKUP);
  assert.equal(backup.length, 4);
  for (let i = 1; i < backup.length; i++)
    assert.ok(backup[i].at - backup[i - 1].at >= 95);
});

test("module backups preserve historical blocks and reject a different chain", async () => {
  const primary = "https://module-primary.example/";
  const wrong = "https://module-wrong.example/";
  const backup = "https://module-backup.example/";
  registerRpcRoute("manual", {
    primary,
    backups: [wrong, backup],
    chainId: 8453,
  });
  const f = fixture((call) => {
    if (call.method === "eth_chainId")
      return { result: call.url === wrong ? "0x1" : "0x2105" };
    if (call.method === "eth_getBlockByNumber")
      return { result: { hash: "0x" + "a".repeat(64) } };
    if (call.url === primary)
      return {
        error: {
          code: -32000,
          message: "archive requests require a personal token",
        },
      };
    return { result: "0x1234" };
  });
  assert.equal(
    await f
      .transport(primary, { module: "manual" })({})
      .request({
        method: "eth_getCode",
        params: ["0x" + "2".repeat(40), "0x123"],
      }),
    "0x1234",
  );
  assert(!f.calls.some((c) => c.url === wrong && c.method !== "eth_chainId"));
  assert.deepEqual(f.calls.at(-1)!.params, ["0x" + "2".repeat(40), "0x123"]);
  const rejected = fixture(() => ({
    error: { code: 3, message: "execution reverted" },
  }));
  await assert.rejects(
    rejected
      .transport(primary, { module: "manual" })({})
      .request({ method: "eth_call", params: [{}, "latest"] }),
    /revert/,
  );
  assert(rejected.calls.every((c) => c.url === primary));
});
