// Helpers puros del Price Desk: ids, fechas, formato de plata y blanks.
// No dependen de React ni del estado de la app.

import { mondayStart } from "../price-logic.js";

export function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

export function fmtDMY(ts) { const d = new Date(ts); return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`; }
export function today() { return fmtDMY(Date.now()); }
export function parseDMY(s, fallbackTs) {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(y, +m[2] - 1, +m[1]); }
  return new Date(fallbackTs || 0);
}

export function nextInvoiceNo(hist) {
  const nums = (hist || []).map((h) => parseInt(h.no, 10)).filter((n) => !Number.isNaN(n));
  return nums.length ? Math.max(...nums) + 1 : 2427;
}

export function blankClient() { return { id: "", name: "", address: "", ruc: "", phone: "", cuentaCorriente: false, esNuestra: false }; }
export function blankShip() { return { id: "", label: "", notify: "", direccion: "", telefono: "", contacto: "" }; }

// Stamp every loaded cell at this cycle's Monday so it loads as "actualizado".
export function timesForPrices(pricesObj) {
  const ts = mondayStart();
  const t = {};
  for (const sku of Object.keys(pricesObj)) {
    t[sku] = {};
    for (const sp of Object.keys(pricesObj[sku])) t[sku][sp] = ts;
  }
  return t;
}

export const load = (k, fallback) => {
  try {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
export const clone = (o) => JSON.parse(JSON.stringify(o));
export const money = (n) =>
  n == null || Number.isNaN(n)
    ? "—"
    : "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
