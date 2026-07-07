// Estado del trade end-to-end. Unifica la etapa pre-venta (order.stage de los
// drafts) con el seguimiento post-venta (opsTracking) en UNA línea de tiempo por
// trade: cotizado → confirmado → facturado → datos (IMEIs por unidad, derivado) →
// [pago si no tiene cuenta corriente] → Miami FOB → [Argentina si cargamos
// nosotros] → [pago si tiene cuenta corriente]. Función pura, sin storage propio.

const CONFIRMED_STAGES = new Set(["confirmada", "esperando_pago", "a_enviar", "enviada"]);

// ¿Todos los items tienen sus IMEI? (checkpoint "Datos", derivado — no se setea a mano)
// El COLOR ya viene cargado con la orden, así que NO se exige. Los IMEI son POR UNIDAD:
// completo = cada línea tiene un IMEI por cada unidad (imeis.length >= qty). Legacy: un solo imei.
function datosCompletos(items) {
  const list = items || [];
  if (!list.length) return false;
  return list.every((it) => {
    const qty = Number(it.qty) || 0;
    const arr = Array.isArray(it.imeis) ? it.imeis.filter((x) => String(x).trim()) : [];
    if (arr.length) return qty ? arr.length >= qty : arr.length > 0; // un IMEI por unidad
    return !!String(it.imei || "").trim(); // compatibilidad: un solo IMEI viejo
  });
}

// Construye la línea de tiempo de UN trade facturado.
function invoiceTimeline(f, t, cli) {
  const cc = !!cli?.cuentaCorriente;
  const cargamos = !!t.cargamosNosotros;
  const datos = datosCompletos(f.items);
  const steps = [
    { id: "cotizado", label: "Cotizado", done: true },
    { id: "confirmado", label: "Confirmado", done: true },
    { id: "facturado", label: "Facturado", done: true },
    { id: "datos", label: "IMEIs (por unidad)", done: datos, derivado: true },
  ];
  const pago = { id: "pago", label: "Pagado", done: !!t.pago };
  const miami = { id: "afuera", label: "Miami FOB", done: !!t.afuera };
  const argentina = { id: "local", label: "En Argentina", done: !!t.local, skipped: !cargamos };
  // sin cuenta corriente: paga ANTES del envío; con cuenta: paga al final
  if (cc) steps.push(miami, argentina, pago);
  else steps.push(pago, miami, argentina);
  return steps;
}

// Trades abiertos (o uno puntual por ref: factura#, cliente o modelo), con
// checkpoint actual, próximo paso pendiente y días desde el último avance.
export function tradeStatus({ drafts, invoiceHistory, opsTracking, clients }, ref) {
  const now = Date.now();
  const out = [];

  // pre-factura: pedidos en armado
  for (const d of drafts || []) {
    const o = d.order || {};
    if (!(o.items || []).length) continue;
    const cli = (clients || []).find((c) => c.id === d.clientId);
    if (cli?.esNuestra) continue;
    const confirmado = CONFIRMED_STAGES.has(o.stage);
    const steps = [
      { id: "cotizado", label: "Cotizado", done: true },
      { id: "confirmado", label: "Confirmado", done: confirmado },
      { id: "facturado", label: "Facturado", done: false },
      { id: "datos", label: "IMEIs (por unidad)", done: false, derivado: true },
      { id: "pago", label: "Pagado", done: false },
      { id: "afuera", label: "Miami FOB", done: false },
      { id: "local", label: "En Argentina", done: false, skipped: true },
    ];
    out.push(buildTrade({ tipo: "pedido", ref: `pedido de ${cli?.name || "(sin cliente)"}`, id: d.id, cliente: cli?.name || "(sin cliente)", ts: d.ts, modelos: [...new Set(o.items.map((i) => i.sku))], steps, now }));
  }

  // facturados: abiertos mientras falte algún checkpoint no salteado
  for (const f of invoiceHistory || []) {
    if (f.type !== "factura") continue;
    const cli = (clients || []).find((c) => c.id === f.clientId);
    if (cli?.esNuestra) continue;
    const t = (opsTracking || {})[f.ts] || {};
    const steps = invoiceTimeline(f, t, cli);
    const trade = buildTrade({ tipo: "factura", ref: `factura #${f.no}`, id: f.ts, invoiceNo: f.no, cliente: f.client || "—", ts: f.ts, total: f.total, modelos: [...new Set((f.items || []).map((i) => i.sku))], steps, now, cargamosNosotros: !!t.cargamosNosotros });
    if (trade.abierto || ref) out.push(trade);
  }

  if (ref) {
    const q = String(ref).toLowerCase().replace(/^#/, "");
    const hit = out.filter((tr) =>
      String(tr.invoiceNo || "").toLowerCase() === q ||
      tr.cliente.toLowerCase().includes(q) ||
      tr.modelos.some((m) => m.toLowerCase().includes(q)));
    return hit;
  }
  return out.filter((tr) => tr.abierto).sort((a, b) => b.dias - a.dias);
}

function buildTrade({ steps, now, ts, ...rest }) {
  const activos = steps.filter((s) => !s.skipped);
  const pendientes = activos.filter((s) => !s.done);
  const hechos = activos.filter((s) => s.done);
  return {
    ...rest,
    dias: Math.floor((now - (ts || now)) / 86400000),
    checkpoints: steps,
    progreso: `${hechos.length}/${activos.length}`,
    actual: hechos.length ? hechos[hechos.length - 1].label : "—",
    proximo_paso: pendientes.length ? pendientes[0].label : null,
    abierto: pendientes.length > 0,
  };
}
