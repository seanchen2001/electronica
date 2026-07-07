import React from "react";
import styles from "../styles.js";
import { money } from "../lib/helpers.js";

// Pestaña Analítica: agregados derivados del Historial — margen por mes (barras),
// top clientes, top proveedores y top modelos. No usa storage propio.
export default function AnaliticaView({ data, inventory = {}, lista = {} }) {
  const s = styles;
  const card = { background: "#11151f", border: "1px solid #1c2230", borderRadius: 6, padding: 12, flex: "1 1 280px", minWidth: 260 };
  const maxV = Math.max(...data.monthly.map((m) => m.ventas), 1);
  // inventario derivado (compras a cuentas nuestras − ventas); solo SKUs con movimiento
  const invRows = Object.values(inventory).filter((r) => r.entradas > 0 || r.onHand !== 0).sort((a, b) => b.onHand - a.onHand);
  const rank = (rows, render) => (
    <table style={{ ...s.invTable, marginTop: 6 }}>
      <tbody>{rows.map(render)}</tbody>
    </table>
  );
  return (
    <section style={s.section}>
      <div style={s.sectionTitle}>ANALÍTICA — derivada del Historial (solo facturas)</div>
      {data.facturas === 0 ? (
        <div style={s.askHint}>Todavía no hay facturas. Generá facturas en Órdenes y acá aparecen las tendencias.</div>
      ) : (
        <>
          {/* KPIs */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            {[
              ["Ventas", money(data.ventas), "#fbbf24"],
              ["Costo", money(data.costo), "#9aa4b2"],
              ["Margen", money(data.margen), "#4ade80"],
              ["Margen % prom.", data.margenPct.toFixed(1) + "%", "#4ade80"],
              ["Piezas", String(data.piezas), "#cfd6e4"],
              ["Facturas", String(data.facturas), "#cfd6e4"],
            ].map(([k, v, c]) => (
              <div key={k} style={{ background: "#11151f", border: "1px solid #1c2230", borderRadius: 6, padding: "10px 14px", minWidth: 110 }}>
                <div style={{ fontSize: 10, color: "#6b7385", letterSpacing: 1 }}>{k.toUpperCase()}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: c }}>{v}</div>
              </div>
            ))}
          </div>

          {/* margen por mes (barras simples) */}
          <div style={{ ...card, marginBottom: 14 }}>
            <div style={s.sectionTitle}>VENTAS / MARGEN POR MES (últimos {data.monthly.length})</div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 12, padding: "6px 4px 0" }}>
              {data.monthly.map((m) => (
                <div key={m.mk} style={{ flex: 1, textAlign: "center", minWidth: 54 }}>
                  <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 4, height: 110 }}>
                    <div title={`Ventas ${money(m.ventas)}`} style={{ width: 20, height: `${(m.ventas / maxV) * 100}%`, minHeight: 2, background: "#b98a1e", borderRadius: "3px 3px 0 0" }} />
                    <div title={`Margen ${money(m.margen)}`} style={{ width: 20, height: `${(Math.max(m.margen, 0) / maxV) * 100}%`, minHeight: 2, background: "#2f9e57", borderRadius: "3px 3px 0 0" }} />
                  </div>
                  <div style={{ fontSize: 10.5, color: "#8b94a7", marginTop: 6 }}>{m.label}</div>
                  <div style={{ fontSize: 10.5, color: "#fbbf24" }} title="Ventas del mes">{money(Math.round(m.ventas))}</div>
                  <div style={{ fontSize: 10.5, color: m.margen >= 0 ? "#4ade80" : "#f87171" }} title="Margen del mes">{money(Math.round(m.margen))}</div>
                  <div style={{ fontSize: 10, color: "#6b7385" }}>{m.piezas} pzs · {m.facturas} fact.</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "#6b7385", marginTop: 8 }}>
              <span style={{ display: "inline-block", width: 10, height: 10, background: "#b98a1e", borderRadius: 2, marginRight: 4, verticalAlign: "-1px" }} /> ventas
              <span style={{ display: "inline-block", width: 10, height: 10, background: "#2f9e57", borderRadius: 2, margin: "0 4px 0 12px", verticalAlign: "-1px" }} /> margen (venta − costo)
            </div>
          </div>

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <div style={card}>
              <div style={s.sectionTitle}>TOP CLIENTES POR FACTURACIÓN</div>
              {rank(data.topClientes.slice(0, 8), (c, i) => (
                <tr key={c.cliente}>
                  <td style={{ ...s.invTd, textAlign: "left", color: "#6b7385", width: 22 }}>{i + 1}</td>
                  <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4" }}>{c.cliente}</td>
                  <td style={{ ...s.invTd, color: "#fbbf24" }}>{money(c.ventas)}</td>
                  <td style={{ ...s.invTd, color: "#6b7385" }}>{c.facturas} fact.</td>
                </tr>
              ))}
            </div>
            <div style={card}>
              <div style={s.sectionTitle}>TOP CLIENTES POR MARGEN</div>
              {rank(data.topClientesPorMargen.slice(0, 8), (c, i) => (
                <tr key={c.cliente}>
                  <td style={{ ...s.invTd, textAlign: "left", color: "#6b7385", width: 22 }}>{i + 1}</td>
                  <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4" }}>{c.cliente}</td>
                  <td style={{ ...s.invTd, color: c.margen >= 0 ? "#4ade80" : "#f87171" }}>{money(c.margen)}</td>
                  <td style={{ ...s.invTd, color: "#6b7385" }}>{c.ventas ? ((c.margen / c.ventas) * 100).toFixed(1) + "%" : "—"}</td>
                </tr>
              ))}
            </div>
            <div style={card}>
              <div style={s.sectionTitle}>TOP PROVEEDORES POR COMPRA</div>
              {rank(data.topProveedores.slice(0, 8), (p, i) => (
                <tr key={p.proveedor}>
                  <td style={{ ...s.invTd, textAlign: "left", color: "#6b7385", width: 22 }}>{i + 1}</td>
                  <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4" }}>{p.proveedor}</td>
                  <td style={{ ...s.invTd, color: "#9aa4b2" }}>{money(p.compra)}</td>
                </tr>
              ))}
            </div>
            {invRows.length > 0 && (
              <div style={card}>
                <div style={s.sectionTitle}>INVENTARIO — stock y costo promedio real</div>
                <table style={{ ...s.invTable, marginTop: 6 }}>
                  <thead>
                    <tr>
                      <th style={{ ...s.invTd, textAlign: "left", color: "#6b7385" }}>Modelo</th>
                      <th style={{ ...s.invTd, color: "#6b7385" }}>Stock</th>
                      <th style={{ ...s.invTd, color: "#6b7385" }}>Costo prom.</th>
                      <th style={{ ...s.invTd, color: "#6b7385" }}>Lista</th>
                      <th style={{ ...s.invTd, color: "#6b7385" }}>Margen real</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invRows.slice(0, 12).map((r) => {
                      const lp = lista[r.sku];
                      const mReal = r.avgCost != null && lp != null ? lp - r.avgCost : null;
                      return (
                        <tr key={r.sku}>
                          <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4" }}>{r.sku}</td>
                          <td style={{ ...s.invTd, color: r.onHand < 0 ? "#f87171" : "#cfd6e4" }}>{r.onHand}</td>
                          <td style={{ ...s.invTd, color: "#9aa4b2" }}>{r.avgCost != null ? money(r.avgCost) : "—"}</td>
                          <td style={{ ...s.invTd, color: "#fbbf24" }}>{lp != null ? money(lp) : "—"}</td>
                          <td style={{ ...s.invTd, color: mReal == null ? "#6b7385" : mReal >= 0 ? "#4ade80" : "#f87171" }}>{mReal != null ? money(mReal) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ fontSize: 10, color: "#6b7385", marginTop: 6 }}>stock = compras a cuentas nuestras − ventas · costo prom. ponderado de las entradas · margen real = lista − costo prom.</div>
              </div>
            )}
            <div style={card}>
              <div style={s.sectionTitle}>TOP MODELOS POR VOLUMEN</div>
              {rank(data.topModelos.slice(0, 8), (m, i) => (
                <tr key={m.modelo}>
                  <td style={{ ...s.invTd, textAlign: "left", color: "#6b7385", width: 22 }}>{i + 1}</td>
                  <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4" }}>{m.modelo}</td>
                  <td style={{ ...s.invTd, color: "#cfd6e4" }}>{m.piezas} pzs</td>
                  <td style={{ ...s.invTd, color: m.margen >= 0 ? "#4ade80" : "#f87171" }}>{money(m.margen)}</td>
                </tr>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
