import assert from "node:assert/strict";
import test from "node:test";
import {
  BaseError,
  ExecutionRevertedError,
  HttpRequestError,
  LimitExceededRpcError,
  RpcRequestError,
  TimeoutError,
} from "viem";
import {
  isRpcHistoricalStateUnavailable,
  isRpcQueryLimit,
  isRpcRateLimit,
  rpcErrorMessage,
} from "./rpcErrors";

const privateRpcUrl = "https://rpc.example/v2/secret-path?apiKey=secret-query";
const rpc = (code: number, message: string) =>
  new RpcRequestError({
    body: { method: "eth_call", params: ["sensitive-request-body"] },
    error: { code, message },
    url: privateRpcUrl,
  });

test("recognizes Base's HTTP-200 rate-limit error through real viem wrappers", () => {
  const error = new BaseError("The contract function positions failed.", {
    cause: new BaseError("An unknown RPC error occurred.", {
      cause: rpc(-32016, "over rate limit"),
      name: "UnknownRpcError",
    }),
    name: "ContractFunctionExecutionError",
  });
  assert.equal(isRpcRateLimit(error), true);
  assert.match(rpcErrorMessage(error), /RPC.*限流/);
  for (const secret of [
    "secret-path",
    "secret-query",
    "sensitive-request-body",
    "rpc.example",
  ])
    assert.equal(rpcErrorMessage(error).includes(secret), false);
});

test("recognizes HTTP 429, nested JSON errors and explicit request throttling", () => {
  for (const error of [
    new HttpRequestError({ status: 429, url: privateRpcUrl }),
    { cause: { response: { status: "429" } } },
    { error: { code: "-32016", message: "limit exceeded" } },
    new LimitExceededRpcError(rpc(-32005, "limit exceeded")),
    rpc(-32000, "Too many requests"),
    new Error("请求频率过高，请稍后重试"),
  ]) {
    assert.equal(isRpcRateLimit(error), true);
    assert.match(rpcErrorMessage(error), /限流/);
  }
});

test("query-range and result-size limits remain distinct from rate limits", () => {
  for (const message of [
    "eth_getLogs is limited to a 10,000 range",
    "eth_getLogs is limited to a 5 block range",
    "block range exceeds 10000",
    "block range is too wide",
    "too many logs",
    "too many results",
    "log limit exceeded",
    "logs limit exceeded",
    "result limit exceeded",
    "results limit exceeded",
    "query returned more than 10000 results",
    "log response size exceeded",
    "response too large",
    "request exceeds allowed batch size",
  ]) {
    const error = new LimitExceededRpcError(rpc(-32005, message));
    assert.equal(isRpcRateLimit(error), false, message);
    assert.equal(isRpcQueryLimit(error), true, message);
    assert.match(rpcErrorMessage(error), /查询范围|数据量/, message);
    assert.equal(
      isRpcQueryLimit(new Error(rpcErrorMessage(error))),
      true,
      message,
    );
  }
  assert.equal(
    isRpcRateLimit(rpc(-32000, "query returned more than 10000 results")),
    false,
  );
  assert.equal(
    isRpcRateLimit({
      status: 429,
      cause: rpc(-32005, "block range exceeds limit"),
    }),
    true,
  );
  assert.equal(
    isRpcRateLimit(rpc(-32005, "rate limit exceeded for block range requests")),
    true,
  );
});

test("invalid and future block ranges are parameter errors, not query-capacity retry signals", () => {
  for (const message of [
    "invalid block range",
    "invalid block range: fromBlock is greater than toBlock",
    "invalid block range: fromBlock exceeds toBlock",
    "block range contains a future block",
    "invalid block range: toBlock exceeds latest block",
    "invalid argument: expected block range",
    "invalid response size parameter",
    "区块范围无效",
  ]) {
    const error = rpc(-32602, message);
    assert.equal(isRpcQueryLimit(error), false, message);
    assert.equal(
      isRpcQueryLimit(new Error(rpcErrorMessage(error))),
      false,
      message,
    );
    assert.match(rpcErrorMessage(error), /不接受当前请求参数/, message);
  }
  assert.equal(isRpcQueryLimit(rpc(-32005, "limit exceeded")), false);
});

test("query-capacity classification cannot override throttling, cancellation, timeout or reverts", () => {
  const capacity = rpc(-32005, "block range exceeds 10000");
  for (const error of [
    { status: 429, cause: capacity },
    { message: "rate limit exceeded", cause: capacity },
    { name: "AbortError", cause: capacity },
    { code: "ABORT_ERR", cause: capacity },
    { message: "request was cancelled", cause: capacity },
    { name: "TimeoutError", cause: capacity },
    { code: "ETIMEDOUT", cause: capacity },
    { cause: rpc(3, "block range exceeds 10000") },
    new ExecutionRevertedError({ message: "block range exceeds 10000" }),
  ]) {
    assert.equal(isRpcQueryLimit(error), false);
    assert.equal(isRpcQueryLimit(new Error(rpcErrorMessage(error))), false);
  }
  assert.match(
    rpcErrorMessage({ cause: rpc(3, "block range exceeds 10000") }),
    /合约调用回滚/,
  );
});

