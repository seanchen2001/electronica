// Inventario y costo promedio REAL, derivados del historial. Sin storage propio.
// Entrada = facturas/remitos a cuentas NUESTRAS (cliente con esNuestra=true):
// compramos para stock. Salida = ventas a clientes reales. Sin carga manual.

// Deriva { [sku]: { onHand, avgCost, entradas, salidas, lastTs } }.
// avgCost = promedio ponderado del costo de las ENTRADAS (lo que realmente pagamos).
export function computeInventory({ invoiceHistory, clients }) {
  const ownIds = new Set((clients || []).filter((c) => c.esNuestra).map((c) => c.id));
  const ownNames = new Set((clients || []).filter((c) => c.esNuestra).map((c) => (c.name || "").toLowerCase()));
  const isOwn = (inv) => ownIds.has(inv.clientId) || ownNames.has((inv.client || "").toLowerCase());
  const bySku = {};
  for (const inv of invoiceHistory || []) {
    if (inv.type !== "factura" && inv.type !== "remito") continue;
    const inbound = isOwn(inv);
    for (const it of inv.items || []) {
      const s = (bySku[it.sku] ||= { sku: it.sku, entradas: 0, salidas: 0, costEntradas: 0, lastTs: 0 });
      const q = Number(it.qty) || 0;
      if (inbound) { s.entradas += q; s.costEntradas += q * (Number(it.cost) || 0); }
      else s.salidas += q;
      s.lastTs = Math.max(s.lastTs, inv.ts || 0);
    }
  }
  const out = {};
  for (const s of Object.values(bySku)) {
    out[s.sku] = {
      sku: s.sku,
      onHand: s.entradas - s.salidas,
      avgCost: s.entradas ? +(s.costEntradas / s.entradas).toFixed(2) : null,
      entradas: s.entradas, salidas: s.salidas, lastTs: s.lastTs,
    };
  }
  return out;
}
