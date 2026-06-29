import React, { useEffect, useMemo, useState } from "react";
import {
  CATALOG,
  SUPPLIERS,
  rowAggregates,
  classifyFreshness,
  mondayStart,
} from "./price-logic.js";
// Seed prices are NOT imported here — they're fetched from /api/data (password-gated)
// so the numbers never land in the public bundle.
import { pdf } from "@react-pdf/renderer";
import InvoiceDoc from "./InvoiceDoc.jsx";

/**
 * S26 Price Desk — supplier comparison + margin + dual input.
 *
 * Data + pricing logic live in ./price-logic.js (validated by seed-validation.test.mjs).
 * Inputs (your "mix of both"):
 *   - Direct entry: type prices straight into supplier cells (clean suppliers).
 *   - Paste & parse: paste a messy quote, Gemini fills that supplier's column.
 * Client price is outlier-aware: median base when the cheapest is a >15% dump.
 */

const GEMINI_MODEL = "gemini-2.5-flash";
const CATALOG_NAMES = CATALOG.map((c) => c.name);
const CATALOG_LINES = CATALOG.map((c) => `${c.name}  [${c.cat}]`);

// Shared disambiguation rules: section headers (EURO/LATIN) + base-variant hint.
const DISAMBIG =
  "If the text has section headers like EURO or LATIN, use them to disambiguate (EURO = the 'XT2xxx ...' models; LATIN = the 'Motorola ...' models). A bare base name like 'Edge 60' (no Neo/Fusion/Pro) means the base variant of that section.";

const PARSE_SYSTEM =
  "You are a price extraction assistant for a phone wholesaler. The user pastes ONE supplier's raw quote in any messy format (Spanish, colors, quantities, section headers). Extract the unit price per phone model and map each to the closest standard SKU from this EXACT list (category in brackets):\n" +
  CATALOG_LINES.join("\n") +
  "\n\nRules: ignore colors and quantities. " + DISAMBIG +
  ' Use the exact SKU string as the JSON key. Respond ONLY with a JSON object like {"S26 ULTRA 12/512GB 5G": 1020}. Omit only what you truly cannot map. No markdown, no commentary.';

const DESK_SYSTEM =
  "You are a trading-desk analyst for a phone wholesaler. Answer using ONLY the supplied JSON data: rows of {sku, cat, prices (per supplier, USD), min, median, client}, the margin %, and optionally a 'previous' snapshot. Be concise and quantitative, cite supplier names, and when asked about changes compare against 'previous'. If the data doesn't cover the question, say so plainly.";

const PRICES_KEY = "desk-prices-v1";
const LISTA_KEY = "desk-lista-v1";
const MARGIN_KEY = "desk-margin-v1";
const SNAP_KEY = "desk-snapshots-v1";
const TIMES_KEY = "desk-times-v1";
const CLIENTS_KEY = "desk-clients-v1";
const SHIPS_KEY = "desk-ships-v1";
const COMPANY = { name: "PHOTO IMAGEN & VIDEO EXPORT LLC" };

function fmtDMY(ts) { const d = new Date(ts); return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`; }
function today() { return fmtDMY(Date.now()); }
function blankClient() { return { id: "", name: "", address: "", ruc: "", phone: "" }; }
function blankShip() { return { id: "", label: "", notify: "", direccion: "", telefono: "", contacto: "" }; }

// Stamp every loaded cell at this cycle's Monday so it loads as "actualizado".
function timesForPrices(pricesObj) {
  const ts = mondayStart();
  const t = {};
  for (const sku of Object.keys(pricesObj)) {
    t[sku] = {};
    for (const sp of Object.keys(pricesObj[sku])) t[sku][sp] = ts;
  }
  return t;
}

const load = (k, fallback) => {
  try {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const money = (n) =>
  n == null || Number.isNaN(n)
    ? "—"
    : "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });

function stripFences(t) {
  let s = (t || "").trim();
  if (s.startsWith("```")) s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  return s;
}

// ---- Gemini ----
// In dev (npm run dev) `apiKey` is your Gemini key → call Google directly.
// In production (Vercel) `apiKey` is the app password → go through the
// /api/gemini proxy, where the real key lives server-side.
async function callGemini({ system, content, apiKey, maxTokens = 2048, json = false, images = [] }) {
  let data;
  if (import.meta.env.DEV) {
    const parts = [];
    for (const im of images) parts.push({ inline_data: { mime_type: im.mimeType, data: im.data } });
    if (content) parts.push({ text: content });
    const body = { contents: [{ role: "user", parts }], generationConfig: { temperature: 0, maxOutputTokens: maxTokens } };
    if (system) body.system_instruction = { parts: [{ text: system }] };
    if (json) body.generationConfig.responseMimeType = "application/json";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    );
    if (!res.ok) {
      let detail = "";
      try { const e = await res.json(); detail = e?.error?.message || JSON.stringify(e); } catch { detail = await res.text(); }
      throw new Error(`Gemini ${res.status}: ${detail}`);
    }
    data = await res.json();
  } else {
    const res = await fetch("/api/gemini", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-password": apiKey || "" },
      body: JSON.stringify({ system, content, images, json, maxTokens, model: GEMINI_MODEL }),
    });
    if (!res.ok) {
      let detail = "";
      try { const e = await res.json(); detail = e?.error?.message || e?.error || JSON.stringify(e); } catch { detail = await res.text(); }
      throw new Error(`Error ${res.status}: ${detail}`);
    }
    data = await res.json();
  }
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).join("");
}

async function parseSupplierQuote(rawText, apiKey) {
  const text = await callGemini({ system: PARSE_SYSTEM, content: rawText, apiKey, json: true });
  const parsed = JSON.parse(stripFences(text));
  const clean = {};
  for (const sku of CATALOG_NAMES) {
    const v = parsed[sku];
    const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.]/g, "")) : v;
    if (typeof n === "number" && !Number.isNaN(n)) clean[sku] = n;
  }
  return clean;
}

const MARK_SYSTEM =
  "El usuario manda una lista o screenshot de modelos a cotizar (texto libre, español, con precios, colores, cantidades o encabezados de sección). Devolvé SOLO un array JSON con los SKU EXACTOS de esta lista que correspondan (categoría entre corchetes):\n" +
  CATALOG_LINES.join("\n") +
  "\n\nReglas: ignorá precios, colores y cantidades. " + DISAMBIG +
  ' Omití solo lo que realmente no puedas mapear. Ejemplo: ["XT2505 Edge 60 8+256", "A17 4+128 DS"]. Sin markdown, sin texto extra.';

