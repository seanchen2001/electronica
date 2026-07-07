import React from "react";
import styles from "../styles.js";

// Interfaz generativa: el agente puede dibujar tablas y gráficos en el chat.
function Artifact({ a }) {
  if (!a) return null;
  const card = { background: "#0d1119", border: "1px solid #2a3346", borderRadius: 8, padding: 10, margin: "6px 0", overflowX: "auto" };
  const title = { fontSize: 12, color: "#8ea0bf", fontWeight: 600, marginBottom: 6 };
  if (a.kind === "table") {
    return (
      <div style={card}>
        {a.title && <div style={title}>{a.title}</div>}
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 }}>
          <thead><tr>{(a.columns || []).map((c, i) => <th key={i} style={{ textAlign: "left", padding: "3px 6px", borderBottom: "1px solid #2a3346", color: "#8b94a7", whiteSpace: "nowrap" }}>{c}</th>)}</tr></thead>
          <tbody>{(a.rows || []).map((r, ri) => <tr key={ri}>{(r || []).map((cell, ci) => <td key={ci} style={{ padding: "3px 6px", borderBottom: "1px solid #171c28", color: "#cfd6e4", whiteSpace: "nowrap" }}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  if (a.kind === "chart") {
    const vals = (a.series && a.series[0] && a.series[0].values) || [];
    const max = Math.max(1, ...vals.map((v) => Math.abs(v)));
    return (
      <div style={card}>
        {a.title && <div style={title}>{a.title}</div>}
        {(a.labels || []).map((lab, i) => {
          const v = vals[i] || 0;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, margin: "2px 0", fontSize: 11 }}>
              <span style={{ width: 96, color: "#9aa4b2", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={lab}>{lab}</span>
              <div style={{ flex: 1, background: "#11151f", borderRadius: 3, height: 14 }}>
                <div style={{ width: (Math.abs(v) / max * 100) + "%", background: v < 0 ? "#f0a0a0" : "#6fa8e6", height: "100%", borderRadius: 3 }} />
              </div>
              <span style={{ width: 62, textAlign: "right", color: "#cfd6e4", fontVariantNumeric: "tabular-nums" }}>{v.toLocaleString("en-US")}</span>
            </div>
          );
        })}
      </div>
    );
  }
  return null;
}

// Chatbox unificado de escritorio (a la derecha, colapsable): el log del agente + input.
export default function ChatBox({
  chatOpen, setChatOpen, chatScrollRef,
  agentLog, showSteps, setShowSteps, resetAgent, agentBusy,
  superOn, setSuperOn, knowledgeCount,
  smartWorker, setSmartWorker,
  runImprovementReview, chatLogCount = 0,
  pendingOps = [], setOpsCheck,
  chatText, setChatText, chatImage, setChatImage, onChatPaste, submitChat, busyChat,
}) {
  const s = styles;
  const chk = (on) => ({ fontSize: 10.5, display: "inline-flex", alignItems: "center", gap: 3, cursor: "pointer", color: on ? "#8ee0a8" : "#8b94a7" });
  return (
    <aside style={{ ...s.chatBox, transform: chatOpen ? "none" : "translateX(100%)" }}>
      <div style={s.chatHead}>
        <span>💬 ASISTENTE</span>
        <button onClick={() => setChatOpen(false)} title="Colapsar hacia la derecha" style={s.chatCollapse}>▶</button>
      </div>

      {/* Pendientes de reclamar — proactivo (post-venta): entrega afuera / local / pago */}
      {pendingOps.length > 0 && (
        <div style={{ background: "#1a1410", border: "1px solid #5a4a1d", borderRadius: 8, padding: "8px 10px", marginBottom: 8, maxHeight: "26vh", overflowY: "auto" }}>
          <div style={{ fontSize: 11.5, color: "#e6c98b", fontWeight: 600, marginBottom: 6 }}>🔔 Pendientes de reclamar ({pendingOps.length})</div>
          {pendingOps.slice(0, 12).map((o) => {
            const blocked = !o.cc && !o.pago;
            return (
              <div key={o.ts} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "3px 0", borderTop: "1px solid #2a2114", fontSize: 11 }}>
                <span style={{ color: o.days >= 5 ? "#f0a0a0" : "#cfd6e4", fontWeight: 600, minWidth: 118 }}>
                  #{o.no} · {o.cliente} · {o.days}d{blocked ? " · ⛔ paga 1º" : ""}
                </span>
                <label style={chk(o.afuera)}><input type="checkbox" checked={o.afuera} onChange={(e) => setOpsCheck(o.ts, "afuera", e.target.checked)} /> afuera</label>
                <label style={chk(o.local)}><input type="checkbox" checked={o.local} onChange={(e) => setOpsCheck(o.ts, "local", e.target.checked)} /> local</label>
                <label style={chk(o.pago)}><input type="checkbox" checked={o.pago} onChange={(e) => setOpsCheck(o.ts, "pago", e.target.checked)} /> pago</label>
              </div>
            );
          })}
        </div>
      )}

      {/* resultados: crecen y ocupan el alto disponible */}
      <div style={s.chatResults} ref={chatScrollRef}>
        {(
          <>
            {agentLog.length > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
                  <label style={{ fontSize: 10.5, color: "#6b7385", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                    <input type="checkbox" checked={showSteps} onChange={(e) => setShowSteps(e.target.checked)} /> ver pasos
                  </label>
                  <label style={{ fontSize: 10.5, color: superOn ? "#8ee0a8" : "#6b7385", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}
                    title="Supervisor (Gemini Pro): revisa, corrige lo de bajo riesgo y aprende reglas del sistema">
                    <input type="checkbox" checked={!!superOn} onChange={(e) => setSuperOn(e.target.checked)} /> 🧭 supervisor{knowledgeCount ? ` (${knowledgeCount})` : ""}
                  </label>
                  {setSmartWorker && (
                    <label style={{ fontSize: 10.5, color: smartWorker ? "#8ee0a8" : "#6b7385", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}
                      title="Modo inteligente: el agente corre en Gemini Pro (mira y razona antes de preguntar). Apagado = Flash, más rápido y barato pero menos vivo.">
                      <input type="checkbox" checked={!!smartWorker} onChange={(e) => setSmartWorker(e.target.checked)} /> 🧠 inteligente
                    </label>
                  )}
                </span>
                <span style={{ display: "inline-flex", gap: 6 }}>
                  {runImprovementReview && (
                    <button onClick={runImprovementReview} disabled={agentBusy}
                      title={`Revisa las últimas conversaciones guardadas (${chatLogCount}) y mejora la memoria de reglas del agente`}
                      style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0, fontSize: 11 }}>🧠 revisar chats</button>
                  )}
                  <button onClick={resetAgent} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0, fontSize: 11 }}>Nueva conversación</button>
                </span>
              </div>
            )}
            {agentLog.filter((m) => showSteps || m.role !== "tool").map((m, i) => (
              m.role === "artifact"
                ? <Artifact key={i} a={m.artifact} />
                : <div key={i} style={
                    m.role === "you" ? s.agYou : m.role === "agent" ? s.agBot : m.role === "tool" ? s.agTool : s.agSys
                  }>{m.text}</div>
            ))}
            {agentBusy && <div style={{ ...s.agTool, display: "flex", alignItems: "center", gap: 6 }}><span style={s.spinner} /> generando…</div>}
            {agentLog.length === 0 && !agentBusy && (
              <div style={s.chatEmpty}>
                <p style={{ margin: "0 0 8px" }}><b style={{ color: "#8ee0a8" }}>🤖 Agente</b> — pedile lo que necesites, hace todo:</p>
                <p style={{ margin: "4px 0" }}>🧾 <b>Órdenes</b> — “Intalper quiere 20 S26 Ultra 256 y 40 S25 Ultra 256, buscá el mejor proveedor y armá la orden.”</p>
                <p style={{ margin: "4px 0" }}>💬 <b>Preguntar</b> — “¿dónde está más competitivo VITEL esta semana?”</p>
                <p style={{ margin: "4px 0" }}>✅ <b>Marcar</b> — “marcá el S26 Ultra y el A56 para la cotización.”</p>
                <p style={{ margin: "4px 0" }}>📥 <b>Cargar precios</b> — pegá o adjuntá 📷 una cotización de un proveedor.</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* input abajo (estilo chat) */}
      <div style={s.chatInputWrap}>
        <textarea value={chatText} onChange={(e) => setChatText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!busyChat) submitChat(); } }}
          onPaste={onChatPaste} rows={4}
          placeholder="Pedile al agente: armar una orden, preguntar, marcar modelos o cargar precios… (Enter envía)"
          style={s.chatInput} />
        {chatImage && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11, color: "#9aa4b2" }}>
            <img alt="adjunta" src={URL.createObjectURL(chatImage)} style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4, border: "1px solid #2a3346" }} />
            <span>imagen adjunta</span>
            <span style={s.chipX} onClick={() => setChatImage(null)}>×</span>
          </div>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <label style={{ ...s.imgBtn, cursor: busyChat ? "default" : "pointer" }} title="Adjuntar screenshot (podés agregarle texto antes de enviar)">📷
            <input type="file" accept="image/*" disabled={busyChat} style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) setChatImage(f); e.target.value = ""; }} />
          </label>
          <button onClick={() => submitChat()} disabled={busyChat} style={{ ...s.askBtn, flex: 1, ...(busyChat ? s.busy : {}) }}>
            {busyChat ? "…" : "Enviar"}
          </button>
        </div>
        <div style={s.askHint}>Enter envía · Shift+Enter salto de línea · 📷/Ctrl+V adjunta.</div>
      </div>
    </aside>
  );
}
