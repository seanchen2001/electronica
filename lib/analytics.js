// Analítica derivada del Historial (solo type==="factura") y del ledger (gastos).
// No agrega storage nuevo: todo se calcula al vuelo. Sin React.

import { parseDMY } from "./helpers.js";
import { MONTHS_ES } from "./constants.js";
import { mondayStart } from "../price-logic.js";

// Agregados para la pestaña Analítica: por mes (últimos `months`), top clientes
// (por facturación y por margen), top proveedores por compra y top modelos.
export function analyticsData({ invoiceHistory }, months = 6) {
  const sales = (invoiceHistory || []).filter((h) => h.type === "factura");
  const byMonth = new Map();
  const byClient = {};
  const bySupplier = {};
  const byModel = {};
  let ventas = 0, costo = 0, piezas = 0;
  for (const f of sales) {
    const d = parseDMY(f.date, f.ts);
    const mk = d.getFullYear() * 12 + d.getMonth();
    const venta = Number(f.subtotal ?? f.total) || 0;
    const c = Number(f.cost) || 0;
    const pz = Number(f.piezas) || 0;
    ventas += venta; costo += c; piezas += pz;
    const m = byMonth.get(mk) || { mk, year: d.getFullYear(), month: d.getMonth(), ventas: 0, costo: 0, piezas: 0, facturas: 0 };
    m.ventas += venta; m.costo += c; m.piezas += pz; m.facturas += 1;
    byMonth.set(mk, m);
    const cl = f.client || "—";
    const bc = (byClient[cl] ||= { cliente: cl, ventas: 0, margen: 0, piezas: 0, facturas: 0 });
    bc.ventas += venta; bc.margen += venta - c; bc.piezas += pz; bc.facturas += 1;
    for (const [sp, sc] of Object.entries(f.supplierCosts || {})) {
      (bySupplier[sp] ||= { proveedor: sp, compra: 0 }).compra += Number(sc) || 0;
    }
    for (const it of f.items || []) {
      const q = Number(it.qty) || 0;
      const bm = (byModel[it.sku] ||= { modelo: it.sku, piezas: 0, margen: 0 });
      bm.piezas += q; bm.margen += ((Number(it.price) || 0) - (Number(it.cost) || 0)) * q;
    }
  }
  const monthly = [...byMonth.values()].sort((a, b) => a.mk - b.mk).slice(-months)
    .map((m) => ({ ...m, label: `${MONTHS_ES[m.month].slice(0, 3)} ${String(m.year).slice(2)}`, margen: m.ventas - m.costo }));
  const margen = ventas - costo;
  return {
    facturas: sales.length, ventas, costo, margen,
    margenPct: ventas ? (margen / ventas) * 100 : 0, piezas,
    monthly,
    topClientes: Object.values(byClient).sort((a, b) => b.ventas - a.ventas),
    topClientesPorMargen: Object.values(byClient).slice().sort((a, b) => b.margen - a.margen),
    topProveedores: Object.values(bySupplier).sort((a, b) => b.compra - a.compra),
    topModelos: Object.values(byModel).sort((a, b) => b.piezas - a.piezas),
  };
}

// Resumen por período para la tool del agente ("¿cuánto gané este mes?").
// period: "semana" (desde el lunes) | "mes" (mes calendario actual) | "todo".
export function analyticsSummary({ invoiceHistory, ledger }, period = "mes") {
  const now = new Date();
  let from = 0, label = "todo el historial";
  if (/sem|week/i.test(String(period))) { from = mondayStart(); label = "esta semana (desde el lunes)"; }
  else if (/mes|month/i.test(String(period))) { from = new Date(now.getFullYear(), now.getMonth(), 1).getTime(); label = `${MONTHS_ES[now.getMonth()]} ${now.getFullYear()}`; }
  const sales = (invoiceHistory || []).filter((h) => h.type === "factura" && parseDMY(h.date, h.ts).getTime() >= from);
  let ventas = 0, costo = 0, piezas = 0;
  const byClient = {}; const bySupplier = {};
  for (const f of sales) {
    const venta = Number(f.subtotal ?? f.total) || 0;
    const c = Number(f.cost) || 0;
    ventas += venta; costo += c; piezas += Number(f.piezas) || 0;
    const cl = f.client || "—";
    (byClient[cl] ||= { cliente: cl, ventas: 0, margen: 0 });
    byClient[cl].ventas += venta; byClient[cl].margen += venta - c;
    for (const [sp, sc] of Object.entries(f.supplierCosts || {})) {
      (bySupplier[sp] ||= { proveedor: sp, compra: 0 }).compra += Number(sc) || 0;
    }
  }
  const gastos = (ledger || [])
    .filter((e) => e.type === "gasto" && parseDMY(e.date, e.ts).getTime() >= from)
    .reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const margen = ventas - costo;
  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    periodo: label,
    facturas: sales.length, piezas,
    ventas: r2(ventas), costo: r2(costo), gastos: r2(gastos),
    margen_bruto: r2(margen), margen_neto: r2(margen - gastos),
    margen_pct: ventas ? r2((margen / ventas) * 100) : 0,
    top_clientes: Object.values(byClient).sort((a, b) => b.ventas - a.ventas).slice(0, 5).map((x) => ({ ...x, ventas: r2(x.ventas), margen: r2(x.margen) })),
    top_proveedores: Object.values(bySupplier).sort((a, b) => b.compra - a.compra).slice(0, 5).map((x) => ({ ...x, compra: r2(x.compra) })),
  };
}
