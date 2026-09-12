import { useEffect, useState } from "react";
import { Alert, Button, InputNumber, Select } from "antd";
import { useI18n, getLocale } from "./useI18n";
import { simulationModel, type SimulationPosition } from "./lpSimulation";
import { capitalKey, fetchUsdcPrices, referenceValue } from "./lpUsdcPricing";
import type { HistoryPoint } from "./lpSimulationHistory";
import type { SimulationImport } from "./lpSimulationRead";
import "./lpUsdcValuation.css";
import { rpcErrorMessage } from "./rpcErrors";

type Props = {
  position: SimulationPosition;
  source: SimulationImport;
  reverse: boolean;
  target: number | null;
  active: boolean;
  firstEntry: HistoryPoint | null;
  historyStatus: string;
  retryHistory: () => void;
  read: (s: SimulationImport, fresh: boolean) => Promise<SimulationPosition>;
};
export default function LpUsdcValuation({
  position,
  source,
  reverse,
  target,
  active,
  firstEntry,
  historyStatus,
  retryHistory,
  read,
}: Props) {
  const { t } = useI18n();
  const [capital, setCapital] = useState<number | null>(() => {
    try {
      const n = Number(localStorage.getItem(capitalKey(position)));
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  });
  const [saveError, setSaveError] = useState(false);
  const [editCapital, setEditCapital] = useState(false);
  const [historical, setHistorical] = useState<{
    time: string;
    prices: Awaited<ReturnType<typeof fetchUsdcPrices>>;
  } | null>(null);
  const [historyQuoteFailed, setHistoryQuoteFailed] = useState(false);
  const [historyRetry, setHistoryRetry] = useState(0);
  const entryTime = firstEntry?.time;
  useEffect(() => {
    if (!entryTime || !active) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    setHistoryQuoteFailed(false);
    fetchUsdcPrices(
      position,
      controller.signal,
      Math.floor(Date.parse(entryTime) / 1000),
    )
      .then((prices) => {
        if (!cancelled) setHistorical({ time: entryTime, prices });
      })
      .catch(() => {
        if (!cancelled) setHistoryQuoteFailed(true);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [entryTime, position, active, historyRetry]);

  const [anchor, setAnchor] = useState(() =>
    /^(WBNB|WETH|WBTC)$/i.test(position.token0.symbol)
      ? 0
      : /^(WBNB|WETH|WBTC)$/i.test(position.token1.symbol)
        ? 1
        : reverse
          ? 0
          : 1,
  );
  const [change, setChange] = useState<number | null>(0);
  const [data, setData] = useState<{
    position: SimulationPosition;
    prices: Awaited<ReturnType<typeof fetchUsdcPrices>>;
    updated: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failureReason, setFailureReason] = useState("");
  const [retry, setRetry] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const sourceId = JSON.stringify(source);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let running = false;
    let first = true;
    let controller: AbortController | null = null;
    async function refresh() {
      if (running || document.hidden) return;
      running = true;
      setBusy(true);
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 12000);
      try {
        const [snapshot, prices] = await Promise.all([
          read(JSON.parse(sourceId), !first),
          fetchUsdcPrices(position, controller.signal),
        ]);
        if (!cancelled) {
          setData({ position: snapshot, prices, updated: Date.now() });
          setFailed(false);
          setFailureReason("");
          setClock(Date.now());
        }
      } catch (error) {
        if (!cancelled) {
          setFailed(true);
          setFailureReason(rpcErrorMessage(error));
        }
      } finally {
        clearTimeout(timeout);
        running = false;
        first = false;
        if (!cancelled) setBusy(false);
      }
    }
    void refresh();
    const timer = setInterval(() => {
      setClock(Date.now());
      void refresh();
    }, 30000);
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      cancelled = true;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active, sourceId, retry, read, position]);
  const tokens = [position.token0, position.token1];
  const price = data?.prices[anchor];
  const fresh =
    !!data &&
    !failed &&
    clock - data.updated < 90000 &&
    !!price &&
    clock - price.timestamp * 1000 <= 900000;
  const anchorIsBase = anchor === (reverse ? 1 : 0);
  let live: ReturnType<typeof simulationModel> | null = null;
  try {
    if (data && Number(data.position.liquidity) > 0)
      live = simulationModel(data.position, reverse);
  } catch {
    /* Invalid or closed position: no live estimate. */
  }
  const scenario = simulationModel(position, reverse);
  const actualHoldings = data
    ? {
        base: Number(reverse ? data.position.amount1 : data.position.amount0),
        quote: Number(reverse ? data.position.amount0 : data.position.amount1),
      }
    : null;
  const actual =
    fresh && data && Number(data.position.liquidity) === 0
      ? 0
      : fresh && live && actualHoldings
        ? referenceValue(
            actualHoldings.base,
            actualHoldings.quote,
            live.price,
            anchorIsBase,
            price!.price,
          )
        : null;
  const holding =
    target !== null && Number.isFinite(target) && target > 0
      ? scenario.at(target)
      : null;
  const simulated =
    fresh && holding && change !== null
      ? referenceValue(
          holding.base,
          holding.quote,
          target!,
          anchorIsBase,
          price!.price * (1 + change / 100),
        )
      : null;
  const entryHoldings = firstEntry ? scenario.at(firstEntry.price) : null;
  const historicalPrices =
    historical?.time === entryTime ? historical?.prices : null;
  const historicalAnchor = historicalPrices?.[anchor]
    ? anchor
    : historicalPrices?.[1 - anchor]
      ? 1 - anchor
      : null;
  const autoCapital =
    entryHoldings && historicalAnchor !== null
      ? referenceValue(
          entryHoldings.base,
          entryHoldings.quote,
          firstEntry!.price,
          historicalAnchor === (reverse ? 1 : 0),
          historicalPrices![historicalAnchor]!.price,
        )
      : null;
  const effectiveCapital = capital ?? autoCapital;
  const format = (v: number) =>
    v.toLocaleString(getLocale(), { maximumFractionDigits: 2 });
  function save(v: number | null) {
    setCapital(v);
    try {
      if (v === null) localStorage.removeItem(capitalKey(position));
      else localStorage.setItem(capitalKey(position), String(v));
      setSaveError(false);
    } catch {
      setSaveError(true);
    }
  }
  return (
    <section className="usdc-valuation">
      <div className="usdc-heading">
        <h3>{t("USDC 本金盈亏")}</h3>
        <span className="muted">
          {busy ? t("正在刷新") : fresh ? t("每 30 秒刷新") : t("行情不可用")}
          <Button
            type="text"
            size="small"
            onClick={() => setRetry((v) => v + 1)}
            disabled={busy}
          >
            {t("刷新")}
          </Button>
        </span>
      </div>
      <div className="usdc-controls">
        <div className="field">
          <span className="usdc-capital-label">
            {capital === null ? t("入场估值 · USDC") : t("实际投入本金 · USDC")}
            <Button
              type="text"
              size="small"
              onClick={() => setEditCapital((v) => !v)}
            >
              {t("修正")}
            </Button>
          </span>
          <strong className="usdc-entry-value">
            {effectiveCapital === null ? "—" : format(effectiveCapital)}{" "}
            <small>USDC</small>
          </strong>
          {effectiveCapital === null && (
            <span className="usdc-note">
              {(historical !== null &&
                historical.time === entryTime &&
                autoCapital === null) ||
              historyQuoteFailed ||
              historyStatus.startsWith("历史读取失败")
                ? t("暂未获取入场估值")
                : firstEntry
                  ? t("正在读取入场时行情…")
                  : t("正在读取入场记录…")}
              <Button
                type="text"
                size="small"
                onClick={() => {
                  setHistoryRetry((v) => v + 1);
                  if (!firstEntry) retryHistory();
                }}
              >
                {t("重试")}
              </Button>
            </span>
          )}
        </div>
        <label className="field">
          <span>{t("实时参考币")}</span>
          <Select
            aria-label={t("实时参考币")}
            value={anchor}
            onChange={setAnchor}
            options={tokens.map((token, i) => ({
              value: i,
              label: token.symbol,
            }))}
          />
        </label>
        <label className="field">
          <span>{t("参考币模拟涨跌")}</span>
          <InputNumber
            aria-label={t("参考币模拟涨跌")}
            min={-99.99}
            max={10000}
            step={1}
            value={change}
            suffix="%"
            onChange={setChange}
          />
        </label>
        <Button onClick={() => setChange(0)}>{t("恢复实时")}</Button>
      </div>
      {editCapital && (
        <div className="usdc-capital-edit">
          <InputNumber
            aria-label={t("实际投入本金 · USDC")}
            value={capital}
            min={0.000001}
            onChange={save}
            placeholder={t("填写实际投入金额")}
            suffix="USDC"
          />
          <Button
            onClick={() => {
              save(null);
              setEditCapital(false);
            }}
          >
            {t("使用自动估值")}
          </Button>
        </div>
      )}
      <p className="usdc-note">
        {capital === null
          ? t(
              "按当前流动性、首次入场比价及当时行情估算；多次增减仓或转入的 NFT 不代表实际累计投入。",
            )
          : t("采用手动修正的实际投入本金")}
      </p>
      <div className="usdc-results">
        {[
          [t("当前仓位估值"), actual],
          [t("滑块模拟估值"), simulated],
        ].map(([label, value]) => {
          const v = typeof value === "number" ? value : null;
          const pnl =
            v !== null && effectiveCapital !== null && effectiveCapital > 0
              ? v - effectiveCapital
              : null;
          return (
            <div className="usdc-result" key={String(label)}>
              <span>{label}</span>
              <strong>
                {v === null ? "—" : format(v)} <small>USDC</small>
              </strong>
              <div
                className={
                  pnl === null || pnl === 0
                    ? "muted"
                    : pnl > 0
                      ? "usdc-profit"
                      : "usdc-loss"
                }
              >
                {pnl === null
                  ? effectiveCapital === null
                    ? t("等待入场估值")
                    : t("等待有效行情")
                  : `${pnl > 0 ? "+" : ""}${format(pnl)} USDC · ${pnl > 0 ? "+" : ""}${format((pnl / effectiveCapital!) * 100)}%`}
              </div>
            </div>
          );
        })}
      </div>
      <p className="usdc-note">
        {fresh
          ? `${tokens[anchor].symbol} = ${price!.price.toLocaleString(getLocale(), { maximumSignificantDigits: 7 })} USDC · ${t("行情时间")} ${new Date(price!.timestamp * 1000).toLocaleTimeString(getLocale())}`
          : t("参考币报价暂不可用，请刷新或切换参考币。")}
      </p>
      <p className="usdc-note">
        {t(
          "按池内比价换算另一种币；模拟涨跌仅影响模拟结果。不含手续费收益、Gas 和已提取资产。",
        )}{" "}
        <a href="https://defillama.com" target="_blank" rel="noreferrer">
          DefiLlama
        </a>
      </p>
      {failed && <p className="usdc-note">{t(failureReason)}</p>}
      {saveError && (
        <Alert
          type="warning"
          title={t("浏览器未能保存本金，当前输入仅保留在本页。")}
        />
      )}
    </section>
  );
}
