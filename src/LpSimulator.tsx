import { useI18n, getLocale } from "./useI18n";
import LpPriceSlider from "./LpPriceSlider";
import LpValueChart from "./LpValueChart";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Popover,
  Input,
  InputNumber,
  Select,
  Table,
} from "antd";
import {
  importSimulationPosition,
  type SimulationImport,
  type SimulationProtocol,
} from "./lpSimulationRead";
import {
  simulationModel,
  simulationEntryValue,
  type SimulationPosition,
} from "./lpSimulation";
import { readEntryHistory, type EntryHistory } from "./lpSimulationHistory";
import { entryRecordKey, parseEntryRecord } from "./lpSimulationRecord";
import {
  simulationNetworks,
  simulationDeployment,
} from "./lpSimulationNetworks";
import { rpcErrorMessage } from "./rpcErrors";
import "../examples/lp-simulator.css";
import "./lpSimulator.css";

const sourceKey = (v: SimulationImport) =>
  JSON.stringify([
    v.chainId,
    v.protocol,
    v.manager.toLowerCase(),
    v.tokenId.trim(),
    v.rpcUrl,
    v.stateView?.toLowerCase(),
  ]);
const num = (v: number, d = 2) =>
  v.toLocaleString(getLocale(), { maximumFractionDigits: d });
