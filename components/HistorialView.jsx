import React from "react";
import styles from "../styles.js";
import { money, nextInvoiceNo } from "../lib/helpers.js";

// Pestaña Historial: facturas / remitos generados, con re-descarga, edición y borrado.
export default function HistorialView({ invoiceHistory, setInvoiceHistory, loadInvoiceForEdit, downloadFromHistory, deleteInvoice, pdfBusy, openImeiEditor }) {
  const s = styles;
  const imeiProg = (h) => {
    const items = h.items || h.order?.items || [];
    const total = items.reduce((a, it) => a + (Number(it.qty) || 0), 0);
    const loaded = items.reduce((a, it) => a + (Array.isArray(it.imeis) ? it.imeis.filter((x) => String(x).trim()).length : (it.imei ? 1 : 0)), 0);
    return { loaded, total };
  };
  return (
    <section style={s.section}>
      <div style={s.sectionTitle}>HISTORIAL — facturas / remitos generados · próximo Invoice # {nextInvoiceNo(invoiceHistory)}</div>
      {invoiceHistory.length === 0 ? (
        <div style={s.askHint}>Todavía no generaste ningún documento. El Invoice # se cuenta solo a medida que generás facturas.</div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
            <button onClick={() => { if (confirm("¿Borrar todo el historial? (el contador del Invoice # vuelve a empezar)")) setInvoiceHistory([]); }} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Limpiar historial</button>
          </div>
          <table style={s.invTable}>
            <thead>
              <tr>
                <th style={{ ...s.invTh, textAlign: "left" }}>Invoice #</th>
                <th style={{ ...s.invTh, textAlign: "left" }}>Fecha</th>
                <th style={{ ...s.invTh, textAlign: "left" }}>Tipo</th>
                <th style={{ ...s.invTh, textAlign: "left" }}>Cliente</th>
                <th style={s.invTh}>Piezas</th>
                <th style={s.invTh}>Total</th>
                <th style={s.invTh}>Costo</th>
                <th style={s.invTh}>Margen</th>
                <th style={{ ...s.invTh, textAlign: "left" }}>Descargar</th>
                <th style={s.invTh}></th>
              </tr>
            </thead>
            <tbody>
              {invoiceHistory.map((h, i) => (
                <tr key={i}>
                  <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4", fontWeight: 600 }}>{h.no}</td>
                  <td style={{ ...s.invTd, textAlign: "left" }}>{h.date}</td>
                  <td style={{ ...s.invTd, textAlign: "left" }}>{h.type}</td>
                  <td style={{ ...s.invTd, textAlign: "left" }}>{h.client}</td>
                  <td style={s.invTd}>{h.piezas}</td>
                  <td style={{ ...s.invTd, color: "#fbbf24" }}>{money(h.total)}</td>
                  <td style={{ ...s.invTd, color: "#9aa4b2" }}>{h.cost != null ? money(h.cost) : "—"}</td>
                  <td style={{ ...s.invTd, color: (h.margin || 0) >= 0 ? "#4ade80" : "#f87171" }}>{h.margin != null ? money(h.margin) : "—"}</td>
                  <td style={{ ...s.invTd, textAlign: "left", whiteSpace: "nowrap" }}>
                    <button onClick={() => loadInvoiceForEdit(h)} style={{ ...s.miniBtn, borderColor: "#3a5", color: "#8ee0a8" }} title="Editar esta factura (items, colores, cantidades, cliente, envío)">✏️ Editar</button>{" "}
                    {h.type === "factura" && openImeiEditor && (() => { const p = imeiProg(h); const done = p.total > 0 && p.loaded >= p.total; return (
                      <><button onClick={() => openImeiEditor(h)} style={{ ...s.miniBtn, borderColor: done ? "#3a5" : "#5a4a1d", color: done ? "#8ee0a8" : "#e0b34d" }} title="Cargar los IMEIs por unidad (agrupados por modelo)">📱 IMEIs {p.loaded}/{p.total}</button>{" "}</>
                    ); })()}
                    <button onClick={() => downloadFromHistory(h, "factura")} disabled={pdfBusy} style={s.miniBtn} title="Factura (con precios)">Factura</button>{" "}
                    <button onClick={() => downloadFromHistory(h, "remitos")} disabled={pdfBusy} style={s.miniBtn} title="Remitos por proveedor (sin precios)">Rem. x prov.</button>
                  </td>
                  <td style={s.invTd}><span style={s.chipX} onClick={() => deleteInvoice(h.ts, h.no)}>×</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
