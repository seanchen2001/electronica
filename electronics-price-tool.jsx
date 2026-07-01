import React, { useEffect, useMemo, useRef, useState } from "react";
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
import InvoiceDoc, { RemitosDoc } from "./InvoiceDoc.jsx";

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
// Categorías válidas para nuevos modelos.
const CATEGORIES = ["Samsung", "Motorola LATIN", "Motorola EURO"];

// Shared disambiguation rules: section headers (EURO/LATIN) + base-variant hint.
const DISAMBIG =
  "If the text has section headers like EURO or LATIN, use them to disambiguate (EURO = the 'XT2xxx ...' models; LATIN = the 'Motorola ...' models). A bare base name like 'Edge 60' (no Neo/Fusion/Pro) means the base variant of that section.";

// Prompts se construyen del catálogo (dinámico). El parser devuelve {matched, new}:
// matched = SKU existente -> precio; new = modelos que no están en el catálogo.
function buildParseSystem(lines) {
  return (
    "You are a price extraction assistant for a phone wholesaler. The user pastes ONE supplier's raw quote (Spanish, messy, with quantities/colors/section headers). Map each model to the closest standard SKU from this EXACT list (category in brackets):\n" +
    lines.join("\n") +
    "\n\nRules:\n- Ignore colors.\n" +
    "- If a model lists several prices by quantity (a price ladder, e.g. a base price for '150+ PCS' plus cheaper ones for 20/50+ units), take the HIGHEST price (the worst / most conservative — the base price for the smallest quantity).\n- " + DISAMBIG +
    "\n- For models that clearly do NOT match any SKU in the list, do NOT force them. Put them under \"new\" with a normalized name in the SAME naming style as the list, a category (one of: Samsung, Motorola LATIN, Motorola EURO), and the price (same highest-price rule).\n" +
    'Respond ONLY with JSON: {"matched": {"<exact SKU from the list>": price, ...}, "new": [{"name": "...", "cat": "...", "price": N}, ...]}. No markdown, no commentary.'
  );
}

function buildMarkSystem(lines) {
  return (
    "El usuario manda una lista o screenshot de modelos a cotizar (texto libre, español, con precios/colores/cantidades/encabezados). Devolvé SOLO un array JSON con los SKU EXACTOS de esta lista que correspondan (categoría entre corchetes):\n" +
    lines.join("\n") +
    "\n\nReglas: ignorá precios, colores y cantidades. " + DISAMBIG +
    ' Omití solo lo que realmente no puedas mapear. Ejemplo: ["XT2505 Edge 60 8+256", "A17 4+128 DS"]. Sin markdown, sin texto extra.'
  );
}

const DESK_SYSTEM =
  "You are a trading-desk analyst for a phone wholesaler. Answer using ONLY the supplied JSON data: rows of {sku, cat, prices (per supplier, USD), min, median, client}, the margin %, and optionally a 'previous' snapshot. Be concise and quantitative, cite supplier names, and when asked about changes compare against 'previous'. If the data doesn't cover the question, say so plainly.";

const PRICES_KEY = "desk-prices-v1";
const LISTA_KEY = "desk-lista-v1";
const MARGIN_KEY = "desk-margin-v1";
const SNAP_KEY = "desk-snapshots-v1";
const TIMES_KEY = "desk-times-v1";
const CLIENTS_KEY = "desk-clients-v1";
const SHIPS_KEY = "desk-ships-v1";
const HIST_KEY = "desk-invoices-v1";
const CAT_KEY = "desk-extra-catalog-v1";
const LEDGER_KEY = "desk-ledger-v1";
const SUPP_KEY = "desk-suppliers-v1";

