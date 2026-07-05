import React from "react";
import styles from "../../styles.js";
import { money } from "../../lib/helpers.js";

// Modal: confirmación del agente (revisor + resumen) antes de generar factura/remitos.
export default function AgentCommitModal({ pending, onCancel, onConfirm }) {
  const s = styles;
  if (!pending) return null;
  return (
    <div style={s.modalOverlay} onClick={onCancel}>
      <div style={s.modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={s.newHead}>{pending.kind === "invoice" ? "🧾 Revisá antes de generar la FACTURA" : "📦 Revisá antes de generar los REMITOS"}</div>
        <div style={{ fontSize: 12.5, color: "#cfd6e4", marginBottom: 8 }}>
          Cliente: <b>{pending.summary.cliente}</b> · Fecha: {pending.summary.fecha}
          {pending.kind === "invoice" && <> · Venta <b style={{ color: "#fbbf24" }}>{money(pending.summary.venta)}</b> · Costo {money(pending.summary.costo)} · Margen <b style={{ color: "#4ade80" }}>{money(pending.summary.margen)}</b></>}
        </div>
        <table style={s.invTable}>
          <thead><tr>
            <th style={s.invTh}>Cant.</th><th style={{ ...s.invTh, textAlign: "left" }}>Modelo</th><th style={{ ...s.invTh, textAlign: "left" }}>Color</th><th style={{ ...s.invTh, textAlign: "left" }}>Prov.</th>
            {pending.kind === "invoice" && <><th style={s.invTh}>Costo</th><th style={s.invTh}>Precio</th></>}
          </tr></thead>
          <tbody>
            {pending.summary.lineas.map((l, i) => (
              <tr key={i}>
                <td style={s.invTd}>{l.cantidad}</td>
                <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4" }}>{l.modelo}</td>
                <td style={{ ...s.invTd, textAlign: "left" }}>{l.color || "—"}</td>
                <td style={{ ...s.invTd, textAlign: "left" }}>{l.proveedor || "—"}</td>
                {pending.kind === "invoice" && <><td style={{ ...s.invTd, color: "#9aa4b2" }}>{money(l.costo)}</td><td style={{ ...s.invTd, color: "#fbbf24" }}>{money(l.precio)}</td></>}
              </tr>
            ))}
          </tbody>
        </table>
        {pending.issues.length > 0 && (
          <div style={{ marginTop: 10, background: "#2a1f0f", border: "1px solid #5a4a1d", borderRadius: 6, padding: "8px 10px", fontSize: 12, color: "#e6d8b8" }}>
            <b>⚠ El revisor marcó:</b>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{pending.issues.map((x, i) => <li key={i}>{x}</li>)}</ul>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button onClick={onCancel} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Cancelar</button>
          <button onClick={onConfirm} style={{ ...s.pdfBtn, border: "none", cursor: "pointer" }}>✓ Confirmar y generar</button>
        </div>
      </div>
    </div>
  );
}
