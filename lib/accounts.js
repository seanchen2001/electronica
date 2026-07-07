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

// Pulso de clientes: digest por cliente para el briefing del agente. Cruza el saldo
// (computeAccounts) con las operaciones post-venta pendientes (opsTracking) y la
// última compra. Excluye cuentas nuestras (esNuestra). Ordenado por urgencia.
export function clientPulse({ invoiceHistory, ledger, aliases, clients, opsTracking }, clientName) {
  const now = Date.now();
  const accs = computeAccounts({ invoiceHistory, ledger, aliases }, "client");
  const own = new Set((clients || []).filter((c) => c.esNuestra).map((c) => canonName(aliases, c.name)));
  const byClient = {};
  for (const f of invoiceHistory || []) {
    if (f.type !== "factura") continue;
    const p = canonName(aliases, f.client || "—");
    if (own.has(p)) continue;
    const c = (byClient[p] ||= { cliente: p, ultima_compra_ts: 0, facturas: 0, pendientes: [] });
    c.facturas += 1;
    c.ultima_compra_ts = Math.max(c.ultima_compra_ts, f.ts || 0);
    const t = (opsTracking || {})[f.ts] || {};
    const falta = [!t.afuera && "entrega afuera", !t.local && "entrega local", !t.pago && "pago"].filter(Boolean);
    if (falta.length) c.pendientes.push({ factura: f.no, total: f.total, dias: Math.floor((now - (f.ts || now)) / 86400000), falta });
  }
  const out = Object.values(byClient).map((c) => {
    const saldo = accs[c.cliente]?.saldo ?? 0;
    const diasSinComprar = c.ultima_compra_ts ? Math.floor((now - c.ultima_compra_ts) / 86400000) : null;
    const pagosVencidos = c.pendientes.filter((p) => p.falta.includes("pago"));
    const maxDiasDeuda = pagosVencidos.length ? Math.max(...pagosVencidos.map((p) => p.dias)) : 0;
    const flags = [];
    if (saldo > 0.005) flags.push(`debe $${+saldo.toFixed(2)}${maxDiasDeuda ? ` hace ${maxDiasDeuda} día(s)` : ""}`);
    for (const p of c.pendientes) if (p.falta.some((x) => x.startsWith("entrega"))) flags.push(`factura #${p.factura}: falta ${p.falta.filter((x) => x.startsWith("entrega")).join(" y ")} (${p.dias} día(s))`);
    if (diasSinComprar != null && diasSinComprar > 14) flags.push(`sin comprar hace ${diasSinComprar} día(s)`);
    return { cliente: c.cliente, saldo: +saldo.toFixed(2), facturas: c.facturas, dias_sin_comprar: diasSinComprar, pendientes: c.pendientes, flags, _urg: saldo * 1000 + maxDiasDeuda };
  }).sort((a, b) => b._urg - a._urg).map(({ _urg, ...c }) => c);
  if (clientName) {
    const q = canonName(aliases, String(clientName).trim()).toLowerCase();
    const hit = out.find((c) => c.cliente.toLowerCase() === q) || out.find((c) => c.cliente.toLowerCase().includes(q));
    return hit ? [hit] : [];
  }
  return out;
}
