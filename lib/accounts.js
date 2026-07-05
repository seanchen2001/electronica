// Cuentas corrientes derivadas: cargos desde las facturas + movimientos manuales
// del ledger. Débito suma al saldo, Crédito resta. Cliente: saldo = lo que nos debe.
// Proveedor: saldo = lo que le debemos. Alias fusiona cuentas.
// Función pura: la usan el memo de la UI y las tools del agente (con cualquier side).

import { parseDMY } from "./helpers.js";

export function canonName(aliases, name) {
  const n = (name || "—").trim() || "—";
  return aliases[n] || n;
}

export function computeAccounts({ invoiceHistory, ledger, aliases }, side) {
  const byParty = {};
  // cargo = aumenta lo adeudado (venta al cliente / compra al proveedor); pago = lo reduce
  const add = (party, m) => { const p = canonName(aliases, party); (byParty[p] ||= []).push({ ...m, when: parseDMY(m.date, m.ts).getTime() }); };
  for (const f of invoiceHistory) {
    if (f.type !== "factura") continue;
    if (side === "client") {
      add(f.client || "—", { key: `f-${f.no}`, ts: f.ts, date: f.date, concept: `Factura #${f.no}`, ref: f.no, cargo: Number(f.total) || 0, pago: 0, derived: true });
    } else {
      for (const [sp, c] of Object.entries(f.supplierCosts || {})) add(sp, { key: `f-${f.no}-${sp}`, ts: f.ts, date: f.date, concept: `Compra fact. #${f.no}`, ref: f.no, cargo: Number(c) || 0, pago: 0, derived: true });
    }
  }
  for (const e of ledger) {
    if (e.side !== side) continue;
    if (e.type === "cargo" && e.ref) continue; // cargos automáticos viejos → se derivan
    const pago = e.type === "pago";
    add(e.party, { key: e.id, id: e.id, ts: e.ts, date: e.date, concept: e.concept, ref: e.ref || "", cargo: pago ? 0 : (Number(e.amount) || 0), pago: pago ? (Number(e.amount) || 0) : 0, derived: false });
  }
  const out = {};
  for (const [party, movs] of Object.entries(byParty)) {
    movs.sort((a, b) => (a.when - b.when) || (a.ts || 0) - (b.ts || 0)); // por fecha para el saldo corriente
    let saldo = 0;
    const rows = movs.map((m) => { saldo += (m.cargo || 0) - (m.pago || 0); return { ...m, saldo }; });
    out[party] = { party, rows, saldo };
  }
  return out;
}
