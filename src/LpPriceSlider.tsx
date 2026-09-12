import { useI18n, getLocale } from "./useI18n";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
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
  const sliderRegion = useRef<HTMLDivElement>(null);
  const zoom = useCallback(
    (factor: number) => {
      setRange(([min, max]) => {
        const span = Math.max(
          value * 1e-6,
          Math.min(Math.max(fullMax, value) * 100, (max - min) * factor),
        );
        const start = Math.max(0, value - span / 2);
        return [start, start + span];
      });
    },
    [value, fullMax],
  );
  useEffect(() => {
    const region = sliderRegion.current;
    if (!region) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
      zoom(Math.exp(Math.max(-100, Math.min(100, delta)) * 0.004));
    };
    region.addEventListener("wheel", onWheel, { passive: false });
    return () => region.removeEventListener("wheel", onWheel);
  }, [zoom]);
  const format = (price: number) =>
    price.toLocaleString(getLocale(), { maximumSignificantDigits: 8 });
  const change = (price: number) => onChange(Number(price.toPrecision(12)));
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
              setRange([Math.min(fullMin, value), Math.max(fullMax, value)]);
            }}
          >
            {t("全范围")}
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
      <div ref={sliderRegion}>
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
