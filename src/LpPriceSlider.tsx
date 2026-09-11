import { useI18n, getLocale } from "./useI18n";
import { useEffect, useState } from "react";
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
  const { t, locale } = useI18n();
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
  const [fine, setFine] = useState(false);
  const [range, setRange] = useState([fullMin, fullMax]);
  useEffect(() => {
    setFine(false);
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
            aria-pressed={!fine}
            onClick={() => {
              setFine(false);
              setRange([Math.min(fullMin, value), Math.max(fullMax, value)]);
            }}
          >
            {t("全范围")}
          </button>
          <button
            type="button"
            aria-pressed={fine}
            onClick={() => {
              setFine(true);
              setRange([value * 0.95, value * 1.05]);
            }}
          >
            {t("精细")}
          </button>
        </div>
        <div className="lp-price-nudge" role="group" aria-label={t("价格微调")}>
          <button
            type="button"
            aria-label={t("价格降低 0.1%")}
            onClick={() => change(value * 0.999)}
          >
            <Minus size={13} />
            0.1%
          </button>
          <button
            type="button"
            aria-label={t("价格提高 0.1%")}
            onClick={() => change(value * 1.001)}
          >
            <Plus size={13} />
            0.1%
          </button>
        </div>
      </div>
      <Slider
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
      <div className="lp-price-endpoints">
        <span>{format(range[0])}</span>
        <span>{format(range[1])}</span>
      </div>
    </div>
  );
}
