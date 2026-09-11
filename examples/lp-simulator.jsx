import { useI18n, getLocale } from "../src/useI18n";
import LpPriceSlider from "../src/LpPriceSlider";
import { lpSimulatorTheme } from "../src/lpSimulatorTheme";
import LpValueChart from "../src/LpValueChart";
import React, { useState, useEffect } from "react";
import { Button, ConfigProvider, InputNumber, Table, Alert } from "antd";
import { createPosition } from "./lp-simulator-math.mjs";
import "./lp-simulator.css";

const number = (n, digits = 2) =>
  n.toLocaleString(getLocale(), {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
const signed = (n, digits = 2) =>
  `${n > 0.0000001 ? "+" : ""}${number(Math.abs(n) < 1e-8 ? 0 : n, digits)}`;
export default function ManualLpSimulator() {
  const { t, locale } = useI18n();
  const [saved] = useState(() => {
    try {
      const value = JSON.parse(
        localStorage.getItem("range-pilot:manual-simulation:v1") || "{}",
      );
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  });
  const initial = (key, fallback) =>
    Number.isFinite(saved[key]) && saved[key] > 0 ? saved[key] : fallback;
  const [entry, setEntry] = useState(() => initial("entry", 3000));
  const [lower, setLower] = useState(() => initial("lower", 2970));
  const [upper, setUpper] = useState(() => initial("upper", 3030));
  const [capital, setCapital] = useState(() => initial("capital", 10000));
  const [market, setMarket] = useState(() => initial("market", 3000));
  const [target, setTarget] = useState(() => initial("target", 3000));
  const span = 20;
  const [saveError, setSaveError] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(
        "range-pilot:manual-simulation:v1",
        JSON.stringify({ entry, lower, upper, capital, market, target }),
      );
      setSaveError(false);
    } catch {
      setSaveError(true);
    }
  }, [entry, lower, upper, capital, market, target]);
  let model, error;
  try {
    model = createPosition(entry, lower, upper, capital);
    if (!Number.isFinite(target) || target <= 0)
      throw Error(t("目标价格必须大于 0。"));
  } catch (e) {
    error = e.message;
  }
  const valid = model && !error;
  const current = valid ? model.at(target) : null;
  const min = valid
    ? Math.min(entry * (1 - span / 100), lower * 0.995, target)
    : 1;
  const max = valid
    ? Math.max(entry * (1 + span / 100), upper * 1.005, target)
    : 2;
  const status = (p) =>
    p <= lower
      ? t("下限及以下 · 全部 ETH")
      : p >= upper
        ? t("上限及以上 · 全部 USDC")
        : t("区间内 · ETH + USDC");
  const rangePercent = (bound, direction) =>
    Number.isFinite(entry) && entry > 0 && Number.isFinite(bound)
      ? Number(((bound / entry - 1) * direction * 100).toPrecision(12))
      : null;
  const setRangePercent = (percent, direction, setter) => {
    if (percent === null) {
      setter(null);
    } else if (Number.isFinite(entry) && entry > 0) {
      setter(
        Number((entry * (1 + (direction * percent) / 100)).toPrecision(14)),
      );
    }
  };
  const rangeControl = (label, bound, direction, setter) => {
    const percent = rangePercent(bound, direction);
    return (
      <div className="range-control">
        <label className="field">
          <span>{label}</span>
          <InputNumber
            aria-label={label}
            value={percent}
            onChange={(value) => setRangePercent(value, direction, setter)}
            disabled={!Number.isFinite(entry) || entry <= 0}
            min={0}
            max={direction < 0 ? 99.999999 : 1e6}
            step={0.1}
            controls={false}
            addonAfter="%"
          />
        </label>
        <div className="presets">
          {[0.1, 0.5, 1, 2, 5].map((width) => (
            <Button
              key={width}
              type={
                percent !== null && Math.abs(percent - width) < 1e-8
                  ? "primary"
                  : "default"
              }
              disabled={!Number.isFinite(entry) || entry <= 0}
              onClick={() => setRangePercent(width, direction, setter)}
            >
              {direction < 0 ? "−" : "+"}
              {width}%
            </Button>
          ))}
        </div>
      </div>
    );
  };
  const field = (label, value, setter, suffix) => (
    <label className="field">
      <span>{label}</span>
      <InputNumber
        aria-label={label}
        value={value}
        onChange={setter}
        controls={false}
        min={0}
        max={1e12}
        addonAfter={suffix}
      />
    </label>
  );
  const rows = valid
    ? [
        ...new Set([
          entry * 0.5,
          entry * 0.8,
          entry * 0.9,
          lower,
          entry,
          upper,
          entry * 1.1,
          entry * 1.2,
          entry * 1.5,
          target,
        ]),
      ]
        .sort((a, b) => a - b)
        .map((p) => ({ ...model.at(p), key: p }))
    : [];
  const tone = (value) =>
    Math.abs(value) < 1e-8 ? "" : value > 0 ? "scenario-gain" : "scenario-loss";
  const cols = [
    {
      title: t("ETH 价格"),
      dataIndex: "price",
      render: (p) => {
        const label =
          p === lower
            ? t("下限")
            : p === upper
              ? t("上限")
              : p === entry
                ? t("入场")
                : "";
        return (
          <button
            className="scenario-price"
            type="button"
            onClick={() => setTarget(p)}
            aria-label={t("模拟 ETH 价格 {0}", number(p))}
            aria-pressed={p === target}
          >
            <span>{number(p)}</span>
            {label && <span className="scenario-tag">{label}</span>}
            {p === target && (
              <span className="scenario-current">{t("模拟中")}</span>
            )}
          </button>
        );
      },
    },
    {
      title: t("币价涨跌"),
      align: "right",
      render: (_, r) => (
        <span className={tone(r.price / entry - 1)}>
          {signed((r.price / entry - 1) * 100)}%
        </span>
      ),
    },
    {
      title: t("LP 价值"),
      align: "right",
      dataIndex: "value",
      render: (n) => <span className="scenario-value">{number(n)}</span>,
    },
    {
      title: t("本金盈亏"),
      align: "right",
      render: (_, r) => (
        <span className={tone(r.pnl)}>
          {signed(r.pnl)} <small>{signed(r.returnPct)}%</small>
        </span>
      ),
    },
    {
      title: t("持币不动"),
      align: "right",
      dataIndex: "hold",
      render: (n) => number(n),
    },
    {
      title: t("相对持币 / IL"),
      align: "right",
      render: (_, r) => (
        <span className={tone(r.il)}>
          {signed(r.il)}
          <small>{signed(r.ilPct)}%</small>
        </span>
      ),
    },
  ];
  return (
    <ConfigProvider theme={lpSimulatorTheme}>
      <main>
        <div className="layout">
          <aside className="panel">
            <h2>
              <span>{t("设置仓位")}</span>
            </h2>
            <div className="pair">
              ETH <span>／</span> USDC
            </div>
            <p className="muted">
              {t(
                "价格 = 1 ETH 值多少 USDC。USDC 为固定计价单位；默认数字仅为示例。",
              )}
            </p>
            {field(t("入场价格"), entry, setEntry, "USDC")}
            {field(t("投入本金"), capital, setCapital, "USDC")}
            {field(
              t("当前价格（手动记录）"),
              market,
              (v) => {
                if (target === market) setTarget(v);
                setMarket(v);
              },
              "USDC",
            )}
            <p className="muted">
              {t(
                "入场价、本金、当前价和区间会保存在当前浏览器。手动模式不自动读取行情；滑块仅改变模拟价格。",
              )}
            </p>
            {saveError && (
              <Alert
                type="warning"
                message={t("浏览器未能保存参数，当前输入仅保留在本页。")}
              />
            )}
            <div className="divider" />
            <div className="label">{t("相对入场价的区间 · 左右独立设置")}</div>
            {rangeControl(t("左侧下跌幅度"), lower, -1, setLower)}
            {rangeControl(t("右侧上涨幅度"), upper, 1, setUpper)}
            {field(t("区间下限"), lower, setLower, "USDC")}
            {field(t("区间上限"), upper, setUpper, "USDC")}
          </aside>
          <section className="content">
            <div className="panel">
              <div className="section-head">
                <h2>
                  <span>{t("价格走到这里")}</span>
                </h2>
                {valid && <span className="pill">{status(target)}</span>}
              </div>
              <p className="muted">
                {t("入场价")} {Number.isFinite(entry) ? number(entry) : "—"}{" "}
                {t("／ 当前价")}{" "}
                {Number.isFinite(market) ? number(market) : "—"} USDC ·{" "}
                {target === market
                  ? t("滑块位于记录的当前价")
                  : t("正在模拟假设价格")}
              </p>
              <div className="target">
                {field(
                  t("目标价格（也可手动输入任意正数）"),
                  target,
                  setTarget,
                  "USDC",
                )}
                {valid && (
                  <span>
                    {t("较入场")} {signed((target / entry - 1) * 100)}%
                  </span>
                )}
              </div>
              {error && <Alert type="error" showIcon message={t(error)} />}
              {valid && (
                <>
                  <LpPriceSlider
                    value={target}
                    reference={entry}
                    lower={lower}
                    upper={upper}
                    entry={entry}
                    onChange={setTarget}
                  />
                  <div className="quick">
                    <Button onClick={() => setTarget(lower)}>
                      {t("到下限")}
                    </Button>
                    {Number.isFinite(market) && market > 0 && (
                      <Button onClick={() => setTarget(market)}>
                        {t("回当前价")}
                      </Button>
                    )}
                    <Button onClick={() => setTarget(entry)}>
                      {t("回入场价")}
                    </Button>
                    <Button onClick={() => setTarget(upper)}>
                      {t("到上限")}
                    </Button>
                  </div>
                  <div className="metrics manual-metrics">
                    <div>
                      <span>{t("LP 资产价值")}</span>
                      <strong>{number(current.value)}</strong>
                      <small>USDC</small>
                      <div className="metric-detail">
                        <span>{number(current.x, 6)} ETH</span>
                        <span>{number(current.y)} USDC</span>
                      </div>
                    </div>
                    <div>
                      <span>{t("相对投入本金")}</span>
                      <strong>{signed(current.returnPct)}%</strong>
                      <small>{signed(current.pnl)} USDC</small>
                    </div>
                    <div>
                      <span>{t("相对持币不动 / 无常损失")}</span>
                      <strong>{signed(current.ilPct)}%</strong>
                      <small>{signed(current.il)} USDC</small>
                      <div className="metric-detail">
                        {t("持币价值")} {number(current.hold)} USDC
                      </div>
                    </div>
                  </div>
                  <LpValueChart
                    key="chart-v2"
                    baseline={capital}
                    quote="USDC"
                    {...{
                      model,
                      entry,
                      lower,
                      upper,
                      capital,
                      target,
                      min,
                      max,
                      setTarget,
                    }}
                  />
                </>
              )}
            </div>
            {valid && (
              <div className="boundaries">
                {[
                  [
                    lower,
                    t("跌到下限"),
                    t("全部变成 ETH；继续下跌，资产价值继续下降。"),
                  ],
                  [
                    upper,
                    t("涨到上限"),
                    t("全部变成 USDC；继续上涨，LP 价值不再增加。"),
                  ],
                ].map(([p, title, note]) => {
                  const r = model.at(p);
                  return (
                    <div className="panel" key={title}>
                      <span className="muted">
                        {title} · {number(p, 4)}
                      </span>
                      <h3>
                        {signed(r.returnPct)}% <small>{t("相对本金")}</small>
                      </h3>
                      <p>
                        {signed(r.pnl)} {t("USDC · 价值")} {number(r.value)}
                      </p>
                      <p className="muted">{note}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
        {valid && (
          <section className="panel scenario manual-scenario">
            <div className="scenario-heading">
              <h2>{t("价格情景")}</h2>
              <span>{t("金额 · USDC")}</span>
            </div>
            <Table
              columns={cols}
              dataSource={rows}
              pagination={false}
              size="middle"
              scroll={{ x: 850 }}
              rowClassName={(r) => (r.price === target ? "selected" : "")}
            />
          </section>
        )}
      </main>
    </ConfigProvider>
  );
}
