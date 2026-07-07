import React from "react";
import styles from "../styles.js";
import { DRAFT_TTL_MS } from "../lib/constants.js";
import { money } from "../lib/helpers.js";

// Pestaña Órdenes (factura / remito): pedidos pendientes, datos de la orden,
// items y generación de PDFs. Cuando se edita una factura del Historial,
// la misma sección flota como modal (editOverlay) sobre la pestaña actual.
export default function OrdenesView({
  editingTs, docType, setDocType,
  drafts, activeId, switchOrder, deleteDraft, resetOrder,
  clients, orderClientId, setOrderClientId, selClient,
  shippings, orderShipId, setOrderShipId,
  order, setOrderField,
  orderQuery, setOrderQuery, catalog, catalogNames, addOrderItem, importMarked,
  prices, tiers, hasTiers, setItem, setItemSupplier, splitItem, removeItem,
  expandedModels, setExpandedModels,
  orderPiezas, orderSubtotal, orderCost, remitoGroups,
  downloadDoc, downloadSupplierRemitos, saveEditChanges, registerPastOperation, pdfBusy,
  openTrades = [], loadImeisForTrade, imeiCountForTrade,
}) {
  const s = styles;
  const [imeiLine, setImeiLine] = React.useState(null); // { idx, sku, color, qty, text } — cargar IMEIs de una línea

  // Línea de tiempo de trades abiertos: facturas con checkpoints pendientes + pedidos en armado
  const tradeTimeline = !editingTs && openTrades.length > 0 && (
    <section style={s.section}>
      <div style={s.sectionTitle}>TRADES EN CURSO — próximo paso por operación</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {openTrades.slice(0, 8).map((t) => (
          <div key={`${t.tipo}-${t.id}`} style={{ background: "#11151f", border: "1px solid #1c2230", borderRadius: 6, padding: "8px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ color: "#cfd6e4", fontSize: 12.5, fontWeight: 600 }}>{t.ref}</span>
              <span style={{ color: "#8b94a7", fontSize: 11.5 }}>{t.cliente}</span>
              {t.total != null && <span style={{ color: "#fbbf24", fontSize: 11.5 }}>{money(t.total)}</span>}
              <span style={{ color: "#6b7385", fontSize: 11 }}>{t.dias} día(s)</span>
              <span style={{ marginLeft: "auto", color: "#8ee0a8", fontSize: 11.5 }}>→ {t.proximo_paso || "completo"}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
              {t.checkpoints.filter((c) => !c.skipped).map((c, i, arr) => {
                // el checkpoint de IMEIs es clickeable en facturas → abre el editor de IMEIs
                const isImei = c.id === "datos" && t.tipo === "factura";
                const cnt = isImei && imeiCountForTrade ? imeiCountForTrade(t) : null;
                return (
                  <React.Fragment key={c.id}>
                    <span title={isImei ? "Cargar IMEIs (uno por unidad)" : c.label}
                      onClick={isImei && loadImeisForTrade ? () => loadImeisForTrade(t) : undefined}
                      style={{ fontSize: 10.5, padding: "2px 7px", borderRadius: 10, whiteSpace: "nowrap", cursor: isImei ? "pointer" : "default", background: c.done ? "#14331f" : "#1a1f2b", color: c.done ? "#8ee0a8" : (isImei ? "#e0b34d" : "#6b7385"), border: `1px solid ${c.done ? "#2f9e57" : (isImei ? "#5a4a1d" : "#242b3a")}` }}>
                      {c.done ? "✓ " : "· "}{c.label}{cnt ? ` ${cnt.loaded}/${cnt.total}` : ""}{isImei ? " ✎" : ""}
                    </span>
                    {i < arr.length - 1 && <span style={{ color: "#3a4356", fontSize: 10 }}>—</span>}
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <div style={editingTs ? s.editOverlay : { display: "contents" }}>
    {tradeTimeline}
    <section style={editingTs ? s.editCard : s.section}>
      <div style={s.sectionTitle}>{editingTs ? `EDITAR FACTURA #${order.invoiceNo}` : "ÓRDENES — Factura / Remito"}</div>
      {/* pedidos pendientes (solo al armar órdenes nuevas, no al editar una factura) */}
      {!editingTs && (
      <div style={s.acctTabs}>
        <span style={{ fontSize: 10.5, color: "#6b7385", alignSelf: "center", marginRight: 2 }}>PEDIDOS:</span>
        {drafts.map((d) => {
          const on = d.id === activeId;
          const cli = clients.find((c) => c.id === d.clientId)?.name;
          const pzs = (d.order?.items || []).reduce((a, i) => a + (Number(i.qty) || 0), 0);
          const models = [...new Set((d.order?.items || []).map((i) => i.sku))];
          const hint = models.slice(0, 2).map((m) => m.split(" ")[0]).join("/") + (models.length > 2 ? "+" : "");
          const idle = Date.now() - (d.ts || 0);
          const age = idle < 3600e3 ? `${Math.max(1, Math.round(idle / 60e3))}m` : idle < 86400e3 ? `${Math.floor(idle / 3600e3)}h` : `${Math.floor(idle / 86400e3)}d`;
          const stale = !on && idle > DRAFT_TTL_MS * 0.66; // acercándose al auto-borrado (6 h)
          return (
            <span key={d.id} style={{ ...s.acctTab, ...(on ? s.acctTabOn : {}), ...(stale ? { opacity: 0.6 } : {}), display: "inline-flex", gap: 6 }}
              title={models.join(", ") + (on ? "" : `\nInactivo hace ${age}` + (stale ? " — se auto-borra a las 6 h de inactividad" : ""))}>
              <span onClick={() => switchOrder(d.id)} style={{ cursor: "pointer" }}>{cli || "sin cliente"} · {hint || "—"} · {pzs}u{on ? "" : <span style={{ color: stale ? "#d08a5a" : "#5a6273" }}> · {stale ? "⏳" : ""}{age}</span>}</span>
              <span style={s.chipX} onClick={() => deleteDraft(d.id)}>×</span>
            </span>
          );
        })}
        <button onClick={resetOrder} style={{ ...s.miniBtn }}>+ Nuevo pedido</button>
      </div>
      )}
      {editingTs && (
        <div style={s.editBanner}>
          ✏️ Estás editando una factura ya generada — al guardar se actualiza esa misma (recalcula cuentas y PnL). No afecta tus pedidos pendientes.
          <span style={{ flex: 1 }} />
          <button onClick={resetOrder} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 8 }}>✕ Cerrar sin guardar</button>
        </div>
      )}
      {!editingTs && orderClientId && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", margin: "8px 0 2px" }}>
          <span style={{ fontSize: 11, color: selClient.cuentaCorriente ? "#8ee0a8" : "#e0b48e" }}
            title={selClient.cuentaCorriente ? "Con cuenta corriente: envío directo, queda en la cuenta." : "Sin cuenta corriente: primero paga, después se envía."}>
            {selClient.cuentaCorriente ? "🟢 con cuenta corriente" : "🟠 sin cuenta — cobra antes de enviar"}
          </span>
        </div>
      )}
      <div style={s.planTabs}>
        <button onClick={() => setDocType("factura")} style={{ ...s.planTab, ...(docType === "factura" ? s.planTabOn : {}) }}>Factura (con precios)</button>
        <button onClick={() => setDocType("remito")} style={{ ...s.planTab, ...(docType === "remito" ? s.planTabOn : {}) }}>Remito x proveedor (sin precios)</button>
      </div>

      <div style={s.invGrid}>
        <div style={s.invCol}>
          <div style={s.invColHead}>CLIENTE</div>
          <select value={orderClientId} onChange={(e) => setOrderClientId(e.target.value)} style={s.invInput}>
            <option value="">— sin cliente —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {orderClientId && (
            <div style={s.selBox}>
              <div style={{ fontWeight: 600, color: "#cfd6e4" }}>{selClient.name}</div>
              {selClient.address ? <div style={s.selLine}>{selClient.address}</div> : null}
              {selClient.ruc ? <div style={s.selLine}>RUC: {selClient.ruc}</div> : null}
              {selClient.phone ? <div style={s.selLine}>Tel: {selClient.phone}</div> : null}
            </div>
          )}
          <div style={s.selHint}>Agregar / editar → tab Clientes</div>
        </div>

        <div style={s.invCol}>
          <div style={s.invColHead}>ENTREGA / SHIPPING</div>
          <select value={orderShipId} onChange={(e) => {
            const id = e.target.value; setOrderShipId(id);
            const sh = shippings.find((x) => x.id === id);
            if (sh && sh.direccion) setOrderField("deliveryAddr", sh.direccion); // prefijar dirección de entrega
          }} style={s.invInput}>
            <option value="">— sin envío guardado —</option>
            {shippings.map((sh) => <option key={sh.id} value={sh.id}>{sh.label || sh.notify}</option>)}
          </select>
          <label style={{ ...s.invField, marginTop: 6 }}>
            <span style={s.invFieldLbl}>Dirección de entrega (depósito) — aparece en el remito</span>
            <textarea value={order.deliveryAddr || ""} onChange={(e) => setOrderField("deliveryAddr", e.target.value)}
              rows={2} placeholder="Dirección del depósito / destino…" style={s.invArea} />
          </label>
          <div style={s.selHint}>Se guarda con la orden. Envíos guardados → tab Clientes.</div>
        </div>

        <div style={s.invCol}>
          <div style={s.invColHead}>DATOS</div>
          <div style={s.invFields}>
            {[["invoiceNo", "Invoice #"], ["date", "Date"], ["payment", "Payment"], ["fob", "FOB"], ["salesperson", "Salesperson"], ["terms", "Payment Terms"], ["dueDate", "Due Date"]].map(([k, lbl]) => (
              <label style={s.invField} key={k}>
                <span style={s.invFieldLbl}>{lbl}</span>
                <input value={order[k]} onChange={(e) => setOrderField(k, e.target.value)} style={s.invInput} />
              </label>
            ))}
            {docType === "factura" && (
              <label style={s.invField}>
                <span style={s.invFieldLbl}>Shipping $</span>
                <input value={order.shippingCost} onChange={(e) => setOrderField("shippingCost", e.target.value)} style={s.invInput} />
              </label>
            )}
          </div>
        </div>
      </div>

      <div style={{ ...s.invColHead, marginTop: 10 }}>ITEMS</div>
      <div style={s.cotInputRow}>
        <input list="catalog-dl" value={orderQuery}
          onChange={(e) => { const v = e.target.value; setOrderQuery(v); if (catalogNames.includes(v)) addOrderItem(v); }}
          onKeyDown={(e) => { if (e.key === "Enter") { const m = catalogNames.find((n) => n.toLowerCase() === orderQuery.trim().toLowerCase()); if (m) addOrderItem(m); } }}
          placeholder="Agregar modelo (Enter)…" style={s.cotSearch} />
        <datalist id="catalog-dl">{catalog.map((c) => <option key={c.name} value={c.name} />)}</datalist>
        <button onClick={importMarked} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }} title="Traer los modelos tildados en la cotización de la Mesa">Traer marcados</button>
      </div>

      {order.items.length > 0 && (
        <table style={s.invTable}>
          <thead>
            <tr>
              <th style={s.invTh}>Qty</th>
              <th style={{ ...s.invTh, textAlign: "left" }}>Descripción</th>
              <th style={s.invTh}>Color</th>
              <th style={s.invTh}>IMEI</th>
              <th style={s.invTh}>Spec</th>
              <th style={s.invTh}>Proveedor</th>
              <th style={s.invTh} title="Costo del proveedor elegido × cantidad">Costo</th>
              {docType === "factura" && <th style={s.invTh}>Precio</th>}
              {docType === "factura" && <th style={s.invTh}>Line Total</th>}
              <th style={s.invTh}></th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              const groups = {};
              order.items.forEach((it, idx) => { (groups[it.sku] ||= []).push({ it, idx }); });
              const detailCols = docType === "factura" ? 8 : 6;
              const editRow = ({ it, idx }, descNode) => {
                const sups = Object.keys(prices[it.sku] || {});
                const supOpts = it.supplier && !sups.includes(it.supplier) ? [it.supplier, ...sups] : sups;
                return (
                  <tr key={idx}>
                    <td style={s.invTd}><input value={it.qty} onChange={(e) => setItem(idx, "qty", e.target.value)} style={{ ...s.cellInput, width: 44, border: "1px solid #232a3a" }} /></td>
                    <td style={{ ...s.invTd, textAlign: "left" }}>{descNode}</td>
                    <td style={s.invTd}>
                      <input value={it.color || ""} onChange={(e) => setItem(idx, "color", e.target.value)} placeholder="—" style={{ ...s.cellInput, width: 72, border: "1px solid #232a3a" }} />
                      <span style={s.chipSplit} title="Splitear: duplica esta línea para otro color" onClick={() => splitItem(idx)}>+</span>
                    </td>
                    <td style={s.invTd}>{(() => {
                      const arr = Array.isArray(it.imeis) ? it.imeis.filter((x) => String(x).trim()) : (it.imei ? [it.imei] : []);
                      const qty = Number(it.qty) || 0; const done = qty > 0 && arr.length >= qty;
                      return (
                        <button onClick={() => setImeiLine({ idx, sku: it.sku, color: it.color || "", qty, text: arr.join("\n") })}
                          title="Cargar los IMEIs de esta línea (pegá la columna de Excel, uno por renglón)"
                          style={{ ...s.miniBtn, borderColor: done ? "#3a5" : "#5a4a1d", color: done ? "#8ee0a8" : "#e0b34d", width: 96 }}>
                          📱 {arr.length}/{qty || "?"}
                        </button>
                      );
                    })()}</td>
                    <td style={s.invTd}><input value={it.spec || ""} onChange={(e) => setItem(idx, "spec", e.target.value)} placeholder="—" style={{ ...s.cellInput, width: 60, border: "1px solid #232a3a" }} /></td>
                    <td style={s.invTd}>
                      <select value={it.supplier || ""} onChange={(e) => setItemSupplier(idx, e.target.value)} style={{ ...s.cellInput, width: 132, border: "1px solid #232a3a" }}>
                        <option value="">—</option>
                        {supOpts.map((sp) => <option key={sp} value={sp}>{sp}{typeof prices[it.sku]?.[sp] === "number" ? ` · $${Math.round(prices[it.sku][sp])}` : ""}</option>)}
                      </select>
                    </td>
                    <td style={s.invTd}>
                      <input value={it.cost ?? 0} onChange={(e) => setItem(idx, "cost", e.target.value)} style={{ ...s.cellInput, width: 64, border: "1px solid #232a3a", color: "#9aa4b2" }} />
                      {hasTiers(it.sku, it.supplier) && <span title={`Escala x cantidad (${it.supplier}):\n` + tiers[it.sku][it.supplier].map((t) => `${t.min}+ pzs → $${t.price}`).join("\n")} style={{ color: "#c084fc", fontSize: 10, marginLeft: 3, cursor: "help" }}>⇙</span>}
                    </td>
                    {docType === "factura" && <td style={s.invTd}><input value={it.price} onChange={(e) => setItem(idx, "price", e.target.value)} style={{ ...s.cellInput, width: 70, border: "1px solid #232a3a" }} /></td>}
                    {docType === "factura" && <td style={{ ...s.invTd, color: "#fbbf24" }}>{money((Number(it.qty) || 0) * (Number(it.price) || 0))}</td>}
                    <td style={s.invTd}><span style={s.chipX} onClick={() => removeItem(idx)}>×</span></td>
                  </tr>
                );
              };
              return Object.entries(groups).map(([sku, rows]) => {
                // un solo color → una sola fila (con el modelo + su color); varios → total + desglose colapsable
                if (rows.length === 1) {
                  const c = rows[0].it.color;
                  return <React.Fragment key={sku}>{editRow(rows[0], <span style={{ color: "#cfd6e4" }}>{sku}{c ? <span style={{ color: "#8b94a7" }}> · {c}</span> : ""}</span>)}</React.Fragment>;
                }
                const totalQty = rows.reduce((a, r) => a + (Number(r.it.qty) || 0), 0);
                const colorsTxt = rows.map((r) => `${r.it.qty} ${r.it.color || "—"}`).join(", ");
                const open = !!expandedModels[sku];
                return (
                  <React.Fragment key={sku}>
                    <tr onClick={() => setExpandedModels((m) => ({ ...m, [sku]: !open }))} style={{ cursor: "pointer", background: "#131823" }}>
                      <td style={{ ...s.invTd, fontWeight: 700 }}>{totalQty}</td>
                      <td style={{ ...s.invTd, textAlign: "left", color: "#e8ecf3" }}>{open ? "▾ " : "▸ "}{sku}</td>
                      <td colSpan={detailCols} style={{ ...s.invTd, textAlign: "left", color: "#8b94a7" }}>{!open ? colorsTxt : ""}</td>
                    </tr>
                    {open && rows.map((r) => editRow(r, <span style={{ color: "#6b7385", paddingLeft: 18 }}>{r.it.color || "↳"}</span>))}
                  </React.Fragment>
                );
              });
            })()}
          </tbody>
        </table>
      )}

      <div style={s.invFoot}>
        <span>Total piezas: <b>{orderPiezas}</b>{docType === "factura" && <> · Subtotal: <b style={{ color: "#fbbf24" }}>{money(orderSubtotal)}</b> · Costo: <b style={{ color: "#9aa4b2" }}>{money(orderCost)}</b> · Margen: <b style={{ color: "#4ade80" }}>{money(orderSubtotal - orderCost)}</b></>}</span>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          {editingTs ? (
            // ---- editando una factura ya generada ----
            order.items.length > 0 ? (
              <>
                <button onClick={resetOrder} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>✕ Cancelar</button>
                <button onClick={downloadDoc} disabled={pdfBusy} title="Guarda los cambios y descarga la factura actualizada" style={{ ...s.toolBtn, marginLeft: 0 }}>{pdfBusy ? "Generando…" : "⬇ Guardar + PDF"}</button>
                <button onClick={saveEditChanges} style={{ ...s.pdfBtn, border: "none", cursor: "pointer" }}>💾 Guardar cambios (factura #{order.invoiceNo})</button>
              </>
            ) : <span style={s.askHint}>Agregá al menos un item.</span>
          ) : (
            // ---- armando una orden nueva / pendiente ----
            <>
              {order.items.length > 0 && <button onClick={resetOrder} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Nueva orden</button>}
              {docType === "factura" && order.items.length > 0 && (
                <button onClick={registerPastOperation} title="Guarda la operación en PnL y Cuentas sin generar PDF (para operaciones pasadas)" style={{ ...s.toolBtn, marginLeft: 0 }}>Registrar sin PDF</button>
              )}
              {order.items.length > 0
                ? (docType === "factura"
                    ? <button onClick={downloadDoc} disabled={pdfBusy} style={{ ...s.pdfBtn, ...(pdfBusy ? s.busy : {}), border: "none", cursor: pdfBusy ? "default" : "pointer" }}>
                        {pdfBusy ? "Generando…" : "⬇ Descargar Factura PDF"}
                      </button>
                    : <button onClick={downloadSupplierRemitos} disabled={pdfBusy} title="Un archivo por proveedor (sin precios ni cliente, con dirección de entrega)"
                        style={{ ...s.pdfBtn, ...(pdfBusy ? s.busy : {}), border: "none", cursor: pdfBusy ? "default" : "pointer" }}>
                        {pdfBusy ? "Generando…" : `⬇ Descargar Remitos por proveedor (${remitoGroups.length})`}
                      </button>)
                : <span style={s.askHint}>Agregá al menos un item para generar (cliente y envío son opcionales).</span>}
            </>
          )}
        </span>
      </div>
    </section>

    {/* Cargar IMEIs de una línea: pegás la columna (uno por renglón) */}
    {imeiLine && (() => {
      const count = imeiLine.text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).length;
      const ok = imeiLine.qty ? count >= imeiLine.qty : count > 0;
      return (
        <div style={s.modalOverlay} onClick={() => setImeiLine(null)}>
          <div style={{ ...s.modalCard, width: "min(460px, 96vw)" }} onClick={(e) => e.stopPropagation()}>
            <div style={s.newHead}>📱 IMEIs — {imeiLine.sku}{imeiLine.color ? ` · ${imeiLine.color}` : ""}</div>
            <div style={{ fontSize: 12, color: ok ? "#8ee0a8" : "#e0b34d", marginBottom: 6 }}>
              {count}/{imeiLine.qty} · pegá la columna del Excel, un IMEI por renglón{count > imeiLine.qty ? ` · ⚠ sobran ${count - imeiLine.qty}` : ""}
            </div>
            <textarea value={imeiLine.text} autoFocus
              onChange={(e) => setImeiLine((v) => ({ ...v, text: e.target.value }))}
              rows={10} placeholder={`Pegá ${imeiLine.qty} IMEIs, uno por renglón…`}
              style={{ ...s.invArea, width: "100%", boxSizing: "border-box", fontFamily: "monospace", fontSize: 11.5 }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
              <button onClick={() => setImeiLine(null)} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Cancelar</button>
              <button onClick={() => { setItem(imeiLine.idx, "imeis", imeiLine.text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)); setImeiLine(null); }} style={{ ...s.pdfBtn, border: "none", cursor: "pointer" }}>💾 Guardar</button>
            </div>
          </div>
        </div>
      );
    })()}
    </div>
  );
}