test("query-limit diagnostics exclude secrets and never classify URL or request payload contents", () => {
  const error = rpc(
    -32005,
    `eth_getLogs is limited to a 5 block range ${privateRpcUrl} Bearer secret-bearer privateKey=secret-private`,
  );
  const message = rpcErrorMessage(error);
  assert.equal(isRpcQueryLimit(error), true);
  assert.equal(isRpcQueryLimit(new Error(message)), true);
  assert.doesNotMatch(message, /rpc\.example|secret-|Bearer|privateKey/);
  assert.equal(
    isRpcQueryLimit(
      new Error("failed to fetch https://rpc.example/maximum-block-range"),
    ),
    false,
  );
  assert.equal(
    isRpcQueryLimit(
      new Error('RPC Request failed.\nRequest body: {"error":"too many logs"}'),
    ),
    false,
  );
});

test("contract reverts and generic -32000 business failures do not trigger throttling", () => {
  for (const error of [
    rpc(-32000, "execution reverted: insufficient allowance"),
    new ExecutionRevertedError({ message: "rate limit exceeded" }),
    { name: "ContractFunctionRevertedError", message: "rate limit exceeded" },
  ]) {
    assert.equal(isRpcRateLimit(error), false);
    assert.match(rpcErrorMessage(error), /合约调用回滚/);
    assert.doesNotMatch(rpcErrorMessage(error), /已触发限流/);
  }
  for (const message of [
    "insufficient funds",
    "gas limit exceeded",
    "nonce too low",
  ])
    assert.equal(isRpcRateLimit(rpc(-32000, message)), false);
});

test("timeouts, aborted reads and receipt timeout have distinct explanations", () => {
  const timeout = new BaseError("HTTP request failed.", {
    cause: new TimeoutError({
      body: { method: "eth_call" },
      url: privateRpcUrl,
    }),
  });
  assert.match(rpcErrorMessage(timeout), /节点响应超时/);
  assert.match(
    rpcErrorMessage({ cause: { code: "ETIMEDOUT" } }),
    /节点响应超时/,
  );
  assert.match(
    rpcErrorMessage({ cause: { name: "AbortError" } }),
    /读取请求已取消/,
  );
  assert.match(
    rpcErrorMessage(new Error("signal is aborted without reason")),
    /读取请求已取消/,
  );
  const receipt = rpcErrorMessage({
    name: "WaitForTransactionReceiptTimeoutError",
    message: "Timed out",
  });
  assert.match(receipt, /继续核对原交易/);
  assert.doesNotMatch(receipt, /更换节点/);
});

test("network, authorization and generic RPC errors omit transport metadata", () => {
  assert.match(
    rpcErrorMessage(
      new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
    ),
    /无法连接 RPC/,
  );
  assert.match(
    rpcErrorMessage(new HttpRequestError({ status: 401, url: privateRpcUrl })),
    /节点拒绝访问/,
  );
  assert.match(
    rpcErrorMessage(new HttpRequestError({ status: 503, url: privateRpcUrl })),
    /HTTP 503/,
  );
  assert.match(
    rpcErrorMessage(rpc(-32601, "method not found")),
    /不支持这项查询/,
  );
  assert.match(
    rpcErrorMessage(rpc(-32602, "invalid parameters")),
    /不接受当前请求参数/,
  );
  assert.equal(
    rpcErrorMessage(rpc(-32000, "provider-specific secret detail")),
    "RPC 请求失败，请稍后重试或检查节点配置。",
  );
});

test("archive capability failures explain the required RPC access instead of invalid parameters", () => {
  const message = `Archive requests require a personal token. Get one at: ${privateRpcUrl}`;
  for (const error of [
    rpc(-32602, message),
    new HttpRequestError({
      status: 403,
      url: privateRpcUrl,
      cause: rpc(-32602, message),
    }),
    new BaseError("Contract read failed.", { cause: rpc(-32602, message) }),
    rpc(-32000, "historical state not available"),
    rpc(-32000, "archive access is disabled"),
    rpc(-32000, "missing trie node 0x123; state has been pruned"),
  ]) {
    const result = rpcErrorMessage(error);
    assert.match(result, /当前 RPC 未开放所需的历史状态查询/);
    assert.match(result, /历史查询权限|更换支持历史状态/);
    assert.doesNotMatch(result, /不接受当前请求参数|节点拒绝访问/);
    assert.equal(isRpcRateLimit(error), false);
    assert.equal(isRpcHistoricalStateUnavailable(error), true);
  }
});

