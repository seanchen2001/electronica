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
import { AGENT_TOOLS, buildAgentSystem, REVIEW_SYSTEM } from "./lib/agent-tools.js";
import styles from "./styles.js";
import {
  PRICES_KEY, LISTA_KEY, MARGIN_KEY, SNAP_KEY, TIMES_KEY, CLIENTS_KEY, SHIPS_KEY,
  HIST_KEY, CAT_KEY, LEDGER_KEY, SUPP_KEY, ALIASES_KEY, TIERS_KEY, PHIST_KEY, DRAFTS_KEY,
  DRAFT_TTL_MS, ORDER_STAGES, stageInfo, CATEGORIES, COMPANY, supplierCode, MONTHS_ES,
} from "./lib/constants.js";
import {
  uid, fmtDMY, today, parseDMY, nextInvoiceNo, blankClient, blankShip,
  timesForPrices, load, clone, money,
} from "./lib/helpers.js";
import {
  upsertWeekly,
  costForQty as costForQtyPure,
  hasTiers as hasTiersPure,
  bestSuppliers as bestSuppliersPure,
  negotiationReport as negotiationReportPure,
} from "./lib/pricing.js";
import {
  callGemini, callGeminiTools, parseSupplierQuote, matchModels,
  buildParseSystem, buildMarkSystem, DESK_SYSTEM, stripFences,
  classifyIntent as classifyIntentAI,
  resolveSku as resolveSkuPure,
  resolveSkuSmart as resolveSkuSmartAI,
  whatsappQuoteText as whatsappQuoteTextPure,
} from "./lib/ai.js";

