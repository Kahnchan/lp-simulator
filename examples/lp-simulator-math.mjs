// Human-unit, fixed-range Uniswap v3 simulation; not transaction math.
export function createPosition(entry, lower, upper, capital) {
  if (![entry, lower, upper, capital].every((n) => Number.isFinite(n) && n > 0))
    throw new Error("入场价、区间与本金都必须是大于 0 的有效数字。");
  if (lower >= upper || entry < lower || entry > upper)
    throw new Error("请让下限 < 上限，并让入场价位于区间内（可在边界）。");
  if (upper / lower - 1 < 1e-8) throw new Error("区间过窄，请增大上下限间距。");
  const a = Math.sqrt(lower);
  const b = Math.sqrt(upper);
  const amounts = (price) => {
    const s = Math.sqrt(Math.max(lower, Math.min(upper, price)));
    return { x: (b - s) / (s * b), y: s - a };
  };
  const start = amounts(entry);
  const liquidity = capital / (start.x * entry + start.y);
  const x0 = start.x * liquidity;
  const y0 = start.y * liquidity;
  if (![liquidity, x0, y0].every(Number.isFinite))
    throw new Error("数值超出计算范围，请缩小输入。");
  return {
    x0,
    y0,
    at(price) {
      if (!Number.isFinite(price) || price <= 0)
        throw new Error("目标价格必须大于 0。");
      const unit = amounts(price);
      const x = unit.x * liquidity;
      const y = unit.y * liquidity;
      const value = x * price + y;
      const hold = x0 * price + y0;
      return {
        price,
        x,
        y,
        value,
        hold,
        pnl: value - capital,
        returnPct: (value / capital - 1) * 100,
        il: value - hold,
        ilPct: (value / hold - 1) * 100,
      };
    },
  };
}
