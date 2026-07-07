// Detección de arbitrajes: SKUs donde un proveedor está MUY por debajo de la
// mediana del resto. Distingue oportunidad real de precio viejo/desactualizado
// (el caso clásico: Planet A17 a 131 vs resto a 138 — el 131 era de la semana
// anterior). SOLO AVISA: no estima montos ni arma órdenes.

import { classifyFreshness } from "../price-logic.js";

// Devuelve [{ sku, lowSupplier, lowPrice, median, gapPct, stale, nota }] ordenado
// por gap descendente. gapPct mínimo configurable (default 3%).
export function arbitrageScan({ prices, times, catalog }, { gapPct = 3 } = {}) {
  const out = [];
  for (const c of catalog || []) {
    const row = prices[c.name];
    if (!row) continue;
    const entries = Object.entries(row).filter(([, v]) => typeof v === "number" && v > 0);
    if (entries.length < 2) continue; // sin comparación no hay arbitraje
    const sorted = entries.map(([, v]) => v).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const [lowSupplier, lowPrice] = entries.sort((a, b) => a[1] - b[1])[0];
    const gap = median ? +(((median - lowPrice) / median) * 100).toFixed(1) : 0;
    if (gap < gapPct) continue;
    const stale = classifyFreshness(times?.[c.name]?.[lowSupplier]) === "expired";
    out.push({
      sku: c.name, lowSupplier, lowPrice, median, gapPct: gap, stale,
      nota: stale
        ? "posiblemente desactualizado — verificar con el proveedor antes de comprar"
        : "gap real vs. mediana — oportunidad",
    });
  }
  return out.sort((a, b) => b.gapPct - a.gapPct);
}
