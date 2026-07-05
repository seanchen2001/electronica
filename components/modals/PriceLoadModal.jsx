import React from "react";
import styles from "../../styles.js";
import { money } from "../../lib/helpers.js";

// Modal: confirmar carga de precios del agente (preview con variaciones y escalas).
export default function PriceLoadModal({ pending, onCancel, onConfirm }) {
  const s = styles;
  if (!pending) return null;
  return (
    <div style={s.modalOverlay} onClick={onCancel}>
      <div style={s.modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={s.newHead}>💲 Cargar precios de <b>{pending.supplier}</b> — revisá antes de guardar</div>
        <table style={s.invTable}>
          <thead><tr>
            <th style={{ ...s.invTh, textAlign: "left" }}>Modelo</th>
            <th style={s.invTh}>Actual</th><th style={s.invTh}>Nuevo</th><th style={s.invTh}>Δ%</th><th style={{ ...s.invTh, textAlign: "left" }}>Escala</th>
          </tr></thead>
          <tbody>
            {pending.rows.map((r) => (
              <tr key={r.sku} style={r.big ? { background: "#2a1f0f" } : undefined}>
                <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4" }}>{r.big ? "⚠ " : ""}{r.sku}</td>
                <td style={{ ...s.invTd, color: "#9aa4b2" }}>{r.oldPrice != null ? money(r.oldPrice) : "—"}</td>
                <td style={{ ...s.invTd, color: "#fbbf24" }}>{money(r.newPrice)}</td>
                <td style={{ ...s.invTd, color: r.big ? "#f87171" : "#8b94a7" }}>{r.pct == null ? "nuevo" : `${r.pct > 0 ? "+" : ""}${r.pct}%`}</td>
                <td style={{ ...s.invTd, textAlign: "left", color: "#c084fc", fontSize: 11 }}>{r.tiers ? r.tiers.map((t) => `${t.min}+→$${t.price}`).join(" · ") : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {pending.newModels?.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 12, color: "#e6d8b8" }}>🆕 Modelos fuera del catálogo (se confirman aparte): {pending.newModels.map((m) => m.name).join(", ")}</div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button onClick={onCancel} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Cancelar</button>
          <button onClick={onConfirm} style={{ ...s.pdfBtn, border: "none", cursor: "pointer" }}>✓ Confirmar y guardar</button>
        </div>
      </div>
    </div>
  );
}