function nextInvoiceNo(hist) {
  const nums = (hist || []).map((h) => parseInt(h.no, 10)).filter((n) => !Number.isNaN(n));
  return nums.length ? Math.max(...nums) + 1 : 2427;
}
const COMPANY = { name: "PHOTO IMAGEN & VIDEO EXPORT LLC" };
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function fmtDMY(ts) { const d = new Date(ts); return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`; }
function today() { return fmtDMY(Date.now()); }

// Un snapshot por semana (lunes del ciclo). Guardar de nuevo en la misma semana
// pisa el anterior → queda "el último precio de la semana". Mantiene ~2 años.
function upsertWeekly(snaps, prices, lista) {
  const week = mondayStart();
  const entry = { week, ts: Date.now(), prices: JSON.parse(JSON.stringify(prices)), lista: JSON.parse(JSON.stringify(lista)) };
  const i = snaps.findIndex((sn) => sn.week === week);
  const next = i >= 0 ? snaps.map((sn, k) => (k === i ? entry : sn)) : [...snaps, entry];
  return next.slice(-104);
}
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
    const body = { contents: [{ role: "user", parts }], generationConfig: { temperature: 0, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } } };
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

const toNum = (v) => {
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.]/g, "")) : v;
  return typeof n === "number" && !Number.isNaN(n) ? n : null;
};

async function parseSupplierQuote(rawText, apiKey, system, names, images = []) {
  const content = rawText || (images.length ? "Extraé los precios de este screenshot de la cotización del proveedor." : "");
  const text = await callGemini({ system, content, apiKey, json: true, images, maxTokens: 8192 });
  let parsed;
  try { parsed = JSON.parse(stripFences(text)); }
  catch { throw new Error("La respuesta se cortó o vino mal formada (lista muy larga). Probá con menos modelos o de a partes."); }
  const matchedRaw = parsed.matched && typeof parsed.matched === "object" ? parsed.matched : parsed;
  const matched = {};
  for (const sku of names) { const n = toNum(matchedRaw[sku]); if (n != null) matched[sku] = n; }
  const known = new Set(names);
  const newModels = (Array.isArray(parsed.new) ? parsed.new : [])
    .map((m) => ({ name: String(m?.name || "").trim(), cat: m?.cat || "Samsung", price: toNum(m?.price) }))
    .filter((m) => m.name && !known.has(m.name));
  return { matched, newModels };
}

async function matchModels(text, apiKey, system, names, images = []) {
  const out = await callGemini({
    system,
    content: text || "Extraé los modelos de la imagen (es un screenshot de una lista de modelos a cotizar).",
    apiKey,
    json: true,
    images,
    maxTokens: 8192,
  });
  let parsed;
  try { parsed = JSON.parse(stripFences(out)); }
  catch { throw new Error("La respuesta se cortó (lista/imagen muy larga). Probá con menos modelos."); }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
    ? Object.values(parsed).find(Array.isArray) || []
    : [];
  return arr.filter((x) => names.includes(x));
}

// ---- component ----
export default function PriceDesk() {
  const [apiKey, setApiKey] = useState(() => { try { return sessionStorage.getItem("desk-secret") || ""; } catch { return ""; } });
  useEffect(() => { try { sessionStorage.setItem("desk-secret", apiKey); } catch {} }, [apiKey]);
  const [margin, setMargin] = useState(() => load(MARGIN_KEY, 3));
  const [hideEmpty, setHideEmpty] = useState(false); // ocultar modelos sin precio esta semana
  // catálogo dinámico: base (fijo) + modelos agregados por el usuario
  const [extraCatalog, setExtraCatalog] = useState(() => load(CAT_KEY, []));
  // proveedores editables (sembrados de la constante, se pueden agregar/sacar)
  const [supplierList, setSupplierList] = useState(() => load(SUPP_KEY, SUPPLIERS));
  const [newSupplier, setNewSupplier] = useState("");
  const catalog = useMemo(() => [...CATALOG, ...extraCatalog], [extraCatalog]);
  const catalogNames = useMemo(() => catalog.map((c) => c.name), [catalog]);
  const parseSystem = useMemo(() => buildParseSystem(catalog.map((c) => `${c.name}  [${c.cat}]`)), [catalog]);
  const markSystem = useMemo(() => buildMarkSystem(catalog.map((c) => `${c.name}  [${c.cat}]`)), [catalog]);
  const [pendingNew, setPendingNew] = useState([]); // sugerencias de modelos nuevos a confirmar
  const [prices, setPrices] = useState(() => load(PRICES_KEY, {}));
  const [lista, setLista] = useState(() => load(LISTA_KEY, {}));
  const [times, setTimes] = useState(() => load(TIMES_KEY, {}));
  const [snapshots, setSnapshots] = useState(() => load(SNAP_KEY, []));

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
  const [invoiceHistory, setInvoiceHistory] = useState(() => load(HIST_KEY, []));
  const [ledger, setLedger] = useState(() => load(LEDGER_KEY, [])); // cuentas corrientes (movimientos)
  const [ledgerSide, setLedgerSide] = useState("client"); // "client" | "supplier"
  const [payForm, setPayForm] = useState({ party: "", amount: "", concept: "", date: today(), type: "pago" });
  const [docType, setDocType] = useState("factura"); // "factura" | "remito"
  const [pdfBusy, setPdfBusy] = useState(false);
  const [orderQuery, setOrderQuery] = useState("");
  const [order, setOrder] = useState({
    items: [], invoiceNo: String(nextInvoiceNo(load(HIST_KEY, []))), date: today(), payment: "W/T", fob: "Miami",
    salesperson: "", job: "", terms: "Due upon receipt", dueDate: today(), shippingCost: 0,
  });
  const [orderClientId, setOrderClientId] = useState(""); // selección en Órdenes
  const [orderShipId, setOrderShipId] = useState("");

  // móvil → layout compacto / AI-focus
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 720px)");
    const fn = (e) => setIsMobile(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  // ask the desk
  const [askMode, setAskMode] = useState("ask"); // "ask" | "mark" (mobile)
  // chatbox unificado (desktop): un solo input, el AI descubre el intent (o selector manual)
  const [chatText, setChatText] = useState("");
  const [chatMode, setChatMode] = useState("auto"); // "auto" | "ask" | "parse" | "mark"
  const [chatOpen, setChatOpen] = useState(true);
  const [chatNote, setChatNote] = useState(null); // {err, text} — feedback del ruteo de intent
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
  useEffect(() => { try { localStorage.setItem(HIST_KEY, JSON.stringify(invoiceHistory)); } catch {} }, [invoiceHistory]);
  useEffect(() => { try { localStorage.setItem(CAT_KEY, JSON.stringify(extraCatalog)); } catch {} }, [extraCatalog]);
  useEffect(() => { try { localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger)); } catch {} }, [ledger]);
  useEffect(() => { try { localStorage.setItem(SUPP_KEY, JSON.stringify(supplierList)); } catch {} }, [supplierList]);

  // ---- sync con la base (Supabase, opcional) ----
  const dbReady = useRef(false);
  const dbOn = useRef(false);
  const storeLoaded = useRef(false);
  const saveTimers = useRef({});

  async function pushStore(key, value) {
    try {
      await fetch("/api/store", {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-password": apiKey || "" },
        body: JSON.stringify({ key, value }),
      });
    } catch { /* ignore */ }
  }

  async function loadStore({ skipObjects = false } = {}) {
    try {
      const r = await fetch("/api/store", { headers: { "x-app-password": apiKey || "" } });
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.configured) {
        dbOn.current = true;
        // DB con datos -> manda la DB. DB vacía pero hay local -> migrar local a la DB.
        const resolve = (dbVal, localVal, key) => {
          if (Array.isArray(dbVal) && dbVal.length) return dbVal;
          if (Array.isArray(localVal) && localVal.length) pushStore(key, localVal);
          return localVal;
        };
        // objetos (prices/times/lista): la DB manda si tiene datos; si está vacía pero hay local, migramos
        const resolveObj = (dbVal, localVal, key) => {
          if (dbVal && typeof dbVal === "object" && Object.keys(dbVal).length) return dbVal;
          if (localVal && Object.keys(localVal).length) pushStore(key, localVal);
          return localVal;
        };
        setClients((c) => resolve(d.clients, c, "clients"));
        setShippings((sh) => resolve(d.shippings, sh, "shippings"));
        setInvoiceHistory((h) => resolve(d.invoices, h, "invoices"));
        setSnapshots((sn) => resolve(d.snapshots, sn, "snapshots"));
        setExtraCatalog((c) => resolve(d.catalog, c, "catalog"));
        setLedger((lg) => resolve(d.ledger, lg, "ledger"));
        setSupplierList((sl) => resolve(d.suppliers, sl, "suppliers"));
        if (!skipObjects) {
          setPrices((p) => resolveObj(d.prices, p, "prices"));
          setTimes((t) => resolveObj(d.times, t, "times"));
          setLista((l) => resolveObj(d.lista, l, "lista"));
        }
      }
    } catch { /* sin DB / dev -> seguimos con localStorage */ }
    finally { dbReady.current = true; }
  }

  function syncUp(key, value) {
    if (!dbReady.current || !dbOn.current) return;
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => {
      fetch("/api/store", {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-password": apiKey || "" },
        body: JSON.stringify({ key, value }),
      }).catch(() => {});
    }, 800);
  }

  useEffect(() => { if (apiKey && !storeLoaded.current) { storeLoaded.current = true; loadStore(); } }, [apiKey]);
  useEffect(() => { syncUp("clients", clients); }, [clients]);
  useEffect(() => { syncUp("shippings", shippings); }, [shippings]);
  useEffect(() => { syncUp("invoices", invoiceHistory); }, [invoiceHistory]);
  useEffect(() => { syncUp("snapshots", snapshots); }, [snapshots]);
  useEffect(() => { syncUp("catalog", extraCatalog); }, [extraCatalog]);
  useEffect(() => { syncUp("prices", prices); }, [prices]);
  useEffect(() => { syncUp("times", times); }, [times]);
  useEffect(() => { syncUp("lista", lista); }, [lista]);
  useEffect(() => { syncUp("ledger", ledger); }, [ledger]);
  useEffect(() => { syncUp("suppliers", supplierList); }, [supplierList]);
  // auto-guardar el snapshot de la semana actual unos segundos después de editar precios
  const weekTimer = useRef();
  useEffect(() => {
    if (!Object.keys(prices).length) return;
    clearTimeout(weekTimer.current);
    weekTimer.current = setTimeout(() => setSnapshots((s) => upsertWeekly(s, prices, lista)), 3000);
    return () => clearTimeout(weekTimer.current);
  }, [prices, lista]);

  const marginNum = parseFloat(margin) || 0;
  // semana anterior (para el trend ▲▼): el snapshot más reciente de una semana previa
  const prevSnap = useMemo(() => {
    const cur = mondayStart();
    const prior = snapshots.filter((sn) => (sn.week ?? 0) < cur).sort((a, b) => (b.week ?? b.ts) - (a.week ?? a.ts));
    return prior[0] || null;
  }, [snapshots]);

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

  async function runParse(file = null, textArg = null, supplierArg = null) {
    const text = textArg ?? rawText;
    const supplier = supplierArg ?? parseSupplier;
    if (!apiKey.trim()) { setParseMsg({ err: true, text: "Enter your Gemini API key first." }); return; }
    if (!text.trim() && !file) { setParseMsg({ err: true, text: "Pegá una cotización o subí una foto." }); return; }
    if (!supplier) { setParseMsg({ err: true, text: "Elegí a qué proveedor cargar la cotización." }); return; }
    setParsing(true);
    setParseMsg(null);
    try {
      const images = file ? [await fileToData(file)] : [];
      const { matched, newModels } = await parseSupplierQuote(text, apiKey.trim(), parseSystem, catalogNames, images);
      const keys = Object.keys(matched);
      setPrices((prev) => {
        const next = { ...prev };
        for (const sku of keys) next[sku] = { ...(next[sku] || {}), [supplier]: matched[sku] };
        return next;
      });
      stampTimes(keys.map((sku) => [sku, supplier, false]));
      if (textArg == null) setRawText("");
      // modelos nuevos → a la cola de confirmación (con el proveedor de origen)
      const adds = newModels
        .filter((m) => !pendingNew.some((p) => p.name === m.name))
        .map((m) => ({ ...m, supplier }));
      if (adds.length) setPendingNew((p) => [...p, ...adds]);
      setParseMsg({
        err: false,
        text: `Cargué ${keys.length} SKU${keys.length === 1 ? "" : "s"} para ${supplier}${adds.length ? ` · ${adds.length} modelo(s) nuevo(s) → revisalos en el modal` : ""}.`,
        skus: keys,
      });
    } catch (e) {
      setParseMsg({ err: true, text: e.message });
    } finally {
      setParsing(false);
    }
  }

  // confirmar / descartar un modelo nuevo sugerido
  function confirmNew(idx) {
    const m = pendingNew[idx];
    if (!m || !m.name.trim()) return;
    setExtraCatalog((c) => (c.some((x) => x.name === m.name) || CATALOG.some((x) => x.name === m.name) ? c : [...c, { name: m.name.trim(), cat: CATEGORIES.includes(m.cat) ? m.cat : "Samsung" }]));
    if (m.price != null) {
      setPrices((prev) => ({ ...prev, [m.name]: { ...(prev[m.name] || {}), [m.supplier]: m.price } }));
      stampTimes([[m.name, m.supplier, false]]);
    }
    setPendingNew((p) => p.filter((_, i) => i !== idx));
  }
  function dismissNew(idx) { setPendingNew((p) => p.filter((_, i) => i !== idx)); }
  function editNew(idx, k, v) { setPendingNew((p) => p.map((m, i) => (i === idx ? { ...m, [k]: k === "price" ? v : v } : m))); }

  function saveSnapshot() {
    setSnapshots((s) => upsertWeekly(s, prices, lista));
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
      loadStore({ skipObjects: true }); // traer clientes / envíos / historial; NO pisar el seed recién cargado
    } catch (e) {
      alert("Error cargando datos: " + e.message);
    }
  }
  function resetToSeed() { loadSeed(true); }

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
    for (const { name } of catalog) {
      const fr = {};
      const freshPrices = {};
      const allVals = [];
      for (const sp of supplierList) {
        const v = prices[name]?.[sp];
        if (typeof v !== "number") continue;
        allVals.push(v);
        const st = classifyFreshness(times[name]?.[sp], now);
        fr[sp] = st;
        if (st !== "expired") freshPrices[sp] = v;
      }
      fresh[name] = fr;
      agg[name] = rowAggregates(freshPrices, marginNum);
      agg[name].minAny = allVals.length ? Math.min(...allVals) : null; // incluye expirados (fallback)
      // si toda la fila está expirada, el precio Client (+%) igual se muestra en vivo desde el último mínimo conocido
      if (agg[name].client == null && agg[name].minAny != null) {
        agg[name].client = Math.round(agg[name].minAny * (1 + marginNum / 100));
        agg[name].clientStale = true;
      }
    }
    return { aggBySku: agg, freshBySku: fresh };
  }, [prices, times, marginNum, now, catalog, supplierList]);

  // Precio de Lista (venta) de una fila: override manual si lo hay; si no, Mín + MARGIN% en vivo.
  // Prefiere el mínimo fresco; si está todo expirado, cae al último mínimo conocido.
  function listaFor(name) {
    if (lista[name] != null) return lista[name];
    const base = aggBySku[name]?.min ?? aggBySku[name]?.minAny;
    return base != null ? Math.round(base * (1 + marginNum / 100)) : null;
  }

  // catálogo a mostrar (oculta los sin precio fresco si el toggle está activo)
  const visibleCatalog = useMemo(
    () => (hideEmpty ? catalog.filter((c) => aggBySku[c.name]?.min != null) : catalog),
    [catalog, aggBySku, hideEmpty]
  );


  // ---- cotizador (client quote) ----
  function toggleSelected(sku) {
    setSelected((p) => { const n = { ...p }; if (n[sku]) delete n[sku]; else n[sku] = true; return n; });
  }
  function selectAll() { setSelected(Object.fromEntries(catalog.map((c) => [c.name, true]))); }
  function selectPriced() { setSelected(Object.fromEntries(catalog.filter((c) => aggBySku[c.name]?.min != null).map((c) => [c.name, true]))); }
  function selectNone() { setSelected({}); }
  function changeSource(src) { setQuoteSource(src); setQuoteOverrides({}); } // switching resets manual edits
  function setOverride(sku, v) {
    setQuoteOverrides((p) => {
      const n = { ...p };
      const x = parseFloat(String(v).replace(/[^0-9.]/g, ""));
      if (v === "" || Number.isNaN(x)) delete n[sku]; else n[sku] = x;
      return n;
    });
  }
  const baseQuotePrice = (sku) => (quoteSource === "lista" ? listaFor(sku) : aggBySku[sku]?.client);
  const selectedSkus = catalog.filter((c) => selected[c.name]).map((c) => c.name);

  // selected models grouped by catalog category (catalog order)
  const quoteGroups = useMemo(() => {
    const groups = [];
    let cur = null;
    for (const { name, cat } of catalog) {
      if (!selected[name]) continue;
      if (!cur || cur.cat !== cat) { cur = { cat, items: [] }; groups.push(cur); }
      cur.items.push(name);
    }
    return groups;
  }, [selected, catalog]);

  // WhatsApp-ready text: "Categoria\nModelo\t$Precio", groups blank-line separated
  const quoteText = useMemo(() => {
    const priceOf = (sku) =>
      sku in quoteOverrides ? quoteOverrides[sku] : quoteSource === "lista" ? listaFor(sku) : aggBySku[sku]?.client;
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
  function addSupplier() {
    const name = newSupplier.trim();
    if (!name) return;
    setSupplierList((l) => (l.includes(name) ? l : [...l, name]));
    setNewSupplier("");
  }
  function removeSupplier(name) {
    if (!confirm(`¿Sacar el proveedor "${name}"? Sus precios quedan guardados pero deja de mostrarse la columna.`)) return;
    setSupplierList((l) => l.filter((s) => s !== name));
    setParseSupplier((p) => (p === name ? "" : p));
  }
  function importMarked() {
    const skus = catalog.filter((c) => selected[c.name]).map((c) => c.name);
    setOrder((p) => {
      const have = new Set(p.items.map((i) => i.sku));
      const add = skus.filter((sk) => !have.has(sk)).map((sk) => newOrderLine(sk));
      return { ...p, items: [...p.items, ...add] };
    });
  }
  function setOrderField(k, v) { setOrder((p) => ({ ...p, [k]: v })); }
  // proveedor más barato (cualquier precio conocido) para sembrar la línea
  function cheapestSupplier(sku) {
    const row = prices[sku] || {};
    let best = "", bv = Infinity;
    for (const [sp, v] of Object.entries(row)) if (typeof v === "number" && v < bv) { bv = v; best = sp; }
    return best;
  }
  // una línea de orden: qty, color, spec (EURO/LATIN), proveedor (de dónde se compra) + su costo, y price (lo que se factura al cliente)
  function specForCat(cat) { return cat === "Motorola LATIN" ? "LATIN" : cat === "Motorola EURO" ? "EURO" : ""; }
  function newOrderLine(sku) {
    const sup = cheapestSupplier(sku);
    const cat = catalog.find((c) => c.name === sku)?.cat || "";
    return { sku, cat, qty: 1, color: "", spec: specForCat(cat), supplier: sup, cost: prices[sku]?.[sup] ?? 0, price: listaFor(sku) ?? aggBySku[sku]?.client ?? 0 };
  }
  // splitear una línea en varios colores: duplica la fila (qty 1, color en blanco para llenar)
  function splitItem(idx) {
    setOrder((p) => {
      const items = [...p.items];
      items.splice(idx + 1, 0, { ...p.items[idx], qty: 1, color: "" });
      return { ...p, items };
    });
  }
  function addOrderItem(sku) {
    if (!catalogNames.includes(sku)) return;
    setOrder((p) => p.items.some((i) => i.sku === sku) ? p
      : { ...p, items: [...p.items, newOrderLine(sku)] });
    setOrderQuery("");
  }
  const NUMERIC_ITEM = new Set(["qty", "price", "cost"]);
  function setItem(idx, k, v) {
    setOrder((p) => ({
      ...p,
      items: p.items.map((it, i) => i === idx
        ? { ...it, [k]: NUMERIC_ITEM.has(k) ? (parseFloat(String(v).replace(/[^0-9.]/g, "")) || 0) : v }
        : it),
    }));
  }
  // cambiar de proveedor: setea proveedor y trae su costo (el "precio alt")
  function setItemSupplier(idx, supplier) {
    setOrder((p) => ({
      ...p,
      items: p.items.map((it, i) => i === idx
        ? { ...it, supplier, cost: prices[it.sku]?.[supplier] ?? it.cost ?? 0 }
        : it),
    }));
  }
  function removeItem(idx) { setOrder((p) => ({ ...p, items: p.items.filter((_, i) => i !== idx) })); }
  const selClient = clients.find((c) => c.id === orderClientId) || blankClient();
  const selShip = shippings.find((sh) => sh.id === orderShipId) || blankShip();
  const clientAddrLines = (selClient.address || "").split("\n").map((x) => x.trim()).filter(Boolean);
  // dirección de envío para el remito: el Envío seleccionado y, si está vacío, la dirección del cliente
  const shipInfo = {
    notify: selShip.notify,
    direccion: selShip.direccion || clientAddrLines.join(", "),
    telefono: selShip.telefono || selClient.phone,
    contacto: selShip.contacto,
  };
  const clientForPdf = {
    name: selClient.name, ruc: selClient.ruc, phone: selClient.phone,
    addressLines: clientAddrLines,
    ...shipInfo,
  };
  const orderPiezas = order.items.reduce((a, i) => a + (Number(i.qty) || 0), 0);
  const orderSubtotal = order.items.reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
  const orderCost = order.items.reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.cost) || 0), 0);

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
      // log al historial = base de datos de la transacción completa (+ autoincremento del invoice #)
      const totalDoc = orderSubtotal + (Number(order.shippingCost) || 0);
      const supplierCosts = {};
      for (const { supplier, items } of remitoGroups) {
        if (supplier === "(sin proveedor)") continue;
        supplierCosts[supplier] = items.reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.cost) || 0), 0);
      }
      setInvoiceHistory((h) => [{
        no: order.invoiceNo, date: order.date, type: docType,
        client: selClient.name || "—", clientId: orderClientId,
        piezas: orderPiezas, subtotal: orderSubtotal, shipping: Number(order.shippingCost) || 0,
        total: totalDoc, cost: orderCost, margin: orderSubtotal - orderCost,
        supplierCosts, items: JSON.parse(JSON.stringify(order.items)),
        // datos para regenerar cualquier PDF desde el Historial
        order: JSON.parse(JSON.stringify(order)), clientPdf: clientForPdf, ts: Date.now(),
      }, ...h].slice(0, 1000));
      if (docType === "factura") {
        // las cuentas (cargo al cliente + compra a cada proveedor) se DERIVAN del historial.
        setOrderField("invoiceNo", String((parseInt(order.invoiceNo, 10) || nextInvoiceNo(invoiceHistory)) + 1));
      }
    } catch (e) {
      alert("Error generando el PDF: " + (e?.message || e));
    } finally {
      setPdfBusy(false);
    }
  }

  // agrupar las líneas de la orden por proveedor (las sin proveedor van juntas)
  const remitoGroups = useMemo(() => {
    const by = {};
    for (const it of order.items) {
      const key = it.supplier || "(sin proveedor)";
      (by[key] ||= []).push(it);
    }
    return Object.entries(by).map(([supplier, items]) => ({ supplier, items }));
  }, [order.items]);

  async function downloadSupplierRemitos() {
    if (!order.items.length) return;
    setPdfBusy(true);
    try {
      const groups = remitoGroups.map(({ supplier, items }) => ({
        supplier,
        client: { name: supplier, addressLines: [], ...shipInfo }, // sin datos de cliente, pero con la dirección de envío
        order: { ...order, items },
      }));
      const blob = await pdf(<RemitosDoc company={COMPANY} groups={groups} />).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `remitos-proveedor-${order.invoiceNo}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      alert("Error generando los remitos: " + (e?.message || e));
    } finally {
      setPdfBusy(false);
    }
  }

  async function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Regenerar un PDF (factura / remito / remitos por proveedor) desde un registro del historial.
  async function downloadFromHistory(rec, mode) {
    setPdfBusy(true);
    try {
      // registros nuevos traen order + clientPdf; los viejos se reconstruyen de items/client
      const ord = rec.order || { items: rec.items || [], invoiceNo: rec.no, date: rec.date, payment: "W/T", fob: "Miami", salesperson: "", job: "", terms: "", dueDate: rec.date, shippingCost: rec.shipping || 0 };
      let cli = rec.clientPdf;
      if (!cli) {
        const c = clients.find((x) => x.id === rec.clientId);
        const lines = c ? (c.address || "").split("\n").map((s) => s.trim()).filter(Boolean) : [];
        cli = { name: rec.client, addressLines: lines, direccion: lines.join(", "), telefono: c?.phone, notify: "", contacto: "" };
      }
      let doc, fname;
      if (mode === "remitos") {
        const by = {};
        for (const it of ord.items || []) { const k = it.supplier || "(sin proveedor)"; (by[k] ||= []).push(it); }
        const groups = Object.entries(by).map(([supplier, items]) => ({
          supplier,
          client: { name: supplier, addressLines: [], notify: cli.notify, direccion: cli.direccion, telefono: cli.telefono, contacto: cli.contacto },
          order: { ...ord, items },
        }));
        doc = <RemitosDoc company={COMPANY} groups={groups} />;
        fname = `remitos-proveedor-${rec.no}.pdf`;
      } else {
        doc = <InvoiceDoc company={COMPANY} client={cli} order={ord} mode={mode} />;
        fname = `${mode}-${rec.no}.pdf`;
      }
      await saveBlob(await pdf(doc).toBlob(), fname);
    } catch (e) {
      alert("Error generando el PDF: " + (e?.message || e));
    } finally {
      setPdfBusy(false);
    }
  }

  // ---- cuentas corrientes ----
  // saldo = lo que el cliente nos debe (side client) / lo que le debemos al proveedor (side supplier).
  // cargo suma, pago resta. La factura genera cargos automáticos; los pagos se registran a mano.
  const ledgerView = useMemo(() => {
    const movs = [];
    // CARGOS derivados de las facturas (no se guardan)
    for (const f of invoiceHistory) {
      if (f.type !== "factura") continue;
      if (ledgerSide === "client") {
        movs.push({ id: `f-${f.no}-cli`, ts: f.ts, party: f.client || "—", type: "cargo", amount: Number(f.total) || 0, concept: `Factura #${f.no}`, date: f.date, ref: f.no, derived: true });
      } else {
        for (const [sp, c] of Object.entries(f.supplierCosts || {})) {
          movs.push({ id: `f-${f.no}-${sp}`, ts: f.ts, party: sp, type: "cargo", amount: Number(c) || 0, concept: `Compra factura #${f.no}`, date: f.date, ref: f.no, derived: true });
        }
      }
    }
    // MANUALES de este lado: pagos y gastos (los cargos automáticos viejos se ignoran, ahora se derivan)
    for (const e of ledger) {
      if (e.side !== ledgerSide) continue;
      if (e.type === "cargo" && e.ref) continue;
      movs.push(e);
    }
    const byParty = {};
    for (const e of movs) {
      const p = e.party || "—";
      (byParty[p] ||= { party: p, saldo: 0, movs: [] });
      byParty[p].saldo += (e.type === "pago" ? -1 : 1) * (Number(e.amount) || 0);
      byParty[p].movs.push(e);
    }
    const parties = Object.values(byParty).sort((a, b) => b.saldo - a.saldo);
    parties.forEach((p) => p.movs.sort((a, b) => (b.ts || 0) - (a.ts || 0)));
    const total = parties.reduce((a, p) => a + p.saldo, 0);
    return { parties, total };
  }, [invoiceHistory, ledger, ledgerSide]);

  function registerPay() {
    const amt = parseFloat(String(payForm.amount).replace(/[^0-9.]/g, "")) || 0;
    const party = payForm.party.trim();
    if (!party) { alert("Elegí o escribí a quién corresponde el movimiento."); return; }
    if (amt <= 0) { alert("Ingresá un monto mayor a 0."); return; }
    setLedger((lg) => [{
      id: uid(), ts: Date.now(), side: ledgerSide, party,
      type: payForm.type, amount: amt, concept: payForm.concept.trim() || (payForm.type === "pago" ? "Pago" : "Gasto envío proveedor"),
      date: payForm.date || today(), ref: "",
    }, ...lg]);
    setPayForm({ party: "", amount: "", concept: "", date: today(), type: "pago" });
  }
  function deleteLedgerEntry(id) {
    if (!confirm("¿Borrar este movimiento?")) return;
    setLedger((lg) => lg.filter((e) => e.id !== id));
  }
  function deleteInvoice(ts, no) {
    if (!confirm(`¿Borrar la factura #${no}? Se recalculan cuentas y PnL.`)) return;
    setInvoiceHistory((h) => h.filter((x) => x.ts !== ts));
  }
  // partes conocidas para el datalist según el lado
  const ledgerParties = useMemo(() => {
    const set = new Set(ledger.filter((e) => e.side === ledgerSide).map((e) => e.party).filter(Boolean));
    if (ledgerSide === "client") clients.forEach((c) => c.name && set.add(c.name));
    else supplierList.forEach((s) => set.add(s));
    return [...set].sort();
  }, [ledger, ledgerSide, clients, supplierList]);

  // PnL / Margen — agregado desde el historial (solo facturas = ventas)
  const pnlView = useMemo(() => {
    const sales = invoiceHistory.filter((h) => h.type === "factura");
    let ventas = 0, costo = 0, piezas = 0;
    const bySupplier = {};
    for (const s of sales) {
      ventas += Number(s.subtotal ?? s.total) || 0;
      costo += Number(s.cost) || 0;
      piezas += Number(s.piezas) || 0;
      for (const [sp, c] of Object.entries(s.supplierCosts || {})) bySupplier[sp] = (bySupplier[sp] || 0) + (Number(c) || 0);
    }
    const gastos = ledger.filter((e) => e.type === "gasto").reduce((a, e) => a + (Number(e.amount) || 0), 0);
    const margen = ventas - costo - gastos;
    const margenPct = ventas ? (margen / ventas) * 100 : 0;
    const supplierRows = Object.entries(bySupplier).map(([sp, c]) => ({ sp, c })).sort((a, b) => b.c - a.c);
    return { sales, ventas, costo, gastos, margen, margenPct, piezas, supplierRows };
  }, [invoiceHistory, ledger]);

  async function askDesk(qArg) {
    const q = (qArg ?? query).trim();
    if (!apiKey.trim()) { setAnswerErr("Enter your Gemini API key first."); return; }
    if (!q) return;
    setAsking(true); setAnswerErr(null);
    try {
      const rows = catalog.map(({ name, cat }) => {
        const a = aggBySku[name];
        return { sku: name, cat, prices: prices[name] || {}, min: a.min, median: a.med, client: a.client };
      }).filter((r) => r.min != null);
      const previous = prevSnap
        ? { date: new Date(prevSnap.ts).toISOString().slice(0, 10), prices: prevSnap.prices }
        : null;
      const content =
        JSON.stringify({ margin_pct: marginNum, rows, previous }) + "\n\nQuestion: " + q;
      const text = await callGemini({ system: DESK_SYSTEM, content, apiKey: apiKey.trim(), maxTokens: 1024 });
      setAnswer(text);
      if (qArg == null) setQuery("");
    } catch (e) {
      setAnswerErr(e.message);
    } finally {
      setAsking(false);
    }
  }

  async function runMark(qArg, image) {
    const q = (qArg ?? query).trim();
    if (!apiKey.trim()) { setMarkMsg({ err: true, text: "Cargá la API key de Gemini primero." }); return; }
    if (!q && !image) return;
    setAsking(true); setMarkMsg(null);
    try {
      const skus = await matchModels(q, apiKey.trim(), markSystem, catalogNames, image ? [image] : []);
      if (qArg == null) setQuery("");
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
      const skus = await matchModels(query.trim(), apiKey.trim(), markSystem, catalogNames, [img]);
      setQuery("");
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

  // ---- chatbox unificado: el AI descubre el intent ----
  async function classifyIntent(text) {
    const sys = "Sos el router de una mesa de precios de celulares. Clasificá el mensaje del usuario y devolvé SOLO JSON " +
      '{"intent":"ask|parse|mark","supplier":""}. ' +
      "intent 'parse' = es una cotización/lista de precios de un proveedor para cargar a la tabla (varios modelos con números). " +
      "intent 'mark' = pide seleccionar/tildar modelos para armar una cotización al cliente. " +
      "intent 'ask' = una pregunta sobre los datos/precios. " +
      "supplier: si el texto menciona uno de estos proveedores, ponelo exacto, si no dejalo vacío: " + supplierList.join(", ") + ".";
    const out = await callGemini({ system: sys, content: text, apiKey: apiKey.trim(), json: true, maxTokens: 200 });
    const p = JSON.parse(stripFences(out));
    return { intent: ["ask", "parse", "mark"].includes(p.intent) ? p.intent : "ask", supplier: p.supplier || "" };
  }

  async function submitChat(file = null) {
    const text = chatText.trim();
    if (!apiKey.trim()) { setChatNote({ err: true, text: "Cargá la contraseña / API key primero." }); return; }
    if (!text && !file) return;
    setChatNote(null);
    let mode = chatMode;
    let supplier = parseSupplier;
    try {
      if (mode === "auto") {
        if (file && !text) { mode = "parse"; } // una foto sola casi siempre es una cotización
        else {
          setAsking(true);
          const c = await classifyIntent(text);
          setAsking(false);
          mode = c.intent;
          if (c.supplier && supplierList.includes(c.supplier)) { supplier = c.supplier; setParseSupplier(c.supplier); }
          setChatNote({ err: false, text: `Intent detectado: ${mode === "ask" ? "Pregunta" : mode === "parse" ? `Cargar precios${supplier ? " → " + supplier : ""}` : "Marcar modelos"}` });
        }
      }
      if (mode === "ask") await askDesk(text);
      else if (mode === "parse") await runParse(file, text || null, supplier);
      else if (mode === "mark") await runMark(text, file ? await fileToData(file) : null);
      setChatText("");
    } catch (e) {
      setAsking(false);
      setChatNote({ err: true, text: "No pude interpretar el mensaje: " + (e?.message || e) + ". Probá con el selector de modo." });
    }
  }

  function onChatPaste(e) {
    for (const it of e.clipboardData?.items || []) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); submitChat(f); return; }
      }
    }
  }

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

  // chatbox unificado de escritorio (a la derecha, colapsable)
  const busyChat = asking || parsing;
  const chatBox = (
    <aside style={{ ...s.chatBox, transform: chatOpen ? "none" : "translateX(100%)" }}>
      <div style={s.chatHead}>
        <span>💬 ASISTENTE</span>
        <button onClick={() => setChatOpen(false)} title="Colapsar hacia la derecha" style={s.chatCollapse}>▶</button>
      </div>
      <div style={s.modeTabs}>
        {[["auto", "Auto"], ["ask", "Preguntar"], ["parse", "Cargar precios"], ["mark", "Marcar"]].map(([m, label]) => (
          <button key={m} onClick={() => setChatMode(m)} style={{ ...s.planTab, ...(chatMode === m ? s.planTabOn : {}) }}>{label}</button>
        ))}
      </div>
      {(chatMode === "parse" || chatMode === "auto") && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "8px 0", fontSize: 11, color: "#9aa4b2" }}>
          <span>Proveedor destino:</span>
          <select value={parseSupplier} onChange={(e) => setParseSupplier(e.target.value)} style={{ ...s.select, flex: 1 }}>
            <option value="">—</option>
            {supplierList.map((sp) => <option key={sp} value={sp}>{sp}</option>)}
          </select>
        </div>
      )}

      {/* resultados: crecen y ocupan el alto disponible */}
      <div style={s.chatResults}>
        {chatNote && <div style={chatNote.err ? s.errorMsg : s.okMsg}>{chatNote.text}</div>}
        {answerErr && <div style={s.errorMsg}>{answerErr}</div>}
        {answer && <div style={s.answerCard}>{answer}</div>}
        {parseMsg && <div style={parseMsg.err ? s.errorMsg : s.okMsg}>{parseMsg.text}{parseMsg.skus?.length ? <span style={s.okSkus}> ({parseMsg.skus.join(", ")})</span> : null}</div>}
        {markMsg && <div style={markMsg.err ? s.errorMsg : s.okMsg}>{markMsg.text}</div>}
        {!chatNote && !answerErr && !answer && !parseMsg && !markMsg && (
          <div style={s.chatEmpty}>
            <p style={{ margin: "0 0 8px" }}><b style={{ color: "#8ea0bf" }}>Escribí lo que necesites</b> y el asistente detecta qué querés:</p>
            <p style={{ margin: "4px 0" }}>💬 <b>Preguntar</b> — “¿dónde está más competitivo VITEL esta semana?”</p>
            <p style={{ margin: "4px 0" }}>📥 <b>Cargar precios</b> — pegá o subí 📷 una cotización de un proveedor.</p>
            <p style={{ margin: "4px 0" }}>✅ <b>Marcar</b> — “marcá el S26 ultra y el A56” para armar la cotización.</p>
          </div>
        )}
      </div>

      {/* input abajo (estilo chat) */}
      <div style={s.chatInputWrap}>
        <textarea value={chatText} onChange={(e) => setChatText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!busyChat) submitChat(); } }}
          onPaste={onChatPaste} rows={4}
          placeholder="Escribí una pregunta, pegá una cotización o pedí marcar modelos… (Enter envía)"
          style={s.chatInput} />
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <label style={{ ...s.imgBtn, cursor: busyChat ? "default" : "pointer" }} title="Subir screenshot (cotización u OCR)">📷
            <input type="file" accept="image/*" disabled={busyChat} style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) submitChat(f); e.target.value = ""; }} />
          </label>
          <button onClick={() => submitChat()} disabled={busyChat} style={{ ...s.askBtn, flex: 1, ...(busyChat ? s.busy : {}) }}>
            {busyChat ? "…" : "Enviar"}
          </button>
        </div>
        <div style={s.askHint}>Enter envía · Shift+Enter salto de línea.</div>
      </div>
    </aside>
  );

  return (
    <div style={{ ...s.app, ...(isMobile ? s.appMobile : {}), ...(!isMobile && chatOpen && view === "mesa" ? { paddingRight: 380 } : {}) }}>
      <header style={s.header}>
        <div>
          <div style={s.title}>PRICE DESK</div>
          {!isMobile && <div style={s.subtitle}>{catalog.length} SKUs · {supplierList.length} suppliers · supplier comparison · adjustable margin</div>}
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
        <button onClick={() => setView("clientes")} style={{ ...s.viewTab, ...(view === "clientes" ? s.viewTabOn : {}) }}>👤 Clientes</button>
        <button onClick={() => setView("cuentas")} style={{ ...s.viewTab, ...(view === "cuentas" ? s.viewTabOn : {}) }}>💰 Cuentas</button>
        <button onClick={() => setView("pnl")} style={{ ...s.viewTab, ...(view === "pnl" ? s.viewTabOn : {}) }}>📈 PnL</button>
        <button onClick={() => setView("historial")} style={{ ...s.viewTab, ...(view === "historial" ? s.viewTabOn : {}) }}>📜 Historial {invoiceHistory.length > 0 ? `(${invoiceHistory.length})` : ""}</button>
      </div>

      {view === "mesa" && (
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
      {!isMobile && chatBox}
      {!isMobile && !chatOpen && (
        <button onClick={() => setChatOpen(true)} title="Abrir asistente" style={s.chatReopen}>💬 Asistente</button>
      )}
      </div>
      )}

      {view === "ordenes" && (
      <section style={s.section}>
        <div style={s.sectionTitle}>ÓRDENES — Factura / Remito</div>
        <div style={s.planTabs}>
          <button onClick={() => setDocType("factura")} style={{ ...s.planTab, ...(docType === "factura" ? s.planTabOn : {}) }}>Factura (con precios)</button>
          <button onClick={() => setDocType("remito")} style={{ ...s.planTab, ...(docType === "remito" ? s.planTabOn : {}) }}>Remito (sin precios)</button>
        </div>

        <div style={s.invGrid}>
          <div style={s.invCol}>
            <div style={s.invColHead}>CLIENTE</div>
            <select value={orderClientId} onChange={(e) => setOrderClientId(e.target.value)} style={s.invInput}>
              <option value="">— sin cliente —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {orderClientId && (
              <div style={s.selBox}>
                <div style={{ fontWeight: 600, color: "#cfd6e4" }}>{selClient.name}</div>
                {selClient.address ? <div style={s.selLine}>{selClient.address}</div> : null}
                {selClient.ruc ? <div style={s.selLine}>RUC: {selClient.ruc}</div> : null}
                {selClient.phone ? <div style={s.selLine}>Tel: {selClient.phone}</div> : null}
              </div>
            )}
            <div style={s.selHint}>Agregar / editar → tab Clientes</div>
          </div>

          <div style={s.invCol}>
            <div style={s.invColHead}>ENVÍO / SHIPPING</div>
            <select value={orderShipId} onChange={(e) => setOrderShipId(e.target.value)} style={s.invInput}>
              <option value="">— sin envío —</option>
              {shippings.map((sh) => <option key={sh.id} value={sh.id}>{sh.label || sh.notify}</option>)}
            </select>
            {orderShipId && (
              <div style={s.selBox}>
                {selShip.notify ? <div style={s.selLine}>Notify: {selShip.notify}</div> : null}
                {selShip.direccion ? <div style={s.selLine}>{selShip.direccion}</div> : null}
                {selShip.telefono ? <div style={s.selLine}>Tel: {selShip.telefono}</div> : null}
                {selShip.contacto ? <div style={s.selLine}>Contacto: {selShip.contacto}</div> : null}
              </div>
            )}
            <div style={s.selHint}>Agregar / editar → tab Clientes</div>
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
            onChange={(e) => { const v = e.target.value; setOrderQuery(v); if (catalogNames.includes(v)) addOrderItem(v); }}
            onKeyDown={(e) => { if (e.key === "Enter") { const m = catalogNames.find((n) => n.toLowerCase() === orderQuery.trim().toLowerCase()); if (m) addOrderItem(m); } }}
            placeholder="Agregar modelo (Enter)…" style={s.cotSearch} />
          <datalist id="catalog-dl">{catalog.map((c) => <option key={c.name} value={c.name} />)}</datalist>
          <button onClick={importMarked} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }} title="Traer los modelos tildados en la cotización de la Mesa">Traer marcados</button>
        </div>

        {order.items.length > 0 && (
          <table style={s.invTable}>
            <thead>
              <tr>
                <th style={s.invTh}>Qty</th>
                <th style={{ ...s.invTh, textAlign: "left" }}>Descripción</th>
                <th style={s.invTh}>Color</th>
                <th style={s.invTh}>Spec</th>
                <th style={s.invTh}>Proveedor</th>
                <th style={s.invTh} title="Costo del proveedor elegido × cantidad">Costo</th>
                {docType === "factura" && <th style={s.invTh}>Precio</th>}
                {docType === "factura" && <th style={s.invTh}>Line Total</th>}
                <th style={s.invTh}></th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((it, idx) => {
                const sups = Object.keys(prices[it.sku] || {});
                const supOpts = it.supplier && !sups.includes(it.supplier) ? [it.supplier, ...sups] : sups;
                return (
                <tr key={idx}>
                  <td style={s.invTd}><input value={it.qty} onChange={(e) => setItem(idx, "qty", e.target.value)} style={{ ...s.cellInput, width: 44, border: "1px solid #232a3a" }} /></td>
                  <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4" }}>{it.sku}</td>
                  <td style={s.invTd}>
                    <input value={it.color || ""} onChange={(e) => setItem(idx, "color", e.target.value)} placeholder="—" style={{ ...s.cellInput, width: 72, border: "1px solid #232a3a" }} />
                    <span style={s.chipSplit} title="Splitear: duplica esta línea para otro color" onClick={() => splitItem(idx)}>+</span>
                  </td>
                  <td style={s.invTd}><input value={it.spec || ""} onChange={(e) => setItem(idx, "spec", e.target.value)} placeholder="—" style={{ ...s.cellInput, width: 60, border: "1px solid #232a3a" }} /></td>
                  <td style={s.invTd}>
                    <select value={it.supplier || ""} onChange={(e) => setItemSupplier(idx, e.target.value)} style={{ ...s.cellInput, width: 132, border: "1px solid #232a3a" }}>
                      <option value="">—</option>
                      {supOpts.map((sp) => <option key={sp} value={sp}>{sp}{typeof prices[it.sku]?.[sp] === "number" ? ` · $${Math.round(prices[it.sku][sp])}` : ""}</option>)}
                    </select>
                  </td>
                  <td style={s.invTd}><input value={it.cost ?? 0} onChange={(e) => setItem(idx, "cost", e.target.value)} style={{ ...s.cellInput, width: 64, border: "1px solid #232a3a", color: "#9aa4b2" }} /></td>
                  {docType === "factura" && <td style={s.invTd}><input value={it.price} onChange={(e) => setItem(idx, "price", e.target.value)} style={{ ...s.cellInput, width: 70, border: "1px solid #232a3a" }} /></td>}
                  {docType === "factura" && <td style={{ ...s.invTd, color: "#fbbf24" }}>{money((Number(it.qty) || 0) * (Number(it.price) || 0))}</td>}
                  <td style={s.invTd}><span style={s.chipX} onClick={() => removeItem(idx)}>×</span></td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div style={s.invFoot}>
          <span>Total piezas: <b>{orderPiezas}</b>{docType === "factura" && <> · Subtotal: <b style={{ color: "#fbbf24" }}>{money(orderSubtotal)}</b> · Costo: <b style={{ color: "#9aa4b2" }}>{money(orderCost)}</b> · Margen: <b style={{ color: "#4ade80" }}>{money(orderSubtotal - orderCost)}</b></>}</span>
          {order.items.length > 0
            ? <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <button onClick={downloadDoc} disabled={pdfBusy} style={{ ...s.pdfBtn, ...(pdfBusy ? s.busy : {}), border: "none", cursor: pdfBusy ? "default" : "pointer" }}>
                  {pdfBusy ? "Generando…" : `⬇ Descargar ${docType} PDF`}
                </button>
                <button onClick={downloadSupplierRemitos} disabled={pdfBusy} title="Un remito sin precios por cada proveedor (una página por proveedor)"
                  style={{ ...s.pdfBtn, ...s.toolBtnGhost, ...(pdfBusy ? s.busy : {}), marginLeft: 0, cursor: pdfBusy ? "default" : "pointer" }}>
                  ⬇ Remitos x proveedor ({remitoGroups.length})
                </button>
              </span>
            : <span style={s.askHint}>Agregá al menos un item para generar (cliente y envío son opcionales).</span>}
        </div>
      </section>

      )}

      {view === "clientes" && (
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
      )}

      {view === "cuentas" && (
        <section style={s.section}>
          <div style={s.sectionTitle}>
            CUENTAS CORRIENTES — {ledgerSide === "client" ? "lo que los clientes nos deben" : "lo que le debemos a cada proveedor"} · se generan solas con cada factura
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={() => setLedgerSide("client")} style={{ ...s.planTab, ...(ledgerSide === "client" ? s.planTabOn : {}) }}>👤 Clientes (nos deben)</button>
            <button onClick={() => setLedgerSide("supplier")} style={{ ...s.planTab, ...(ledgerSide === "supplier" ? s.planTabOn : {}) }}>🏭 Proveedores (les debemos)</button>
            <span style={{ marginLeft: "auto", fontSize: 12, color: "#9aa4b2" }}>
              Saldo total: <b style={{ color: ledgerView.total >= 0 ? "#fbbf24" : "#4ade80" }}>{money(ledgerView.total)}</b>
            </span>
          </div>

          {/* registrar pago / ajuste manual */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14, padding: 10, background: "#11151f", border: "1px solid #1c2230", borderRadius: 6 }}>
            <label style={s.ctrlLabel}><span style={s.ctrlText}>{ledgerSide === "client" ? "CLIENTE" : "PROVEEDOR"}</span>
              <input list="ledger-parties" value={payForm.party} onChange={(e) => setPayForm((f) => ({ ...f, party: e.target.value }))} style={{ ...s.invInput, width: 170 }} placeholder="Nombre" />
              <datalist id="ledger-parties">{ledgerParties.map((p) => <option key={p} value={p} />)}</datalist>
            </label>
            <label style={s.ctrlLabel}><span style={s.ctrlText}>TIPO</span>
              <select value={payForm.type} onChange={(e) => setPayForm((f) => ({ ...f, type: e.target.value }))} style={{ ...s.invInput, width: 140 }}>
                <option value="pago">Pago (−)</option>
                <option value="gasto">Gasto envío (+)</option>
              </select>
            </label>
            <label style={s.ctrlLabel}><span style={s.ctrlText}>MONTO</span>
              <input value={payForm.amount} onChange={(e) => setPayForm((f) => ({ ...f, amount: e.target.value }))} style={{ ...s.invInput, width: 90 }} inputMode="decimal" placeholder="0" />
            </label>
            <label style={s.ctrlLabel}><span style={s.ctrlText}>FECHA</span>
              <input value={payForm.date} onChange={(e) => setPayForm((f) => ({ ...f, date: e.target.value }))} style={{ ...s.invInput, width: 110 }} />
            </label>
            <label style={s.ctrlLabel}><span style={s.ctrlText}>CONCEPTO</span>
              <input value={payForm.concept} onChange={(e) => setPayForm((f) => ({ ...f, concept: e.target.value }))} style={{ ...s.invInput, width: 160 }} placeholder="opcional" />
            </label>
            <button onClick={registerPay} style={{ ...s.toolBtn, marginLeft: 0 }}>+ Registrar</button>
          </div>

          {ledgerView.parties.length === 0 ? (
            <div style={s.askHint}>Todavía no hay movimientos. Generá una factura (Órdenes) o registrá un pago/cargo arriba.</div>
          ) : (
            ledgerView.parties.map((p) => (
              <div key={p.party} style={{ marginBottom: 16, border: "1px solid #1c2230", borderRadius: 6, overflow: "hidden" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "#13182333" }}>
                  <b style={{ color: "#cfd6e4" }}>{p.party}</b>
                  <span>Saldo: <b style={{ color: p.saldo > 0.005 ? "#fbbf24" : p.saldo < -0.005 ? "#4ade80" : "#6b7385" }}>{money(p.saldo)}</b></span>
                </div>
                <table style={s.invTable}>
                  <thead>
                    <tr>
                      <th style={{ ...s.invTh, textAlign: "left" }}>Fecha</th>
                      <th style={{ ...s.invTh, textAlign: "left" }}>Factura #</th>
                      <th style={{ ...s.invTh, textAlign: "left" }}>Concepto</th>
                      <th style={s.invTh}>Entrada (cargo)</th>
                      <th style={s.invTh}>Salida (pago)</th>
                      <th style={s.invTh}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.movs.map((e) => (
                      <tr key={e.id}>
                        <td style={{ ...s.invTd, textAlign: "left" }}>{e.date}</td>
                        <td style={{ ...s.invTd, textAlign: "left", color: "#6fa8e6" }}>{e.ref ? `#${e.ref}` : "—"}</td>
                        <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4" }}>{e.concept}</td>
                        <td style={{ ...s.invTd, color: "#fbbf24" }}>{e.type !== "pago" ? money(e.amount) : ""}</td>
                        <td style={{ ...s.invTd, color: "#4ade80" }}>{e.type === "pago" ? money(e.amount) : ""}</td>
                        <td style={s.invTd}>{e.derived ? <span style={{ color: "#3a4255", fontSize: 10 }} title="Derivado de la factura — se edita/borra desde el Historial">🔒</span> : <span style={s.chipX} onClick={() => deleteLedgerEntry(e.id)}>×</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </section>
      )}

      {view === "pnl" && (
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
      )}

      {view === "historial" && (
        <section style={s.section}>
          <div style={s.sectionTitle}>HISTORIAL — facturas / remitos generados · próximo Invoice # {nextInvoiceNo(invoiceHistory)}</div>
          {invoiceHistory.length === 0 ? (
            <div style={s.askHint}>Todavía no generaste ningún documento. El Invoice # se cuenta solo a medida que generás facturas.</div>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                <button onClick={() => { if (confirm("¿Borrar todo el historial? (el contador del Invoice # vuelve a empezar)")) setInvoiceHistory([]); }} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Limpiar historial</button>
              </div>
              <table style={s.invTable}>
                <thead>
                  <tr>
                    <th style={{ ...s.invTh, textAlign: "left" }}>Invoice #</th>
                    <th style={{ ...s.invTh, textAlign: "left" }}>Fecha</th>
                    <th style={{ ...s.invTh, textAlign: "left" }}>Tipo</th>
                    <th style={{ ...s.invTh, textAlign: "left" }}>Cliente</th>
                    <th style={s.invTh}>Piezas</th>
                    <th style={s.invTh}>Total</th>
                    <th style={s.invTh}>Costo</th>
                    <th style={s.invTh}>Margen</th>
                    <th style={{ ...s.invTh, textAlign: "left" }}>Descargar</th>
                    <th style={s.invTh}></th>
                  </tr>
                </thead>
                <tbody>
                  {invoiceHistory.map((h, i) => (
                    <tr key={i}>
                      <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4", fontWeight: 600 }}>{h.no}</td>
                      <td style={{ ...s.invTd, textAlign: "left" }}>{h.date}</td>
                      <td style={{ ...s.invTd, textAlign: "left" }}>{h.type}</td>
                      <td style={{ ...s.invTd, textAlign: "left" }}>{h.client}</td>
                      <td style={s.invTd}>{h.piezas}</td>
                      <td style={{ ...s.invTd, color: "#fbbf24" }}>{money(h.total)}</td>
                      <td style={{ ...s.invTd, color: "#9aa4b2" }}>{h.cost != null ? money(h.cost) : "—"}</td>
                      <td style={{ ...s.invTd, color: (h.margin || 0) >= 0 ? "#4ade80" : "#f87171" }}>{h.margin != null ? money(h.margin) : "—"}</td>
                      <td style={{ ...s.invTd, textAlign: "left", whiteSpace: "nowrap" }}>
                        <button onClick={() => downloadFromHistory(h, "factura")} disabled={pdfBusy} style={s.miniBtn} title="Factura (con precios)">Factura</button>{" "}
                        <button onClick={() => downloadFromHistory(h, "remito")} disabled={pdfBusy} style={s.miniBtn} title="Remito al cliente (sin precios)">Remito</button>{" "}
                        <button onClick={() => downloadFromHistory(h, "remitos")} disabled={pdfBusy} style={s.miniBtn} title="Remitos por proveedor (sin precios)">Rem. x prov.</button>
                      </td>
                      <td style={s.invTd}><span style={s.chipX} onClick={() => deleteInvoice(h.ts, h.no)}>×</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {/* Modal: modelos nuevos detectados — aparece sí o sí sobre todo */}
      {pendingNew.length > 0 && (
        <div style={s.modalOverlay} onClick={() => setPendingNew([])}>
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
              <button onClick={() => setPendingNew([])} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Cerrar (descartar todos)</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  app: { background: "#0b0e14", color: "#d6dae3", minHeight: "100vh", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12.5, padding: "16px 20px 48px", boxSizing: "border-box", transition: "padding-right .2s ease" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "1px solid #1c2230", paddingBottom: 12, marginBottom: 10, flexWrap: "wrap", gap: 12 },
  title: { fontSize: 18, fontWeight: 700, letterSpacing: 1.5, color: "#e8ecf3" },
  subtitle: { fontSize: 11, color: "#6b7385", marginTop: 2 },
  controls: { display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" },
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
  listaAuto: { color: "#7c8597", fontStyle: "italic" },
  mesaMain: { minWidth: 0, transition: "margin-right .2s ease" },
  chatBox: { position: "fixed", top: 0, right: 0, height: "100vh", width: 360, boxSizing: "border-box", display: "flex", flexDirection: "column", background: "#0f1420", borderLeft: "1px solid #22304a", padding: 14, zIndex: 40, transition: "transform .2s ease" },
  chatResults: { flex: 1, overflowY: "auto", marginTop: 8, display: "flex", flexDirection: "column", gap: 8 },
  chatEmpty: { fontSize: 12, color: "#6b7385", lineHeight: 1.5, border: "1px dashed #22304a", borderRadius: 6, padding: 12, background: "#0b0e14" },
  chatInputWrap: { flexShrink: 0, paddingTop: 10, borderTop: "1px solid #1c2230", marginTop: 8 },
  chatHead: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, letterSpacing: 1, color: "#6fa8e6", fontWeight: 700, marginBottom: 8 },
  chatCollapse: { background: "transparent", border: "1px solid #22304a", color: "#9aa4b2", borderRadius: 4, cursor: "pointer", padding: "1px 8px", fontSize: 13 },
  chatInput: { width: "100%", boxSizing: "border-box", background: "#0b0e14", border: "1px solid #232a3a", color: "#e8ecf3", borderRadius: 4, padding: "8px 9px", fontFamily: "inherit", fontSize: 12.5, outline: "none", resize: "vertical" },
  chatReopen: { position: "fixed", top: "50%", right: 0, transform: "translateY(-50%)", background: "#0f1420", border: "1px solid #22304a", borderRight: "none", color: "#6fa8e6", borderRadius: "8px 0 0 8px", cursor: "pointer", padding: "16px 7px", fontSize: 15, zIndex: 40, writingMode: "vertical-rl", letterSpacing: 1 },
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
  viewNav: { display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" },
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
  selBox: { background: "#0b0e14", border: "1px solid #1c2230", borderRadius: 4, padding: 8, fontSize: 11.5, color: "#9aa3b5" },
  selLine: { marginBottom: 2 },
  selHint: { fontSize: 10, color: "#525a6b", marginTop: 2 },
  newWrap: { marginTop: 10, background: "#11151f", border: "1px solid #244068", borderRadius: 6, padding: 10 },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(3,6,12,0.72)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "8vh 16px", zIndex: 1000 },
  modalCard: { background: "#0f1420", border: "1px solid #2a4a75", borderRadius: 8, padding: 16, width: "min(720px, 96vw)", maxHeight: "80vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" },
  newHead: { fontSize: 11.5, color: "#6fa8e6", fontWeight: 600, marginBottom: 8 },
  newRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" },
  newPrice: { display: "inline-flex", alignItems: "center", gap: 2, color: "#fbbf24", fontWeight: 600 },
  newSup: { fontSize: 10.5, color: "#6b7385", minWidth: 50 },
  newAdd: { background: "#16a34a", border: "none", color: "#fff", padding: "5px 12px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600 },
  // móvil
  appMobile: { padding: "12px 12px 40px", fontSize: 13 },
  mLoadRow: { display: "flex", gap: 8, marginBottom: 14 },
  mTable: { borderCollapse: "collapse", width: "100%", fontSize: 11.5, tableLayout: "fixed" },
  mTh: { background: "#11151f", color: "#8b94a7", fontSize: 9.5, fontWeight: 600, textAlign: "right", padding: "6px 4px", borderBottom: "1px solid #1c2230", position: "sticky", top: 0 },
  mTd: { padding: "5px 4px", textAlign: "right", borderBottom: "1px solid #151a26", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
  mModel: { padding: "5px 4px", textAlign: "left", borderBottom: "1px solid #151a26", color: "#cfd6e4", whiteSpace: "normal", wordBreak: "break-word", lineHeight: 1.25 },
  mCat: { background: "#0e1218", color: "#8b94a7", fontSize: 9.5, fontWeight: 700, letterSpacing: 1, padding: "4px 6px", textTransform: "uppercase" },
  mLista: { width: "100%", boxSizing: "border-box", background: "#0b0e14", border: "1px solid #232a3a", color: "#c4b5fd", textAlign: "right", fontFamily: "inherit", fontSize: 11.5, padding: "3px 4px", borderRadius: 3, outline: "none" },
  tableBar: { display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 10 },
  hideToggle: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#9aa3b5", cursor: "pointer" },
  hideCount: { color: "#525a6b", fontSize: 11 },
  markGroup: { display: "inline-flex", alignItems: "center", gap: 5, flexWrap: "wrap" },
  miniBtn: { background: "#1f2937", border: "1px solid #2a3346", color: "#cfd6e4", padding: "3px 9px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 11 },
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
  chipSplit: { cursor: "pointer", color: "#6ea8fe", fontSize: 14, fontWeight: 700, lineHeight: 1, padding: "0 4px", marginLeft: 2 },
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
