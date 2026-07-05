// Lógica de precios pura del Price Desk. Todas las funciones reciben el estado
// por parámetro (prices, tiers, catalog, etc.) — acá NO hay React ni estado global.
// El componente arma wrappers finos que inyectan su estado actual.

import { mondayStart } from "../price-logic.js";

// Un snapshot por semana (lunes del ciclo). Guardar de nuevo en la misma semana
// pisa el anterior → queda "el último precio de la semana". Mantiene ~2 años.
export function upsertWeekly(snaps, prices, lista) {
  const week = mondayStart();
  const entry = { week, ts: Date.now(), prices: JSON.parse(JSON.stringify(prices)), lista: JSON.parse(JSON.stringify(lista)) };
  const i = snaps.findIndex((sn) => sn.week === week);
  const next = i >= 0 ? snaps.map((sn, k) => (k === i ? entry : sn)) : [...snaps, entry];
  return next.slice(-104);
}

// costo del proveedor para una cantidad, usando la escala (tier) si existe; si no, el precio base
export function costForQty(prices, tiers, sku, supplier, qty = 1) {
  const t = tiers[sku]?.[supplier];
  if (Array.isArray(t) && t.length) {
    const sorted = [...t].sort((a, b) => a.min - b.min);
    let p = sorted[0].price;
    for (const x of sorted) if (qty >= x.min) p = x.price;
    return p;
  }
  return prices[sku]?.[supplier] ?? 0;
}

export function hasTiers(tiers, sku, supplier) {
  return Array.isArray(tiers[sku]?.[supplier]) && tiers[sku][supplier].length > 1;
}

// ranking de proveedores por costo para una cantidad (respeta tiers)
export function bestSuppliers({ prices, tiers, prevSnap, supplierList }, sku, qty = 1) {
  const row = prices[sku] || {};
  const list = Object.keys(row)
    .map((sp) => ({ supplier: sp, cost: costForQty(prices, tiers, sku, sp, qty), base: row[sp], escala: hasTiers(tiers, sku, sp) }))
    .filter((x) => typeof x.cost === "number")
    .sort((a, b) => a.cost - b.cost);
  const prevVals = prevSnap ? supplierList.map((sp) => prevSnap.prices?.[sku]?.[sp]).filter((x) => typeof x === "number") : [];
  const prevMin = prevVals.length ? Math.min(...prevVals) : null;
  return {
    sku, qty, ranking: list,
    mejor: list[0] ? { proveedor: list[0].supplier, costo: list[0].cost } : null,
    brecha_con_alternativa: list[0] && list[1] ? +(list[1].cost - list[0].cost).toFixed(2) : null,
    un_solo_proveedor: list.length === 1,
    subio_vs_semana_pasada: list[0] && prevMin != null ? list[0].cost > prevMin : false,
  };
}

// dónde conviene negociar: proveedor sin competencia, precio que subió, o brecha con la alternativa
export function negotiationReport({ prices, tiers, prevSnap, supplierList, catalog, orderItems }, scope = "order") {
  const skus = scope === "all" ? catalog.map((c) => c.name) : [...new Set(orderItems.map((i) => i.sku))];
  const out = [];
  for (const sku of skus) {
    const qty = orderItems.find((i) => i.sku === sku)?.qty || 1;
    const bs = bestSuppliers({ prices, tiers, prevSnap, supplierList }, sku, qty);
    if (!bs.mejor) continue;
    const flags = [];
    if (bs.un_solo_proveedor) flags.push("sin competencia (un solo proveedor)");
    if (bs.subio_vs_semana_pasada) flags.push("subió vs la semana pasada");
    if (bs.brecha_con_alternativa != null && bs.brecha_con_alternativa > 0.005) flags.push(`la alternativa está $${bs.brecha_con_alternativa} más cara`);
    if (flags.length) out.push({ sku, proveedor: bs.mejor.proveedor, costo: bs.mejor.costo, flags });
  }
  return { scope, sugerencias: out };
}
