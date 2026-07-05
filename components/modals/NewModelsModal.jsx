import React from "react";
import styles from "../../styles.js";
import { CATEGORIES } from "../../lib/constants.js";

// Modal: modelos nuevos detectados en una cotización — revisar y confirmar para el catálogo.
export default function NewModelsModal({ pendingNew, editNew, confirmNew, dismissNew, onClose }) {
  const s = styles;
  if (!pendingNew.length) return null;
  return (
    <div style={s.modalOverlay} onClick={onClose}>
      <div style={s.modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={s.newHead}>🆕 {pendingNew.length} modelo(s) nuevo(s) detectado(s) — revisá y confirmá para agregarlos al catálogo:</div>
        {pendingNew.map((m, i) => (
          <div style={s.newRow} key={i}>
            <input value={m.name} onChange={(e) => editNew(i, "name", e.target.value)} style={{ ...s.invInput, flex: 1, minWidth: 160 }} />
            <select value={CATEGORIES.includes(m.cat) ? m.cat : "Samsung"} onChange={(e) => editNew(i, "cat", e.target.value)} style={{ ...s.invInput, width: 130 }}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <span style={s.newPrice}>$<input value={m.price ?? ""} onChange={(e) => editNew(i, "price", parseFloat(String(e.target.value).replace(/[^0-9.]/g, "")) || null)} style={{ ...s.cellInput, width: 64, border: "1px solid #232a3a" }} /></span>
            <span style={s.newSup}>{m.supplier}</span>
            <button onClick={() => confirmNew(i)} style={s.newAdd}>✓ Agregar</button>
            <button onClick={() => dismissNew(i)} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>✕</button>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button onClick={onClose} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Cerrar (descartar todos)</button>
        </div>
      </div>
    </div>
  );
}
