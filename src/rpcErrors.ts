interface ErrorPart {
  name: string;
  text: string;
  shortMessage: string;
  message: string;
  code?: number | string;
  status?: number;
}
function property(value: object, name: string): unknown {
  try {
    return (value as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}
function string(value: unknown) {
  return typeof value === "string" ? value.slice(0, 12_000) : "";
}
function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d{1,8}$/.test(value))
    return Number(value);
  return undefined;
}
function stripDiagnostics(value: string) {
  let inDiagnostics = false;
  return value
    .replace(/\\\//g, "/")
    .split(/\r?\n/)
    .filter((line) => {
      if (/^\s*Details\s*:/i.test(line)) inDiagnostics = false;
      if (
        /^\s*(?:URL|URI|Docs|Version|Request(?: body| headers)?|Response headers|Headers|Body|Stack)\s*:/i.test(
          line,
        )
      ) {
        inDiagnostics = true;
      }
      return !inDiagnostics;
    })
    .join("\n")
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"'`]+/gi, "[节点地址已隐藏]");
}
/** Read only relevant scalar fields; never stringify request bodies, headers or keys. */
function parts(error: unknown): ErrorPart[] {
  const queue = [error],
    seen = new Set<unknown>(),
    result: ErrorPart[] = [];
  for (let cursor = 0; cursor < queue.length && cursor < 32; cursor++) {
    const value = queue[cursor];
    if (value == null || seen.has(value)) continue;
    seen.add(value);
    if (typeof value === "string") {
      const message = stripDiagnostics(string(value));
      result.push({ name: "", text: message, shortMessage: "", message });
      continue;
    }
    if (typeof value !== "object" && typeof value !== "function") continue;
    const code = property(value, "code");
    const shortMessage = stripDiagnostics(
      string(property(value, "shortMessage")),
    );
    const message = stripDiagnostics(string(property(value, "message")));
    const details = stripDiagnostics(string(property(value, "details")));
    result.push({
      name: string(property(value, "name")),
      shortMessage,
      message,
      text: [shortMessage, details, message].join("\n"),
      code: number(code) ?? (typeof code === "string" ? code : undefined),
      status:
        number(property(value, "status")) ??
        number(property(value, "statusCode")),
    });
    for (const key of ["cause", "error", "response"]) {
      const child = property(value, key);
      if (child != null && queue.length < 64) queue.push(child);
    }
    const errors = property(value, "errors");
    if (Array.isArray(errors))
      for (const child of errors.slice(0, 8))
        if (queue.length < 64) queue.push(child);
  }
  return result;
}
const reverted = (part: ErrorPart) =>
  part.code === 3 ||
  /^(?:ExecutionRevertedError|ContractFunctionRevertedError)$/.test(
    part.name,
  ) ||
  /\b(?:execution|transaction|call)\s+reverted\b|\breverted\s+(?:with|for)\b|gas required exceeds allowance|合约(?:调用|执行)?.{0,20}回滚/i.test(
    part.text,
  );
const queryLimit = (part: ErrorPart) =>
  /\brange(?: size)?\s+(?:(?:is|has been)\s+)?(?:limit\b|exceeds?\s+(?:(?:the\s+)?(?:allowed|max(?:imum)?|limit)\b|[\d,]+)|too (?:large|wide))|\b(?:maximum|max)(?: allowed)?\s+(?:block range|batch size|response size|results?(?: count)?|logs?(?: count)?)|\btoo many (?:logs|results)\b|\blogs?\s+limit\b|\bresults?\s+limit\b|\bquery returned (?:more than|over|too many)\b|\blimited to.{0,40}(?:blocks?|range)\b|\bresponse.{0,30}(?:size.{0,15}(?:exceed|limit)|too large)|\bexceeds.{0,30}batch size|查询范围或返回数据量超过节点限制|(?:区块|查询)范围.{0,20}(?:超过.{0,10}(?:限制|上限)|过大)/i.test(
    part.text,
  );
const cancelled = (part: ErrorPart) =>
  part.name === "AbortError" ||
  part.code === "ABORT_ERR" ||
  /signal (?:is |was )?aborted|request (?:was )?aborted|\bcancell?ed\b|已取消(?:读取|请求|核验)/i.test(
    part.text,
  );
const timedOut = (part: ErrorPart) =>
  /TimeoutError$/.test(part.name) ||
  [
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ].includes(String(part.code)) ||
  /\btimed?\s*out\b|\brequest timeout\b|请求超时|响应超时/i.test(part.text);
const explicitRate = (part: ErrorPart) =>
  /\brate[ -]?limit(?:ed|ing)?\b|\btoo many requests\b|\brequest rate\b|requests? per (?:second|minute)|请求.{0,20}(?:过于频繁|频率过高)|(?:RPC|节点).{0,20}限流/i.test(
    part.text,
  );
const historicalStateUnavailable = (part: ErrorPart) =>
  /\barchive requests?\s+require\b|\b(?:archive|historical(?: state| data)?).{0,70}(?:not supported|unsupported|not available|unavailable|disabled|not enabled|require[sd]? (?:a |an )?(?:personal token|api key|access|archive))|\bmissing trie node\b|\bstate(?: data)? (?:is |was |has been )?pruned\b|(?:RPC|节点).{0,25}(?:未开放|不支持|无法提供).{0,15}历史状态/i.test(
    part.text,
  );
function rateLimited(errors: ErrorPart[]) {
  if (errors.some((part) => part.status === 429 || part.code === 429))
    return true;
  // A contract's own "rate limit" revert is a business result, not provider throttling.
  if (errors.some(reverted)) return false;
  return errors.some(
    (part) =>
      explicitRate(part) ||
      ((part.code === -32016 || part.code === -32005) &&
        !errors.some(queryLimit)),
  );
}
/** Recognizes provider throttling, not generic -32000 errors or contract reverts. */
export function isRpcRateLimit(error: unknown): boolean {
  return rateLimited(parts(error));
}
function queryLimited(errors: ErrorPart[]) {
  return (
    !errors.some(
      (part) => reverted(part) || cancelled(part) || timedOut(part),
    ) &&
    !rateLimited(errors) &&
    errors.some(queryLimit)
  );
}
/** Explicit query-capacity limits only; invalid ranges, cancellation and reverts are not retry signals. */
export function isRpcQueryLimit(error: unknown): boolean {
  return queryLimited(parts(error));
}

/** Explicit archive capability failures only; never retry reverts or cancelled reads on another node. */
export function isRpcHistoricalStateUnavailable(error: unknown): boolean {
  const errors = parts(error);
  return (
    !errors.some(
      (part) => reverted(part) || cancelled(part) || timedOut(part),
    ) &&
    !rateLimited(errors) &&
    errors.some(historicalStateUnavailable)
  );
}

function safeBusinessMessage(value: string) {
  return stripDiagnostics(value)
    .replace(
      /(?:^|\s)(?:Request(?: body| headers)?|Response headers|Headers|Body)\s*:[\s\S]*/i,
      "",
    )
    .replace(/\b(?:Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi, "[访问凭据已隐藏]")
    .replace(
      /((?:["']?)(?:authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|private[_-]?key|RANGE_PILOT_PRIVATE_KEY|RANGE_PILOT_AUTOMATION_TOKEN|私钥|访问令牌)(?:["']?)\s*[:=：]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
      "$1[已隐藏]",
    )
    .replace(/((?:私钥|访问令牌|private[_-]?key)\s+)[^\s,;]+/gi, "$1[已隐藏]")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}
/** A concise display reason. Detailed RPC request metadata must stay out of UI/logs. */
export function rpcErrorMessage(error: unknown): string {
  const errors = parts(error);
  if (rateLimited(errors))
    return "RPC 节点请求过于频繁，已触发限流。请稍后重试，或更换可用节点。";
  if (errors.some(reverted))
    return "合约调用回滚，请检查仓位状态、权限或操作参数。更换节点通常不能解决合约校验失败。";
  if (
    errors.some((part) => part.name === "WaitForTransactionReceiptTimeoutError")
  )
    return "等待链上回执超时，请继续核对原交易，避免重复发送。";
  if (
    errors.some(
      (part) =>
        /^(?:TimeoutError|ConnectTimeoutError|HeadersTimeoutError)$/.test(
          part.name,
        ) ||
        [
          "ETIMEDOUT",
          "UND_ERR_CONNECT_TIMEOUT",
          "UND_ERR_HEADERS_TIMEOUT",
          "UND_ERR_BODY_TIMEOUT",
        ].includes(String(part.code)) ||
        /\btimed?\s*out\b|\brequest timeout\b|请求超时|响应超时/i.test(
          part.text,
        ),
    )
  )
    return "RPC 节点响应超时，请稍后重试或更换节点。";
  if (
    errors.some(
      (part) =>
        part.name === "AbortError" ||
        /signal (?:is |was )?aborted|request (?:was )?aborted/i.test(part.text),
    )
  )
    return "读取请求已取消，可重新刷新状态。";
  if (errors.some(historicalStateUnavailable))
    return "当前 RPC 未开放所需的历史状态查询。请开通该节点的历史查询权限，或更换支持历史状态查询的 RPC。";
  if (queryLimited(errors))
    return "RPC 查询范围或返回数据量超过节点限制，请缩小查询范围或使用支持该查询的节点。";
  if (errors.some((part) => part.status === 401 || part.status === 403))
    return "RPC 节点拒绝访问，请检查节点权限与配置。";
  const http = errors.find(
    (part) =>
      part.status !== undefined && part.status >= 400 && part.status <= 599,
  )?.status;
  if (http) return `RPC 节点返回 HTTP ${http}，请稍后重试或检查节点配置。`;
  if (
    errors.some(
      (part) =>
        [
          "ECONNRESET",
          "ECONNREFUSED",
          "ENOTFOUND",
          "EAI_AGAIN",
          "EHOSTUNREACH",
          "ENETUNREACH",
          "EPIPE",
          "UND_ERR_SOCKET",
        ].includes(String(part.code)) ||
        /NetworkError|SocketClosedError|WebSocketRequestError/.test(
          part.name,
        ) ||
        /failed to fetch|fetch failed|network request failed|network error|networkerror|connection (?:reset|refused|closed)|socket hang up|无法连接节点/i.test(
          part.text,
        ),
    )
  )
    return "无法连接 RPC 节点，请检查网络连接或更换节点。";
  const rpc = errors.some(
    (part) =>
      /(?:Rpc|RpcRequest|HttpRequest|ContractFunctionExecution|CallExecution)Error$/.test(
        part.name,
      ) ||
      /\b(?:RPC|HTTP) request failed\b/i.test(part.text) ||
      (typeof part.code === "number" &&
        part.code <= -32000 &&
        part.code >= -32700),
  );
  if (rpc) {
    if (errors.some((part) => part.code === -32601))
      return "RPC 节点不支持这项查询，请使用支持该接口的节点。";
    if (errors.some((part) => part.code === -32602))
      return "RPC 节点不接受当前请求参数，请检查查询配置。";
    return "RPC 请求失败，请稍后重试或检查节点配置。";
  }
  const summary = errors[0]?.shortMessage || errors[0]?.message;
  return summary
    ? safeBusinessMessage(summary) || "请求未完成，请重试。"
    : "请求未完成，请重试。";
}