/**
 * S26 Price Desk — supplier comparison + margin + dual input.
 *
 * Data + pricing logic live in ./price-logic.js (validated by seed-validation.test.mjs).
 * Inputs (your "mix of both"):
 *   - Direct entry: type prices straight into supplier cells (clean suppliers).
 *   - Paste & parse: paste a messy quote, Gemini fills that supplier's column.
 * Client price is outlier-aware: median base when the cheapest is a >15% dump.
 */

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
  const [tiers, setTiers] = useState(() => load(TIERS_KEY, {})); // escalas por cantidad: tiers[sku][sup] = [{min,price}]
  const [priceHistory, setPriceHistory] = useState(() => load(PHIST_KEY, [])); // append-only: {sku,sup,price,ts} para analítica
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
  const [ledger, setLedger] = useState(() => load(LEDGER_KEY, [])); // cuentas corrientes (movimientos manuales)
  const [aliases, setAliases] = useState(() => load(ALIASES_KEY, {})); // fusionar cuentas: { nombre → cuenta canónica }
  const [ledgerSide, setLedgerSide] = useState("client"); // "client" | "supplier"
  const [ledgerAccount, setLedgerAccount] = useState(""); // cuenta seleccionada (nombre canónico)
  const [mergeFrom, setMergeFrom] = useState(""); const [mergeTo, setMergeTo] = useState("");
  const [payForm, setPayForm] = useState({ amount: "", concept: "", date: today(), type: "pago" });
  const [docType, setDocType] = useState("factura"); // "factura" | "remito"
  const [expandedModels, setExpandedModels] = useState({}); // desglose de colores abierto por modelo en la orden
  const [pdfBusy, setPdfBusy] = useState(false);
  const [orderQuery, setOrderQuery] = useState("");
  const [order, setOrder] = useState({
    items: [], invoiceNo: String(nextInvoiceNo(load(HIST_KEY, []))), date: today(), payment: "W/T", fob: "Miami",
    salesperson: "", job: "", terms: "Due upon receipt", dueDate: today(), shippingCost: 0, deliveryAddr: "", stage: "cotizando",
  });
  const [orderClientId, setOrderClientId] = useState(""); // selección en Órdenes
  const [orderShipId, setOrderShipId] = useState("");
  const [editingTs, setEditingTs] = useState(null); // ts del registro del Historial que se está editando
  const [drafts, setDrafts] = useState(() => load(DRAFTS_KEY, [])); // pedidos pendientes: [{id, order, clientId, shipId, ts}]
  const [activeId, setActiveId] = useState(() => uid()); // id del pedido activo
  // ---- agente ----
  const [agentLog, setAgentLog] = useState([]); // [{role, text}]
  const [agentBusy, setAgentBusy] = useState(false);
  const [showSteps, setShowSteps] = useState(false); // ver el proceso (herramientas) del agente
  const [pendingAgentCommit, setPendingAgentCommit] = useState(null); // {kind, summary, issues}
  const [pendingDelete, setPendingDelete] = useState(null); // {ts, no, cliente, total} para confirmar borrado de factura vía agente
  const [pendingPriceLoad, setPendingPriceLoad] = useState(null); // {supplier, rows, newModels} para confirmar carga de precios
  const lastQuoteRef = useRef({ text: "", images: [] }); // último mensaje (para load_prices)
  const agentContents = useRef([]); // conversación multi-turno del agente
  const orderRef = useRef(order); // espejo síncrono de la orden para los handlers del agente
  const chatScrollRef = useRef(null); // auto-scroll del chat

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
  const [chatMode, setChatMode] = useState("agente"); // el chatbox de escritorio ahora es solo el agente (AI)
  const [chatOpen, setChatOpen] = useState(true);
  const [chatNote, setChatNote] = useState(null); // {err, text} — feedback del ruteo de intent
  const [chatImage, setChatImage] = useState(null); // imagen adjunta al mensaje (File), con preview
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
  // default de cuenta corriente para clientes sin el campo (una vez): Ojus / Intalper arrancan con CC.
  useEffect(() => {
    if (!clients.some((c) => c.cuentaCorriente === undefined)) return;
    setClients((prev) => prev.map((c) => (c.cuentaCorriente === undefined ? { ...c, cuentaCorriente: /ojus|intalper/i.test(c.name || "") } : c)));
  }, [clients]);
  useEffect(() => { try { localStorage.setItem(HIST_KEY, JSON.stringify(invoiceHistory)); } catch {} }, [invoiceHistory]);
  useEffect(() => { try { localStorage.setItem(CAT_KEY, JSON.stringify(extraCatalog)); } catch {} }, [extraCatalog]);
  useEffect(() => { try { localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger)); } catch {} }, [ledger]);
  useEffect(() => { try { localStorage.setItem(SUPP_KEY, JSON.stringify(supplierList)); } catch {} }, [supplierList]);
  useEffect(() => { try { localStorage.setItem(ALIASES_KEY, JSON.stringify(aliases)); } catch {} }, [aliases]);
  useEffect(() => { try { localStorage.setItem(TIERS_KEY, JSON.stringify(tiers)); } catch {} }, [tiers]);
  useEffect(() => { try { localStorage.setItem(PHIST_KEY, JSON.stringify(priceHistory)); } catch {} }, [priceHistory]);
  useEffect(() => { try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch {} }, [drafts]);

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
        setAliases((al) => resolveObj(d.aliases, al, "aliases"));
        if (!skipObjects) {
          setPrices((p) => resolveObj(d.prices, p, "prices"));
          setTimes((t) => resolveObj(d.times, t, "times"));
          setLista((l) => resolveObj(d.lista, l, "lista"));
          setTiers((t) => resolveObj(d.tiers, t, "tiers"));
          setPriceHistory((h) => resolve(d.priceHistory, h, "priceHistory"));
        }
        setDrafts((x) => resolve(d.drafts, x, "drafts"));
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
  useEffect(() => { syncUp("aliases", aliases); }, [aliases]);
  useEffect(() => { syncUp("tiers", tiers); }, [tiers]);
  useEffect(() => { syncUp("priceHistory", priceHistory); }, [priceHistory]);
  useEffect(() => { syncUp("drafts", drafts); }, [drafts]);
  // auto-guardar el pedido activo (si tiene items) en la lista de pendientes
  useEffect(() => {
    if (!activeId || !order.items.length || editingTs) return; // al editar una factura vieja NO tocamos los pedidos pendientes
    setDrafts((ds) => {
      const entry = { id: activeId, order, clientId: orderClientId, shipId: orderShipId, ts: Date.now() };
      const i = ds.findIndex((x) => x.id === activeId);
      if (i >= 0) { const n = [...ds]; n[i] = entry; return n; }
      return [entry, ...ds];
    });
  }, [order, orderClientId, orderShipId, activeId, editingTs]);
  // barrer pedidos pendientes inactivos: los que no se tocan hace más de DRAFT_TTL_MS se borran solos.
  // Nunca borra el pedido ACTIVO. Corre al abrir y cada 15 min.
  useEffect(() => {
    const sweep = () => {
      const cutoff = Date.now() - DRAFT_TTL_MS;
      setDrafts((ds) => {
        const kept = ds.filter((d) => d.id === activeId || (d.ts || 0) > cutoff);
        return kept.length === ds.length ? ds : kept;
      });
    };
    sweep();
    const t = setInterval(sweep, 15 * 60 * 1000);
    return () => clearInterval(t);
  }, [activeId]);
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
  // append-only: guarda cada actualización de precio (para analítica / serie temporal)
  function logPrices(entries) {
    const now = Date.now();
    const recs = (entries || []).filter((e) => typeof e.price === "number").map((e) => ({ sku: e.sku, sup: e.supplier, price: e.price, ts: now }));
    if (recs.length) setPriceHistory((h) => [...recs, ...h].slice(0, 50000));
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
      const { matched, tiers: parsedTiers, newModels } = await parseSupplierQuote(text, apiKey.trim(), parseSystem, catalogNames, images);
      const keys = Object.keys(matched);
      setPrices((prev) => {
        const next = { ...prev };
        for (const sku of keys) next[sku] = { ...(next[sku] || {}), [supplier]: matched[sku] };
        return next;
      });
      // escalas por cantidad: guardar las que vinieron, limpiar las de este proveedor que ya no aplican
      setTiers((prev) => {
        const next = { ...prev };
        for (const sku of keys) {
          const row = { ...(next[sku] || {}) };
          if (parsedTiers[sku]) row[supplier] = parsedTiers[sku]; else delete row[supplier];
          if (Object.keys(row).length) next[sku] = row; else delete next[sku];
        }
        return next;
      });
      stampTimes(keys.map((sku) => [sku, supplier, false]));
      logPrices(keys.map((sku) => ({ sku, supplier, price: matched[sku] })));
      if (textArg == null) setRawText("");
      const tierCount = keys.filter((sku) => parsedTiers[sku]).length;
      // modelos nuevos → a la cola de confirmación (con el proveedor de origen)
      const adds = newModels
        .filter((m) => !pendingNew.some((p) => p.name === m.name))
        .map((m) => ({ ...m, supplier }));
      if (adds.length) setPendingNew((p) => [...p, ...adds]);
      setParseMsg({
        err: false,
        text: `Cargué ${keys.length} SKU${keys.length === 1 ? "" : "s"} para ${supplier}${tierCount ? ` · ${tierCount} con escala x cantidad` : ""}${adds.length ? ` · ${adds.length} modelo(s) nuevo(s) → revisalos en el modal` : ""}.`,
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
      logPrices([{ sku: m.name, supplier: m.supplier, price: m.price }]);
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

  // texto de cotización WhatsApp para una lista de SKUs (agrupado por categoría del catálogo).
  // priceMap[sku] fija el precio por modelo; si no, usa lista (o client).
  function whatsappQuoteText(skus, source = "lista", priceMap = null) {
    return whatsappQuoteTextPure({ catalog, listaFor, aggBySku }, skus, source, priceMap);
  }
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
  // costo del proveedor para una cantidad (wrapper sobre lib/pricing con el estado actual)
  function costForQty(sku, supplier, qty = 1) { return costForQtyPure(prices, tiers, sku, supplier, qty); }
  function hasTiers(sku, supplier) { return hasTiersPure(tiers, sku, supplier); }
  // una línea de orden: qty, color, spec (EURO/LATIN), proveedor (de dónde se compra) + su costo, y price (lo que se factura al cliente)
  function specForCat(cat) { return cat === "Motorola LATIN" ? "LATIN" : cat === "Motorola EURO" ? "EURO" : ""; }
  function newOrderLine(sku) {
    const sup = cheapestSupplier(sku);
    const cat = catalog.find((c) => c.name === sku)?.cat || "";
    return { sku, cat, qty: 1, color: "", imei: "", spec: specForCat(cat), supplier: sup, cost: costForQty(sku, sup, 1), price: listaFor(sku) ?? aggBySku[sku]?.client ?? 0 };
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
      items: p.items.map((it, i) => {
        if (i !== idx) return it;
        const nv = NUMERIC_ITEM.has(k) ? (parseFloat(String(v).replace(/[^0-9.]/g, "")) || 0) : v;
        const next = { ...it, [k]: nv };
        // si el proveedor tiene escala por cantidad, el costo sigue a la cantidad
        if (k === "qty" && hasTiers(it.sku, it.supplier)) next.cost = costForQty(it.sku, it.supplier, nv);
        return next;
      }),
    }));
  }
  // cambiar de proveedor: setea proveedor y trae su costo según la cantidad (escala o precio base)
  function setItemSupplier(idx, supplier) {
    setOrder((p) => ({
      ...p,
      items: p.items.map((it, i) => i === idx
        ? { ...it, supplier, cost: costForQty(it.sku, supplier, it.qty) || it.cost || 0 }
        : it),
    }));
  }
  function removeItem(idx) { setOrder((p) => ({ ...p, items: p.items.filter((_, i) => i !== idx) })); }
  const selClient = clients.find((c) => c.id === orderClientId) || blankClient();
  const selShip = shippings.find((sh) => sh.id === orderShipId) || blankShip();
  const clientAddrLines = (selClient.address || "").split("\n").map((x) => x.trim()).filter(Boolean);
  // dirección de entrega para el remito: el campo explícito de la orden, luego el Envío, luego el cliente
  const shipInfo = {
    notify: selShip.notify,
    direccion: order.deliveryAddr || selShip.direccion || clientAddrLines.join(", "),
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

  // Guardar la orden en el historial (base de datos de la transacción) — sin generar PDF.
  // Alimenta PnL y cuentas corrientes. Reutilizado por downloadDoc y por "registrar sin PDF".
  function commitOrderToHistory() {
    if (!order.items.length) { alert("Agregá al menos un item."); return false; }
    const totalDoc = orderSubtotal + (Number(order.shippingCost) || 0);
    const supplierCosts = {};
    for (const { supplier, items } of remitoGroups) {
      if (supplier === "(sin proveedor)") continue;
      supplierCosts[supplier] = items.reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.cost) || 0), 0);
    }
    const rec = {
      no: order.invoiceNo, date: order.date, type: docType,
      client: selClient.name || "—", clientId: orderClientId, shipId: orderShipId,
      piezas: orderPiezas, subtotal: orderSubtotal, shipping: Number(order.shippingCost) || 0,
      total: totalDoc, cost: orderCost, margin: orderSubtotal - orderCost,
      supplierCosts, items: JSON.parse(JSON.stringify(order.items)),
      order: JSON.parse(JSON.stringify(order)), clientPdf: clientForPdf,
    };
    if (editingTs) {
      setInvoiceHistory((h) => h.map((x) => (x.ts === editingTs ? { ...rec, ts: editingTs } : x)));
      setEditingTs(null);
      resetOrder(); // cerrar el editor de edición; no dejar la factura editada como pedido pendiente
    } else {
      setInvoiceHistory((h) => [{ ...rec, ts: Date.now() }, ...h].slice(0, 1000));
      if (docType === "factura") {
        setOrderField("invoiceNo", String((parseInt(order.invoiceNo, 10) || nextInvoiceNo(invoiceHistory)) + 1));
      }
    }
    return true;
  }
  // Guardar los cambios de una factura editada, sin regenerar el PDF (commit + cierra el editor).
  function saveEditChanges() {
    if (commitOrderToHistory()) {
      alert("Cambios guardados. Se actualizó la factura, el PnL y las Cuentas.");
    }
  }
  // Registrar una operación pasada sin PDF (backfill de PnL / cuentas).
  function registerPastOperation() {
    if (commitOrderToHistory()) {
      alert(`Operación registrada (venta ${money(orderSubtotal)}, costo ${money(orderCost)}, margen ${money(orderSubtotal - orderCost)}). Ya está en PnL y Cuentas.`);
      resetOrder();
    }
  }

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
      commitOrderToHistory();
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

  async function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Remitos por proveedor: un archivo por proveedor, sin precios ni cliente, con la dirección
  // de entrega (depósito). Nombre: Remito_<Factura#>_<proveedor>.pdf
  // Remitos por proveedor: un archivo por proveedor (solo sus items). Adentro se ve igual que la
  // factura pero sin precios y SIN datos del proveedor. El código va solo en el nombre del archivo.
  async function emitSupplierRemitos(ord, clientPdf) {
    const by = {};
    for (const it of ord.items || []) { const k = it.supplier || "sin_proveedor"; (by[k] ||= []).push(it); }
    const entries = Object.entries(by);
    if (!entries.length) { alert("La orden no tiene items."); return; }
    for (const [supplier, items] of entries) {
      const code = supplierCode(supplier);
      const doc = <InvoiceDoc company={COMPANY} client={clientPdf} order={{ ...ord, items }} mode="remito" />;
      await saveBlob(await pdf(doc).toBlob(), `Remito_${ord.invoiceNo}_${code}.pdf`);
      if (entries.length > 1) await new Promise((r) => setTimeout(r, 450)); // separar descargas
    }
  }

  async function downloadSupplierRemitos() {
    if (!order.items.length) return;
    setPdfBusy(true);
    try {
      await emitSupplierRemitos(order, clientForPdf);
    } catch (e) {
      alert("Error generando los remitos: " + (e?.message || e));
    } finally {
      setPdfBusy(false);
    }
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
      if (mode === "remitos") {
        await emitSupplierRemitos(ord, cli);
      } else {
        await saveBlob(await pdf(<InvoiceDoc company={COMPANY} client={cli} order={ord} mode={mode} />).toBlob(), `${mode}-${rec.no}.pdf`);
      }
    } catch (e) {
      alert("Error generando el PDF: " + (e?.message || e));
    } finally {
      setPdfBusy(false);
    }
  }

  // Cargar una factura del Historial en el editor de Órdenes para modificarla.
  function loadInvoiceForEdit(rec) {
    if (!rec.order) { alert("Esta factura es vieja y no tiene los datos completos para editar. Podés rehacerla como nueva."); return; }
    setOrder(JSON.parse(JSON.stringify(rec.order)));
    setOrderClientId(rec.clientId || "");
    setOrderShipId(rec.shipId || "");
    setDocType(rec.type === "remito" ? "remito" : "factura");
    setEditingTs(rec.ts); // abre el editor como modal flotante sobre el Historial (no cambia de pestaña)
  }
  // Volver a una orden nueva (limpia el modo edición).
  function resetOrder() {
    const empty = { items: [], invoiceNo: String(nextInvoiceNo(invoiceHistory)), date: today(), payment: "W/T", fob: "Miami", salesperson: "", job: "", terms: "Due upon receipt", dueDate: today(), shippingCost: 0, deliveryAddr: "", stage: "cotizando" };
    orderRef.current = empty; setOrder(empty);
    setOrderClientId(""); setOrderShipId(""); setEditingTs(null); setDocType("factura");
    setActiveId(uid()); // pedido nuevo (los otros quedan en pendientes)
  }
  // cambiar de pedido pendiente
  function switchOrder(id) {
    const d = drafts.find((x) => x.id === id); if (!d) return;
    orderRef.current = d.order; setOrder(d.order); setOrderClientId(d.clientId || ""); setOrderShipId(d.shipId || ""); setActiveId(id); setEditingTs(null); setDocType("factura");
  }
  function deleteDraft(id) {
    if (!confirm("¿Borrar este pedido pendiente?")) return;
    setDrafts((ds) => ds.filter((x) => x.id !== id));
    if (id === activeId) resetOrder();
  }
  // nombre de cliente de un draft (para mostrar/buscar)
  function draftClientName(d) { return clients.find((c) => c.id === d.clientId)?.name || d.order?.items?.[0]?.sku || "sin cliente"; }

  // ---- cuentas corrientes ----
  // Débito suma al saldo, Crédito resta. Cliente: saldo = lo que nos debe. Proveedor: saldo = lo que le debemos.
  // Cargos (venta/compra) DERIVADOS de las facturas; pagos y gastos son manuales. Alias fusiona cuentas.
  function canon(name) { const n = (name || "—").trim() || "—"; return aliases[n] || n; }

  const accounts = useMemo(() => {
    const byParty = {};
    // cargo = aumenta lo adeudado (venta al cliente / compra al proveedor); pago = lo reduce
    const add = (party, m) => { const p = canon(party); (byParty[p] ||= []).push({ ...m, when: parseDMY(m.date, m.ts).getTime() }); };
    for (const f of invoiceHistory) {
      if (f.type !== "factura") continue;
      if (ledgerSide === "client") {
        add(f.client || "—", { key: `f-${f.no}`, ts: f.ts, date: f.date, concept: `Factura #${f.no}`, ref: f.no, cargo: Number(f.total) || 0, pago: 0, derived: true });
      } else {
        for (const [sp, c] of Object.entries(f.supplierCosts || {})) add(sp, { key: `f-${f.no}-${sp}`, ts: f.ts, date: f.date, concept: `Compra fact. #${f.no}`, ref: f.no, cargo: Number(c) || 0, pago: 0, derived: true });
      }
    }
    for (const e of ledger) {
      if (e.side !== ledgerSide) continue;
      if (e.type === "cargo" && e.ref) continue; // cargos automáticos viejos → se derivan
      const pago = e.type === "pago";
      add(e.party, { key: e.id, id: e.id, ts: e.ts, date: e.date, concept: e.concept, ref: e.ref || "", cargo: pago ? 0 : (Number(e.amount) || 0), pago: pago ? (Number(e.amount) || 0) : 0, derived: false });
    }
    const out = {};
    for (const [party, movs] of Object.entries(byParty)) {
      movs.sort((a, b) => (a.when - b.when) || (a.ts || 0) - (b.ts || 0)); // por fecha para el saldo corriente
      let saldo = 0;
      const rows = movs.map((m) => { saldo += (m.cargo || 0) - (m.pago || 0); return { ...m, saldo }; });
      out[party] = { party, rows, saldo };
    }
    return out;
  }, [invoiceHistory, ledger, ledgerSide, aliases]);

  const accountNames = useMemo(() => Object.keys(accounts).sort((a, b) => a.localeCompare(b)), [accounts]);
  const currentAccount = accounts[canon(ledgerAccount)] || null;
  const totalSaldo = useMemo(() => Object.values(accounts).reduce((a, x) => a + x.saldo, 0), [accounts]);

  function registerPay() {
    const amt = parseFloat(String(payForm.amount).replace(/[^0-9.]/g, "")) || 0;
    const party = canon(ledgerAccount);
    if (!ledgerAccount) { alert("Elegí una cuenta primero."); return; }
    if (amt <= 0) { alert("Ingresá un monto mayor a 0."); return; }
    setLedger((lg) => [{
      id: uid(), ts: Date.now(), side: ledgerSide, party,
      type: payForm.type, amount: amt, concept: payForm.concept.trim() || (payForm.type === "pago" ? "Pago" : "Gasto envío proveedor"),
      date: payForm.date || today(), ref: "",
    }, ...lg]);
    setPayForm({ amount: "", concept: "", date: today(), type: "pago" });
  }
  function deleteLedgerEntry(id) {
    if (!confirm("¿Borrar este movimiento?")) return;
    setLedger((lg) => lg.filter((e) => e.id !== id));
  }
  function deleteInvoice(ts, no) {
    if (!confirm(`¿Borrar la factura #${no}? Se recalculan cuentas y PnL.`)) return;
    setInvoiceHistory((h) => h.filter((x) => x.ts !== ts));
  }
  function mergeAccounts() {
    if (!mergeFrom || !mergeTo || mergeFrom === mergeTo) { alert("Elegí dos cuentas distintas para fusionar."); return; }
    setAliases((a) => ({ ...a, [mergeFrom]: mergeTo }));
    if (ledgerAccount === mergeFrom) setLedgerAccount(mergeTo);
    setMergeFrom(""); setMergeTo("");
  }
  function unmerge(name) { setAliases((a) => { const n = { ...a }; delete n[name]; return n; }); }

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
  function classifyIntent(text) { return classifyIntentAI({ supplierList, apiKey: apiKey.trim() }, text); }

  async function submitChat(explicitFile = null) {
    const text = chatText.trim();
    const file = explicitFile || chatImage; // usa la imagen adjunta si no se pasó una explícita
    if (chatMode === "agente") { if (text || file) { setChatText(""); setChatImage(null); runAgent(text, file); } return; }
    if (!apiKey.trim()) { setChatNote({ err: true, text: "Cargá la contraseña / API key primero." }); return; }
    if (!text && !file) return;
    setChatImage(null);
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
        if (f) { e.preventDefault(); setChatImage(f); return; } // adjunta (no envía); agregás texto y mandás
      }
    }
  }

  // ---- agente de órdenes (function-calling) ----
  useEffect(() => { orderRef.current = order; }, [order]);
  useEffect(() => { const el = chatScrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [agentLog, answer, parseMsg, markMsg, chatNote, agentBusy]);
  function agentSetOrder(updater) { const next = updater(orderRef.current); orderRef.current = next; setOrder(next); }

  // ranking de proveedores / reporte de negociación (wrappers sobre lib/pricing con el estado actual)
  function bestSuppliers(sku, qty = 1) { return bestSuppliersPure({ prices, tiers, prevSnap, supplierList }, sku, qty); }
  function negotiationReport(scope = "order") {
    return negotiationReportPure({ prices, tiers, prevSnap, supplierList, catalog, orderItems: orderRef.current.items }, scope);
  }
  function orderSummaryData() {
    const o = orderRef.current;
    const lineas = o.items.map((it) => ({
      modelo: it.sku, cantidad: Number(it.qty) || 0, color: it.color || "", proveedor: it.supplier || "",
      costo: Number(it.cost) || 0, precio: Number(it.price) || 0,
      margen: ((Number(it.price) || 0) - (Number(it.cost) || 0)) * (Number(it.qty) || 0),
    }));
    const venta = lineas.reduce((a, l) => a + l.precio * l.cantidad, 0);
    const costo = lineas.reduce((a, l) => a + l.costo * l.cantidad, 0);
    return { cliente: selClient.name || "(sin cliente)", tiene_cuenta_corriente: !!selClient.cuentaCorriente, etapa: stageInfo(o.stage).label, etapa_id: stageInfo(o.stage).id, fecha: o.date, entrega: o.deliveryAddr || "", margin_pct: marginNum, lineas, venta, costo, margen: venta - costo };
  }
  async function reviewOrder() {
    const summary = orderSummaryData();
    const issues = [];
    if (!summary.lineas.length) issues.push("La orden está vacía.");
    for (const l of summary.lineas) {
      if (!l.proveedor) issues.push(`${l.modelo}: sin proveedor.`);
      if (!l.precio) issues.push(`${l.modelo}: sin precio de venta.`);
      if (!l.cantidad) issues.push(`${l.modelo}: cantidad 0.`);
      if (l.precio && l.costo && l.precio < l.costo) issues.push(`${l.modelo}: precio por debajo del costo.`);
    }
    try {
      const out = await callGemini({ system: REVIEW_SYSTEM, content: JSON.stringify(summary), apiKey: apiKey.trim(), json: true, maxTokens: 512 });
      const p = JSON.parse(stripFences(out));
      if (Array.isArray(p.issues)) for (const i of p.issues) if (i && !issues.includes(i)) issues.push(i);
    } catch { /* el crítico es best-effort */ }
    return { summary, issues };
  }
  // resolución de SKUs (wrappers sobre lib/ai con el catálogo actual)
  function resolveSku(name) { return resolveSkuPure({ catalog, catalogNames }, name); }
  function resolveSkuSmart(name) { return resolveSkuSmartAI({ catalog, catalogNames, apiKey: apiKey.trim() }, name); }
  async function runTool(name, args) {
    if (name === "best_supplier") { const sku = await resolveSkuSmart(args.sku); return sku ? bestSuppliers(sku, args.qty || 1) : { error: `No encontré "${args.sku}" en el catálogo.` }; }
    if (name === "negotiation_report") return negotiationReport(args.scope || "order");
    if (name === "order_summary") return orderSummaryData();
    if (name === "list_orders") {
      const list = drafts.map((d) => ({
        id: d.id, activo: d.id === activeId,
        cliente: clients.find((c) => c.id === d.clientId)?.name || "sin cliente",
        etapa: stageInfo(d.order?.stage).label,
        modelos: [...new Set((d.order?.items || []).map((i) => i.sku))],
        piezas: (d.order?.items || []).reduce((a, i) => a + (Number(i.qty) || 0), 0),
      }));
      return { activo: activeId, pedidos: list };
    }
    if (name === "set_order_stage") {
      const st = ORDER_STAGES.find((x) => x.id === args.stage || x.label.toLowerCase() === String(args.stage || "").toLowerCase());
      if (!st) return { ok: false, error: `Etapa desconocida: ${args.stage}. Válidas: ${ORDER_STAGES.map((x) => x.id).join(", ")}.` };
      agentSetOrder((o) => ({ ...o, stage: st.id }));
      return { ok: true, etapa: st.label };
    }
    if (name === "switch_order") {
      const inc = (a, b) => String(a || "").toLowerCase().includes(String(b || "").toLowerCase());
      const nm = (x) => clients.find((c) => c.id === x.clientId)?.name || "sin cliente";
      const summ = (x) => ({ id: x.id, cliente: nm(x), modelos: [...new Set((x.order?.items || []).map((i) => i.sku))], piezas: (x.order?.items || []).reduce((a, i) => a + (Number(i.qty) || 0), 0) });
      if (args.id) { const d = drafts.find((x) => x.id === args.id); if (d) { switchOrder(d.id); return { ok: true, cambiado_a: summ(d) }; } }
      let cands = drafts;
      if (args.clientName) cands = cands.filter((x) => inc(nm(x), args.clientName));
      if (args.model) cands = cands.filter((x) => (x.order?.items || []).some((i) => inc(i.sku, args.model)));
      if (cands.length === 1) { switchOrder(cands[0].id); return { ok: true, cambiado_a: summ(cands[0]) }; }
      if (cands.length === 0) return { ok: false, error: "No encontré un pedido con eso.", pedidos: drafts.map(summ) };
      return { ambiguo: true, mensaje: "Hay varios pedidos que coinciden. Preguntá al usuario cuál (distinguí por los modelos).", candidatos: cands.map(summ) };
    }
    if (name === "delete_order") {
      const inc = (a, b) => String(a || "").toLowerCase().includes(String(b || "").toLowerCase());
      const nm = (x) => clients.find((c) => c.id === x.clientId)?.name || "sin cliente";
      const summ = (x) => ({ id: x.id, cliente: nm(x), modelos: [...new Set((x.order?.items || []).map((i) => i.sku))], piezas: (x.order?.items || []).reduce((a, i) => a + (Number(i.qty) || 0), 0) });
      if (args.all) { // borrar TODOS los pedidos pendientes
        const n = drafts.length;
        if (!n) return { ok: true, borrados: 0, mensaje: "No hay pedidos pendientes." };
        setPendingDelete({
          titulo: `¿Borrar TODOS los pedidos pendientes (${n})?`,
          detalle: "Se borran todos los pedidos a medio armar. No se puede deshacer.",
          run: () => { setDrafts([]); resetOrder(); setAgentLog((l) => [...l, { role: "system", text: `🗑️ Borré ${n} pedido(s) pendiente(s).` }]); },
        });
        return { status: "needs_confirmation", mensaje: `Esperando confirmación del usuario para borrar los ${n} pedidos pendientes.` };
      }
      let cands = drafts;
      if (args.id) cands = drafts.filter((x) => x.id === args.id);
      else {
        if (args.clientName) cands = cands.filter((x) => inc(nm(x), args.clientName));
        if (args.model) cands = cands.filter((x) => (x.order?.items || []).some((i) => inc(i.sku, args.model)));
      }
      if (cands.length === 0) return { ok: false, error: "No encontré un pedido pendiente con eso.", pedidos: drafts.map(summ) };
      if (cands.length > 1) return { ambiguo: true, mensaje: "Hay varios pedidos que coinciden. Preguntá cuál borrar (distinguí por los modelos). No borres sin estar seguro.", candidatos: cands.map(summ) };
      const target = cands[0];
      const info = summ(target);
      setPendingDelete({
        titulo: `¿Borrar el pedido de ${info.cliente}?`,
        detalle: `${info.modelos.join(", ") || "(sin modelos)"} · ${info.piezas}u`,
        run: () => { setDrafts((ds) => ds.filter((x) => x.id !== target.id)); if (target.id === activeId) resetOrder(); setAgentLog((l) => [...l, { role: "system", text: `🗑️ Borré el pedido de ${info.cliente}.` }]); },
      });
      return { status: "needs_confirmation", mensaje: `Esperando confirmación del usuario para borrar el pedido de ${info.cliente}.` };
    }
    if (name === "new_order") { resetOrder(); return { ok: true, mensaje: "Pedido nuevo y vacío. Los otros quedan en pendientes." }; }
    if (name === "add_order_line") {
      const sku = await resolveSkuSmart(args.sku);
      if (!sku) return { ok: false, error: `SKU desconocido: ${args.sku}` };
      const sup = args.supplier || cheapestSupplier(sku);
      const qty = Number(args.qty) || 1;
      agentSetOrder((o) => {
        const items = [...o.items];
        const idx = items.findIndex((i) => i.sku === sku && (i.color || "") === (args.color || ""));
        const line = {
          ...(idx >= 0 ? items[idx] : newOrderLine(sku)),
          sku, qty, color: args.color || (idx >= 0 ? items[idx].color : ""), supplier: sup,
          // costo: negociado si lo pasan; si no, se conserva el de la línea existente; si es nueva, sale del tier
          cost: args.cost != null ? Number(args.cost) : (idx >= 0 ? items[idx].cost : costForQty(sku, sup, qty)),
          // si no pasan clientPrice: en una línea existente se CONSERVA el precio; en una nueva se usa la lista
          price: args.clientPrice != null ? Number(args.clientPrice) : (idx >= 0 ? items[idx].price : (listaFor(sku) ?? aggBySku[sku]?.client ?? 0)),
          cat: catalog.find((c) => c.name === sku)?.cat || "",
        };
        if (idx >= 0) items[idx] = line; else items.push(line);
        return { ...o, items };
      });
      return { ok: true, linea: { modelo: sku, cantidad: qty, proveedor: sup, costo: costForQty(sku, sup, qty) } };
    }
    if (name === "set_order_items") {
      const priceBySku = {}, costBySku = {}; // conservar precio y costo acordados por modelo
      orderRef.current.items.forEach((l) => { priceBySku[l.sku] = l.price; costBySku[l.sku] = l.cost; });
      const lines = [];
      for (const it of args.items || []) {
        const sku = await resolveSkuSmart(it.sku); if (!sku) continue;
        const sup = it.supplier || cheapestSupplier(sku);
        const qty = Number(it.qty) || 1;
        lines.push({
          ...newOrderLine(sku), sku, qty, color: it.color || "", supplier: sup,
          cost: it.cost != null ? Number(it.cost) : (costBySku[sku] ?? costForQty(sku, sup, qty)),
          price: it.clientPrice != null ? Number(it.clientPrice) : (priceBySku[sku] ?? listaFor(sku) ?? aggBySku[sku]?.client ?? 0),
          cat: catalog.find((c) => c.name === sku)?.cat || "",
        });
      }
      agentSetOrder((o) => ({ ...o, items: lines }));
      return { ok: true, total_lineas: lines.length };
    }
    if (name === "set_order_meta") {
      const notes = {};
      if (args.clientName) {
        const q = String(args.clientName).toLowerCase();
        const c = clients.find((x) => (x.name || "").toLowerCase() === q) || clients.find((x) => (x.name || "").toLowerCase().includes(q));
        if (c) setOrderClientId(c.id); else notes.cliente_no_encontrado = args.clientName; // el agente debe agregarlo con add_client
      }
      if (args.shipping) {
        const q = String(args.shipping).toLowerCase();
        const sh = shippings.find((x) => (x.label || "").toLowerCase() === q || (x.notify || "").toLowerCase() === q)
          || shippings.find((x) => (x.label || "").toLowerCase().includes(q) || (x.notify || "").toLowerCase().includes(q));
        if (sh) { setOrderShipId(sh.id); if (sh.direccion) agentSetOrder((o) => ({ ...o, deliveryAddr: sh.direccion })); }
        else notes.envio_no_encontrado = args.shipping; // el agente debe agregarlo con add_shipping (o pedir la dirección)
      }
      if (args.deliveryAddr) agentSetOrder((o) => ({ ...o, deliveryAddr: args.deliveryAddr }));
      if (args.date) agentSetOrder((o) => ({ ...o, date: args.date }));
      if (args.marginPct != null) setMargin(String(args.marginPct));
      return { ok: true, ...notes };
    }
    if (name === "quote_analysis") {
      const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
      const items = await Promise.all((args.items || []).map(async (it) => {
        const sku = await resolveSkuSmart(it.sku), qty = Number(it.qty) || 1;
        const known = !!sku;
        const bs = known ? bestSuppliers(sku, qty) : null;
        const costo = bs?.mejor?.costo ?? null;
        const lista = known ? listaFor(sku) : null; // Mín + margen%
        const suger = it.clientPrice != null ? Number(it.clientPrice) : null;
        return {
          modelo: sku || it.sku, cantidad: qty, en_catalogo: known,
          costo, mejor_proveedor: bs?.mejor?.proveedor ?? null,
          precio_lista: lista,
          margen_lista_pct: costo && lista ? r1(((lista - costo) / costo) * 100) : null,
          precio_sugerido_cliente: suger,
          margen_sugerido_pct: costo && suger ? r1(((suger - costo) / costo) * 100) : null,
          ganancia_sugerida_unit: costo && suger ? r1(suger - costo) : null,
          podemos_igualar: suger != null && costo != null ? suger >= costo : null,
          por_debajo_costo: suger != null && costo != null ? suger < costo : false,
        };
      }));
      return { items, margin_pct_actual: marginNum, nota: "margen_%_ es sobre el costo (igual que el MARGIN % de la app)." };
    }
    if (name === "build_quote") {
      const skus = []; const priceMap = {};
      for (const it of args.items || []) {
        const sku = await resolveSkuSmart(it.model); if (!sku) continue;
        skus.push(sku); if (it.price != null) priceMap[sku] = Number(it.price);
      }
      if (!skus.length) return { ok: false, error: "No hay modelos para cotizar." };
      setSelected(Object.fromEntries(skus.map((s) => [s, true]))); // marca en la Mesa (NO toca la orden)
      return { ok: true, texto_whatsapp: whatsappQuoteText(skus, "lista", priceMap), nota: "Mostrale este texto TAL CUAL al usuario para copiar a WhatsApp. No toqués la orden." };
    }
    if (name === "generate_invoice") {
      setDocType("factura");
      const { summary, issues } = await reviewOrder();
      setPendingAgentCommit({ kind: "invoice", summary, issues });
      return { status: "needs_confirmation", issues, mensaje: "Le mostré el resumen al usuario y estoy esperando que confirme para generar la factura." };
    }
    if (name === "generate_remitos") {
      const { summary, issues } = await reviewOrder();
      setPendingAgentCommit({ kind: "remitos", summary, issues });
      return { status: "needs_confirmation", issues, mensaje: "Esperando confirmación del usuario para generar los remitos por proveedor." };
    }
    if (name === "load_prices") {
      const supplier = supplierList.find((s) => s.toLowerCase() === String(args.supplier || "").toLowerCase()) || args.supplier;
      if (!supplierList.includes(supplier)) return { ok: false, error: `Proveedor desconocido: ${args.supplier}. Disponibles: ${supplierList.join(", ")}.` };
      const q = lastQuoteRef.current || {};
      if (!q.text && !(q.images || []).length) return { ok: false, error: "No tengo la cotización (texto o imagen) en este mensaje. Pedile que la mande de nuevo." };
      const { matched, tiers: pt, newModels } = await parseSupplierQuote(q.text || "", apiKey.trim(), parseSystem, catalogNames, q.images || []);
      const rows = Object.keys(matched).map((sku) => {
        const oldP = prices[sku]?.[supplier];
        const newP = matched[sku];
        const pct = typeof oldP === "number" && oldP ? Math.round(((newP - oldP) / oldP) * 1000) / 10 : null;
        return { sku, oldPrice: oldP ?? null, newPrice: newP, pct, tiers: pt[sku] || null, big: pct != null && Math.abs(pct) > 15 };
      });
      if (!rows.length && !newModels.length) return { ok: false, error: "No pude extraer precios de la cotización." };
      setPendingPriceLoad({ supplier, rows, newModels });
      return { status: "needs_confirmation", supplier, cargados: rows.length, con_variacion_grande: rows.filter((r) => r.big).map((r) => `${r.sku} (${r.pct}%)`), nuevos: newModels.map((m) => m.name), mensaje: "Le mostré la previsualización al usuario para que confirme antes de guardar." };
    }
    if (name === "add_client") {
      const nm = String(args.name || "").trim();
      if (!nm) return { ok: false, error: "Falta el nombre del cliente." };
      const ex = clients.find((c) => (c.name || "").toLowerCase() === nm.toLowerCase());
      if (ex) {
        const upd = { ...ex, address: args.address ?? ex.address, ruc: args.ruc ?? ex.ruc, phone: args.phone ?? ex.phone, cuentaCorriente: args.cuentaCorriente != null ? !!args.cuentaCorriente : ex.cuentaCorriente };
        setClients((prev) => prev.map((c) => (c.id === ex.id ? upd : c)));
        return { ok: true, actualizado: true, cliente: nm, id: ex.id };
      }
      const nc = { id: "cl" + Date.now(), name: nm, address: args.address || "", ruc: args.ruc || "", phone: args.phone || "", cuentaCorriente: !!args.cuentaCorriente };
      setClients((prev) => [...prev, nc]);
      return { ok: true, creado: true, cliente: nm, id: nc.id };
    }
    if (name === "add_shipping") {
      const label = String(args.label || args.notify || "").trim();
      if (!label && !args.direccion) return { ok: false, error: "Falta al menos etiqueta/notify o dirección." };
      const ns = { id: "sh" + Date.now(), label: args.label || "", notify: args.notify || "", direccion: args.direccion || "", telefono: args.telefono || "", contacto: args.contacto || "" };
      setShippings((prev) => [...prev, ns]);
      return { ok: true, envio: ns.label || ns.direccion, id: ns.id };
    }
    if (name === "add_supplier") {
      const nm = String(args.name || "").trim();
      if (!nm) return { ok: false, error: "Falta el nombre del proveedor." };
      if (supplierList.some((s) => s.toLowerCase() === nm.toLowerCase())) return { ok: true, existe: true, proveedor: nm };
      setSupplierList((l) => [...l, nm]);
      return { ok: true, creado: true, proveedor: nm };
    }
    // ---- READ: listar clientes / envíos / proveedores ----
    if (name === "list_clients") return { clientes: clients.map((c) => ({ nombre: c.name, direccion: c.address || "", ruc: c.ruc || "", telefono: c.phone || "", cuenta_corriente: !!c.cuentaCorriente })) };
    if (name === "list_shippings") return { envios: shippings.map((sh) => ({ nombre: sh.label || sh.notify, notify: sh.notify || "", direccion: sh.direccion || "", telefono: sh.telefono || "", contacto: sh.contacto || "" })) };
    if (name === "list_suppliers") return { proveedores: supplierList };
    // ---- DELETE: borrar cliente / envío / proveedor (con guard de ambigüedad) ----
    if (name === "delete_client") {
      const q = String(args.name || "").trim().toLowerCase();
      if (!q) return { ok: false, error: "Falta el nombre del cliente a borrar." };
      let cands = clients.filter((c) => (c.name || "").toLowerCase() === q);
      if (!cands.length) cands = clients.filter((c) => (c.name || "").toLowerCase().includes(q));
      if (!cands.length) return { ok: false, error: `No encontré el cliente "${args.name}".`, clientes: clients.map((c) => c.name) };
      if (cands.length > 1) return { ambiguo: true, mensaje: "Hay varios clientes que coinciden. Preguntá cuál borrar.", candidatos: cands.map((c) => c.name) };
      const t = cands[0];
      setPendingDelete({
        titulo: `¿Borrar el cliente "${t.name}"?`,
        detalle: "No afecta las facturas ya hechas ni las cuentas corrientes.",
        run: () => { setClients((prev) => prev.filter((c) => c.id !== t.id)); setAgentLog((l) => [...l, { role: "system", text: `🗑️ Borré el cliente ${t.name}.` }]); },
      });
      return { status: "needs_confirmation", mensaje: `Esperando confirmación del usuario para borrar el cliente ${t.name}.` };
    }
    if (name === "delete_shipping") {
      const q = String(args.name || "").trim().toLowerCase();
      if (!q) return { ok: false, error: "Falta el nombre del envío a borrar." };
      const key = (x) => (x.label || x.notify || "").toLowerCase();
      let cands = shippings.filter((x) => key(x) === q);
      if (!cands.length) cands = shippings.filter((x) => key(x).includes(q) || (x.notify || "").toLowerCase().includes(q));
      if (!cands.length) return { ok: false, error: `No encontré el envío "${args.name}".`, envios: shippings.map((x) => x.label || x.notify) };
      if (cands.length > 1) return { ambiguo: true, mensaje: "Hay varios envíos que coinciden. Preguntá cuál borrar.", candidatos: cands.map((x) => x.label || x.notify) };
      const t = cands[0];
      const tn = t.label || t.notify;
      setPendingDelete({
        titulo: `¿Borrar el envío "${tn}"?`,
        detalle: t.direccion || "",
        run: () => { setShippings((prev) => prev.filter((x) => x.id !== t.id)); setAgentLog((l) => [...l, { role: "system", text: `🗑️ Borré el envío ${tn}.` }]); },
      });
      return { status: "needs_confirmation", mensaje: `Esperando confirmación del usuario para borrar el envío ${tn}.` };
    }
    if (name === "delete_supplier") {
      const q = String(args.name || "").trim().toLowerCase();
      if (!q) return { ok: false, error: "Falta el nombre del proveedor a borrar." };
      let cands = supplierList.filter((s) => s.toLowerCase() === q);
      if (!cands.length) cands = supplierList.filter((s) => s.toLowerCase().includes(q));
      if (!cands.length) return { ok: false, error: `No encontré el proveedor "${args.name}".`, proveedores: supplierList };
      if (cands.length > 1) return { ambiguo: true, mensaje: "Hay varios proveedores que coinciden. Preguntá cuál borrar.", candidatos: cands };
      const t = cands[0];
      setPendingDelete({
        titulo: `¿Borrar el proveedor "${t}"?`,
        detalle: "Los precios cargados de ese proveedor quedan sin usarse.",
        run: () => { setSupplierList((l) => l.filter((s) => s !== t)); setAgentLog((l) => [...l, { role: "system", text: `🗑️ Borré el proveedor ${t}.` }]); },
      });
      return { status: "needs_confirmation", mensaje: `Esperando confirmación del usuario para borrar el proveedor ${t}.` };
    }
    if (name === "supplier_ask") {
      const m = args.minMarginPct != null ? Number(args.minMarginPct) : marginNum;
      const r2 = (n) => Math.round(n * 100) / 100;
      const items = await Promise.all((args.items || []).map(async (it) => {
        const sku = await resolveSkuSmart(it.sku); const qty = Number(it.qty) || 1;
        if (!sku) return { modelo: it.sku, en_catalogo: false };
        const bs = bestSuppliers(sku, qty);
        const costoActual = bs?.mejor?.costo ?? null;
        const target = it.targetClientPrice != null ? Number(it.targetClientPrice) : null;
        const costoObjetivo = target != null ? r2(target / (1 + m / 100)) : null;
        const bajar = costoActual != null && costoObjetivo != null ? r2(costoActual - costoObjetivo) : null;
        return {
          modelo: sku, cantidad: qty,
          proveedor_actual: bs?.mejor?.proveedor ?? null, costo_actual: costoActual,
          precio_objetivo_cliente: target, margen_min_pct: m,
          costo_objetivo: costoObjetivo,            // lo que necesitás que te deje el proveedor
          pedir_baja_de: bajar,                     // cuánto pedirle que baje (≤0 = ya te alcanza)
          ya_alcanza: bajar != null ? bajar <= 0 : null,
          alternativa: bs?.ranking?.[1] ? { proveedor: bs.ranking[1].supplier, costo: bs.ranking[1].cost } : null,
        };
      }));
      return { items, margen_min_pct: m, nota: "costo_objetivo = precio_cliente / (1+margen). pedir_baja_de = cuánto pedirle al proveedor que baje su costo. Si ya_alcanza=true, no hace falta negociar. Usá la alternativa como palanca." };
    }
    if (name === "send_document") {
      const no = String(args.invoiceNo || "").trim();
      const rec = invoiceHistory.find((h) => String(h.no) === no) || (no ? null : invoiceHistory[0]);
      if (!rec) return { ok: false, error: no ? `No encontré la factura #${no} en el historial.` : "No hay facturas en el historial.", disponibles: invoiceHistory.slice(0, 12).map((h) => h.no) };
      const kind = /remit/i.test(args.kind || "") ? "remitos" : "factura";
      await downloadFromHistory(rec, kind);
      return { ok: true, enviado: kind, factura: rec.no, mensaje: `Descargué ${kind === "remitos" ? "los remitos por proveedor" : "la factura"} #${rec.no} (${rec.client || "—"}). Ya la tenés para reenviar.` };
    }
    if (name === "delete_invoice") {
      const no = String(args.invoiceNo || "").trim();
      const rec = invoiceHistory.find((h) => String(h.no) === no);
      if (!rec) return { ok: false, error: `No encontré la factura #${no}.`, disponibles: invoiceHistory.slice(0, 12).map((h) => h.no) };
      setPendingDelete({
        titulo: `¿Borrar la factura #${rec.no}?`,
        detalle: `Cliente: ${rec.client || "—"} · Total ${money(rec.total)}. Se recalculan cuentas corrientes y PnL. No se puede deshacer.`,
        run: () => { setInvoiceHistory((h) => h.filter((x) => x.ts !== rec.ts)); setAgentLog((l) => [...l, { role: "system", text: `🗑️ Borré la factura #${rec.no}. Se recalcularon cuentas y PnL.` }]); },
      });
      return { status: "needs_confirmation", mensaje: `Le pedí al usuario que confirme borrar la factura #${rec.no} (${rec.client || "—"}, ${money(rec.total)}).` };
    }
    return { ok: false, error: "herramienta desconocida" };
  }
  // Confirmación universal de borrado del agente: pendingDelete = { titulo, detalle, run }.
  function confirmDelete() {
    const d = pendingDelete; setPendingDelete(null);
    if (d?.run) d.run();
  }
  async function runAgent(userText, file = null) {
    if (!apiKey.trim()) { setAgentLog((l) => [...l, { role: "system", text: "Cargá la contraseña / API key primero." }]); return; }
    if (!userText.trim() && !file) return;
    setDocType("factura");
    setAgentBusy(true);
    setAgentLog((l) => [...l, { role: "you", text: (userText || "") + (file ? "  📷 (imagen)" : "") }]);
    const system = buildAgentSystem({ catalogNames, suppliers: supplierList, clientNames: clients.map((c) => c.name).filter(Boolean), shippingNames: shippings.map((sh) => sh.label || sh.notify).filter(Boolean) });
    const stateSnapshot = { orden_actual: orderSummaryData() };
    const parts = [];
    const quoteImages = [];
    if (file) { try { const img = await fileToData(file); quoteImages.push(img); parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } }); } catch { /* ignore */ } }
    lastQuoteRef.current = { text: userText || "", images: quoteImages }; // para load_prices
    parts.push({ text: (userText || "(mirá la imagen adjunta para contexto)") + "\n\nESTADO: " + JSON.stringify(stateSnapshot) });
    const contents = [...agentContents.current, { role: "user", parts }];
    try {
      for (let step = 0; step < 8; step++) {
        const cand = await callGeminiTools({ system, contents, tools: AGENT_TOOLS, apiKey: apiKey.trim(), maxTokens: 2048 });
        contents.push(cand);
        const calls = (cand.parts || []).filter((p) => p.functionCall).map((p) => p.functionCall);
        const textOut = (cand.parts || []).filter((p) => p.text).map((p) => p.text).join("").trim();
        // solo mostramos la respuesta FINAL (turno sin herramientas); la narración intermedia se oculta
        if (textOut && !calls.length) setAgentLog((l) => [...l, { role: "agent", text: textOut }]);
        if (!calls.length) break;
        const responses = [];
        let paused = false;
        for (const fc of calls) {
          setAgentLog((l) => [...l, { role: "tool", text: `⚙ ${fc.name}(${JSON.stringify(fc.args || {})})` }]);
          const result = await runTool(fc.name, fc.args || {});
          const rs = JSON.stringify(result);
          setAgentLog((l) => [...l, { role: "tool", text: `↳ ${rs.length > 400 ? rs.slice(0, 400) + "…" : rs}` }]);
          responses.push({ functionResponse: { name: fc.name, response: result } });
          if (result && result.status === "needs_confirmation") paused = true;
        }
        contents.push({ role: "user", parts: responses });
        if (paused) break;
      }
      agentContents.current = contents;
    } catch (e) {
      setAgentLog((l) => [...l, { role: "system", text: "Error: " + (e?.message || e) }]);
    } finally {
      setAgentBusy(false);
    }
  }
  async function confirmAgentCommit() {
    const c = pendingAgentCommit; setPendingAgentCommit(null);
    if (!c) return;
    try {
      if (c.kind === "invoice") { setDocType("factura"); await downloadDoc(); setAgentLog((l) => [...l, { role: "system", text: "✅ Factura generada y registrada." }]); }
      else if (c.kind === "remitos") { await downloadSupplierRemitos(); setAgentLog((l) => [...l, { role: "system", text: "✅ Remitos por proveedor generados." }]); }
    } catch (e) { setAgentLog((l) => [...l, { role: "system", text: "Error al generar: " + (e?.message || e) }]); }
  }
  function confirmPriceLoad() {
    const p = pendingPriceLoad; setPendingPriceLoad(null);
    if (!p) return;
    setPrices((prev) => { const next = { ...prev }; for (const r of p.rows) next[r.sku] = { ...(next[r.sku] || {}), [p.supplier]: r.newPrice }; return next; });
    setTiers((prev) => {
      const next = { ...prev };
      for (const r of p.rows) { const row = { ...(next[r.sku] || {}) }; if (r.tiers) row[p.supplier] = r.tiers; else delete row[p.supplier]; if (Object.keys(row).length) next[r.sku] = row; else delete next[r.sku]; }
      return next;
    });
    stampTimes(p.rows.map((r) => [r.sku, p.supplier, false]));
    logPrices(p.rows.map((r) => ({ sku: r.sku, supplier: p.supplier, price: r.newPrice })));
    if (p.newModels?.length) setPendingNew((pn) => [...pn, ...p.newModels.filter((m) => !pn.some((x) => x.name === m.name)).map((m) => ({ ...m, supplier: p.supplier }))]);
    setAgentLog((l) => [...l, { role: "system", text: `✅ Cargué ${p.rows.length} precio(s) para ${p.supplier}${p.newModels?.length ? ` · ${p.newModels.length} modelo(s) nuevo(s) → confirmá en el modal` : ""}.` }]);
  }
  function resetAgent() { agentContents.current = []; setAgentLog([]); setPendingAgentCommit(null); setPendingPriceLoad(null); }

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
  const busyChat = asking || parsing || agentBusy;
  const chatBox = (
    <aside style={{ ...s.chatBox, transform: chatOpen ? "none" : "translateX(100%)" }}>
      <div style={s.chatHead}>
        <span>💬 ASISTENTE</span>
        <button onClick={() => setChatOpen(false)} title="Colapsar hacia la derecha" style={s.chatCollapse}>▶</button>
      </div>

      {/* resultados: crecen y ocupan el alto disponible */}
      <div style={s.chatResults} ref={chatScrollRef}>
        {(
          <>
            {agentLog.length > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <label style={{ fontSize: 10.5, color: "#6b7385", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                  <input type="checkbox" checked={showSteps} onChange={(e) => setShowSteps(e.target.checked)} /> ver pasos
                </label>
                <button onClick={resetAgent} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0, fontSize: 11 }}>Nueva conversación</button>
              </div>
            )}
            {agentLog.filter((m) => showSteps || m.role !== "tool").map((m, i) => (
              <div key={i} style={
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

  return (
    <div style={{ ...s.app, ...(isMobile ? s.appMobile : {}), ...(!isMobile && chatOpen ? { paddingRight: 380 } : {}) }}>
      <style>{"@keyframes deskspin{to{transform:rotate(360deg)}}"}</style>
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
      </div>
      )}

      {/* Órdenes: inline en su pestaña; cuando editás una factura vieja, flota como modal sobre el Historial (aislado de los pedidos pendientes). */}
      {(view === "ordenes" || editingTs) && (
      <div style={editingTs ? s.editOverlay : { display: "contents" }}>
      <section style={editingTs ? s.editCard : s.section}>
        <div style={s.sectionTitle}>{editingTs ? `EDITAR FACTURA #${order.invoiceNo}` : "ÓRDENES — Factura / Remito"}</div>
        {/* pedidos pendientes (solo al armar órdenes nuevas, no al editar una factura) */}
        {!editingTs && (
        <div style={s.acctTabs}>
          <span style={{ fontSize: 10.5, color: "#6b7385", alignSelf: "center", marginRight: 2 }}>PEDIDOS:</span>
          {drafts.map((d) => {
            const on = d.id === activeId;
            const cli = clients.find((c) => c.id === d.clientId)?.name;
            const pzs = (d.order?.items || []).reduce((a, i) => a + (Number(i.qty) || 0), 0);
            const models = [...new Set((d.order?.items || []).map((i) => i.sku))];
            const hint = models.slice(0, 2).map((m) => m.split(" ")[0]).join("/") + (models.length > 2 ? "+" : "");
            const idle = Date.now() - (d.ts || 0);
            const age = idle < 3600e3 ? `${Math.max(1, Math.round(idle / 60e3))}m` : idle < 86400e3 ? `${Math.floor(idle / 3600e3)}h` : `${Math.floor(idle / 86400e3)}d`;
            const stale = !on && idle > DRAFT_TTL_MS * 0.66; // acercándose al auto-borrado (6 h)
            return (
              <span key={d.id} style={{ ...s.acctTab, ...(on ? s.acctTabOn : {}), ...(stale ? { opacity: 0.6 } : {}), display: "inline-flex", gap: 6 }}
                title={models.join(", ") + (on ? "" : `\nInactivo hace ${age}` + (stale ? " — se auto-borra a las 6 h de inactividad" : ""))}>
                <span onClick={() => switchOrder(d.id)} style={{ cursor: "pointer" }}>{cli || "sin cliente"} · {hint || "—"} · {pzs}u{on ? "" : <span style={{ color: stale ? "#d08a5a" : "#5a6273" }}> · {stale ? "⏳" : ""}{age}</span>}</span>
                <span style={s.chipX} onClick={() => deleteDraft(d.id)}>×</span>
              </span>
            );
          })}
          <button onClick={resetOrder} style={{ ...s.miniBtn }}>+ Nuevo pedido</button>
        </div>
        )}
        {editingTs && (
          <div style={s.editBanner}>
            ✏️ Estás editando una factura ya generada — al guardar se actualiza esa misma (recalcula cuentas y PnL). No afecta tus pedidos pendientes.
            <span style={{ flex: 1 }} />
            <button onClick={resetOrder} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 8 }}>✕ Cerrar sin guardar</button>
          </div>
        )}
        {!editingTs && orderClientId && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", margin: "8px 0 2px" }}>
            <span style={{ fontSize: 11, color: selClient.cuentaCorriente ? "#8ee0a8" : "#e0b48e" }}
              title={selClient.cuentaCorriente ? "Con cuenta corriente: envío directo, queda en la cuenta." : "Sin cuenta corriente: primero paga, después se envía."}>
              {selClient.cuentaCorriente ? "🟢 con cuenta corriente" : "🟠 sin cuenta — cobra antes de enviar"}
            </span>
          </div>
        )}
        <div style={s.planTabs}>
          <button onClick={() => setDocType("factura")} style={{ ...s.planTab, ...(docType === "factura" ? s.planTabOn : {}) }}>Factura (con precios)</button>
          <button onClick={() => setDocType("remito")} style={{ ...s.planTab, ...(docType === "remito" ? s.planTabOn : {}) }}>Remito x proveedor (sin precios)</button>
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
            <div style={s.invColHead}>ENTREGA / SHIPPING</div>
            <select value={orderShipId} onChange={(e) => {
              const id = e.target.value; setOrderShipId(id);
              const sh = shippings.find((x) => x.id === id);
              if (sh && sh.direccion) setOrderField("deliveryAddr", sh.direccion); // prefijar dirección de entrega
            }} style={s.invInput}>
              <option value="">— sin envío guardado —</option>
              {shippings.map((sh) => <option key={sh.id} value={sh.id}>{sh.label || sh.notify}</option>)}
            </select>
            <label style={{ ...s.invField, marginTop: 6 }}>
              <span style={s.invFieldLbl}>Dirección de entrega (depósito) — aparece en el remito</span>
              <textarea value={order.deliveryAddr || ""} onChange={(e) => setOrderField("deliveryAddr", e.target.value)}
                rows={2} placeholder="Dirección del depósito / destino…" style={s.invArea} />
            </label>
            <div style={s.selHint}>Se guarda con la orden. Envíos guardados → tab Clientes.</div>
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
                <th style={s.invTh}>IMEI</th>
                <th style={s.invTh}>Spec</th>
                <th style={s.invTh}>Proveedor</th>
                <th style={s.invTh} title="Costo del proveedor elegido × cantidad">Costo</th>
                {docType === "factura" && <th style={s.invTh}>Precio</th>}
                {docType === "factura" && <th style={s.invTh}>Line Total</th>}
                <th style={s.invTh}></th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const groups = {};
                order.items.forEach((it, idx) => { (groups[it.sku] ||= []).push({ it, idx }); });
                const detailCols = docType === "factura" ? 8 : 6;
                const editRow = ({ it, idx }, descNode) => {
                  const sups = Object.keys(prices[it.sku] || {});
                  const supOpts = it.supplier && !sups.includes(it.supplier) ? [it.supplier, ...sups] : sups;
                  return (
                    <tr key={idx}>
                      <td style={s.invTd}><input value={it.qty} onChange={(e) => setItem(idx, "qty", e.target.value)} style={{ ...s.cellInput, width: 44, border: "1px solid #232a3a" }} /></td>
                      <td style={{ ...s.invTd, textAlign: "left" }}>{descNode}</td>
                      <td style={s.invTd}>
                        <input value={it.color || ""} onChange={(e) => setItem(idx, "color", e.target.value)} placeholder="—" style={{ ...s.cellInput, width: 72, border: "1px solid #232a3a" }} />
                        <span style={s.chipSplit} title="Splitear: duplica esta línea para otro color" onClick={() => splitItem(idx)}>+</span>
                      </td>
                      <td style={s.invTd}><input value={it.imei || ""} onChange={(e) => setItem(idx, "imei", e.target.value)} placeholder="—" title="IMEI(s) — uno o varios" style={{ ...s.cellInput, width: 110, border: "1px solid #232a3a" }} /></td>
                      <td style={s.invTd}><input value={it.spec || ""} onChange={(e) => setItem(idx, "spec", e.target.value)} placeholder="—" style={{ ...s.cellInput, width: 60, border: "1px solid #232a3a" }} /></td>
                      <td style={s.invTd}>
                        <select value={it.supplier || ""} onChange={(e) => setItemSupplier(idx, e.target.value)} style={{ ...s.cellInput, width: 132, border: "1px solid #232a3a" }}>
                          <option value="">—</option>
                          {supOpts.map((sp) => <option key={sp} value={sp}>{sp}{typeof prices[it.sku]?.[sp] === "number" ? ` · $${Math.round(prices[it.sku][sp])}` : ""}</option>)}
                        </select>
                      </td>
                      <td style={s.invTd}>
                        <input value={it.cost ?? 0} onChange={(e) => setItem(idx, "cost", e.target.value)} style={{ ...s.cellInput, width: 64, border: "1px solid #232a3a", color: "#9aa4b2" }} />
                        {hasTiers(it.sku, it.supplier) && <span title={`Escala x cantidad (${it.supplier}):\n` + tiers[it.sku][it.supplier].map((t) => `${t.min}+ pzs → $${t.price}`).join("\n")} style={{ color: "#c084fc", fontSize: 10, marginLeft: 3, cursor: "help" }}>⇙</span>}
                      </td>
                      {docType === "factura" && <td style={s.invTd}><input value={it.price} onChange={(e) => setItem(idx, "price", e.target.value)} style={{ ...s.cellInput, width: 70, border: "1px solid #232a3a" }} /></td>}
                      {docType === "factura" && <td style={{ ...s.invTd, color: "#fbbf24" }}>{money((Number(it.qty) || 0) * (Number(it.price) || 0))}</td>}
                      <td style={s.invTd}><span style={s.chipX} onClick={() => removeItem(idx)}>×</span></td>
                    </tr>
                  );
                };
                return Object.entries(groups).map(([sku, rows]) => {
                  // un solo color → una sola fila (con el modelo + su color); varios → total + desglose colapsable
                  if (rows.length === 1) {
                    const c = rows[0].it.color;
                    return <React.Fragment key={sku}>{editRow(rows[0], <span style={{ color: "#cfd6e4" }}>{sku}{c ? <span style={{ color: "#8b94a7" }}> · {c}</span> : ""}</span>)}</React.Fragment>;
                  }
                  const totalQty = rows.reduce((a, r) => a + (Number(r.it.qty) || 0), 0);
                  const colorsTxt = rows.map((r) => `${r.it.qty} ${r.it.color || "—"}`).join(", ");
                  const open = !!expandedModels[sku];
                  return (
                    <React.Fragment key={sku}>
                      <tr onClick={() => setExpandedModels((m) => ({ ...m, [sku]: !open }))} style={{ cursor: "pointer", background: "#131823" }}>
                        <td style={{ ...s.invTd, fontWeight: 700 }}>{totalQty}</td>
                        <td style={{ ...s.invTd, textAlign: "left", color: "#e8ecf3" }}>{open ? "▾ " : "▸ "}{sku}</td>
                        <td colSpan={detailCols} style={{ ...s.invTd, textAlign: "left", color: "#8b94a7" }}>{!open ? colorsTxt : ""}</td>
                      </tr>
                      {open && rows.map((r) => editRow(r, <span style={{ color: "#6b7385", paddingLeft: 18 }}>{r.it.color || "↳"}</span>))}
                    </React.Fragment>
                  );
                });
              })()}
            </tbody>
          </table>
        )}

        <div style={s.invFoot}>
          <span>Total piezas: <b>{orderPiezas}</b>{docType === "factura" && <> · Subtotal: <b style={{ color: "#fbbf24" }}>{money(orderSubtotal)}</b> · Costo: <b style={{ color: "#9aa4b2" }}>{money(orderCost)}</b> · Margen: <b style={{ color: "#4ade80" }}>{money(orderSubtotal - orderCost)}</b></>}</span>
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            {editingTs ? (
              // ---- editando una factura ya generada ----
              order.items.length > 0 ? (
                <>
                  <button onClick={resetOrder} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>✕ Cancelar</button>
                  <button onClick={downloadDoc} disabled={pdfBusy} title="Guarda los cambios y descarga la factura actualizada" style={{ ...s.toolBtn, marginLeft: 0 }}>{pdfBusy ? "Generando…" : "⬇ Guardar + PDF"}</button>
                  <button onClick={saveEditChanges} style={{ ...s.pdfBtn, border: "none", cursor: "pointer" }}>💾 Guardar cambios (factura #{order.invoiceNo})</button>
                </>
              ) : <span style={s.askHint}>Agregá al menos un item.</span>
            ) : (
              // ---- armando una orden nueva / pendiente ----
              <>
                {order.items.length > 0 && <button onClick={resetOrder} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Nueva orden</button>}
                {docType === "factura" && order.items.length > 0 && (
                  <button onClick={registerPastOperation} title="Guarda la operación en PnL y Cuentas sin generar PDF (para operaciones pasadas)" style={{ ...s.toolBtn, marginLeft: 0 }}>Registrar sin PDF</button>
                )}
                {order.items.length > 0
                  ? (docType === "factura"
                      ? <button onClick={downloadDoc} disabled={pdfBusy} style={{ ...s.pdfBtn, ...(pdfBusy ? s.busy : {}), border: "none", cursor: pdfBusy ? "default" : "pointer" }}>
                          {pdfBusy ? "Generando…" : "⬇ Descargar Factura PDF"}
                        </button>
                      : <button onClick={downloadSupplierRemitos} disabled={pdfBusy} title="Un archivo por proveedor (sin precios ni cliente, con dirección de entrega)"
                          style={{ ...s.pdfBtn, ...(pdfBusy ? s.busy : {}), border: "none", cursor: pdfBusy ? "default" : "pointer" }}>
                          {pdfBusy ? "Generando…" : `⬇ Descargar Remitos por proveedor (${remitoGroups.length})`}
                        </button>)
                  : <span style={s.askHint}>Agregá al menos un item para generar (cliente y envío son opcionales).</span>}
              </>
            )}
          </span>
        </div>
      </section>
      </div>
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
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 12, color: "#cfd6e4", cursor: "pointer" }} title="Con cuenta corriente: se envía directo y queda en la cuenta. Sin cuenta: paga primero y después se envía.">
                <input type="checkbox" checked={!!clientForm.cuentaCorriente} onChange={(e) => setClientField("cuentaCorriente", e.target.checked)} />
                Tiene cuenta corriente
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
      )}

      {view === "cuentas" && (
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
                        <button onClick={() => loadInvoiceForEdit(h)} style={{ ...s.miniBtn, borderColor: "#3a5", color: "#8ee0a8" }} title="Editar esta factura (items, colores, cantidades, cliente, envío)">✏️ Editar</button>{" "}
                        <button onClick={() => downloadFromHistory(h, "factura")} disabled={pdfBusy} style={s.miniBtn} title="Factura (con precios)">Factura</button>{" "}
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

      {/* Chatbox / asistente — global, en todas las pestañas */}
      {!isMobile && chatBox}
      {!isMobile && !chatOpen && (
        <button onClick={() => setChatOpen(true)} title="Abrir asistente" style={s.chatReopen}>💬 Asistente</button>
      )}

      {/* Modal: confirmar carga de precios del agente */}
      {pendingPriceLoad && (
        <div style={s.modalOverlay} onClick={() => setPendingPriceLoad(null)}>
          <div style={s.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={s.newHead}>💲 Cargar precios de <b>{pendingPriceLoad.supplier}</b> — revisá antes de guardar</div>
            <table style={s.invTable}>
              <thead><tr>
                <th style={{ ...s.invTh, textAlign: "left" }}>Modelo</th>
                <th style={s.invTh}>Actual</th><th style={s.invTh}>Nuevo</th><th style={s.invTh}>Δ%</th><th style={{ ...s.invTh, textAlign: "left" }}>Escala</th>
              </tr></thead>
              <tbody>
                {pendingPriceLoad.rows.map((r) => (
                  <tr key={r.sku} style={r.big ? { background: "#2a1f0f" } : undefined}>
                    <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4" }}>{r.big ? "⚠ " : ""}{r.sku}</td>
                    <td style={{ ...s.invTd, color: "#9aa4b2" }}>{r.oldPrice != null ? money(r.oldPrice) : "—"}</td>
                    <td style={{ ...s.invTd, color: "#fbbf24" }}>{money(r.newPrice)}</td>
                    <td style={{ ...s.invTd, color: r.big ? "#f87171" : "#8b94a7" }}>{r.pct == null ? "nuevo" : `${r.pct > 0 ? "+" : ""}${r.pct}%`}</td>
                    <td style={{ ...s.invTd, textAlign: "left", color: "#c084fc", fontSize: 11 }}>{r.tiers ? r.tiers.map((t) => `${t.min}+→$${t.price}`).join(" · ") : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pendingPriceLoad.newModels?.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#e6d8b8" }}>🆕 Modelos fuera del catálogo (se confirman aparte): {pendingPriceLoad.newModels.map((m) => m.name).join(", ")}</div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={() => setPendingPriceLoad(null)} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Cancelar</button>
              <button onClick={confirmPriceLoad} style={{ ...s.pdfBtn, border: "none", cursor: "pointer" }}>✓ Confirmar y guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: confirmación del agente (revisor + resumen) antes de generar */}
      {pendingAgentCommit && (
        <div style={s.modalOverlay} onClick={() => setPendingAgentCommit(null)}>
          <div style={s.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={s.newHead}>{pendingAgentCommit.kind === "invoice" ? "🧾 Revisá antes de generar la FACTURA" : "📦 Revisá antes de generar los REMITOS"}</div>
            <div style={{ fontSize: 12.5, color: "#cfd6e4", marginBottom: 8 }}>
              Cliente: <b>{pendingAgentCommit.summary.cliente}</b> · Fecha: {pendingAgentCommit.summary.fecha}
              {pendingAgentCommit.kind === "invoice" && <> · Venta <b style={{ color: "#fbbf24" }}>{money(pendingAgentCommit.summary.venta)}</b> · Costo {money(pendingAgentCommit.summary.costo)} · Margen <b style={{ color: "#4ade80" }}>{money(pendingAgentCommit.summary.margen)}</b></>}
            </div>
            <table style={s.invTable}>
              <thead><tr>
                <th style={s.invTh}>Cant.</th><th style={{ ...s.invTh, textAlign: "left" }}>Modelo</th><th style={{ ...s.invTh, textAlign: "left" }}>Color</th><th style={{ ...s.invTh, textAlign: "left" }}>Prov.</th>
                {pendingAgentCommit.kind === "invoice" && <><th style={s.invTh}>Costo</th><th style={s.invTh}>Precio</th></>}
              </tr></thead>
              <tbody>
                {pendingAgentCommit.summary.lineas.map((l, i) => (
                  <tr key={i}>
                    <td style={s.invTd}>{l.cantidad}</td>
                    <td style={{ ...s.invTd, textAlign: "left", color: "#cfd6e4" }}>{l.modelo}</td>
                    <td style={{ ...s.invTd, textAlign: "left" }}>{l.color || "—"}</td>
                    <td style={{ ...s.invTd, textAlign: "left" }}>{l.proveedor || "—"}</td>
                    {pendingAgentCommit.kind === "invoice" && <><td style={{ ...s.invTd, color: "#9aa4b2" }}>{money(l.costo)}</td><td style={{ ...s.invTd, color: "#fbbf24" }}>{money(l.precio)}</td></>}
                  </tr>
                ))}
              </tbody>
            </table>
            {pendingAgentCommit.issues.length > 0 && (
              <div style={{ marginTop: 10, background: "#2a1f0f", border: "1px solid #5a4a1d", borderRadius: 6, padding: "8px 10px", fontSize: 12, color: "#e6d8b8" }}>
                <b>⚠ El revisor marcó:</b>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{pendingAgentCommit.issues.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={() => setPendingAgentCommit(null)} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Cancelar</button>
              <button onClick={confirmAgentCommit} style={{ ...s.pdfBtn, border: "none", cursor: "pointer" }}>✓ Confirmar y generar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: confirmar CUALQUIER borrado pedido por el agente (factura, pedido, cliente, envío, proveedor) */}
      {pendingDelete && (
        <div style={s.modalOverlay} onClick={() => setPendingDelete(null)}>
          <div style={{ ...s.modalCard, width: "min(460px, 96vw)" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ ...s.newHead, color: "#f0a0a0" }}>🗑️ {pendingDelete.titulo}</div>
            {pendingDelete.detalle && (
              <div style={{ fontSize: 12.5, color: "#cfd6e4", marginBottom: 10 }}>{pendingDelete.detalle}</div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setPendingDelete(null)} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>Cancelar</button>
              <button onClick={confirmDelete} style={{ ...s.pdfBtn, border: "none", cursor: "pointer", background: "#b91c1c" }}>🗑️ Borrar</button>
            </div>
          </div>
        </div>
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

