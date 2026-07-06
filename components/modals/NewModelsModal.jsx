import React from "react";
import styles from "../../styles.js";
import { CATEGORIES, DEFAULT_DEPT } from "../../lib/constants.js";

// Modal: modelos nuevos detectados en una cotización — revisar (departamento + categoría) y confirmar.
export default function NewModelsModal({ pendingNew, editNew, confirmNew, dismissNew, onClose, deptList, supplierDepts = {} }) {
  const s = styles;
  if (!pendingNew.length) return null;
  const depts = deptList && deptList.length ? deptList : [DEFAULT_DEPT];
  return (
    <div style={s.modalOverlay} onClick={onClose}>
      <div style={s.modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={s.newHead}>🆕 {pendingNew.length} modelo(s) nuevo(s) detectado(s) — revisá departamento y categoría, y confirmá:</div>
        {pendingNew.map((m, i) => {
          // default del departamento según el proveedor (ej. South → iPhone); editable
          const dept = m.dept || (supplierDepts[m.supplier] || [])[0] || DEFAULT_DEPT;
          const isPhone = dept === DEFAULT_DEPT;
          return (
            <div style={s.newRow} key={i}>
              <input value={m.name} onChange={(e) => editNew(i, "name", e.target.value)} style={{ ...s.invInput, flex: 1, minWidth: 150 }} />
              <select value={dept} onChange={(e) => editNew(i, "dept", e.target.value)} style={{ ...s.invInput, width: 100 }} title="Departamento (pestaña de la Mesa)">
                {depts.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              {isPhone ? (
                <select value={CATEGORIES.includes(m.cat) ? m.cat : "Samsung"} onChange={(e) => editNew(i, "cat", e.target.value)} style={{ ...s.invInput, width: 120 }}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input value={m.cat || dept} onChange={(e) => editNew(i, "cat", e.target.value)} placeholder="Categoría" style={{ ...s.invInput, width: 120 }} title="Categoría libre (ej. iPhone, MacBook)" />
              )}
              <span style={s.newPrice}>$<input value={m.price ?? ""} onChange={(e) => editNew(i, "price", parseFloat(String(e.target.value).replace(/[^0-9.]/g, "")) || null)} style={{ ...s.cellInput, width: 64, border: "1px solid #232a3a" }} /></span>
              <span style={s.newSup}>{m.supplier}</span>
              <button onClick={() => confirmNew(i)} style={s.newAdd}>✓ Agregar</button>
              <button onClick={() => dismissNew(i)} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>✕</button>
            </div>
          );
        })}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button onClick={onClose} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Cerrar (descartar todos)</button>
        </div>
      </div>
    </div>
  );
}
