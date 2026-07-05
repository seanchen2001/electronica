import React from "react";
import styles from "../styles.js";
import { MONTHS_ES } from "../lib/constants.js";
import { money, parseDMY } from "../lib/helpers.js";

// Pestaña Cuentas corrientes: saldos por cliente/proveedor, fusión de cuentas,
// detalle de movimientos y registro manual de pagos/gastos.
export default function CuentasView({
  ledgerSide, setLedgerSide, ledgerAccount, setLedgerAccount, totalSaldo,
  accounts, accountNames, currentAccount, canon,
  mergeFrom, setMergeFrom, mergeTo, setMergeTo, mergeAccounts, aliases, unmerge,
  payForm, setPayForm, registerPay, deleteLedgerEntry,
}) {
  const s = styles;
  return (
    <section style={s.section}>
      <div style={s.sectionTitle}>CUENTAS CORRIENTES</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => { setLedgerSide("client"); setLedgerAccount(""); }} style={{ ...s.planTab, ...(ledgerSide === "client" ? s.planTabOn : {}) }}>👤 Clientes (nos deben)</button>
        <button onClick={() => { setLedgerSide("supplier"); setLedgerAccount(""); }} style={{ ...s.planTab, ...(ledgerSide === "supplier" ? s.planTabOn : {}) }}>🏭 Proveedores (les debemos)</button>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#9aa4b2" }}>
          Total {ledgerSide === "client" ? "por cobrar" : "por pagar"}: <b style={{ color: totalSaldo >= 0 ? "#fbbf24" : "#4ade80" }}>{money(totalSaldo)}</b>
        </span>
      </div>

      {/* solapas: una por cuenta */}
      <div style={s.acctTabs}>
        {accountNames.length === 0 && <span style={s.askHint}>Sin cuentas todavía. Generá una factura o registrá un movimiento.</span>}
        {accountNames.map((name) => {
          const on = canon(ledgerAccount) === name;
          const sal = accounts[name].saldo;
          return (
            <button key={name} onClick={() => setLedgerAccount(name)} style={{ ...s.acctTab, ...(on ? s.acctTabOn : {}) }}>
              {name} <b style={{ color: sal > 0.005 ? "#fbbf24" : sal < -0.005 ? "#4ade80" : "#6b7385" }}>{money(sal)}</b>
            </button>
          );
        })}
      </div>

      {/* fusionar cuentas (ej. Intalper = Ojus) */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", margin: "6px 0 14px", fontSize: 11, color: "#8b94a7" }}>
        <span>Fusionar:</span>
        <select value={mergeFrom} onChange={(e) => setMergeFrom(e.target.value)} style={{ ...s.invInput, width: 150 }}><option value="">cuenta…</option>{accountNames.map((n) => <option key={n} value={n}>{n}</option>)}</select>
        <span>→</span>
        <select value={mergeTo} onChange={(e) => setMergeTo(e.target.value)} style={{ ...s.invInput, width: 150 }}><option value="">dentro de…</option>{accountNames.map((n) => <option key={n} value={n}>{n}</option>)}</select>
        <button onClick={mergeAccounts} style={{ ...s.toolBtn, marginLeft: 0 }}>Fusionar</button>
        {Object.entries(aliases).map(([a, b]) => (
          <span key={a} style={{ background: "#11151f", border: "1px solid #1c2230", borderRadius: 4, padding: "2px 6px" }}>{a} → {b} <span style={s.chipX} onClick={() => unmerge(a)}>×</span></span>
        ))}
      </div>

      {!currentAccount ? (
        <div style={s.askHint}>Elegí una cuenta arriba para ver su detalle.</div>
      ) : (
        <div style={{ border: "1px solid #1c2230", borderRadius: 6, overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", background: "#131823" }}>
            <b style={{ color: "#e8ecf3", fontSize: 14 }}>{currentAccount.party}</b>
            <span style={{ fontSize: 13 }}>{ledgerSide === "client" ? "Nos debe" : "Le debemos"}: <b style={{ color: currentAccount.saldo > 0.005 ? "#fbbf24" : currentAccount.saldo < -0.005 ? "#4ade80" : "#6b7385" }}>{money(currentAccount.saldo)}</b></span>
          </div>
          <table style={s.invTable}>
            <thead>
              <tr>
                <th style={{ ...s.invTh, textAlign: "left" }}>Fecha</th>
                <th style={{ ...s.invTh, textAlign: "left" }}>Concepto</th>
                <th style={{ ...s.invTh, textAlign: "left" }}>Ref</th>
                <th style={s.invTh} title={ledgerSide === "client" ? "Venta (les damos crédito)" : "Pago que hacemos"}>Débito</th>
                <th style={s.invTh} title={ledgerSide === "client" ? "Pago que recibimos" : "Compra (nos dan crédito)"}>Crédito</th>
                <th style={s.invTh}>Saldo</th>
                <th style={s.invTh}></th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                let lastMonth = null;
                return currentAccount.rows.map((m) => {
                  const d = parseDMY(m.date, m.ts);
                  const mk = d.getFullYear() * 12 + d.getMonth();
                  // en cliente: Débito=venta(cargo), Crédito=pago. En proveedor: Débito=pago, Crédito=compra(cargo).
                  const debCol = ledgerSide === "client" ? m.cargo : m.pago;
                  const credCol = ledgerSide === "client" ? m.pago : m.cargo;
                  const header = mk !== lastMonth ? ((lastMonth = mk), (
                    <tr key={"mh-" + mk}><td colSpan={7} style={s.acctMonth}>{MONTHS_ES[d.getMonth()]} {d.getFullYear()}</td></tr>
                  )) : null;
                  return (
                    <React.Fragment key={m.key}>
                      {header}
                      <tr>
                        <td style={{ ...s.invTd, textAlign: "left" }}>{m.date}</td>
                        <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4" }}>{m.concept}</td>
                        <td style={{ ...s.invTd, textAlign: "left", color: "#6fa8e6" }}>{m.ref ? `#${m.ref}` : ""}</td>
                        <td style={{ ...s.invTd, color: "#fbbf24" }}>{debCol ? money(debCol) : ""}</td>
                        <td style={{ ...s.invTd, color: "#4ade80" }}>{credCol ? money(credCol) : ""}</td>
                        <td style={{ ...s.invTd, background: "#0f1a12", color: m.saldo < -0.005 ? "#f87171" : "#cfe6b8", fontWeight: 600 }}>{money(m.saldo)}</td>
                        <td style={s.invTd}>{m.derived ? <span style={{ color: "#3a4255", fontSize: 10 }} title="Derivado de la factura — se edita/borra desde el Historial">🔒</span> : <span style={s.chipX} onClick={() => deleteLedgerEntry(m.id)}>×</span>}</td>
                      </tr>
                    </React.Fragment>
                  );
                });
              })()}
            </tbody>
          </table>
          {/* registrar pago / gasto en esta cuenta */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", padding: 10, borderTop: "1px solid #1c2230", background: "#0f131c" }}>
            <label style={s.ctrlLabel}><span style={s.ctrlText}>TIPO</span>
              <select value={payForm.type} onChange={(e) => setPayForm((f) => ({ ...f, type: e.target.value }))} style={{ ...s.invInput, width: 140 }}>
                <option value="pago">Pago (baja el saldo)</option>
                <option value="gasto">Gasto envío (sube el saldo)</option>
              </select>
            </label>
            <label style={s.ctrlLabel}><span style={s.ctrlText}>MONTO</span>
              <input value={payForm.amount} onChange={(e) => setPayForm((f) => ({ ...f, amount: e.target.value }))} style={{ ...s.invInput, width: 100 }} inputMode="decimal" placeholder="0" />
            </label>
            <label style={s.ctrlLabel}><span style={s.ctrlText}>FECHA</span>
              <input value={payForm.date} onChange={(e) => setPayForm((f) => ({ ...f, date: e.target.value }))} style={{ ...s.invInput, width: 110 }} />
            </label>
            <label style={s.ctrlLabel}><span style={s.ctrlText}>CONCEPTO</span>
              <input value={payForm.concept} onChange={(e) => setPayForm((f) => ({ ...f, concept: e.target.value }))} style={{ ...s.invInput, width: 180 }} placeholder="opcional" />
            </label>
            <button onClick={registerPay} style={{ ...s.toolBtn, marginLeft: 0 }}>+ Registrar en {currentAccount.party}</button>
          </div>
        </div>
      )}
    </section>
  );
}
