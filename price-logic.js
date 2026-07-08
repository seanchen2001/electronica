// Catalog, seed data, and framework-agnostic pricing logic.
// Imported by BOTH the React component and the test, so they can't drift.

export const SUPPLIERS = ["planET", "mirgor", "VITEL", "SH", "Bax"];

// Standard catalog, grouped by section. Names are verbatim from the trader's sheet.
export const CATALOG = [
  { cat: "Samsung", name: "A06 4+64 DS" },
  { cat: "Samsung", name: "A07 4+64 DS" },
  { cat: "Samsung", name: "A07 4+128 DS" },
  { cat: "Samsung", name: "A16 4+128 DS" },
  { cat: "Samsung", name: "A17 4+128 DS" },
  { cat: "Samsung", name: "A26 8+256 5G DS" },
  { cat: "Samsung", name: "A36 6+128 5G DS" },
  { cat: "Samsung", name: "A36 8+256 5G DS" },
  { cat: "Samsung", name: "A37 6+128 5G DS" },
  { cat: "Samsung", name: "A37 8+256 5G DS" },
  { cat: "Samsung", name: "A56 8+128 5G DS" },
  { cat: "Samsung", name: "A56 8+256 5G DS" },
  { cat: "Samsung", name: "A56 12+256 5G DS" },
  { cat: "Samsung", name: "A57 8+128 5G DS" },
  { cat: "Samsung", name: "A57 8+256 5G DS" },
  { cat: "Samsung", name: "A57 12+256 5G DS" },
  { cat: "Samsung", name: "S25 FE 8+256 5G DS" },
  { cat: "Samsung", name: "S25 FE 8+512 5G DS" },
  { cat: "Samsung", name: "S25 ULTRA 12+256 5G DS" },
  { cat: "Samsung", name: "S25 ULTRA 12+512 5G DS" },
  { cat: "Samsung", name: "S25 ULTRA 12+1T 5G DS" },
  { cat: "Samsung", name: "S26 12/256GB 5G" },
  { cat: "Samsung", name: "S26 12/512GB 5G" },
  { cat: "Samsung", name: "S26 Plus 12/256GB 5G" },
  { cat: "Samsung", name: "S26 Plus 12/512GB 5G" },
  { cat: "Samsung", name: "S26 ULTRA 12/256GB 5G" },
  { cat: "Samsung", name: "S26 ULTRA 12/512GB 5G" },
  { cat: "Samsung", name: "S26 ULTRA 12/1TB 5G" },
  { cat: "Motorola LATIN", name: "Motorola G06 4+256" },
  { cat: "Motorola LATIN", name: "Motorola G15 4+256" },
  { cat: "Motorola LATIN", name: "Motorola G17 4+256" },
  { cat: "Motorola LATIN", name: "Motorola G35 4+256 5G" },
  { cat: "Motorola LATIN", name: "Motorola G56 8+256 5G" },
  { cat: "Motorola LATIN", name: "Motorola Edge 60 12+512" },
  { cat: "Motorola LATIN", name: "Motorola Edge 60 Fusion 8+256 5G" },
  { cat: "Motorola LATIN", name: "Motorola Edge 60 Pro 8+512 5G" },
  { cat: "Motorola LATIN", name: "Motorola Edge 70 Fusion 8+256 5G" },
  { cat: "Motorola LATIN", name: "Motorola Edge 70 Fusion 8+256 5G - FIFA2026" },
  { cat: "Motorola LATIN", name: "Motorola G86 PWR 8+256" },
  { cat: "Motorola EURO", name: "XT2535 G06 4+256" },
  { cat: "Motorola EURO", name: "XT2527 G86 8+256 5G" },
  { cat: "Motorola EURO", name: "XT2505 Edge 60 8+256" },
  { cat: "Motorola EURO", name: "XT2509 Edge 60 Neo 12+256" },
];