const signed = (v: number) => (v > 0 ? "+" : "") + num(v);
export default function LpSimulator({
  toolbarRoot,
  active,
}: {
  toolbarRoot: HTMLElement | null;
  active: boolean;
}) {
  const { t, locale } = useI18n();
  const [form, setForm] = useState<SimulationImport>({
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    protocol: "aerodrome",
    ...simulationDeployment(8453, "aerodrome"),
    tokenId: "",
  });
  const [customNetwork, setCustomNetwork] = useState(false);
  const [position, setPosition] = useState<SimulationPosition | null>(null);
  const [loadedSource, setLoadedSource] = useState("");
  const [reverse, setReverse] = useState(false);
  const [target, setTarget] = useState<number | null>(null);
  const [entry, setEntry] = useState<number | null>(null);
  const [history, setHistory] = useState<EntryHistory | null>(null);
  const [historyStatus, setHistoryStatus] = useState("");
  const [saveError, setSaveError] = useState("");
  const [cost, setCost] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  function restoreRecord(p: SimulationPosition, rev: boolean) {
    try {
      const record = parseEntryRecord(
        localStorage.getItem(entryRecordKey(p, rev)),
      );
      setEntry(record.entry);
      setCost(record.cost);
      setSaveError("");
    } catch {
      setEntry(null);
      setCost(null);
      setSaveError("无法读取本地入场记录，请重新填写；当前链上数据不受影响。");
    }
  }
  function saveRecord(nextEntry: number | null, nextCost: number | null) {
    setEntry(nextEntry);
    setCost(nextCost);
    if (!position) return;
    try {
      localStorage.setItem(
        entryRecordKey(position, reverse),
        JSON.stringify({ entry: nextEntry, cost: nextCost }),
      );
      setSaveError("");
    } catch {
      setSaveError("浏览器未能保存入场记录，当前输入仅保留在本页。");
    }
  }

  function edit(patch: Partial<SimulationImport>) {
    request.current++;
    setHistoryStatus("");
    setLoading(false);
    setError("");
    setForm((v) => ({ ...v, ...patch }));
  }
  let model: ReturnType<typeof simulationModel> | null = null;
  let modelError = "";
  try {
    if (position) model = simulationModel(position, reverse);
  } catch (e) {
    modelError = rpcErrorMessage(e);
  }
  async function fetchHistory(
    p: SimulationPosition,
    rev: boolean,
    source: SimulationImport,
    id: number,
  ) {
    setHistory(null);
    setHistoryStatus("正在读取历史入场记录…");
    try {
      const result = await readEntryHistory(
        source,
        BigInt(p.blockNumber),
        rev,
        (status) => {
          if (id === request.current) setHistoryStatus(status);
        },
        () => id === request.current,
      );
      if (id !== request.current) return;
      setHistory(result);
      setHistoryStatus("");
      setEntry((previous) => previous ?? result.first.price);
    } catch (e) {
      if (id === request.current)
        setHistoryStatus("历史读取失败：" + rpcErrorMessage(e));
    }
  }
  async function load() {
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      const p = await importSimulationPosition({ ...form });
      if (id !== request.current) return;
      const samePosition =
        position?.chainId === p.chainId &&
        position.manager.toLowerCase() === p.manager.toLowerCase() &&
        position.tokenId === p.tokenId;
      const rev = samePosition
        ? reverse
        : p.token0.symbol.toUpperCase() === "USDC" ||
          p.token0.symbol.toUpperCase() === "USDT";
      const m = simulationModel(p, rev);
      setPosition(p);
      setLoadedSource(sourceKey(form));
      setReverse(rev);
      setTarget(m.price);
      if (!samePosition) restoreRecord(p, rev);
      void fetchHistory(p, rev, { ...form }, id);
    } catch (e) {
      if (id === request.current) setError(rpcErrorMessage(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }
  const baseline = simulationEntryValue(model, entry, cost);
  const validTarget = target !== null && Number.isFinite(target) && target > 0;
  const current = model && validTarget ? model.at(target) : null;
  const min = model
    ? Math.min(
        model.price * 0.5,
        model.lower * 0.9,
        entry !== null && entry > 0 ? entry : model.price,
        validTarget ? target : model.price,
      )
    : 1;
  const max = model
    ? Math.max(
        model.price * 2,
        model.upper * 1.1,
        entry !== null && entry > 0 ? entry : model.price,
        validTarget ? target : model.price,
      )
    : 2;
  const stale = position && loadedSource !== sourceKey(form);
  const stats =
    model && current
      ? [
          [t("LP 本金价值"), num(current.value) + " " + model.quote.symbol],
          [
            t("相对入场价值"),
            baseline === null
              ? t("待获取入场价值")
              : signed(current.value - baseline) + " " + model.quote.symbol,
          ],
          [
            t("本金变化比例"),
            baseline !== null && baseline > 0
              ? signed((current.value / baseline - 1) * 100) + "%"
              : "—",
          ],
        ]
      : [];
  const samples = model
    ? [
        ...new Set([
          model.price * 0.5,
          model.lower,
          model.price,
          model.upper,
          model.price * 1.5,
          ...(validTarget ? [target] : []),
        ]),
      ]
        .sort((a, b) => a - b)
        .map((p) => ({ ...model.at(p), key: p }))
    : [];
  const importCardRef = useRef<HTMLElement>(null);
  const previousCardRect = useRef<DOMRect | null>(null);
  const hadModel = useRef(false);
  useLayoutEffect(() => {
    const card = importCardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const previous = previousCardRect.current;
    if (
      model &&
      !hadModel.current &&
      previous &&
      previous.width > 0 &&
      rect.width > 0 &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      card.animate(
        [
          {
            transform: `translate(${previous.left - rect.left}px, ${previous.top - rect.top}px)`,
          },
          { transform: "translate(0, 0)" },
        ],
        { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }
    previousCardRect.current = rect;
    hadModel.current = Boolean(model);
  });
  return (
    <main className="lp-live">
      {toolbarRoot &&
        active &&
        createPortal(
          <>
            <Select
              aria-label={t("网络")}
              value={customNetwork ? -1 : form.chainId}
              options={[
                ...simulationNetworks.map((n) => ({
                  label: n.name,
                  value: n.id,
                })),
                { label: t("自定义网络"), value: -1 },
              ]}
              onChange={(id) => {
                setCustomNetwork(id === -1);
                if (id === -1) {
                  edit({
                    chainId: 0,
                    rpcUrl: "",
                    ...simulationDeployment(0, form.protocol),
                  });
                  return;
                }
                const network = simulationNetworks.find((n) => n.id === id)!;
                const protocol =
                  form.protocol === "aerodrome" && id !== 8453
                    ? "uniswap-v3"
                    : form.protocol;
                edit({
                  chainId: id,
                  rpcUrl: network.rpc,
                  protocol,
                  ...simulationDeployment(id, protocol),
                });
              }}
            />
            <Popover
              trigger="click"
              placement="bottomRight"
              title={t("RPC 设置")}
              content={
                <div className="lp-rpc-settings">
                  <label className="field">
                    <span>Chain ID</span>
                    <InputNumber
                      aria-label="Chain ID"
                      min={1}
                      precision={0}
                      value={form.chainId}
                      onChange={(v) => {
                        setCustomNetwork(true);
                        edit({
                          chainId: v ?? 0,
                          rpcUrl:
                            simulationNetworks.find((n) => n.id === v)?.rpc ??
                            "",
                          ...simulationDeployment(v ?? 0, form.protocol),
                        });
                      }}
                    />
                  </label>

                  <label className="field">
                    <span>{t("RPC 地址")}</span>
                    <Input
                      aria-label={t("RPC 地址")}
                      value={form.rpcUrl}
                      onChange={(e) => edit({ rpcUrl: e.target.value })}
                    />
                  </label>
                </div>
              }
            >
              <Button>{t("RPC 设置")}</Button>
            </Popover>
          </>,
          toolbarRoot,
        )}

      <div
        className={`layout ${model ? "lp-import-ready" : "lp-import-empty"}`}
      >
        <aside className="panel" ref={importCardRef}>
          <h2>
            <span>{t("导入 NFT 仓位")}</span>
          </h2>
          <label className="field">
            <span>{t("协议")}</span>
            <Select
              aria-label={t("协议")}
              value={form.protocol}
              options={[
                { label: "Uniswap V3", value: "uniswap-v3" },
                { label: "Uniswap V4", value: "uniswap-v4" },
                { label: "Aerodrome / Slipstream", value: "aerodrome" },
              ]}
              onChange={(protocol: SimulationProtocol) =>
                edit({
                  protocol,
                  ...simulationDeployment(form.chainId, protocol),
                })
              }
            />
          </label>
          <details className="lp-contract-settings">
            <summary>{t("自定义合约")}</summary>
            <label className="field">
              <span>{t("NFT 管理合约")}</span>
              <Input
                aria-label={t("NFT 管理合约")}
                value={form.manager}
                onChange={(e) => edit({ manager: e.target.value })}
              />
            </label>
            {form.protocol === "uniswap-v4" && (
              <label className="field">
                <span>V4 StateView</span>
                <Input
                  aria-label="V4 StateView"
                  value={form.stateView}
                  onChange={(e) => edit({ stateView: e.target.value })}
                />
              </label>
            )}
          </details>
          <label className="field">
            <span>{t("NFT 编号")}</span>
            <Input
              aria-label={t("NFT 编号")}
              value={form.tokenId}
              onChange={(e) => edit({ tokenId: e.target.value })}
              onPressEnter={() => void load()}
            />
          </label>
          <Button
            block
            type="primary"
            loading={loading}
            onClick={() => void load()}
          >
            {t("读取仓位")}
          </Button>
          {!form.manager && (
            <Alert
              type="info"
              title={t("该链与协议暂无预设，请展开自定义合约填写地址。")}
            />
          )}
          {error && (
            <Alert
              type="error"
              showIcon
              title={t("读取失败")}
              description={t(error)}
            />
          )}
          {position && (
            <details className="lp-read-details">
              <summary>{t("仓位详情")}</summary>
              <div className="note">
                {t("已读取网络：")}
                {position.chainId}
                <br />
                NFT：{position.tokenId}
                <br />
                {t("区块：")}
                {position.blockNumber}
                <br />
                {t("区块时间：")}
                {new Date(position.blockTime).toLocaleString(locale)}
                <br />
                {t("持有人：")}
                <span className="address">{position.owner}</span>
              </div>
            </details>
          )}
          {model && (
            <>
              <div className="divider" />
              <label className="field">
                <span>{t("计价单位")}</span>
                <Select
                  aria-label={t("计价单位")}
                  value={reverse ? "token0" : "token1"}
                  options={[
                    { value: "token1", label: position!.token1.symbol },
                    { value: "token0", label: position!.token0.symbol },
                  ]}
                  onChange={(v) => {
                    const rev = v === "token0";
                    request.current++;
                    setLoading(false);
                    setReverse(rev);
                    restoreRecord(position!, rev);
                    setTarget(simulationModel(position!, rev).price);
                    void fetchHistory(
                      position!,
                      rev,
                      { ...form },
                      request.current,
                    );
                  }}
                />
              </label>
              <label className="field">
                <span>
                  {t("入场价格 ·")} {model.quote.symbol}/{model.base.symbol}
                </span>
                <InputNumber
                  aria-label={t("记录入场价格")}
                  min={Number.MIN_VALUE}
                  value={entry}
                  placeholder={t("填写实际入场价")}
                  onChange={(v) => saveRecord(v, cost)}
                />
              </label>
              {historyStatus && (
                <Alert
                  type={
                    historyStatus.startsWith("历史读取失败")
                      ? "warning"
                      : "info"
                  }
                  title={t(historyStatus)}
                />
              )}
              {history && (
                <div className="lp-entry-options">
                  {[
                    [t("首次创建"), history.first],
                    [t("最近加仓"), history.latest],
                  ].map(([label, raw]) => {
                    if (!raw || typeof raw === "string") return null;
                    return (
                      <div className="lp-entry-option" key={String(label)}>
                        <div className="lp-entry-choice">
                          <span>
                            <small>{String(label)}</small>
                            <strong>{num(raw.price, 8)}</strong>
                          </span>
                          <Button
                            size="small"
                            onClick={() => saveRecord(raw.price, cost)}
                            aria-label={t("采用{0}价", String(label))}
                          >
                            {t("采用")}
                          </Button>
                        </div>
                        <details>
                          <summary>{t("来源")}</summary>
                          <p>
                            {new Date(raw.time).toLocaleString(locale)}
                            {t("· 区块")} {raw.block}
                          </p>
                          <p className="address">{raw.transaction}</p>
                          <p>{t(raw.method)}</p>
                        </details>
                      </div>
                    );
                  })}
                  {history.warning && (
                    <details>
                      <summary>{t("历史读取说明")}</summary>
                      <p>{t(history.warning)}</p>
                    </details>
                  )}
                </div>
              )}
              {saveError && <Alert type="warning" title={t(saveError)} />}
              <label className="field">
                <span>
                  {t("实际投入本金（可选，{0}）", model.quote.symbol)}
                </span>
                <InputNumber
                  aria-label={t("实际投入本金")}
                  min={0.000000001}
                  value={cost}
                  placeholder={t("默认按入场价估算")}
                  onChange={(v) => saveRecord(entry, v)}
                />
              </label>
            </>
          )}
        </aside>
        <section className="content">
          {stale && (
            <Alert
              type="warning"
              title={t(
                "输入已修改，下方仍是上一次导入的仓位。点击读取仓位后更新。",
              )}
            />
          )}
          {modelError && <Alert type="error" title={t(modelError)} />}
          {model && (
            <div className="panel">
              <div className="section-head">
                <h2>
                  <span>
                    {model.base.symbol} / {model.quote.symbol}
                  </span>
                </h2>
              </div>
              <div className="target">
                <label className="field">
                  <span>{t("模拟价格")}</span>
                  <InputNumber
                    aria-label={t("模拟价格")}
                    value={target}
                    min={Number.MIN_VALUE}
                    controls={false}
                    onChange={setTarget}
                  />
                </label>
                <span>
                  {t("往左：{0} 变便宜；往右：变贵", model.base.symbol)}
                </span>
              </div>
              {!validTarget && (
                <Alert type="warning" title={t("请输入大于 0 的模拟价格。")} />
              )}
              <LpPriceSlider
                value={validTarget ? target : model.price}
                reference={model.price}
                lower={model.lower}
                upper={model.upper}
                entry={entry}
                onChange={setTarget}
              />
              <div className="quick">
                {entry !== null && entry > 0 && (
                  <Button onClick={() => setTarget(entry)}>
                    {t("到入场价")}
                  </Button>
                )}
                <Button onClick={() => setTarget(model!.lower)}>
                  {t("到下限")}
                </Button>
                <Button onClick={() => setTarget(model!.price)}>
                  {t("回当前价")}
                </Button>
                <Button onClick={() => setTarget(model!.upper)}>
                  {t("到上限")}
                </Button>
              </div>
              {current && (
                <>
                  <p className="muted">
                    {baseline === null
                      ? t("等待入场价或填写投入本金后计算入场盈亏。")
                      : t(
                          "入场价值：{0} {1}（{2}）",
                          num(baseline),
                          model.quote.symbol,
                          cost === null
                            ? t(
                                "按当前流动性在入场价估算；多次增减仓时不等于历史累计投入",
                              )
                            : t("采用填写的投入本金"),
                        )}
                  </p>
                  <div className="metrics">
                    {stats.map(([label, v]) => (
                      <div key={label}>
                        <span>{label}</span>
                        <strong>{v}</strong>
                      </div>
                    ))}
                  </div>
                  <p>
                    {t("模拟持币：")}
                    <b>
                      {num(current.base, 8)} {model.base.symbol} +{" "}
                      {num(current.quote, 8)} {model.quote.symbol}
                    </b>
                  </p>
                  <LpValueChart
                    key={`chart-v2:${position!.chainId}:${position!.manager}:${position!.tokenId}:${reverse}`}
                    model={model}
                    lower={model.lower}
                    upper={model.upper}
                    quote={model.quote.symbol}
                    min={min}
                    max={max}
                    target={target!}
                    baseline={baseline}
                    entry={entry}
                  />
                </>
              )}
            </div>
          )}
          {model && (
            <div className="boundaries">
              {[
                [model.lower, t("到左侧下限")],
                [model.upper, t("到右侧上限")],
              ].map(([p, label]) => {
                const v = model.at(Number(p));
                return (
                  <div className="panel" key={label}>
                    <span>
                      {label} · {num(Number(p), 8)}
                    </span>
                    <h3>
                      {baseline === null
                        ? t("待获取入场价值")
                        : `${signed(v.value - baseline)} ${model.quote.symbol}`}
                    </h3>
                    <p>
                      {t("本金价值")} {num(v.value)} {model.quote.symbol}
                    </p>
                    <p className="muted">
                      {Number(p) === model.lower
                        ? t("全部变成 ") +
                          model.base.symbol +
                          t("；继续下跌，价值继续减少。")
                        : t("全部变成 ") +
                          model.quote.symbol +
                          t("；以该币计价的本金价值保持不变。")}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
      {model && (
        <section className="panel scenario">
          <h2>
            <span>{t("不同价格下的结果")}</span>
          </h2>
          <Table
            pagination={false}
            dataSource={samples}
            rowKey="key"
            scroll={{ x: 650 }}
            columns={[
              {
                title: t(
                  "价格（{0}/{1}）",
                  model.quote.symbol,
                  model.base.symbol,
                ),
                dataIndex: "price",
                render: (v: number) => (
                  <Button type="text" onClick={() => setTarget(v)}>
                    {num(v, 8)}
                  </Button>
                ),
              },
              {
                title: t("LP 价值"),
                dataIndex: "value",
                render: (v: number) => num(v),
              },
              {
                title: t("本金盈亏"),
                dataIndex: "value",
                render: (v: number) =>
                  baseline === null ? "—" : signed(v - baseline),
              },
              {
                title: model.base.symbol + t(" 数量"),
                dataIndex: "base",
                render: (v: number) => num(v, 8),
              },
              {
                title: model.quote.symbol + t(" 数量"),
                dataIndex: "quote",
                render: (v: number) => num(v, 8),
              },
            ]}
          />
        </section>
      )}
      {position?.warnings.map((w) => (
        <Alert key={w} type="warning" title={w} />
      ))}
    </main>
  );
}
