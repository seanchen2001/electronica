import React from "react";
import styles from "../styles.js";
import { money } from "../lib/helpers.js";

// Pestaña PnL / Margen: agregados desde las facturas generadas (ventas).
export default function PnLView({ pnlView }) {
  const s = styles;
  return (
    <section style={s.section}>
      <div style={s.sectionTitle}>PnL / MARGEN — desde las facturas generadas (ventas)</div>
      {pnlView.sales.length === 0 ? (
        <div style={s.askHint}>Todavía no hay facturas. Generá una factura en Órdenes y acá ves ventas, costo y margen.</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            {[
              ["Ventas", money(pnlView.ventas), "#fbbf24"],
              ["Costo", money(pnlView.costo), "#9aa4b2"],
              ["Gastos envío", money(pnlView.gastos), "#9aa4b2"],
              ["Margen", money(pnlView.margen), "#4ade80"],
              ["Margen %", pnlView.margenPct.toFixed(1) + "%", "#4ade80"],
              ["Piezas", String(pnlView.piezas), "#cfd6e4"],
              ["Facturas", String(pnlView.sales.length), "#cfd6e4"],
            ].map(([k, v, c]) => (
              <div key={k} style={{ background: "#11151f", border: "1px solid #1c2230", borderRadius: 6, padding: "10px 14px", minWidth: 110 }}>
                <div style={{ fontSize: 10, color: "#6b7385", letterSpacing: 1 }}>{k.toUpperCase()}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: c }}>{v}</div>
              </div>
            ))}
          </div>

          <div style={{ ...s.sectionTitle, marginTop: 4 }}>Por factura</div>
          <table style={s.invTable}>
            <thead>
              <tr>
                <th style={{ ...s.invTh, textAlign: "left" }}>#</th>
                <th style={{ ...s.invTh, textAlign: "left" }}>Fecha</th>
                <th style={{ ...s.invTh, textAlign: "left" }}>Cliente</th>
                <th style={s.invTh}>Piezas</th>
                <th style={s.invTh}>Venta</th>
                <th style={s.invTh}>Costo</th>
                <th style={s.invTh}>Margen</th>
                <th style={s.invTh}>%</th>
              </tr>
            </thead>
            <tbody>
              {pnlView.sales.map((s2, i) => {
                const venta = Number(s2.subtotal ?? s2.total) || 0;
                const costo = Number(s2.cost) || 0;
                const mg = venta - costo;
                return (
                  <tr key={i}>
                    <td style={{ ...s.invTd, textAlign: "left", color: "#6fa8e6" }}>#{s2.no}</td>
                    <td style={{ ...s.invTd, textAlign: "left" }}>{s2.date}</td>
                    <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4" }}>{s2.client}</td>
                    <td style={s.invTd}>{s2.piezas}</td>
                    <td style={{ ...s.invTd, color: "#fbbf24" }}>{money(venta)}</td>
                    <td style={{ ...s.invTd, color: "#9aa4b2" }}>{money(costo)}</td>
                    <td style={{ ...s.invTd, color: mg >= 0 ? "#4ade80" : "#f87171" }}>{money(mg)}</td>
                    <td style={{ ...s.invTd, color: "#9aa4b2" }}>{venta ? ((mg / venta) * 100).toFixed(0) + "%" : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {pnlView.supplierRows.length > 0 && (
            <>
              <div style={{ ...s.sectionTitle, marginTop: 16 }}>Costo comprado por proveedor</div>
              <table style={s.invTable}>
                <thead><tr><th style={{ ...s.invTh, textAlign: "left" }}>Proveedor</th><th style={s.invTh}>Costo total</th></tr></thead>
                <tbody>
                  {pnlView.supplierRows.map(({ sp, c }) => (
                    <tr key={sp}><td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4" }}>{sp}</td><td style={{ ...s.invTd, color: "#9aa4b2" }}>{money(c)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </section>
  );
}