test("archive retry classification excludes generic parameters, throttling, cancellation, timeout and reverts", () => {
  for (const error of [
    rpc(-32602, "invalid argument 1: expected block number"),
    rpc(-32016, "rate limit exceeded: historical state not available"),
    rpc(-32000, "execution reverted: historical state not available"),
    new Error("request timeout: historical state not available"),
    new Error("request cancelled: historical state not available"),
    new Error("RPC Request failed."),
  ])
    assert.equal(isRpcHistoricalStateUnavailable(error), false);
  assert.equal(
    isRpcHistoricalStateUnavailable(
      new Error(
        rpcErrorMessage(
          rpc(-32602, "Archive requests require a personal token"),
        ),
      ),
    ),
    true,
  );
});

test("archive classification preserves revert and parameter distinctions and cannot leak diagnostics", () => {
  const diagnostic = `Archive requests require a personal token. ${privateRpcUrl} Bearer secret-bearer privateKey=secret-private api_key=secret-api`;
  const result = rpcErrorMessage(rpc(-32602, diagnostic));
  for (const secret of [
    "rpc.example",
    "secret-path",
    "secret-query",
    "secret-bearer",
    "secret-private",
    "secret-api",
  ])
    assert.equal(result.includes(secret), false);
  assert.match(
    rpcErrorMessage(
      rpc(
        -32000,
        "execution reverted: Archive requests require a personal token",
      ),
    ),
    /合约调用回滚/,
  );
  assert.match(
    rpcErrorMessage(rpc(-32602, "invalid argument 1: expected block number")),
    /不接受当前请求参数/,
  );
  assert.match(
    rpcErrorMessage(
      new HttpRequestError({
        status: 403,
        url: privateRpcUrl,
        details: "API key is invalid",
      }),
    ),
    /节点拒绝访问/,
  );
  assert.equal(rpcErrorMessage(new Error("未获仓位授权")), "未获仓位授权");
});

test("ordinary Chinese business errors preserve their message", () => {
  for (const message of [
    "未获仓位授权",
    "机器人每天最多允许执行 3 次。",
    "此仓位已暂停，请先恢复任务。",
    "每笔费用超过预算，暂不执行。",
  ])
    assert.equal(rpcErrorMessage(new Error(message)), message);
});

test("business fallback redacts URL credentials, tokens and private-key assignments", () => {
  const error = new Error(
    [
      `配置无效 ${privateRpcUrl}`,
      "Authorization: Bearer secret-bearer",
      "Basic c2VjcmV0",
      'access_token="secret-access" privateKey=0xsecret-key',
      "RANGE_PILOT_PRIVATE_KEY=secret-env 私钥 secret-chinese-key",
      'token: "secret-token" x-api-key: secret-header',
    ].join("\n"),
  );
  const result = rpcErrorMessage(error);
  assert.match(result, /配置无效/);
  for (const secret of [
    "secret-path",
    "secret-query",
    "secret-bearer",
    "c2VjcmV0",
    "secret-access",
    "secret-key",
    "secret-env",
    "secret-chinese-key",
    "secret-token",
    "secret-header",
    "rpc.example",
  ])
    assert.equal(result.includes(secret), false, secret);
});

test("multiline headers and request bodies are not exposed or used to classify errors", () => {
  const error = new Error(
    [
      "配置不完整",
      "Headers:",
      "Custom-Header: unlabelled-secret",
      "Request body:",
      '{"message":"rate limit exceeded","data":"private-payload"}',
      "Version: viem@2",
    ].join("\n"),
  );
  assert.equal(isRpcRateLimit(error), false);
  assert.equal(rpcErrorMessage(error), "配置不完整");
  assert.equal(
    rpcErrorMessage(
      new Error("读取配置失败 Headers: Custom-Header=unlabelled-secret"),
    ),
    "读取配置失败",
  );
  assert.equal(
    isRpcRateLimit(new Error("failed to fetch https://rpc.example/rate-limit")),
    false,
  );
  const viemText = new Error(
    "RPC Request failed.\nURL: https://rpc.example/key\nRequest body: {}\nDetails: over rate limit\nVersion: viem@2",
  );
  assert.equal(isRpcRateLimit(viemText), true);
});

test("only relevant scalar fields are inspected and malformed cyclic errors are bounded", () => {
  let sensitiveReads = 0;
  const error = {
    message: "未设置机器人服务",
    get body() {
      sensitiveReads++;
      throw new Error("must not read");
    },
    get headers() {
      sensitiveReads++;
      throw new Error("must not read");
    },
    get privateKey() {
      sensitiveReads++;
      throw new Error("must not read");
    },
    get cause() {
      throw new Error("throwing getter");
    },
    toJSON() {
      throw new Error("must not stringify");
    },
  };
  assert.equal(rpcErrorMessage(error), "未设置机器人服务");
  assert.equal(sensitiveReads, 0);
  const cycle: { message: string; cause?: unknown; errors?: unknown[] } = {
    message: "连接未完成",
  };
  cycle.cause = cycle;
  cycle.errors = [cycle];
  assert.equal(isRpcRateLimit(cycle), false);
  assert.equal(rpcErrorMessage(cycle), "连接未完成");
  for (const value of [null, undefined, 123, true])
    assert.equal(rpcErrorMessage(value), "请求未完成，请重试。");
});
