import React from "react";
import styles from "../../styles.js";

// Modal: confirmar CUALQUIER borrado pedido por el agente (factura, pedido, cliente, envío, proveedor).
export default function DeleteModal({ pending, onCancel, onConfirm }) {
  const s = styles;
  if (!pending) return null;
  return (
    <div style={s.modalOverlay} onClick={onCancel}>
      <div style={{ ...s.modalCard, width: "min(460px, 96vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...s.newHead, color: "#f0a0a0" }}>🗑️ {pending.titulo}</div>
        {pending.detalle && (
          <div style={{ fontSize: 12.5, color: "#cfd6e4", marginBottom: 10 }}>{pending.detalle}</div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Cancelar</button>
          <button onClick={onConfirm} style={{ ...s.pdfBtn, border: "none", cursor: "pointer", background: "#b91c1c" }}>🗑️ Borrar</button>
        </div>
      </div>
    </div>
  );
}
