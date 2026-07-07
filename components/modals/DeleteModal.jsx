import React from "react";
import styles from "../../styles.js";

// Modal de confirmación simple del agente (T1): borrados y también acciones livianas
// como registrar un pago. Por defecto es un borrado (rojo); pending puede traer
// icon / confirmLabel / confirmColor para otras acciones.
export default function DeleteModal({ pending, onCancel, onConfirm }) {
  const s = styles;
  if (!pending) return null;
  const icon = pending.icon || "🗑️";
  const color = pending.confirmColor || "#b91c1c";
  return (
    <div style={s.modalOverlay} onClick={onCancel}>
      <div style={{ ...s.modalCard, width: "min(460px, 96vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...s.newHead, color: pending.confirmColor ? "#cfe3cf" : "#f0a0a0" }}>{icon} {pending.titulo}</div>
        {pending.detalle && (
          <div style={{ fontSize: 12.5, color: "#cfd6e4", marginBottom: 10 }}>{pending.detalle}</div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Cancelar</button>
          <button onClick={onConfirm} style={{ ...s.pdfBtn, border: "none", cursor: "pointer", background: color }}>{pending.confirmLabel || "🗑️ Borrar"}</button>
        </div>
      </div>
    </div>
  );
}
