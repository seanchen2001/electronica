import React from "react";
import styles from "../styles.js";

// Panel Papelero: lo borrado en las últimas 24 h, con Restaurar por item.
// El auto-purge (>24 h) corre en el orquestador.
export default function TrashPanel({ trash, trashLabel, restoreTrash, onClose }) {
  const s = styles;
  const age = (ts) => {
    const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
    return m < 60 ? `hace ${m} min` : `hace ${Math.floor(m / 60)} h`;
  };
  return (
    <div style={s.modalOverlay} onClick={onClose}>
      <div style={{ ...s.modalCard, width: "min(560px, 96vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={s.newHead}>🗑️ Papelero — borrado en las últimas 24 h (después se purga solo)</div>
        {trash.length === 0 ? (
          <div style={s.askHint}>Vacío. Cuando borres algo (factura, pedido, cliente, envío, proveedor o movimiento) queda acá 24 h para restaurarlo.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {trash.map((item) => (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "#11151f", border: "1px solid #1c2230", borderRadius: 5, padding: "6px 10px" }}>
                <span style={{ flex: 1, color: "#cfd6e4", fontSize: 12.5 }}>{trashLabel(item)}</span>
                <span style={{ fontSize: 10.5, color: "#6b7385" }}>{age(item.deletedAt)}</span>
                <button onClick={() => restoreTrash(item.id)} style={{ ...s.toolBtn, marginLeft: 0, borderColor: "#3a5", color: "#8ee0a8" }}>↩ Restaurar</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <button onClick={onClose} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
