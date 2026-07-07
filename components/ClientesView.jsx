import React from "react";
import styles from "../styles.js";

// Pestaña Clientes: ABM de clientes, envíos y proveedores (después se eligen en Órdenes).
export default function ClientesView({
  clients, clientForm, setClientField, loadClient, saveClient, deleteClient,
  shippings, shipForm, setShipField, loadShip, saveShip, deleteShip,
  supplierList, newSupplier, setNewSupplier, addSupplier, removeSupplier,
}) {
  const s = styles;
  return (
    <section style={s.section}>
      <div style={s.sectionTitle}>CLIENTES Y ENVÍOS — agregar / editar (después se eligen en Órdenes)</div>
      <div style={s.invGrid}>
        <div style={s.invCol}>
          <div style={s.invColHead}>CLIENTE</div>
          <select value={clientForm.id} onChange={(e) => loadClient(e.target.value)} style={s.invInput}>
            <option value="">— nuevo cliente —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input placeholder="Nombre" value={clientForm.name} onChange={(e) => setClientField("name", e.target.value)} style={s.invInput} />
          <textarea placeholder="Dirección (varias líneas)" value={clientForm.address} onChange={(e) => setClientField("address", e.target.value)} rows={2} style={s.invArea} />
          <input placeholder="RUC" value={clientForm.ruc} onChange={(e) => setClientField("ruc", e.target.value)} style={s.invInput} />
          <input placeholder="Teléfono" value={clientForm.phone} onChange={(e) => setClientField("phone", e.target.value)} style={s.invInput} />
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 12, color: "#cfd6e4", cursor: "pointer" }} title="Con cuenta corriente: se envía directo y queda en la cuenta. Sin cuenta: paga primero y después se envía.">
            <input type="checkbox" checked={!!clientForm.cuentaCorriente} onChange={(e) => setClientField("cuentaCorriente", e.target.checked)} />
            Tiene cuenta corriente
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 12, color: "#cfd6e4", cursor: "pointer" }} title="Cuenta propia: lo que se le factura cuenta como COMPRA a inventario (stock in), no como venta.">
            <input type="checkbox" checked={!!clientForm.esNuestra} onChange={(e) => setClientField("esNuestra", e.target.checked)} />
            Es cuenta nuestra (compras a inventario)
          </label>
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <button onClick={saveClient} style={s.toolBtn}>{clientForm.id ? "Actualizar" : "Guardar"} cliente</button>
            {clientForm.id && <button onClick={deleteClient} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Borrar</button>}
          </div>
        </div>
        <div style={s.invCol}>
          <div style={s.invColHead}>ENVÍO / SHIPPING</div>
          <select value={shipForm.id} onChange={(e) => loadShip(e.target.value)} style={s.invInput}>
            <option value="">— nuevo envío —</option>
            {shippings.map((sh) => <option key={sh.id} value={sh.id}>{sh.label || sh.notify}</option>)}
          </select>
          <input placeholder="Etiqueta (ej. CIF Miami)" value={shipForm.label} onChange={(e) => setShipField("label", e.target.value)} style={s.invInput} />
          <input placeholder="Notify" value={shipForm.notify} onChange={(e) => setShipField("notify", e.target.value)} style={s.invInput} />
          <input placeholder="Dirección de envío" value={shipForm.direccion} onChange={(e) => setShipField("direccion", e.target.value)} style={s.invInput} />
          <input placeholder="Teléfono" value={shipForm.telefono} onChange={(e) => setShipField("telefono", e.target.value)} style={s.invInput} />
          <input placeholder="Contacto" value={shipForm.contacto} onChange={(e) => setShipField("contacto", e.target.value)} style={s.invInput} />
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <button onClick={saveShip} style={s.toolBtn}>{shipForm.id ? "Actualizar" : "Guardar"} envío</button>
            {shipForm.id && <button onClick={deleteShip} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Borrar</button>}
          </div>
        </div>
        <div style={s.invCol}>
          <div style={s.invColHead}>PROVEEDORES</div>
          <div style={{ display: "flex", gap: 6 }}>
            <input placeholder="Nuevo proveedor" value={newSupplier}
              onChange={(e) => setNewSupplier(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addSupplier(); }}
              style={{ ...s.invInput, flex: 1 }} />
            <button onClick={addSupplier} style={s.toolBtn}>+ Agregar</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
            {supplierList.map((sp) => (
              <div key={sp} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#11151f", border: "1px solid #1c2230", borderRadius: 4, padding: "4px 8px" }}>
                <span style={{ color: "#cfd6e4" }}>{sp}</span>
                <span style={s.chipX} onClick={() => removeSupplier(sp)}>×</span>
              </div>
            ))}
            {supplierList.length === 0 && <span style={s.askHint}>Sin proveedores. Agregá al menos uno.</span>}
          </div>
        </div>
      </div>
      <div style={s.selHint}>{clients.length} cliente(s) · {shippings.length} envío(s) · {supplierList.length} proveedor(es) guardados.</div>
    </section>
  );
}
