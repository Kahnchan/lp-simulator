import { useI18n, getLocale } from "./useI18n";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Slider } from "antd";
import { Minus, Plus } from "lucide-react";
import "./lpPriceSlider.css";

export default function LpPriceSlider({
  value,
  reference,
  lower,
  upper,
  entry,
  onChange,
}: {
  value: number;
  reference: number;
  lower: number;
  upper: number;
  entry: number | null;
  onChange: (value: number) => void;
}) {
  const { t } = useI18n();
  const fullMin = Math.min(
    reference * 0.8,
    lower * 0.95,
    entry && entry > 0 ? entry : reference,
  );
  const fullMax = Math.max(
    reference * 1.2,
    upper * 1.05,
    entry && entry > 0 ? entry : reference,
  );
  const [nudgePercent, setNudgePercent] = useState(0.1);
  const [range, setRange] = useState([fullMin, fullMax]);
  useEffect(() => {
    setRange([fullMin, fullMax]);
  }, [fullMin, fullMax]);
  useEffect(() => {
    setRange(([min, max]) =>
      value < min
        ? [value * 0.95, max]
        : value > max
          ? [min, value * 1.05]
          : [min, max],
    );
  }, [value, fullMin, fullMax]);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const frame = useRef(0);
  const zoomTarget = useRef<number[] | null>(null);
  const drag = useRef<{
    id: number;
    x: number;
    width: number;
    range: number[];
    value: number;
    handle: boolean;
  } | null>(null);
  const stopAnimation = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    zoomTarget.current = null;
  }, []);
  useEffect(() => stopAnimation, [stopAnimation]);
  useEffect(() => {
    stopAnimation();
  }, [fullMin, fullMax, stopAnimation]);
  const animateRange = useCallback((next: number[]) => {
    zoomTarget.current = next;
    if (frame.current) return;
    let previousTime = performance.now();
    const tick = (time: number) => {
      const target = zoomTarget.current;
      if (!target) {
        frame.current = 0;
        return;
      }
      const current = rangeRef.current;
      const alpha = 1 - Math.exp(-Math.min(64, time - previousTime) / 45);
      previousTime = time;
      const done =
        Math.max(
          Math.abs(target[0] - current[0]),
          Math.abs(target[1] - current[1]),
        ) <
        (target[1] - target[0]) * 0.0001;
      const updated = done
        ? target
        : current.map((v, i) => v + (target[i] - v) * alpha);
      rangeRef.current = updated;
      setRange(updated);
      if (done) {
        frame.current = 0;
        zoomTarget.current = null;
      } else frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, []);
  const sliderRegion = useRef<HTMLDivElement>(null);
  const zoom = useCallback(
    (factor: number, anchor = 0.5) => {
      const [min, max] = zoomTarget.current ?? rangeRef.current;
      const span = Math.max(
        value * 1e-6,
        Math.min(Math.max(fullMax, value) * 100, (max - min) * factor),
      );
      const pivot = min + (max - min) * anchor;
      const start = Math.max(0, pivot - span * anchor);
      animateRange([start, start + span]);
    },
    [value, fullMax, animateRange],
  );
  useEffect(() => {
    const region = sliderRegion.current;
    if (!region) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY || drag.current) return;
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
      const rect = region.getBoundingClientRect();
      const anchor = Math.max(
        0,
        Math.min(1, (event.clientX - rect.left) / rect.width),
      );
      zoom(Math.exp(Math.max(-100, Math.min(100, delta)) * 0.002), anchor);
    };
    region.addEventListener("wheel", onWheel, { passive: false });
    return () => region.removeEventListener("wheel", onWheel);
  }, [zoom]);
  const format = (price: number) =>
    price.toLocaleString(getLocale(), { maximumSignificantDigits: 8 });
  const change = (price: number) => onChange(Number(price.toPrecision(12)));
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopAnimation();
    const rect = event.currentTarget.getBoundingClientRect();
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      width: rect.width,
      range: [...rangeRef.current],
      value,
      handle: !!(event.target as HTMLElement).closest(".ant-slider-handle"),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (drag.current.handle)
      event.currentTarget
        .querySelector<HTMLElement>(".ant-slider-handle")
        ?.focus();
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = drag.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    const span = gesture.range[1] - gesture.range[0];
    const offset = ((event.clientX - gesture.x) / gesture.width) * span;
    if (gesture.handle)
      change(
        Math.max(
          Number.MIN_VALUE,
          Math.min(
            gesture.range[1],
            Math.max(gesture.range[0], gesture.value + offset),
          ),
        ),
      );
    else {
      const start = Math.max(0, gesture.range[0] - offset);
      const next = [start, start + span];
      rangeRef.current = next;
      setRange(next);
    }
  };
  const finishDrag = () => {
    drag.current = null;
  };
  return (
    <div className="lp-price-control">
      <div className="lp-price-control-head">
        <div
          className="lp-price-scale"
          role="group"
          aria-label={t("价格调整范围")}
        >
          <button
            type="button"
            onClick={() => {
              stopAnimation();
              setRange([Math.min(fullMin, value), Math.max(fullMax, value)]);
            }}
          >
            {t("重置布局")}
          </button>
          <button
            type="button"
            aria-label={t("放大价格范围")}
            title={t("放大价格范围")}
            onClick={() => zoom(0.5)}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            aria-label={t("缩小价格范围")}
            title={t("缩小价格范围")}
            onClick={() => zoom(2)}
          >
            <Minus size={14} />
          </button>
        </div>
        <div className="lp-price-nudge" role="group" aria-label={t("价格微调")}>
          <button
            type="button"
            aria-label={t("价格降低 {0}%", nudgePercent)}
            onClick={() => change(value * (1 - nudgePercent / 100))}
          >
            <Minus size={13} />
          </button>
          <select
            aria-label={t("微调精度")}
            value={nudgePercent}
            onChange={(event) => setNudgePercent(Number(event.target.value))}
          >
            {[0.01, 0.1, 1].map((percent) => (
              <option key={percent} value={percent}>
                {percent}%
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label={t("价格提高 {0}%", nudgePercent)}
            onClick={() => change(value * (1 + nudgePercent / 100))}
          >
            <Plus size={13} />
          </button>
        </div>
      </div>
      <div
        ref={sliderRegion}
        className="lp-price-drag-region"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
        onMouseDownCapture={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <Slider
          included={false}
          style={
            {
              "--lp-range-start": `${Math.max(0, Math.min(100, ((lower - range[0]) / (range[1] - range[0])) * 100))}%`,
              "--lp-range-end": `${Math.max(0, Math.min(100, ((upper - range[0]) / (range[1] - range[0])) * 100))}%`,
            } as CSSProperties
          }
          aria-label={t("模拟价格滑块")}
          min={0}
          max={10000}
          step={1}
          value={((value - range[0]) / (range[1] - range[0])) * 10000}
          onChange={(position) =>
            change(range[0] + (position / 10000) * (range[1] - range[0]))
          }
          tooltip={{
            formatter: (position) =>
              format(
                range[0] + ((position ?? 0) / 10000) * (range[1] - range[0]),
              ),
          }}
        />
      </div>
      <div className="lp-price-endpoints">
        <span>{format(range[0])}</span>
        <span>{format(range[1])}</span>
      </div>
    </div>
  );
}
