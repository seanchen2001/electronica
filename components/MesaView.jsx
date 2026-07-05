import React from "react";
import styles from "../styles.js";
import { money } from "../lib/helpers.js";

// Pestaña Mesa de precios: ask-the-desk (móvil), paste & parse (móvil), tabla
// comparativa de proveedores y cotización al cliente (WhatsApp).
export default function MesaView({
  isMobile,
  // ask the desk (móvil)
  askMode, setAskMode, query, setQuery, asking, submitAsk, onAskPaste, markFromImage, answer, answerErr, markMsg,
  // toolbar / snapshots
  saveSnapshot, expireAll, snapshots, prevSnap, loadSeed, prices,
  // paste & parse (móvil)
  parseSupplier, setParseSupplier, supplierList, rawText, setRawText, runParse, parsing, parseMsg,
  // tabla
  hideEmpty, setHideEmpty, catalog, visibleCatalog, selectAll, selectPriced, selectNone,
  selectedSkus, selected, toggleSelected, setSelected,
  aggBySku, freshBySku, lista, listaFor, setListaCell, setCell, marginNum,
  // cotización al cliente
  quoteGroups, quoteSource, changeSource, copyQuote, copied, quoteOverrides, baseQuotePrice, setOverride, quoteText,
}) {
  const s = styles;
  let lastCat = null;

  const askSection = (
    <section style={s.section}>
      <div style={s.sectionTitle}>ASK THE DESK</div>
      <div style={s.modeTabs}>
        <button onClick={() => setAskMode("ask")} style={{ ...s.planTab, ...(askMode === "ask" ? s.planTabOn : {}) }}>Preguntar</button>
        <button onClick={() => setAskMode("mark")} style={{ ...s.planTab, ...(askMode === "mark" ? s.planTabOn : {}) }}>Marcar modelos</button>
      </div>
      <div style={s.askRow}>
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !asking && submitAsk()}
          onPaste={onAskPaste}
          placeholder={askMode === "ask"
            ? "ej. ¿Dónde está más competitivo VITEL? ¿Qué cambió vs la semana pasada?"
            : "Pegá modelos o un screenshot (Ctrl+V)…"}
          style={s.askInput} />
        {askMode === "mark" && (
          <label style={s.imgBtn} title="Subir screenshot (OCR con Gemini)">📷
            <input type="file" accept="image/*" style={{ display: "none" }}
              onChange={(e) => { markFromImage(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
        )}
        <button onClick={submitAsk} disabled={asking} style={{ ...s.askBtn, ...(asking ? s.busy : {}) }}>
          {asking ? "…" : askMode === "ask" ? "Ask" : "Marcar"}
        </button>
      </div>
      {answerErr && <div style={s.errorMsg}>{answerErr}</div>}
      {askMode === "ask" && (answer
        ? <div style={s.answerCard}>{answer}</div>
        : <div style={s.askHint}>Responde estricto sobre la tabla actual (y tu última semana, si hay).</div>)}
      {askMode === "mark" && (markMsg
        ? <div style={markMsg.err ? s.errorMsg : s.okMsg}>{markMsg.text}</div>
        : <div style={s.askHint}>Escribí/pegá una lista, pegá un screenshot o usá 📷; Gemini lee y tilda los modelos.</div>)}
    </section>
  );

  return (
    <div>
    <div style={!isMobile ? s.mesaMain : undefined}>
    {isMobile && askSection}
    {/* toolbar (solo escritorio) */}
    {!isMobile && (
    <div style={s.toolbar}>
      <button onClick={saveSnapshot} style={s.toolBtn}>Save snapshot</button>
      <button onClick={expireAll} style={s.toolBtn}>Expirar todo (lunes)</button>
      <span style={s.listaFill}>Lista = Mín + MARGIN% (en vivo) · escribí en una celda para fijar un precio manual</span>
      <span style={s.toolNote}>
        {snapshots.length} snapshot{snapshots.length === 1 ? "" : "s"}
        {prevSnap && ` · last ${new Date(prevSnap.ts).toISOString().slice(0, 10)}`}
        {" · "}los precios expiran cada lunes · ▲▼ vs snapshot
      </span>
      <button onClick={() => loadSeed(Object.keys(prices).length > 0)} style={{ ...s.toolBtn, ...s.toolBtnGhost }}>Cargar / Reset datos</button>
    </div>
    )}

    {isMobile && (
      <div style={s.mLoadRow}>
        <button onClick={() => loadSeed(Object.keys(prices).length > 0)} style={s.toolBtn}>Cargar datos</button>
        <button onClick={saveSnapshot} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Guardar semana</button>
      </div>
    )}

    {Object.keys(prices).length === 0 && (
      <div style={s.loadBanner}>
        🔒 Los precios no están en el código (por seguridad). Poné la contraseña arriba y
        <button onClick={() => loadSeed(false)} style={{ ...s.toolBtn, marginLeft: 8 }}>Cargar datos</button>
      </div>
    )}

    {/* paste & parse (solo mobile; en desktop está en el chatbox de la derecha) */}
    {isMobile && (
    <section style={s.section}>
      <div style={s.sectionTitle}>PASTE &amp; PARSE — fill a supplier column from a messy quote</div>
      <div style={s.parseRow}>
        <select value={parseSupplier} onChange={(e) => setParseSupplier(e.target.value)} style={s.select}>
          {supplierList.map((sp) => <option key={sp} value={sp}>{sp}</option>)}
        </select>
        <textarea value={rawText} onChange={(e) => setRawText(e.target.value)} rows={2}
          placeholder='e.g. "S26 ultra 512gb 1020 · A07 4+128 94 · Negro Motorola G06 100"'
          style={s.parseArea} />
        <button onClick={() => runParse()} disabled={parsing} style={{ ...s.parseBtn, ...(parsing ? s.busy : {}) }}>
          {parsing ? "Parsing…" : `Parse → ${parseSupplier}`}
        </button>
        <label style={{ ...s.parseBtn, ...s.toolBtnGhost, ...(parsing ? s.busy : {}), cursor: parsing ? "default" : "pointer", display: "inline-flex", alignItems: "center" }} title="Subí un screenshot de la cotización — extrae precios y detecta modelos nuevos">
          📷 Foto
          <input type="file" accept="image/*" disabled={parsing} style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) runParse(f); e.target.value = ""; }} />
        </label>
      </div>
      {parseMsg && (
        <div style={parseMsg.err ? s.errorMsg : s.okMsg}>
          {parseMsg.text}
          {parseMsg.skus && parseMsg.skus.length > 0 && (
            <span style={s.okSkus}> ({parseMsg.skus.join(", ")})</span>
          )}
        </div>
      )}

    </section>
    )}

    {/* comparison table */}
    <section style={s.section}>
      <div style={s.tableBar}>
        <label style={s.hideToggle}>
          <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} style={s.chk} />
          Ocultar sin precio
          {hideEmpty && <span style={s.hideCount}> ({catalog.length - visibleCatalog.length})</span>}
        </label>
        <span style={s.markGroup}>
          <span style={s.hideCount}>Marcar:</span>
          <button onClick={selectAll} style={s.miniBtn}>Todo</button>
          <button onClick={selectPriced} style={s.miniBtn}>Con precio</button>
          <button onClick={selectNone} style={s.miniBtn}>Ninguno</button>
          <span style={s.hideCount}>{selectedSkus.length} marcado(s)</span>
        </span>
      </div>
      {isMobile ? (
        <table style={s.mTable}>
          <thead>
            <tr>
              <th style={{ ...s.mTh, textAlign: "left" }}>Modelo</th>
              <th style={{ ...s.mTh, width: 56 }}>Mín</th>
              <th style={{ ...s.mTh, width: 52 }}>Lista</th>
              <th style={{ ...s.mTh, width: 54, color: "#fbbf24" }}>+{marginNum}%</th>
            </tr>
          </thead>
          <tbody>
            {(() => { let lc = null; return visibleCatalog.map(({ name, cat }) => {
              const agg = aggBySku[name];
              const pmv = prevSnap ? supplierList.map((sp) => prevSnap.prices?.[name]?.[sp]).filter((x) => typeof x === "number") : [];
              const pMin = pmv.length ? Math.min(...pmv) : null;
              const mt = (agg.min != null && pMin != null && pMin !== agg.min) ? { up: agg.min > pMin, prev: pMin, diff: agg.min - pMin } : null;
              const header = cat !== lc ? ((lc = cat), (
                <tr key={"mc-" + cat}><td colSpan={4} style={s.mCat}>{cat}</td></tr>
              )) : null;
              return (
                <React.Fragment key={name}>
                  {header}
                  <tr>
                    <td style={s.mModel}>{name}</td>
                    <td style={s.mTd}>{agg.min != null ? "$" + Math.round(agg.min).toLocaleString() : "—"}{mt && <span style={mt.up ? s.trendUp : s.trendDown} title={`Mín semana pasada: $${Math.round(mt.prev)}`}> {mt.up ? "▲" : "▼"}{Math.abs(Math.round(mt.diff))}</span>}</td>
                    <td style={{ ...s.mTd, padding: 2 }}>
                      <input value={listaFor(name) ?? ""} onChange={(e) => setListaCell(name, e.target.value)} style={{ ...s.mLista, ...(lista[name] == null ? s.listaAuto : {}) }} inputMode="decimal" />
                    </td>
                    <td style={{ ...s.mTd, color: "#fbbf24", fontWeight: 600 }}>{agg.client != null ? "$" + Math.round(agg.client).toLocaleString() : "—"}</td>
                  </tr>
                </React.Fragment>
              );
            }); })()}
          </tbody>
        </table>
      ) : (<>
      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={{ ...s.th, ...s.thSku }}>SKU</th>
              {supplierList.map((sp) => <th key={sp} style={s.th}>{sp}</th>)}
              <th style={s.th}>Minimo</th>
              <th style={s.th}>Medio</th>
              <th style={s.th}>Lista</th>
              <th style={{ ...s.th, ...s.thMine }}>Client {marginNum}%</th>
            </tr>
          </thead>
          <tbody>
            {visibleCatalog.map(({ name, cat }) => {
              const agg = aggBySku[name];
              const spread = agg.min != null && agg.med != null && agg.min !== agg.med;
              const delta = spread ? agg.med - agg.min : 0;
              const prevMinVals = prevSnap ? supplierList.map((sp) => prevSnap.prices?.[name]?.[sp]).filter((x) => typeof x === "number") : [];
              const prevMin = prevMinVals.length ? Math.min(...prevMinVals) : null;
              const minTrend = (agg.min != null && prevMin != null && prevMin !== agg.min) ? { up: agg.min > prevMin, prev: prevMin, diff: agg.min - prevMin } : null;
              const header =
                cat !== lastCat ? ((lastCat = cat), (
                  <tr key={"cat-" + cat}>
                    <td colSpan={supplierList.length + 5} style={s.catRow}>{cat}</td>
                  </tr>
                )) : null;
              return (
                <React.Fragment key={name}>
                  {header}
                  <tr style={s.tr}>
                    <td style={{ ...s.td, ...s.tdSku }}>
                      <label style={s.skuLabel}>
                        <input type="checkbox" checked={!!selected[name]} onChange={() => toggleSelected(name)} style={s.chk} />
                        <span>{name}</span>
                      </label>
                    </td>
                    {supplierList.map((sp) => {
                      const v = prices[name]?.[sp];
                      const has = typeof v === "number";
                      const state = freshBySku[name]?.[sp]; // recent | updated | expired | undefined
                      const isFresh = state && state !== "expired";
                      const isBest = isFresh && agg.count > 0 && v === agg.min;
                      const isOut = isFresh && agg.outliers.has(sp);
                      let bg = null, inColor = null;
                      if (isOut) { bg = s.cellOut; inColor = s.inOut; }
                      else if (isBest && state === "recent") {
                        // recién actualizado Y mejor precio → media celda turquesa / media verde
                        bg = { background: "linear-gradient(135deg, #0e3536 0 47%, #0b0e14 47% 53%, #123a1d 53% 100%)" };
                        inColor = s.inBest;
                      }
                      else if (isBest) { bg = s.cellBest; inColor = s.inBest; } // mejor pero no recién → verde sólido
                      else if (state === "recent") { bg = s.cellRecent; inColor = s.inRecent; }
                      else if (state === "updated") { bg = s.cellUpdated; inColor = s.inUpdated; }
                      else if (state === "expired") { bg = s.cellExpired; inColor = s.inExpired; }
                      const prev = prevSnap?.prices?.[name]?.[sp];
                      let trend = null;
                      if (has && typeof prev === "number" && prev !== v)
                        trend = { up: v > prev, pct: ((v - prev) / prev) * 100, prev, diff: v - prev };
                      const title = [
                        state === "expired" && "Expirado — re-pedir",
                        state === "recent" && "Recién actualizado (24h)",
                        state === "updated" && "Actualizado este ciclo",
                        isOut && `Outlier — bajo la mediana ${money(agg.med)} (exceso de stock)`,
                        isBest && "Mejor precio (fresco)",
                      ].filter(Boolean).join(" · ") || undefined;
                      return (
                        <td key={sp} style={{ ...s.td, ...s.tdCell, ...(bg || {}) }} title={title}>
                          <span style={s.cellInner}>
                            {isOut && "🔥"}
                            <input
                              value={has ? v : ""}
                              onChange={(e) => setCell(name, sp, e.target.value)}
                              style={{ ...s.cellInput, ...(inColor || {}) }}
                              inputMode="decimal"
                            />
                            {trend && (
                              <span style={trend.up ? s.trendUp : s.trendDown}
                                title={`Semana pasada: $${Math.round(trend.prev)} → ahora $${Math.round(v)} (${trend.up ? "+" : "−"}${Math.abs(trend.pct).toFixed(0)}%)`}>
                                {trend.up ? "▲" : "▼"}{Math.abs(Math.round(trend.diff))}
                              </span>
                            )}
                          </span>
                        </td>
                      );
                    })}
                    <td style={{ ...s.td, ...s.tdNum }}>
                      {money(agg.min)}
                      {minTrend && <span style={minTrend.up ? s.trendUp : s.trendDown} title={`Mín semana pasada: $${Math.round(minTrend.prev)} → ahora $${Math.round(agg.min)}`}> {minTrend.up ? "▲" : "▼"}{Math.abs(Math.round(minTrend.diff))}</span>}
                    </td>
                    <td style={{ ...s.td, ...s.tdNum, ...s.tdMuted }}>
                      {money(agg.med)}
                      {spread && <span style={s.deltaTag} title={`Δ ${money(delta)} entre mínimo y medio`}> Δ{Math.round(delta)}</span>}
                    </td>
                    <td style={{ ...s.td, ...s.tdCell, ...(spread ? s.listaSpread : {}) }}
                      title={spread ? `Spread: mín ${money(agg.min)} / medio ${money(agg.med)} — conviene revisar Lista` : undefined}>
                      <input value={listaFor(name) ?? ""} onChange={(e) => setListaCell(name, e.target.value)}
                        title={lista[name] == null ? `Auto: Mín + ${marginNum}% (escribí para fijar un precio manual; borrá para volver al automático)` : "Precio manual (borrá para volver al automático)"}
                        style={{ ...s.cellInput, ...(spread ? s.listaInputSpread : {}), ...(lista[name] == null ? s.listaAuto : {}) }} inputMode="decimal" />
                    </td>
                    <td style={{ ...s.td, ...s.tdNum, ...s.tdMine }}
                      title={agg.bestIsOutlier ? `Outlier — priced from median ${money(agg.med)} × ${(1 + marginNum / 100).toFixed(3)}` : undefined}>
                      {agg.client != null ? <>{money(agg.client)}{agg.bestIsOutlier && <span style={s.medTag}> ·med</span>}</> : <span style={s.dash}>—</span>}
                    </td>
                  </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={s.legend}>
        <span><span style={{ ...s.legChip, ...s.cellRecent }} /> recién (24h)</span>
        <span><span style={{ ...s.legChip, ...s.cellUpdated }} /> actualizado</span>
        <span><span style={{ ...s.legChip, ...s.cellExpired }} /> expirado · re-pedir</span>
        <span><span style={{ ...s.legChip, ...s.cellBest }} /> mejor precio</span>
        <span><span style={{ ...s.legChip, background: "linear-gradient(135deg,#0e3536 0 47%,#0b0e14 47% 53%,#123a1d 53% 100%)" }} /> recién + mejor precio</span>
        <span><span style={{ ...s.legChip, ...s.cellOut }} /> 🔥 outlier (&gt;15% bajo mediana)</span>
        <span><span style={{ ...s.legChip, borderLeft: "3px solid #7c3aed", background: "#191526" }} /> Lista violeta = hay spread mín≠medio (revisar)</span>
        <span>expirados NO cuentan para Minimo/Medio/Client</span>
        <span><span style={s.trendUp}>▲</span>/<span style={s.trendDown}>▼</span> = cuánto subió/bajó vs la semana pasada (en $) · ·med = precio sobre mediana</span>
      </div>
      </>)}
    </section>

    {/* cotización al cliente (para WhatsApp) */}
    <section style={s.section}>
      <div style={s.sectionTitle}>COTIZACIÓN AL CLIENTE — {selectedSkus.length} modelo(s) marcado(s)</div>
      {selectedSkus.length === 0 ? (
        <div style={s.askHint}>Marcá con el checkbox (al lado de cada modelo en la tabla) lo que te pidió el cliente. Acá se arma el texto para WhatsApp.</div>
      ) : (
        <>
          <div style={s.quoteBar}>
            <div style={s.planTabs}>
              <button onClick={() => changeSource("lista")} style={{ ...s.planTab, ...(quoteSource === "lista" ? s.planTabOn : {}) }}>Desde Lista</button>
              <button onClick={() => changeSource("client")} style={{ ...s.planTab, ...(quoteSource === "client" ? s.planTabOn : {}) }}>Desde Client {marginNum}%</button>
            </div>
            <button onClick={() => setSelected({})} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Limpiar</button>
            <button onClick={copyQuote} style={s.copyBtn}>{copied ? "¡Copiado!" : "Copiar para WhatsApp"}</button>
          </div>

          <div style={s.quoteEditor}>
            {quoteGroups.map((g) => (
              <div key={g.cat} style={s.quoteGroup}>
                <div style={s.quoteGroupHead}>{g.cat}</div>
                {g.items.map((sku) => {
                  const edited = sku in quoteOverrides;
                  const base = baseQuotePrice(sku);
                  const val = edited ? quoteOverrides[sku] : base != null ? Math.round(base) : "";
                  return (
                    <div key={sku} style={s.quoteLine}>
                      <span style={s.quoteSku}>{sku}</span>
                      <span style={s.quotePriceWrap}>
                        $<input value={val} onChange={(e) => setOverride(sku, e.target.value)} style={s.quoteInput} inputMode="decimal" placeholder="—" />
                        {edited && <span style={s.ovTag} title="precio editado a mano">✎</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div style={s.quotePreviewLabel}>Vista previa (esto se copia):</div>
          <pre style={s.quotePreview}>{quoteText}</pre>
        </>
      )}
    </section>

    </div>
    </div>
  );
}
