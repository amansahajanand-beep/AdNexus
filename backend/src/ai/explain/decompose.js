/**
 * Splits a change in earnings into causes, with exact arithmetic (no model involved).
 *
 * earnings = volume × price (price = earnings per unit of volume: per impression or per page view).
 * For items present in both periods, each item's change is
 *     volume effect = (V1 - V0) × P0      what the change in traffic alone would have done at the old price
 *   + price effect  = (P1 - P0) × V1      what the change in price per unit did on the new traffic
 * which adds up to E1 - E0 exactly. Across items, the volume effects split again into
 *     pure volume = (total ΔV) × (old average price)   all items grew or shrank together
 *   + mix         = the rest                            traffic moved toward lower- or higher-priced items
 * Items only in the new period are "new", items only in the old period are "lost", and anything the
 * listed items do not account for is "other" (rows beyond the list limit, rounding).
 * pure volume + mix + price + new + lost + other = ΔE, always.
 */

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
};
const round = (v) => Math.round(v * 100) / 100;

/** Whole-account split from the two period totals only (no breakdown needed). */
function decomposeTotals({ earningsNow, earningsPrev, volumeNow, volumePrev }) {
  const e1 = num(earningsNow);
  const e0 = num(earningsPrev);
  const v1 = num(volumeNow);
  const v0 = num(volumePrev);
  const delta = e1 - e0;
  if (v0 <= 0 || v1 <= 0) {
    return { delta: round(delta), volume: round(delta), price: 0 };
  }
  const p0 = e0 / v0;
  const p1 = e1 / v1;
  return {
    delta: round(delta),
    volume: round((v1 - v0) * p0),
    price: round((p1 - p0) * v1),
  };
}

/**
 * @param {{name: string, earnings: number, volume: number}[]} currRows
 * @param {{name: string, earnings: number, volume: number}[]} prevRows
 * @param {{earningsNow: number, earningsPrev: number}} totals  whole-period totals (rows may be a partial list)
 * @param {{topN?: number}} [opts]
 */
function decomposeDimension(currRows, prevRows, totals, { topN = 8 } = {}) {
  const cur = new Map((currRows || []).map((r) => [r.name, { e: num(r.earnings), v: num(r.volume) }]));
  const prev = new Map((prevRows || []).map((r) => [r.name, { e: num(r.earnings), v: num(r.volume) }]));
  const totalDelta = num(totals.earningsNow) - num(totals.earningsPrev);

  const items = [];
  let sumVol = 0;
  let sumPrice = 0;
  let e0S = 0;
  let v0S = 0;
  let v1S = 0;
  let newItems = 0;
  let lostItems = 0;

  for (const [name, c] of cur) {
    const p = prev.get(name);
    if (!p) {
      newItems += c.e;
      items.push({ name, delta: c.e, volume: c.e, price: 0, now: c.e, prev: 0, status: 'new' });
      continue;
    }
    let vol;
    let price;
    if (p.v > 0 && c.v > 0) {
      const p0 = p.e / p.v;
      const p1 = c.e / c.v;
      vol = (c.v - p.v) * p0;
      price = (p1 - p0) * c.v;
    } else {
      // No traffic on one side: nothing to price against, so the whole change counts as volume.
      vol = c.e - p.e;
      price = 0;
    }
    sumVol += vol;
    sumPrice += price;
    e0S += p.e;
    v0S += p.v;
    v1S += c.v;
    items.push({ name, delta: c.e - p.e, volume: vol, price, now: c.e, prev: p.e, status: null });
  }
  for (const [name, p] of prev) {
    if (cur.has(name)) continue;
    lostItems -= p.e;
    items.push({ name, delta: -p.e, volume: -p.e, price: 0, now: 0, prev: p.e, status: 'lost' });
  }

  const pureVolume = v0S > 0 ? (v1S - v0S) * (e0S / v0S) : 0;
  const mix = sumVol - pureVolume;
  const explained = pureVolume + mix + sumPrice + newItems + lostItems;
  const other = totalDelta - explained;

  const ranked = items.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const sumAbs = items.reduce((a, i) => a + Math.abs(i.delta), 0);
  const top3Abs = ranked.slice(0, 3).reduce((a, i) => a + Math.abs(i.delta), 0);

  return {
    totalDelta: round(totalDelta),
    effects: {
      pureVolume: round(pureVolume),
      mix: round(mix),
      price: round(sumPrice),
      newItems: round(newItems),
      lostItems: round(lostItems),
      other: round(other),
    },
    concentrationPct: sumAbs > 0 ? Math.round((top3Abs / sumAbs) * 1000) / 10 : 0,
    items: ranked.slice(0, topN).map((i) => ({
      name: i.name,
      delta: round(i.delta),
      volume: round(i.volume),
      price: round(i.price),
      now: round(i.now),
      prev: round(i.prev),
      status: i.status,
      sharePct: Math.abs(totalDelta) > 0 ? Math.round((i.delta / totalDelta) * 1000) / 10 : null,
    })),
    itemCount: items.length,
  };
}

module.exports = { decomposeTotals, decomposeDimension };