// ---- pure logic ----
export function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Outlier-aware client pricing. base = median when the cheapest is a >threshold
// dump (excess stock), else the cheapest. client = round(base * (1 + margin%)).
export function rowAggregates(pricesForSku, marginPct, outlierThreshold = 0.15) {
  // considerar TODOS los proveedores presentes en el objeto (no solo los 5 originales
  // hardcodeados) — si no, los proveedores nuevos (ej. de iPhone) quedaban fuera del
  // Mínimo/Medio/Client y del coloreo.
  const present = Object.entries(pricesForSku || {}).filter(([, v]) => typeof v === "number");
  if (!present.length)
    return { count: 0, min: null, med: null, outliers: new Set(), bestIsOutlier: false, base: null, client: null };
  const vals = present.map(([, v]) => v);
  const min = Math.min(...vals);
  const med = median(vals);
  const outliers = new Set();
  for (const [s, v] of present) if (v < med * (1 - outlierThreshold)) outliers.add(s);
  const bestIsOutlier = min < med * (1 - outlierThreshold);
  const base = bestIsOutlier ? med : min;
  const client = base == null ? null : Math.round(base * (1 + marginPct / 100));
  return { count: vals.length, min, med, outliers, bestIsOutlier, base, client };
}

// ---- weekly freshness (prices expire every Monday 00:00 local) ----
export const RECENT_MS = 24 * 60 * 60 * 1000; // "recién actualizado" window

// Start (ms) of the current Monday->Sunday cycle for a given moment.
export function mondayStart(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
  const sinceMonday = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - sinceMonday);
  return d.getTime();
}

// "expired" | "updated" | "recent". A missing timestamp counts as expired
// (unknown age → must re-request). Cycle boundary is checked before recency.
export function classifyFreshness(ts, now = Date.now(), recentMs = RECENT_MS) {
  if (ts == null) return "expired";
  if (ts < mondayStart(new Date(now))) return "expired";
  if (ts >= now - recentMs) return "recent";
  return "updated";
}

// ---- Cotizador (sourcing planner) ----
// A supplier "has" a model if it has ANY known price for it (fresh or expired),
// because on Monday everything is expired and we still need to know who to ask.
// `needed` is a map { sku: qty }. Prices come from the full matrix.

function suppliersWithPrice(sku, prices) {
  return SUPPLIERS.map((sp) => [sp, prices[sku]?.[sp]]).filter(([, v]) => typeof v === "number");
}

// Plan A: each model goes to its globally-cheapest known supplier. Minimal cost,
// possibly many suppliers.
export function planBestPrice(needed, prices) {
  const bySupplier = {};
  let total = 0;
  const uncoverable = [];
  for (const sku of Object.keys(needed)) {
    const qty = needed[sku] || 1;
    const cands = suppliersWithPrice(sku, prices).sort((a, b) => a[1] - b[1]);
    if (!cands.length) { uncoverable.push(sku); continue; }
    const [sp, price] = cands[0];
    (bySupplier[sp] = bySupplier[sp] || []).push({ sku, qty, price });
    total += qty * price;
  }
  return { bySupplier, total, suppliers: Object.keys(bySupplier), uncoverable };
}

// Plan B: fewest suppliers to CONTACT that cover all coverable models; tie-break
// by lowest total cost. Exact via brute force over all supplier subsets (2^5).
export function planMinSuppliers(needed, prices) {
  const skus = Object.keys(needed);
  const uncoverable = skus.filter((sku) => suppliersWithPrice(sku, prices).length === 0);
  const coverable = skus.filter((sku) => !uncoverable.includes(sku));

  let best = null;
  for (let mask = 1; mask < 1 << SUPPLIERS.length; mask++) {
    const subset = SUPPLIERS.filter((_, i) => mask & (1 << i));
    const covers = coverable.every((sku) => subset.some((sp) => typeof prices[sku]?.[sp] === "number"));
    if (!covers) continue;
    const bySupplier = {};
    let total = 0;
    for (const sku of coverable) {
      const qty = needed[sku] || 1;
      const [sp, price] = subset
        .map((s) => [s, prices[sku]?.[s]])
        .filter(([, v]) => typeof v === "number")
        .sort((a, b) => a[1] - b[1])[0];
      (bySupplier[sp] = bySupplier[sp] || []).push({ sku, qty, price });
      total += qty * price;
    }
    const used = Object.keys(bySupplier).length; // suppliers actually contacted
    if (!best || used < best.used || (used === best.used && total < best.total))
      best = { bySupplier, total, used };
  }
  if (!best) return { bySupplier: {}, total: 0, suppliers: [], uncoverable };
  return { bySupplier: best.bySupplier, total: best.total, suppliers: Object.keys(best.bySupplier), uncoverable };
}