async function matchModels(text, apiKey, images = []) {
  const out = await callGemini({
    system: MARK_SYSTEM,
    content: text || "Extraé los modelos de la imagen (es un screenshot de una lista de modelos a cotizar).",
    apiKey,
    json: true,
    images,
  });
  const parsed = JSON.parse(stripFences(out));
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
    ? Object.values(parsed).find(Array.isArray) || []
    : [];
  return arr.filter((x) => CATALOG_NAMES.includes(x));
}

// ---- component ----
export default function PriceDesk() {
  const [apiKey, setApiKey] = useState(() => { try { return sessionStorage.getItem("desk-secret") || ""; } catch { return ""; } });
  useEffect(() => { try { sessionStorage.setItem("desk-secret", apiKey); } catch {} }, [apiKey]);
  const [margin, setMargin] = useState(() => load(MARGIN_KEY, 3));
  const [prices, setPrices] = useState(() => load(PRICES_KEY, {}));
  const [lista, setLista] = useState(() => load(LISTA_KEY, {}));
  const [times, setTimes] = useState(() => load(TIMES_KEY, {}));
  const [snapshots, setSnapshots] = useState(() => load(SNAP_KEY, []));
  const [listaPct, setListaPct] = useState(3); // % para el "pegar en Lista"

  // parse panel
  const [parseSupplier, setParseSupplier] = useState(SUPPLIERS[0]);
  const [rawText, setRawText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseMsg, setParseMsg] = useState(null);

  // cotizador — cotización al cliente
  const [selected, setSelected] = useState({}); // { sku: true }
  const [quoteSource, setQuoteSource] = useState("lista"); // "lista" | "client"
  const [quoteOverrides, setQuoteOverrides] = useState({}); // { sku: number }
  const [copied, setCopied] = useState(false);

  // vista (Mesa de precios / Órdenes)
  const [view, setView] = useState("mesa"); // "mesa" | "ordenes"

  // factura / remito
  const [clients, setClients] = useState(() => load(CLIENTS_KEY, []));
  const [clientForm, setClientForm] = useState(blankClient());
  const [shippings, setShippings] = useState(() => load(SHIPS_KEY, []));
  const [shipForm, setShipForm] = useState(blankShip());
  const [docType, setDocType] = useState("factura"); // "factura" | "remito"
  const [pdfBusy, setPdfBusy] = useState(false);
  const [orderQuery, setOrderQuery] = useState("");
  const [order, setOrder] = useState({
    items: [], invoiceNo: "2427", date: today(), payment: "W/T", fob: "Miami",
    salesperson: "", job: "", terms: "Due upon receipt", dueDate: today(), shippingCost: 0,
  });

  // ask the desk
  const [askMode, setAskMode] = useState("ask"); // "ask" | "mark"
  const [query, setQuery] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [answerErr, setAnswerErr] = useState(null);
  const [markMsg, setMarkMsg] = useState(null);

  useEffect(() => { try { localStorage.setItem(PRICES_KEY, JSON.stringify(prices)); } catch {} }, [prices]);
  useEffect(() => { try { localStorage.setItem(LISTA_KEY, JSON.stringify(lista)); } catch {} }, [lista]);
  useEffect(() => { try { localStorage.setItem(TIMES_KEY, JSON.stringify(times)); } catch {} }, [times]);
  useEffect(() => { try { localStorage.setItem(MARGIN_KEY, JSON.stringify(margin)); } catch {} }, [margin]);
  useEffect(() => { try { localStorage.setItem(SNAP_KEY, JSON.stringify(snapshots)); } catch {} }, [snapshots]);
  useEffect(() => { try { localStorage.setItem(CLIENTS_KEY, JSON.stringify(clients)); } catch {} }, [clients]);
  useEffect(() => { try { localStorage.setItem(SHIPS_KEY, JSON.stringify(shippings)); } catch {} }, [shippings]);

  const marginNum = parseFloat(margin) || 0;
  const prevSnap = snapshots.length ? snapshots[snapshots.length - 1] : null;

  function stampTimes(pairs) {
    // pairs: array of [sku, supplier]; null value => remove stamp
    setTimes((prev) => {
      const next = { ...prev };
      const now = Date.now();
      for (const [sku, sp, remove] of pairs) {
        next[sku] = { ...(next[sku] || {}) };
        if (remove) delete next[sku][sp];
        else next[sku][sp] = now;
      }
      return next;
    });
  }

  function setCell(sku, supplier, value) {
    const n = parseFloat(String(value).replace(/[^0-9.]/g, ""));
    const remove = value === "" || Number.isNaN(n);
    setPrices((prev) => {
      const next = { ...prev, [sku]: { ...(prev[sku] || {}) } };
      if (remove) delete next[sku][supplier];
      else next[sku][supplier] = n;
      return next;
    });
    stampTimes([[sku, supplier, remove]]);
  }
  function setListaCell(sku, value) {
    setLista((prev) => {
      const next = { ...prev };
      const n = parseFloat(String(value).replace(/[^0-9.]/g, ""));
      if (value === "" || Number.isNaN(n)) delete next[sku];
      else next[sku] = n;
      return next;
    });
  }

  async function runParse() {
    if (!apiKey.trim()) { setParseMsg({ err: true, text: "Enter your Gemini API key first." }); return; }
    if (!rawText.trim()) { setParseMsg({ err: true, text: "Paste a quote to parse." }); return; }
    setParsing(true);
    setParseMsg(null);
    try {
      const map = await parseSupplierQuote(rawText, apiKey.trim());
      const keys = Object.keys(map);
      setPrices((prev) => {
        const next = { ...prev };
        for (const sku of keys) next[sku] = { ...(next[sku] || {}), [parseSupplier]: map[sku] };
        return next;
      });
      stampTimes(keys.map((sku) => [sku, parseSupplier, false]));
      setParseMsg({
        err: false,
        text: `Filled ${keys.length} SKU${keys.length === 1 ? "" : "s"} for ${parseSupplier}.`,
        skus: keys,
      });
    } catch (e) {
      setParseMsg({ err: true, text: e.message });
    } finally {
      setParsing(false);
    }
  }

  function saveSnapshot() {
    setSnapshots((s) => [...s, { ts: Date.now(), prices: clone(prices) }].slice(-52));
  }
  // Fetch the seed prices/lista from the server (password-gated) and load them.
  async function loadSeed(confirmOverwrite) {
    if (confirmOverwrite && !confirm("¿Cargar datos del servidor y sobrescribir lo actual?")) return;
    try {
      const res = await fetch("/api/data", { headers: { "x-app-password": apiKey || "" } });
      if (!res.ok) {
        let m = res.status; try { m = (await res.json()).error || m; } catch {}
        alert("No pude cargar los datos: " + m + " (¿contraseña correcta?)");
        return;
      }
      const { prices: sp, lista: sl } = await res.json();
      setPrices(sp || {});
      setLista(sl || {});
      setTimes(timesForPrices(sp || {}));
    } catch (e) {
      alert("Error cargando datos: " + e.message);
    }
  }
  function resetToSeed() { loadSeed(true); }

  // Bulk-fill Lista = Minimo + listaPct% for rows with a fresh min (mini reset).
  function fillLista() {
    const pct = parseFloat(listaPct) || 0;
    if (!confirm(`¿Pegar Mínimo + ${pct}% en la columna Lista? (sobrescribe las filas con precio fresco)`)) return;
    setLista((prev) => {
      const next = { ...prev };
      for (const { name } of CATALOG) {
        const a = rowAggregates(
          Object.fromEntries(
            SUPPLIERS.map((sp) => [sp, prices[name]?.[sp]]).filter(
              ([sp, v]) => typeof v === "number" && classifyFreshness(times[name]?.[sp], Date.now()) !== "expired"
            )
          ),
          marginNum
        );
        if (a.min != null) next[name] = Math.round(a.min * (1 + pct / 100));
      }
      return next;
    });
  }

  // Mark every current price as expired (e.g. it's a new Monday — re-request all).
  function expireAll() {
    if (!confirm("Mark all current prices as expired? (a previous-cycle timestamp)")) return;
    const past = mondayStart() - 24 * 60 * 60 * 1000; // last Sunday => before this cycle
    setTimes(() => {
      const t = {};
      for (const sku of Object.keys(prices))
        for (const sp of Object.keys(prices[sku] || {})) {
          t[sku] = t[sku] || {};
          t[sku][sp] = past;
        }
      return t;
    });
  }

  // per-row: classify each cell's freshness, then aggregate over NON-expired only
  // (so Minimo/Medio/Client and "best" can never come from an expired price).
  const now = Date.now();
  const { aggBySku, freshBySku } = useMemo(() => {
    const agg = {}, fresh = {};
    for (const { name } of CATALOG) {
      const fr = {};
      const freshPrices = {};
      for (const sp of SUPPLIERS) {
        const v = prices[name]?.[sp];
        if (typeof v !== "number") continue;
        const st = classifyFreshness(times[name]?.[sp], now);
        fr[sp] = st;
        if (st !== "expired") freshPrices[sp] = v;
      }
      fresh[name] = fr;
      agg[name] = rowAggregates(freshPrices, marginNum);
    }
    return { aggBySku: agg, freshBySku: fresh };
  }, [prices, times, marginNum, now]);


  // ---- cotizador (client quote) ----
  function toggleSelected(sku) {
    setSelected((p) => { const n = { ...p }; if (n[sku]) delete n[sku]; else n[sku] = true; return n; });
  }
  function changeSource(src) { setQuoteSource(src); setQuoteOverrides({}); } // switching resets manual edits
  function setOverride(sku, v) {
    setQuoteOverrides((p) => {
      const n = { ...p };
      const x = parseFloat(String(v).replace(/[^0-9.]/g, ""));
      if (v === "" || Number.isNaN(x)) delete n[sku]; else n[sku] = x;
      return n;
    });
  }
  const baseQuotePrice = (sku) => (quoteSource === "lista" ? lista[sku] : aggBySku[sku]?.client);
  const selectedSkus = CATALOG.filter((c) => selected[c.name]).map((c) => c.name);

  // selected models grouped by catalog category (catalog order)
  const quoteGroups = useMemo(() => {
    const groups = [];
    let cur = null;
    for (const { name, cat } of CATALOG) {
      if (!selected[name]) continue;
      if (!cur || cur.cat !== cat) { cur = { cat, items: [] }; groups.push(cur); }
      cur.items.push(name);
    }
    return groups;
  }, [selected]);

  // WhatsApp-ready text: "Categoria\nModelo\t$Precio", groups blank-line separated
  const quoteText = useMemo(() => {
    const priceOf = (sku) =>
      sku in quoteOverrides ? quoteOverrides[sku] : quoteSource === "lista" ? lista[sku] : aggBySku[sku]?.client;
    return quoteGroups
      .map((g) => {
        const lines = g.items.map((sku) => {
          const p = priceOf(sku);
          return `${sku}\t${p == null ? "—" : "$" + Math.round(p)}`;
        });
        return `${g.cat}\n${lines.join("\n")}`;
      })
      .join("\n\n");
  }, [quoteGroups, quoteSource, quoteOverrides, lista, aggBySku]);

  async function copyQuote() {
    try {
      await navigator.clipboard.writeText(quoteText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — user can copy from the preview box */ }
  }

  // ---- factura / remito ----
  function setClientField(k, v) { setClientForm((p) => ({ ...p, [k]: v })); }
  function loadClient(id) { const c = clients.find((x) => x.id === id); setClientForm(c ? { ...c } : blankClient()); }
  function saveClient() {
    if (!clientForm.name.trim()) return;
    setClients((prev) => {
      if (clientForm.id) return prev.map((c) => (c.id === clientForm.id ? clientForm : c));
      const nc = { ...clientForm, id: "cl" + Date.now() };
      setClientForm(nc);
      return [...prev, nc];
    });
  }
  function deleteClient() {
    if (!clientForm.id) return;
    setClients((prev) => prev.filter((c) => c.id !== clientForm.id));
    setClientForm(blankClient());
  }
  // shipping book (separate from client)
  function setShipField(k, v) { setShipForm((p) => ({ ...p, [k]: v })); }
  function loadShip(id) { const sh = shippings.find((x) => x.id === id); setShipForm(sh ? { ...sh } : blankShip()); }
  function saveShip() {
    if (!shipForm.label.trim() && !shipForm.notify.trim()) return;
    setShippings((prev) => {
      if (shipForm.id) return prev.map((x) => (x.id === shipForm.id ? shipForm : x));
      const ns = { ...shipForm, id: "sh" + Date.now() };
      setShipForm(ns);
      return [...prev, ns];
    });
  }
  function deleteShip() {
    if (!shipForm.id) return;
    setShippings((prev) => prev.filter((x) => x.id !== shipForm.id));
    setShipForm(blankShip());
  }
  function importMarked() {
    const skus = CATALOG.filter((c) => selected[c.name]).map((c) => c.name);
    setOrder((p) => {
      const have = new Set(p.items.map((i) => i.sku));
      const add = skus.filter((sk) => !have.has(sk)).map((sk) => ({ sku: sk, qty: 1, price: lista[sk] ?? aggBySku[sk]?.client ?? 0 }));
      return { ...p, items: [...p.items, ...add] };
    });
  }
  function setOrderField(k, v) { setOrder((p) => ({ ...p, [k]: v })); }
  function addOrderItem(sku) {
    if (!CATALOG_NAMES.includes(sku)) return;
    setOrder((p) => p.items.some((i) => i.sku === sku) ? p
      : { ...p, items: [...p.items, { sku, qty: 1, price: lista[sku] ?? aggBySku[sku]?.client ?? 0 }] });
    setOrderQuery("");
  }
  function setItem(idx, k, v) {
    setOrder((p) => ({
      ...p,
      items: p.items.map((it, i) => i === idx
        ? { ...it, [k]: k === "sku" ? v : (parseFloat(String(v).replace(/[^0-9.]/g, "")) || 0) }
        : it),
    }));
  }
  function removeItem(idx) { setOrder((p) => ({ ...p, items: p.items.filter((_, i) => i !== idx) })); }
  const clientForPdf = {
    name: clientForm.name, ruc: clientForm.ruc, phone: clientForm.phone,
    addressLines: (clientForm.address || "").split("\n").map((x) => x.trim()).filter(Boolean),
    notify: shipForm.notify, direccion: shipForm.direccion, telefono: shipForm.telefono, contacto: shipForm.contacto,
  };
  const orderPiezas = order.items.reduce((a, i) => a + (Number(i.qty) || 0), 0);
  const orderSubtotal = order.items.reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);

  // Generate the PDF only on click (not on every render) — avoids saturating the browser.
  async function downloadDoc() {
    setPdfBusy(true);
    try {
      const blob = await pdf(
        <InvoiceDoc company={COMPANY} client={clientForPdf} order={order} mode={docType} />
      ).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${docType}-${order.invoiceNo}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      alert("Error generando el PDF: " + (e?.message || e));
    } finally {
      setPdfBusy(false);
    }
  }

  async function askDesk() {
    if (!apiKey.trim()) { setAnswerErr("Enter your Gemini API key first."); return; }
    if (!query.trim()) return;
    setAsking(true); setAnswerErr(null);
    try {
      const rows = CATALOG.map(({ name, cat }) => {
        const a = aggBySku[name];
        return { sku: name, cat, prices: prices[name] || {}, min: a.min, median: a.med, client: a.client };
      }).filter((r) => r.min != null);
      const previous = prevSnap
        ? { date: new Date(prevSnap.ts).toISOString().slice(0, 10), prices: prevSnap.prices }
        : null;
      const content =
        JSON.stringify({ margin_pct: marginNum, rows, previous }) + "\n\nQuestion: " + query;
      const text = await callGemini({ system: DESK_SYSTEM, content, apiKey: apiKey.trim(), maxTokens: 1024 });
      setAnswer(text);
    } catch (e) {
      setAnswerErr(e.message);
    } finally {
      setAsking(false);
    }
  }

  async function runMark() {
    if (!apiKey.trim()) { setMarkMsg({ err: true, text: "Cargá la API key de Gemini primero." }); return; }
    if (!query.trim()) return;
    setAsking(true); setMarkMsg(null);
    try {
      const skus = await matchModels(query.trim(), apiKey.trim());
      if (!skus.length) {
        setMarkMsg({ err: false, text: "No reconocí modelos del catálogo en ese texto." });
      } else {
        setSelected((prev) => { const n = { ...prev }; for (const sk of skus) n[sk] = true; return n; });
        setMarkMsg({ err: false, text: `Marqué ${skus.length}: ${skus.join(", ")}` });
      }
    } catch (e) {
      setMarkMsg({ err: true, text: e.message });
    } finally {
      setAsking(false);
    }
  }

  function submitAsk() { askMode === "ask" ? askDesk() : runMark(); }

  function fileToData(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const res = String(r.result);
        resolve({ mimeType: file.type || "image/png", data: res.slice(res.indexOf(",") + 1) });
      };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  async function markFromImage(file) {
    if (!file) return;
    if (!apiKey.trim()) { setMarkMsg({ err: true, text: "Cargá la API key de Gemini primero." }); return; }
    setAsking(true); setMarkMsg(null);
    try {
      const img = await fileToData(file);
      const skus = await matchModels(query.trim(), apiKey.trim(), [img]);
      if (!skus.length) {
        setMarkMsg({ err: false, text: "No reconocí modelos del catálogo en la imagen." });
      } else {
        setSelected((prev) => { const n = { ...prev }; for (const sk of skus) n[sk] = true; return n; });
        setMarkMsg({ err: false, text: `📷 Marqué ${skus.length}: ${skus.join(", ")}` });
      }
    } catch (e) {
      setMarkMsg({ err: true, text: e.message });
    } finally {
      setAsking(false);
    }
  }

  function onAskPaste(e) {
    if (askMode !== "mark") return;
    for (const it of e.clipboardData?.items || []) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); markFromImage(f); return; }
      }
    }
  }

  const s = styles;
  let lastCat = null;

  return (
    <div style={s.app}>
      <header style={s.header}>
        <div>
          <div style={s.title}>PRICE DESK</div>
          <div style={s.subtitle}>{CATALOG.length} SKUs · {SUPPLIERS.length} suppliers · supplier comparison · adjustable margin</div>
        </div>
        <div style={s.controls}>
          <div style={s.mondayBadge}>
            <span style={s.ctrlText}>ÚLTIMO LUNES</span>
            <span style={s.mondayDate}>{fmtDMY(mondayStart())}</span>
          </div>
          <label style={s.ctrlLabel}>
            <span style={s.ctrlText}>{import.meta.env.DEV ? "GEMINI KEY" : "CONTRASEÑA"}</span>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder={import.meta.env.DEV ? "AI Studio key…" : "contraseña…"} style={{ ...s.input, width: 170 }} />
          </label>
          <label style={s.ctrlLabel}>
            <span style={s.ctrlText}>MARGIN %</span>
            <input type="number" value={margin} onChange={(e) => setMargin(e.target.value)}
              step="0.5" style={{ ...s.input, width: 64, textAlign: "right" }} />
          </label>
        </div>
      </header>

      <div style={s.viewNav}>
        <button onClick={() => setView("mesa")} style={{ ...s.viewTab, ...(view === "mesa" ? s.viewTabOn : {}) }}>📊 Mesa de precios</button>
        <button onClick={() => setView("ordenes")} style={{ ...s.viewTab, ...(view === "ordenes" ? s.viewTabOn : {}) }}>🧾 Órdenes · factura / remito</button>
      </div>

      {view === "mesa" && (<>
      {/* toolbar */}
      <div style={s.toolbar}>
        <button onClick={saveSnapshot} style={s.toolBtn}>Save snapshot</button>
        <button onClick={expireAll} style={s.toolBtn}>Expirar todo (lunes)</button>
        <span style={s.listaFill}>
          Lista = Mín +
          <input type="number" value={listaPct} onChange={(e) => setListaPct(e.target.value)} step="0.5" style={s.listaPctInput} />
          %
          <button onClick={fillLista} style={s.toolBtn}>Pegar en Lista</button>
        </span>
        <span style={s.toolNote}>
          {snapshots.length} snapshot{snapshots.length === 1 ? "" : "s"}
          {prevSnap && ` · last ${new Date(prevSnap.ts).toISOString().slice(0, 10)}`}
          {" · "}los precios expiran cada lunes · ▲▼ vs snapshot
        </span>
        <button onClick={() => loadSeed(Object.keys(prices).length > 0)} style={{ ...s.toolBtn, ...s.toolBtnGhost }}>Cargar / Reset datos</button>
      </div>

      {Object.keys(prices).length === 0 && (
        <div style={s.loadBanner}>
          🔒 Los precios no están en el código (por seguridad). Poné la contraseña arriba y
          <button onClick={() => loadSeed(false)} style={{ ...s.toolBtn, marginLeft: 8 }}>Cargar datos</button>
        </div>
      )}

      {/* paste & parse */}
      <section style={s.section}>
        <div style={s.sectionTitle}>PASTE &amp; PARSE — fill a supplier column from a messy quote</div>
        <div style={s.parseRow}>
          <select value={parseSupplier} onChange={(e) => setParseSupplier(e.target.value)} style={s.select}>
            {SUPPLIERS.map((sp) => <option key={sp} value={sp}>{sp}</option>)}
          </select>
          <textarea value={rawText} onChange={(e) => setRawText(e.target.value)} rows={2}
            placeholder='e.g. "S26 ultra 512gb 1020 · A07 4+128 94 · Negro Motorola G06 100"'
            style={s.parseArea} />
          <button onClick={runParse} disabled={parsing} style={{ ...s.parseBtn, ...(parsing ? s.busy : {}) }}>
            {parsing ? "Parsing…" : `Parse → ${parseSupplier}`}
          </button>
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

      {/* comparison table */}
      <section style={s.section}>
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={{ ...s.th, ...s.thSku }}>SKU</th>
                {SUPPLIERS.map((sp) => <th key={sp} style={s.th}>{sp}</th>)}
                <th style={s.th}>Minimo</th>
                <th style={s.th}>Medio</th>
                <th style={s.th}>Lista</th>
                <th style={{ ...s.th, ...s.thMine }}>Client {marginNum}%</th>
              </tr>
            </thead>
            <tbody>
              {CATALOG.map(({ name, cat }) => {
                const agg = aggBySku[name];
                const spread = agg.min != null && agg.med != null && agg.min !== agg.med;
                const delta = spread ? agg.med - agg.min : 0;
                const header =
                  cat !== lastCat ? ((lastCat = cat), (
                    <tr key={"cat-" + cat}>
                      <td colSpan={SUPPLIERS.length + 5} style={s.catRow}>{cat}</td>
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
                      {SUPPLIERS.map((sp) => {
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
                          trend = { up: v > prev, pct: ((v - prev) / prev) * 100 };
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
                                <span style={trend.up ? s.trendUp : s.trendDown}>
                                  {trend.up ? "▲" : "▼"}{Math.abs(trend.pct).toFixed(0)}
                                </span>
                              )}
                            </span>
                          </td>
                        );
                      })}
                      <td style={{ ...s.td, ...s.tdNum }}>{money(agg.min)}</td>
                      <td style={{ ...s.td, ...s.tdNum, ...s.tdMuted }}>
                        {money(agg.med)}
                        {spread && <span style={s.deltaTag} title={`Δ ${money(delta)} entre mínimo y medio`}> Δ{Math.round(delta)}</span>}
                      </td>
                      <td style={{ ...s.td, ...s.tdCell, ...(spread ? s.listaSpread : {}) }}
                        title={spread ? `Spread: mín ${money(agg.min)} / medio ${money(agg.med)} — conviene revisar Lista` : undefined}>
                        <input value={lista[name] ?? ""} onChange={(e) => setListaCell(name, e.target.value)}
                          style={{ ...s.cellInput, ...(spread ? s.listaInputSpread : {}) }} inputMode="decimal" />
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
          <span><span style={s.trendUp}>▲</span>/<span style={s.trendDown}>▼</span> vs snapshot · ·med = precio sobre mediana</span>
        </div>
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

      </>)}

      {view === "ordenes" && (
      <section style={s.section}>
        <div style={s.sectionTitle}>ÓRDENES — Factura / Remito</div>
        <div style={s.planTabs}>
          <button onClick={() => setDocType("factura")} style={{ ...s.planTab, ...(docType === "factura" ? s.planTabOn : {}) }}>Factura (con precios)</button>
          <button onClick={() => setDocType("remito")} style={{ ...s.planTab, ...(docType === "remito" ? s.planTabOn : {}) }}>Remito (sin precios)</button>
        </div>

        <div style={s.invGrid}>
          <div style={s.invCol}>
            <div style={s.invColHead}>CLIENTE (opcional)</div>
            <select value={clientForm.id} onChange={(e) => loadClient(e.target.value)} style={s.invInput}>
              <option value="">— nuevo / sin cliente —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input placeholder="Nombre" value={clientForm.name} onChange={(e) => setClientField("name", e.target.value)} style={s.invInput} />
            <textarea placeholder="Dirección (varias líneas)" value={clientForm.address} onChange={(e) => setClientField("address", e.target.value)} rows={2} style={s.invArea} />
            <input placeholder="RUC" value={clientForm.ruc} onChange={(e) => setClientField("ruc", e.target.value)} style={s.invInput} />
            <input placeholder="Teléfono" value={clientForm.phone} onChange={(e) => setClientField("phone", e.target.value)} style={s.invInput} />
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <button onClick={saveClient} style={s.toolBtn}>{clientForm.id ? "Actualizar" : "Guardar"} cliente</button>
              {clientForm.id && <button onClick={deleteClient} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Borrar</button>}
            </div>
          </div>

          <div style={s.invCol}>
            <div style={s.invColHead}>ENVÍO / SHIPPING (opcional)</div>
            <select value={shipForm.id} onChange={(e) => loadShip(e.target.value)} style={s.invInput}>
              <option value="">— nuevo / sin envío —</option>
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
            <div style={s.invColHead}>DATOS</div>
            <div style={s.invFields}>
              {[["invoiceNo", "Invoice #"], ["date", "Date"], ["payment", "Payment"], ["fob", "FOB"], ["salesperson", "Salesperson"], ["terms", "Payment Terms"], ["dueDate", "Due Date"]].map(([k, lbl]) => (
                <label style={s.invField} key={k}>
                  <span style={s.invFieldLbl}>{lbl}</span>
                  <input value={order[k]} onChange={(e) => setOrderField(k, e.target.value)} style={s.invInput} />
                </label>
              ))}
              {docType === "factura" && (
                <label style={s.invField}>
                  <span style={s.invFieldLbl}>Shipping $</span>
                  <input value={order.shippingCost} onChange={(e) => setOrderField("shippingCost", e.target.value)} style={s.invInput} />
                </label>
              )}
            </div>
          </div>
        </div>

        <div style={{ ...s.invColHead, marginTop: 10 }}>ITEMS</div>
        <div style={s.cotInputRow}>
          <input list="catalog-dl" value={orderQuery}
            onChange={(e) => { const v = e.target.value; setOrderQuery(v); if (CATALOG_NAMES.includes(v)) addOrderItem(v); }}
            onKeyDown={(e) => { if (e.key === "Enter") { const m = CATALOG_NAMES.find((n) => n.toLowerCase() === orderQuery.trim().toLowerCase()); if (m) addOrderItem(m); } }}
            placeholder="Agregar modelo (Enter)…" style={s.cotSearch} />
          <datalist id="catalog-dl">{CATALOG.map((c) => <option key={c.name} value={c.name} />)}</datalist>
          <button onClick={importMarked} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }} title="Traer los modelos tildados en la cotización de la Mesa">Traer marcados</button>
        </div>

        {order.items.length > 0 && (
          <table style={s.invTable}>
            <thead>
              <tr>
                <th style={s.invTh}>Qty</th>
                <th style={{ ...s.invTh, textAlign: "left" }}>Descripción</th>
                {docType === "factura" && <th style={s.invTh}>Precio</th>}
                {docType === "factura" && <th style={s.invTh}>Line Total</th>}
                <th style={s.invTh}></th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((it, idx) => (
                <tr key={idx}>
                  <td style={s.invTd}><input value={it.qty} onChange={(e) => setItem(idx, "qty", e.target.value)} style={{ ...s.cellInput, width: 50, border: "1px solid #232a3a" }} /></td>
                  <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4" }}>{it.sku}</td>
                  {docType === "factura" && <td style={s.invTd}><input value={it.price} onChange={(e) => setItem(idx, "price", e.target.value)} style={{ ...s.cellInput, width: 70, border: "1px solid #232a3a" }} /></td>}
                  {docType === "factura" && <td style={{ ...s.invTd, color: "#fbbf24" }}>{money((Number(it.qty) || 0) * (Number(it.price) || 0))}</td>}
                  <td style={s.invTd}><span style={s.chipX} onClick={() => removeItem(idx)}>×</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={s.invFoot}>
          <span>Total piezas: <b>{orderPiezas}</b>{docType === "factura" && <> · Subtotal: <b style={{ color: "#fbbf24" }}>{money(orderSubtotal)}</b></>}</span>
          {order.items.length > 0
            ? <button onClick={downloadDoc} disabled={pdfBusy} style={{ ...s.pdfBtn, ...(pdfBusy ? s.busy : {}), border: "none", cursor: pdfBusy ? "default" : "pointer" }}>
                {pdfBusy ? "Generando…" : `⬇ Descargar ${docType} PDF`}
              </button>
            : <span style={s.askHint}>Agregá al menos un item para generar (cliente y envío son opcionales).</span>}
        </div>
      </section>

      )}

      {view === "mesa" && (<>
      {/* ask the desk */}
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
              ? "ej. ¿Dónde está más competitivo VITEL? ¿Qué cambió vs el último snapshot?"
              : "Pegá modelos o un screenshot (Ctrl+V)… (ej. G15, A17 4+128, Motorola G86 PWR)"}
            style={s.askInput} />
          {askMode === "mark" && (
            <label style={s.imgBtn} title="Subir screenshot (OCR con Gemini)">
              📷 Imagen
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
          : <div style={s.askHint}>Responde estricto sobre la tabla actual (y tu último snapshot, si hay).</div>)}
        {askMode === "mark" && (markMsg
          ? <div style={markMsg.err ? s.errorMsg : s.okMsg}>{markMsg.text}</div>
          : <div style={s.askHint}>Escribí/pegá una lista, pegá un screenshot (Ctrl+V) o usá 📷 Imagen; Gemini lee y tilda los modelos del catálogo (se suman a lo ya marcado).</div>)}
      </section>
      </>)}
    </div>
  );
}

const styles = {
  app: { background: "#0b0e14", color: "#d6dae3", minHeight: "100vh", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12.5, padding: "16px 20px 48px", boxSizing: "border-box" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "1px solid #1c2230", paddingBottom: 12, marginBottom: 10, flexWrap: "wrap", gap: 12 },
  title: { fontSize: 18, fontWeight: 700, letterSpacing: 1.5, color: "#e8ecf3" },
  subtitle: { fontSize: 11, color: "#6b7385", marginTop: 2 },
  controls: { display: "flex", gap: 14, alignItems: "flex-end" },
  ctrlLabel: { display: "flex", flexDirection: "column", gap: 4 },
  ctrlText: { fontSize: 10, color: "#6b7385", letterSpacing: 1 },
  mondayBadge: { display: "flex", flexDirection: "column", gap: 4, background: "#11151f", border: "1px solid #244068", borderRadius: 4, padding: "4px 10px" },
  mondayDate: { fontSize: 15, fontWeight: 700, color: "#6fa8e6", fontVariantNumeric: "tabular-nums" },
  input: { background: "#11151f", border: "1px solid #232a3a", color: "#e8ecf3", padding: "6px 8px", borderRadius: 4, fontFamily: "inherit", fontSize: 13, outline: "none" },
  toolbar: { display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" },
  toolBtn: { background: "#1f2937", border: "1px solid #2a3346", color: "#cfd6e4", padding: "5px 12px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 12 },
  toolBtnGhost: { marginLeft: "auto", color: "#b06a72", borderColor: "#3a1d22", background: "transparent" },
  toolNote: { fontSize: 10.5, color: "#6b7385" },
  loadBanner: { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", background: "#13233a", border: "1px solid #244068", color: "#cfd6e4", borderRadius: 6, padding: "8px 12px", marginBottom: 16, fontSize: 12 },
  listaFill: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "#9aa3b5" },
  listaPctInput: { width: 44, background: "#0b0e14", border: "1px solid #232a3a", color: "#e8ecf3", borderRadius: 3, textAlign: "right", fontFamily: "inherit", fontSize: 11, padding: "2px 4px", outline: "none" },
  deltaTag: { color: "#a78bfa", fontSize: 9, marginLeft: 2 },
  listaSpread: { borderLeft: "2px solid #7c3aed", background: "#191526" },
  listaInputSpread: { color: "#c4b5fd" },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 11, letterSpacing: 1.2, color: "#6b7385", marginBottom: 8, fontWeight: 600 },
  parseRow: { display: "flex", gap: 8, alignItems: "stretch" },
  select: { background: "#11151f", border: "1px solid #232a3a", color: "#e8ecf3", borderRadius: 4, padding: "0 8px", fontFamily: "inherit", fontSize: 12.5, outline: "none" },
  parseArea: { flex: 1, background: "#0b0e14", border: "1px solid #232a3a", color: "#cfd6e4", borderRadius: 4, padding: 8, fontFamily: "inherit", fontSize: 12, resize: "vertical", outline: "none", lineHeight: 1.5 },
  parseBtn: { background: "#2563eb", border: "none", color: "#fff", padding: "0 16px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" },
  busy: { background: "#374151", cursor: "default" },
  okMsg: { fontSize: 11.5, color: "#4ade80", marginTop: 8 },
  okSkus: { color: "#6b7385" },
  errorMsg: { fontSize: 11.5, color: "#f87171", background: "#1a1014", border: "1px solid #3a1d22", borderRadius: 4, padding: "5px 7px", marginTop: 8, wordBreak: "break-word" },
  tableWrap: { overflowX: "auto", border: "1px solid #1c2230", borderRadius: 6, maxHeight: "70vh", overflowY: "auto" },
  table: { borderCollapse: "collapse", width: "100%", minWidth: 880 },
  th: { background: "#11151f", color: "#8b94a7", fontSize: 10.5, fontWeight: 600, textAlign: "right", padding: "8px 8px", borderBottom: "1px solid #1c2230", whiteSpace: "nowrap", position: "sticky", top: 0, zIndex: 1 },
  thSku: { textAlign: "left", position: "sticky", left: 0, zIndex: 2 },
  thMine: { color: "#fbbf24" },
  tr: { borderBottom: "1px solid #151a26" },
  td: { padding: "3px 8px", borderBottom: "1px solid #151a26", whiteSpace: "nowrap" },
  tdSku: { textAlign: "left", color: "#cfd6e4", fontWeight: 600, position: "sticky", left: 0, background: "#0b0e14", zIndex: 1 },
  tdCell: { padding: "2px 4px" },
  tdNum: { textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#cfd6e4" },
  tdMuted: { color: "#7b8499" },
  tdMine: { color: "#fbbf24", fontWeight: 700, background: "#15130a", textAlign: "right" },
  catRow: { background: "#0e1218", color: "#8b94a7", fontSize: 10.5, fontWeight: 700, letterSpacing: 1, padding: "5px 8px", textTransform: "uppercase", position: "sticky", left: 0 },
  cellInner: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2 },
  cellInput: { width: 58, background: "transparent", border: "1px solid transparent", color: "#cfd6e4", textAlign: "right", fontFamily: "inherit", fontSize: 12, padding: "3px 4px", borderRadius: 3, outline: "none", fontVariantNumeric: "tabular-nums" },
  // cell backgrounds by freshness / role
  cellBest: { background: "#0f2a17" },                          // mejor precio (verde)
  cellOut: { background: "#2a2410" },                           // outlier (amarillo)
  cellRecent: { background: "#0b2f30" },                        // recién (turquesa)
  cellUpdated: { background: "#10203a" },                       // actualizado (azul)
  cellExpired: { background: "#2a1117" },                       // expirado (rojo)
  // matching input text colors
  inBest: { color: "#4ade80", fontWeight: 700 },
  inOut: { color: "#fbbf24", fontWeight: 700 },
  inRecent: { color: "#6ee7d6" },
  inUpdated: { color: "#9fb4dc" },
  inExpired: { color: "#a86b72" },
  legChip: { display: "inline-block", width: 11, height: 11, borderRadius: 2, marginRight: 4, verticalAlign: "-1px" },
  trendUp: { color: "#f87171", fontSize: 9 },
  trendDown: { color: "#4ade80", fontSize: 9 },
  medTag: { fontSize: 9, color: "#a87f2a" },
  dash: { color: "#3b4252" },
  legend: { display: "flex", gap: 16, flexWrap: "wrap", fontSize: 10, color: "#6b7385", marginTop: 8, alignItems: "center" },
  legBest: { display: "inline-block", width: 10, height: 10, background: "#0f2a17", border: "1px solid #4ade80", borderRadius: 2, marginRight: 4, verticalAlign: "-1px" },
  legOut: { display: "inline-block", width: 10, height: 10, background: "#2a2410", border: "1px solid #fbbf24", borderRadius: 2, marginRight: 4, verticalAlign: "-1px" },
  scoreboard: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10 },
  scoreCard: { background: "#11151f", border: "1px solid #1c2230", borderRadius: 6, padding: 12 },
  scoreLeader: { borderColor: "#16a34a", background: "#0e1a12" },
  scoreName: { fontSize: 12, color: "#cfd6e4", fontWeight: 600 },
  scoreWins: { fontSize: 26, fontWeight: 700, color: "#e8ecf3", lineHeight: 1.1 },
  scoreTrack: { height: 5, background: "#1c2230", borderRadius: 3, overflow: "hidden", marginTop: 6 },
  scoreFill: { height: "100%", borderRadius: 3 },
  skuLabel: { display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" },
  chk: { accentColor: "#3b82f6", cursor: "pointer", width: 13, height: 13 },
  quoteBar: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" },
  copyBtn: { marginLeft: "auto", background: "#16a34a", border: "none", color: "#fff", padding: "7px 16px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600 },
  quoteEditor: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12, marginBottom: 14 },
  quoteGroup: { background: "#11151f", border: "1px solid #1c2230", borderRadius: 6, padding: 10 },
  quoteGroupHead: { fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#8b94a7", textTransform: "uppercase", borderBottom: "1px solid #1c2230", paddingBottom: 6, marginBottom: 6 },
  quoteLine: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "2px 0", fontSize: 11.5 },
  quoteSku: { color: "#cfd6e4" },
  quotePriceWrap: { display: "inline-flex", alignItems: "center", gap: 3, color: "#fbbf24", fontWeight: 700 },
  quoteInput: { width: 56, background: "#0b0e14", border: "1px solid #232a3a", color: "#fbbf24", textAlign: "right", fontFamily: "inherit", fontSize: 12, fontWeight: 700, padding: "2px 5px", borderRadius: 3, outline: "none", fontVariantNumeric: "tabular-nums" },
  ovTag: { color: "#6b7385", fontSize: 10 },
  quotePreviewLabel: { fontSize: 10.5, color: "#6b7385", marginBottom: 4 },
  quotePreview: { background: "#0b0e14", border: "1px solid #232a3a", borderRadius: 6, padding: 12, fontFamily: "inherit", fontSize: 12.5, color: "#dfe4ee", lineHeight: 1.6, whiteSpace: "pre-wrap", margin: 0, overflowX: "auto" },
  viewNav: { display: "flex", gap: 8, marginBottom: 16 },
  viewTab: { background: "#11151f", border: "1px solid #232a3a", color: "#9aa3b5", padding: "9px 18px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 },
  viewTabOn: { background: "#1e293b", borderColor: "#3b82f6", color: "#e8ecf3" },
  invGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14, marginBottom: 6 },
  invCol: { display: "flex", flexDirection: "column", gap: 5 },
  invColHead: { fontSize: 10, fontWeight: 700, letterSpacing: 1, color: "#6b7385" },
  invInput: { background: "#11151f", border: "1px solid #232a3a", color: "#e8ecf3", padding: "6px 8px", borderRadius: 4, fontFamily: "inherit", fontSize: 12, outline: "none" },
  invArea: { background: "#0b0e14", border: "1px solid #232a3a", color: "#cfd6e4", padding: "6px 8px", borderRadius: 4, fontFamily: "inherit", fontSize: 12, outline: "none", resize: "vertical", lineHeight: 1.4 },
  invFields: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 },
  invField: { display: "flex", flexDirection: "column", gap: 3 },
  invFieldLbl: { fontSize: 9.5, color: "#6b7385" },
  invTable: { borderCollapse: "collapse", width: "100%", marginTop: 8, border: "1px solid #1c2230" },
  invTh: { background: "#11151f", color: "#8b94a7", fontSize: 10, fontWeight: 600, textAlign: "right", padding: "6px 8px", borderBottom: "1px solid #1c2230" },
  invTd: { padding: "3px 8px", textAlign: "right", borderBottom: "1px solid #151a26", fontVariantNumeric: "tabular-nums" },
  invFoot: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, flexWrap: "wrap", gap: 10, fontSize: 12, color: "#cfd6e4" },
  pdfBtn: { background: "#16a34a", color: "#fff", padding: "8px 18px", borderRadius: 4, fontSize: 12.5, fontWeight: 600, textDecoration: "none", fontFamily: "inherit" },
  cotInputRow: { display: "flex", gap: 8, alignItems: "center", marginBottom: 10 },
  cotSearch: { flex: 1, maxWidth: 360, background: "#11151f", border: "1px solid #232a3a", color: "#e8ecf3", padding: "8px 10px", borderRadius: 4, fontFamily: "inherit", fontSize: 13, outline: "none" },
  chips: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 },
  chip: { display: "inline-flex", alignItems: "center", gap: 6, background: "#11151f", border: "1px solid #232a3a", borderRadius: 14, padding: "3px 6px 3px 10px", fontSize: 11.5, color: "#cfd6e4" },
  chipQty: { width: 38, background: "#0b0e14", border: "1px solid #232a3a", color: "#cfd6e4", borderRadius: 3, textAlign: "right", fontFamily: "inherit", fontSize: 11, padding: "1px 4px", outline: "none" },
  chipX: { cursor: "pointer", color: "#8b94a7", fontSize: 14, lineHeight: 1, padding: "0 2px" },
  planBar: { display: "flex", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" },
  planTabs: { display: "flex", gap: 6 },
  planTab: { background: "#11151f", border: "1px solid #232a3a", color: "#9aa3b5", padding: "6px 12px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 11.5 },
  planTabOn: { background: "#1e293b", borderColor: "#3b82f6", color: "#e8ecf3", fontWeight: 600 },
  planDelta: { fontSize: 10.5, color: "#6b7385" },
  planCards: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 },
  planCard: { background: "#11151f", border: "1px solid #1c2230", borderRadius: 6, padding: 10 },
  planCardHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "1px solid #1c2230", paddingBottom: 6, marginBottom: 6 },
  planSupplier: { fontSize: 13, fontWeight: 700, color: "#e8ecf3" },
  planSub: { fontSize: 10.5, color: "#6b7385" },
  planItem: { display: "flex", justifyContent: "space-between", gap: 8, padding: "2px 0", fontSize: 11.5 },
  planItemSku: { color: "#cfd6e4" },
  planQ: { color: "#6b7385" },
  planItemPrice: { color: "#cfd6e4", fontVariantNumeric: "tabular-nums" },
  staleTag: { color: "#fbbf24" },
  planFoot: { display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", marginTop: 10, fontSize: 11.5, color: "#cfd6e4" },
  uncoverable: { color: "#f87171" },
  planNote: { fontSize: 10, color: "#525a6b" },
  modeTabs: { display: "flex", gap: 6, marginBottom: 8 },
  askRow: { display: "flex", gap: 8, alignItems: "stretch" },
  imgBtn: { display: "inline-flex", alignItems: "center", background: "#1f2937", border: "1px solid #2a3346", color: "#cfd6e4", padding: "0 14px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 12, whiteSpace: "nowrap" },
  askInput: { flex: 1, background: "#11151f", border: "1px solid #232a3a", color: "#e8ecf3", padding: "9px 11px", borderRadius: 4, fontFamily: "inherit", fontSize: 13, outline: "none" },
  askBtn: { background: "#7c3aed", border: "none", color: "#fff", padding: "0 22px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 },
  askHint: { fontSize: 10.5, color: "#525a6b", marginTop: 8 },
  answerCard: { background: "#11151f", border: "1px solid #1c2230", borderRadius: 6, padding: 12, marginTop: 10, fontSize: 13, color: "#dfe4ee", lineHeight: 1.6, whiteSpace: "pre-wrap" },
};
