import { useI18n, getLocale } from "./useI18n";
import { useEffect, useRef, useState } from "react";
import { Plus, Minus, RotateCcw } from "lucide-react";
import {
  init,
  use,
  type EChartsType,
  type EChartsCoreOption,
} from "echarts/core";
import { LineChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import "./lpValueChart.css";

use([
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  CanvasRenderer,
]);

type View = { min: number; max: number };
type Point = { price: number; value: number; hold: number };
interface Props {
  model: { at: (price: number) => Point };
  min: number;
  max: number;
  lower: number;
  upper: number;
  entry: number | null;
  target: number;
  baseline: number | null;
  quote: string;
  holdings: (price: number) => { base: number; quote: number };
  baseSymbol: string;
}
const priceText = (v: number) =>
  v.toLocaleString(getLocale(), { maximumSignificantDigits: 9 });
const valueText = (v: number) =>
  v.toLocaleString(getLocale(), { maximumFractionDigits: 2 });

function markerLabel(name: string, price: number, color: string, lane: number) {
  return {
    show: true,
    formatter: name + " " + priceText(price),
    color,
    position: "end",
    rotate: 0,
    offset: [0, 16 + lane * 24],
    align: "center",
    verticalAlign: "top",
    backgroundColor: "#181818",
    padding: [4, 6],
    borderRadius: 6,
    fontSize: 12,
  };
}

export default function LpValueChart({
  model,
  min,
  max,
  lower,
  upper,
  entry,
  target,
  baseline,
  quote,
  holdings,
  baseSymbol,
}: Props) {
  const { t, locale } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const [width, setWidth] = useState(0);
  const [verticalView, setVerticalView] = useState<View | null>(null);
  const [view, setView] = useState<View | null>(null);
  const visible = view ?? { min, max };
  const span = max - min;
  const domainMin = min - span * 100;
  const domainMax = max + span * 100;

  useEffect(() => {
    const element = host.current!;
    const resize = () => {
      if (element.clientWidth <= 0) return;
      if (!chart.current) {
        chart.current = init(element);
        chart.current.on("datazoom", () => {
          const option = chart.current!.getOption() as {
            dataZoom: { startValue: number; endValue: number }[];
          };
          const zoom = option.dataZoom[0];
          if (
            Number.isFinite(zoom.startValue) &&
            Number.isFinite(zoom.endValue) &&
            zoom.endValue > zoom.startValue
          )
            setView({ min: zoom.startValue, max: zoom.endValue });
        });
      }
      chart.current.resize();
      setWidth(element.clientWidth);
    };
    let verticalDrag: {
      y: number;
      min: number;
      max: number;
      height: number;
    } | null = null;
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary || !chart.current) return;
      const box = element.getBoundingClientRect();
      const scale = box.height / element.clientHeight;
      const point = [
        ((event.clientX - box.left) * element.clientWidth) / box.width,
        (event.clientY - box.top) / scale,
      ];
      if (!chart.current.containPixel({ gridIndex: 0 }, point)) return;
      const axis = (
        chart.current.getOption() as { yAxis: { min: number; max: number }[] }
      ).yAxis[0];
      verticalDrag = {
        y: event.clientY,
        min: axis.min,
        max: axis.max,
        height: (element.clientHeight - 56) * scale,
      };
    };
    const move = (event: PointerEvent) => {
      if (!verticalDrag || Math.abs(event.clientY - verticalDrag.y) < 3) return;
      const delta =
        ((event.clientY - verticalDrag.y) / verticalDrag.height) *
        (verticalDrag.max - verticalDrag.min);
      setVerticalView({
        min: verticalDrag.min + delta,
        max: verticalDrag.max + delta,
      });
    };
    const up = () => {
      verticalDrag = null;
    };
    const wheel = (event: WheelEvent) => {
      if (!event.shiftKey || !chart.current) return;
      event.preventDefault();
      event.stopPropagation();
      const axis = (
        chart.current.getOption() as { yAxis: { min: number; max: number }[] }
      ).yAxis[0];
      const box = element.getBoundingClientRect();
      const fraction = Math.max(
        0,
        Math.min(
          1,
          1 -
            (((event.clientY - box.top) / box.height) * element.clientHeight -
              18) /
              (element.clientHeight - 56),
        ),
      );
      const anchor = axis.min + (axis.max - axis.min) * fraction;
      const size =
        (axis.max - axis.min) *
        Math.exp(Math.max(-0.3, Math.min(0.3, event.deltaY * 0.003)));
      if (size > 1e-12 && Number.isFinite(size))
        setVerticalView({
          min: anchor - size * fraction,
          max: anchor + size * (1 - fraction),
        });
    };
    element.addEventListener("wheel", wheel, { capture: true, passive: false });
    element.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => {
      observer.disconnect();
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("wheel", wheel, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chart.current || width === 0) return;
    const lo = visible.min,
      hi = visible.max;
    const sampleMin = Math.max(lo, Math.min(hi, min * 1e-9));
    const prices =
      hi > 0
        ? [
            ...new Set([
              ...Array.from(
                { length: 401 },
                (_, i) => sampleMin + ((hi - sampleMin) * i) / 400,
              ),
              lower,
              upper,
              target,
              ...(entry !== null ? [entry] : []),
            ]),
          ]
            .filter((p) => p > 0 && p >= lo && p <= hi)
            .sort((a, b) => a - b)
        : [];
    const points = prices.map((p) => model.at(p));
    const values = points.flatMap((p) => [p.value, p.hold]);
    const lowValue = values.length
      ? Math.min(...values)
      : (baseline ?? model.at(target).value);
    const highValue = values.length ? Math.max(...values) : lowValue;
    const padding = Math.max(
      (highValue - lowValue) * 0.15,
      Math.abs(highValue) * 0.003,
      1e-12,
    );
    const option: EChartsCoreOption = {
      animation: false,
      grid: { left: 16, right: 20, top: 18, bottom: 38 },
      xAxis: {
        type: "value",
        min: domainMin,
        max: domainMax,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: {
          color: "#999",
          hideOverlap: true,
          formatter: (v: number) => (v >= 0 ? priceText(v) : ""),
        },
      },
      yAxis: {
        type: "value",
        min: verticalView?.min ?? Math.max(0, lowValue - padding),
        max: verticalView?.max ?? highValue + padding,
        show: false,
        axisPointer: { show: false },
      },
      tooltip: {
        trigger: "axis",
        renderMode: "html",
        padding: 0,
        extraCssText: "border-radius:12px;box-shadow:0 8px 28px #0005;",
        confine: true,
        backgroundColor: "#202020",
        borderColor: "#3a3a3a",
        textStyle: { color: "#eee" },
        axisPointer: {
          type: "line",
          z: 1,
          lineStyle: { color: "#8b93a6", type: "dashed" },
          label: { backgroundColor: "#444" },
        },
        formatter: (params: { value: number[] }[]) => {
          const price = Number(params[0]?.value?.[0]);
          if (!Number.isFinite(price) || price < 0) return "";
          const point = model.at(price);
          const amounts = holdings(price);
          // Escape every external label before inserting HTML into the tooltip.
          const safe = (text: string) =>
            text.replace(
              /[&<>"']/g,
              (char) =>
                ({
                  "&": "&amp;",
                  "<": "&lt;",
                  ">": "&gt;",
                  '"': "&quot;",
                  "'": "&#39;",
                })[char]!,
            );
          const row = (
            label: string,
            amount: string,
            unit: string,
            color?: string,
          ) =>
            `<div class="lp-tip-row"><span class="lp-tip-label">${color ? `<i style="background:${color}"></i>` : ""}${safe(label)}</span><span class="lp-tip-number">${safe(amount)}${unit ? ` <span class="lp-tip-unit">${safe(unit)}</span>` : ""}</span></div>`;
          const quantity = (v: number) =>
            v.toLocaleString(getLocale(), { maximumSignificantDigits: 7 });
          return `<div class="lp-tip">
            <div class="lp-tip-heading"><span>${safe(t("模拟价格"))}</span><strong>${safe(priceText(price))}<small>${safe(quote)} / ${safe(baseSymbol)}</small></strong></div>
            <div class="lp-tip-group">${row(t("LP 价值"), valueText(point.value), quote, "#7897ff")}${row(t("持币不动"), valueText(point.hold), quote, "#e8b36d")}</div>
            <div class="lp-tip-holdings"><div class="lp-tip-caption">${safe(t("剩余持币"))}</div>${row(baseSymbol, quantity(amounts.base), "")}${row(quote, quantity(amounts.quote), "")}</div>
          </div>`;
        },
      },
      dataZoom: [
        {
          type: "inside",
          xAxisIndex: 0,
          filterMode: "none",
          startValue: lo,
          endValue: hi,
          minValueSpan: span / 1000,
          maxValueSpan: span * 100,
          zoomOnMouseWheel: true,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
          preventDefaultMouseMove: true,
        },
      ],
      series: [
        {
          id: "lp",
          name: t("LP 价值"),
          type: "line",
          showSymbol: false,
          symbol: "circle",
          symbolSize: 8,
          z: 5,
          data: points.map((p) => [p.price, p.value]),
          lineStyle: { color: "#7897ff", width: 2.5 },
          areaStyle: { opacity: 0 },
          itemStyle: {
            color: "#7897ff",
            opacity: 1,
            borderColor: "#eef1ff",
            borderWidth: 2,
          },
          markArea: {
            silent: true,
            itemStyle: { color: "rgba(70,190,156,0.12)" },
            data: [
              [
                {
                  xAxis: lower,
                  lineStyle: { color: "transparent" },
                },
                { xAxis: upper },
              ],
            ],
          },
          markLine: {
            silent: true,
            // Preserve exact token prices; ECharts otherwise rounds markers to 2 decimals.
            precision: -1,
            symbol: "none",
            label: { show: false },
            lineStyle: { color: "#888", type: "dashed" },
            data: [
              {
                xAxis: lower,
                lineStyle: { color: "transparent" },
                label: markerLabel(t("下限"), lower, "#a1a1aa", 0),
              },
              {
                xAxis: upper,
                lineStyle: { color: "transparent" },
                label: markerLabel(t("上限"), upper, "#a1a1aa", 2),
              },
              ...(entry !== null
                ? [
                    {
                      xAxis: entry,
                      lineStyle: {
                        color: "#e4dcce",
                        type: "dashed",
                        width: 1.5,
                      },
                      label: markerLabel(t("入场"), entry, "#e4dcce", 1),
                    },
                  ]
                : []),
              {
                xAxis: target,
                lineStyle: { color: "#cf9fff", type: "solid", width: 1.5 },
                label: markerLabel(t("模拟价"), target, "#cf9fff", 3),
              },
              ...(baseline !== null
                ? [
                    {
                      yAxis: baseline,
                      lineStyle: { color: "#777", type: [5, 8], width: 1 },
                    },
                  ]
                : []),
            ],
          },
        },
        {
          id: "hold",
          name: t("持币不动"),
          type: "line",
          showSymbol: false,
          symbol: "circle",
          symbolSize: 8,
          z: 5,
          data: points.map((p) => [p.price, p.hold]),
          lineStyle: { color: "#e1ad72", width: 2, type: "dashed" },
          itemStyle: {
            color: "#e1ad72",
            opacity: 1,
            borderColor: "#fff0da",
            borderWidth: 2,
          },
        },
        {
          id: "target",
          name: t("模拟价格"),
          type: "scatter",
          symbolSize: 10,
          z: 100,
          itemStyle: {
            color: "#cf9fff",
            opacity: 1,
            borderColor: "#131313",
            borderWidth: 2,
            shadowBlur: 12,
            shadowColor: "#cf9fff66",
          },
          data:
            target >= lo && target <= hi
              ? [[target, model.at(target).value]]
              : [],
        },
      ],
    };
    chart.current.setOption(option, {
      notMerge: false,
      silent: true,
    });
  }, [
    locale,
    model,
    min,
    max,
    lower,
    upper,
    entry,
    target,
    baseline,
    quote,
    holdings,
    baseSymbol,
    width,
    visible.min,
    visible.max,
    verticalView,
    domainMin,
    domainMax,
    span,
  ]);

  const zoomVertical = (factor: number) => {
    if (!chart.current) return;
    const axis = (
      chart.current.getOption() as { yAxis: { min: number; max: number }[] }
    ).yAxis[0];
    const center = (axis.min + axis.max) / 2;
    const size = (axis.max - axis.min) * factor;
    if (size > 1e-12 && Number.isFinite(size))
      setVerticalView({ min: center - size / 2, max: center + size / 2 });
  };
  const zoom = (factor: number) => {
    const nextSpan = Math.max(
      span / 1000,
      Math.min(span * 100, (visible.max - visible.min) * factor),
    );
    const center = (visible.min + visible.max) / 2;
    const nextMin = Math.max(
      domainMin,
      Math.min(domainMax - nextSpan, center - nextSpan / 2),
    );
    setView({ min: nextMin, max: nextMin + nextSpan });
  };
  return (
    <div className="lp-value-chart">
      <div className="lp-chart-header">
        <div className="lp-value-chart-toolbar">
          <div
            className="lp-zoom-group"
            role="group"
            aria-label={t("横向缩放")}
          >
            <span>{t("横向")}</span>
            <button
              type="button"
              className="lp-chart-button"
              aria-label={t("放大图表")}
              onClick={() => zoom(0.7)}
            >
              <Plus size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="lp-chart-button"
              aria-label={t("缩小图表")}
              onClick={() => zoom(1 / 0.7)}
            >
              <Minus size={15} aria-hidden="true" />
            </button>
          </div>
          <div
            className="lp-zoom-group"
            role="group"
            aria-label={t("纵向缩放")}
          >
            <span>{t("纵向")}</span>
            <button
              type="button"
              className="lp-chart-button"
              aria-label={t("纵向拉伸")}
              title={t("纵向拉伸 · Shift + 滚轮")}
              onClick={() => zoomVertical(0.7)}
            >
              <Plus size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="lp-chart-button"
              aria-label={t("纵向压扁")}
              title={t("纵向压扁 · Shift + 滚轮")}
              onClick={() => zoomVertical(1 / 0.7)}
            >
              <Minus size={15} aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            className="lp-chart-button"
            onClick={() => {
              setView(null);
              setVerticalView(null);
            }}
          >
            <RotateCcw size={13} aria-hidden="true" />
            {t("重置视野")}
          </button>
        </div>
      </div>
      <div className="lp-chart-surface">
        <div
          ref={host}
          className="lp-value-chart-canvas"
          role="img"
          aria-label={t(
            "LP 价值图表，区间下限 {0}，上限 {1}",
            priceText(lower),
            priceText(upper),
          )}
        />
      </div>
      <div className="lp-value-legend">
        <span>
          <i style={{ background: "#7897ff" }} />
          {t("LP 价值")}
        </span>
        <span>
          <i className="dashed" style={{ color: "#e1ad72" }} />
          {t("持币不动")}
        </span>
        <span>
          <i className="baseline" />
          {t("入场本金")}
        </span>
      </div>
    </div>
  );
}
