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
import PnLView from "./components/PnLView.jsx";
import HistorialView from "./components/HistorialView.jsx";
import ClientesView from "./components/ClientesView.jsx";
import CuentasView from "./components/CuentasView.jsx";
import PriceLoadModal from "./components/modals/PriceLoadModal.jsx";
import AgentCommitModal from "./components/modals/AgentCommitModal.jsx";
import DeleteModal from "./components/modals/DeleteModal.jsx";
import NewModelsModal from "./components/modals/NewModelsModal.jsx";
import ChatBox from "./components/ChatBox.jsx";
import MesaView from "./components/MesaView.jsx";
import OrdenesView from "./components/OrdenesView.jsx";
import {
  PRICES_KEY, LISTA_KEY, MARGIN_KEY, SNAP_KEY, TIMES_KEY, CLIENTS_KEY, SHIPS_KEY,
  HIST_KEY, CAT_KEY, LEDGER_KEY, SUPP_KEY, ALIASES_KEY, TIERS_KEY, PHIST_KEY, DRAFTS_KEY,
  TRASH_KEY, TRASH_TTL_MS,
  DRAFT_TTL_MS, ORDER_STAGES, stageInfo, CATEGORIES, DEPTS, DEFAULT_DEPT, COMPANY, supplierCode, MONTHS_ES,
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
import { computeAccounts, canonName } from "./lib/accounts.js";
import { analyticsData, analyticsSummary } from "./lib/analytics.js";
import AnaliticaView from "./components/AnaliticaView.jsx";
import TrashPanel from "./components/TrashPanel.jsx";

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
  const [selectedDept, setSelectedDept] = useState(DEFAULT_DEPT); // departamento activo en la Mesa (Teléfonos / iPhone / Laptops / …)
  // catálogo dinámico: base (fijo) + modelos agregados por el usuario
  const [extraCatalog, setExtraCatalog] = useState(() => load(CAT_KEY, []));
  const [hiddenModels, setHiddenModels] = useState(() => load("desk-hidden-models-v1", [])); // modelos base ocultados (borrar/renombrar/unificar)
  // proveedores editables (sembrados de la constante, se pueden agregar/sacar)
  const [supplierList, setSupplierList] = useState(() => load(SUPP_KEY, SUPPLIERS));
  const [supplierDepts, setSupplierDepts] = useState(() => load("desk-supplier-depts-v1", {})); // proveedor -> [departamentos] (qué columnas aparecen en cada depto)
  const [newSupplier, setNewSupplier] = useState("");
  // Orden por categoría (estable): junta todos los de una misma categoría, aunque se hayan
  // agregado después. Si no, los modelos nuevos quedan en una sección aparte al final.
  const catalog = useMemo(() => {
    const hidden = new Set(hiddenModels);
    const extraByName = new Map(extraCatalog.map((c) => [c.name, c]));
    const baseNames = new Set(CATALOG.map((c) => c.name));
    const merged = [];
    const seen = new Set(); // dedup por nombre: cada modelo aparece UNA sola vez
    const push = (c) => { if (!hidden.has(c.name) && !seen.has(c.name)) { seen.add(c.name); merged.push(c); } };
    // modelos base (con override de categoría si hay un extra del mismo nombre), salvo los ocultados
    for (const c of CATALOG) push(extraByName.get(c.name) || c);
    // modelos agregados que no pisan a uno base
    for (const c of extraCatalog) { if (!baseNames.has(c.name)) push(c); }
    const idx = (c) => { const i = CATEGORIES.indexOf(c.cat); return i < 0 ? CATEGORIES.length : i; };
    // cada modelo tiene departamento (default Teléfonos) y categoría; ordenar por categoría y, dentro, por nombre
    // (defensivo: hay registros viejos sin cat/nombre → String(... || "") para no romper el render)
    return merged.map((c) => ({ ...c, cat: c.cat || "Otros", dept: c.dept || DEFAULT_DEPT }))
      .sort((a, b) => (idx(a) - idx(b)) || String(a.cat || "").localeCompare(String(b.cat || "")) || String(a.name || "").localeCompare(String(b.name || ""), "en", { numeric: true }));
  }, [extraCatalog, hiddenModels]);
  // departamentos disponibles: los fijos + los que existan en el catálogo (para que aparezca la pestaña)
  const deptList = useMemo(() => [...new Set([...DEPTS, ...catalog.map((c) => c.dept)])], [catalog]);
  const catalogNames = useMemo(() => catalog.map((c) => c.name), [catalog]);
  const parseSystem = useMemo(() => buildParseSystem(catalog.map((c) => `${c.name}  [${c.cat}]`)), [catalog]);
  const markSystem = useMemo(() => buildMarkSystem(catalog.map((c) => `${c.name}  [${c.cat}]`)), [catalog]);
  const [pendingNew, setPendingNew] = useState([]); // sugerencias de modelos nuevos a confirmar
  const [prices, setPrices] = useState(() => load(PRICES_KEY, {}));
  const [tiers, setTiers] = useState(() => load(TIERS_KEY, {})); // escalas por cantidad: tiers[sku][sup] = [{min,price}]
  // proveedores del departamento activo: los que YA tienen algún precio cargado ahí (auto por uso).
  // Si el depto todavía no tiene precios, mostramos todos para poder empezar a cargar. (después de `prices`, evita TDZ)
  const deptSuppliers = useMemo(() => {
    const skus = catalog.filter((c) => c.dept === selectedDept).map((c) => c.name);
    const hasPrice = (sp) => skus.some((sku) => typeof prices[sku]?.[sp] === "number");
    const serving = supplierList.filter((sp) => {
      const assigned = supplierDepts[sp];
      if (Array.isArray(assigned) && assigned.length) return assigned.includes(selectedDept); // asignación explícita manda
      return hasPrice(sp); // sin asignar → aparece donde tenga precios (auto por uso)
    });
    return serving.length ? serving : supplierList; // depto sin proveedores aún → todos (para poder arrancar)
  }, [catalog, selectedDept, supplierList, prices, supplierDepts]);
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
  // papelero: copia completa de lo borrado (24 h) — items {id, kind, data, deletedAt}
  const [trash, setTrash] = useState(() => load(TRASH_KEY, []));
  const [undoToast, setUndoToast] = useState(null); // { label, ids } — toast "Borrado X · Deshacer"
  const [trashOpen, setTrashOpen] = useState(false); // panel Papelero
  const undoTimer = useRef();
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
  useEffect(() => { try { localStorage.setItem("desk-hidden-models-v1", JSON.stringify(hiddenModels)); } catch {} }, [hiddenModels]);
  useEffect(() => { try { localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger)); } catch {} }, [ledger]);
  useEffect(() => { try { localStorage.setItem(SUPP_KEY, JSON.stringify(supplierList)); } catch {} }, [supplierList]);
  useEffect(() => { try { localStorage.setItem("desk-supplier-depts-v1", JSON.stringify(supplierDepts)); } catch {} }, [supplierDepts]);
  useEffect(() => { try { localStorage.setItem(ALIASES_KEY, JSON.stringify(aliases)); } catch {} }, [aliases]);
  useEffect(() => { try { localStorage.setItem(TIERS_KEY, JSON.stringify(tiers)); } catch {} }, [tiers]);
  useEffect(() => { try { localStorage.setItem(PHIST_KEY, JSON.stringify(priceHistory)); } catch {} }, [priceHistory]);
  useEffect(() => { try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch {} }, [drafts]);
  useEffect(() => { try { localStorage.setItem(TRASH_KEY, JSON.stringify(trash)); } catch {} }, [trash]);

  // ---- sync con la base (Supabase, opcional) ----
  const dbReady = useRef(false);
  const dbOn = useRef(false);
  const storeLoaded = useRef(false);
  const saveTimers = useRef({});
  // Migración (una vez, tras cargar la DB): el precio base de un modelo con escala pasa a ser
  // el del escalón MÁS BARATO. Así la Mesa/Mín/Medio/Client/Lista muestran el mejor precio, no el de comprar poco.
  const tiersMigrated = useRef(false);
  useEffect(() => {
    if (tiersMigrated.current) return;
    if (!tiers || !Object.keys(tiers).length) return;
    let changed = false;
    const next = { ...prices };
    for (const sku of Object.keys(tiers)) {
      for (const sup of Object.keys(tiers[sku] || {})) {
        const t = tiers[sku][sup];
        if (!Array.isArray(t) || t.length < 2) continue;
        const cheap = Math.min(...t.map((x) => x.price).filter((p) => typeof p === "number"));
        if (Number.isFinite(cheap) && next[sku]?.[sup] !== cheap) { next[sku] = { ...(next[sku] || {}), [sup]: cheap }; changed = true; }
      }
    }
    if (changed) setPrices(next);
    tiersMigrated.current = true;
  }, [tiers]);
  // limpiar duplicados guardados en el catálogo agregado (una vez, tras cargar)
  const catDeduped = useRef(false);
  useEffect(() => {
    if (catDeduped.current) return;
    if (!extraCatalog.length) return;
    const seen = new Set(); const clean = [];
    for (const c of extraCatalog) { if (seen.has(c.name)) continue; seen.add(c.name); clean.push(c); }
    if (clean.length !== extraCatalog.length) setExtraCatalog(clean);
    catDeduped.current = true;
  }, [extraCatalog]);

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
        setHiddenModels((h) => resolve(d.hiddenModels, h, "hiddenModels"));
        setLedger((lg) => resolve(d.ledger, lg, "ledger"));
        setSupplierList((sl) => resolve(d.suppliers, sl, "suppliers"));
        setSupplierDepts((sd) => resolveObj(d.supplierDepts, sd, "supplierDepts"));
        setAliases((al) => resolveObj(d.aliases, al, "aliases"));
        if (!skipObjects) {
          setPrices((p) => resolveObj(d.prices, p, "prices"));
          setTimes((t) => resolveObj(d.times, t, "times"));
          setLista((l) => resolveObj(d.lista, l, "lista"));
          setTiers((t) => resolveObj(d.tiers, t, "tiers"));
          setPriceHistory((h) => resolve(d.priceHistory, h, "priceHistory"));
        }
        setDrafts((x) => resolve(d.drafts, x, "drafts"));
        setTrash((x) => resolve(d.trash, x, "trash"));
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
  useEffect(() => { syncUp("hiddenModels", hiddenModels); }, [hiddenModels]);
  useEffect(() => { syncUp("prices", prices); }, [prices]);
  useEffect(() => { syncUp("times", times); }, [times]);
  useEffect(() => { syncUp("lista", lista); }, [lista]);
  useEffect(() => { syncUp("ledger", ledger); }, [ledger]);
  useEffect(() => { syncUp("suppliers", supplierList); }, [supplierList]);
  useEffect(() => { syncUp("supplierDepts", supplierDepts); }, [supplierDepts]);
  useEffect(() => { syncUp("aliases", aliases); }, [aliases]);
  useEffect(() => { syncUp("tiers", tiers); }, [tiers]);
  useEffect(() => { syncUp("priceHistory", priceHistory); }, [priceHistory]);
  useEffect(() => { syncUp("drafts", drafts); }, [drafts]);
  useEffect(() => { syncUp("trash", trash); }, [trash]);
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
  // ---- papelero (deshacer borrado) ----
  // auto-purga: lo borrado hace más de TRASH_TTL_MS (24 h) se va solo. Corre al abrir y cada 15 min.
  useEffect(() => {
    const purge = () => setTrash((t) => {
      const cutoff = Date.now() - TRASH_TTL_MS;
      const kept = t.filter((x) => (x.deletedAt || 0) > cutoff);
      return kept.length === t.length ? t : kept;
    });
    purge();
    const t = setInterval(purge, 15 * 60 * 1000);
    return () => clearInterval(t);
  }, []);
  // guarda una copia completa ANTES de borrar; devuelve el item del papelero
  function pushTrash(kind, data) {
    const item = { id: uid(), kind, data: clone(data), deletedAt: Date.now() };
    setTrash((t) => [item, ...t].slice(0, 200));
    return item;
  }
  // toast "Borrado X · Deshacer" (~10 s)
  function showUndo(label, items) {
    setUndoToast({ label, ids: items.map((x) => x.id) });
    clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndoToast(null), 10000);
  }
  // helper único (UI + agente): registra en el papelero y muestra el toast
  function trashAndUndo(kind, data, label) { showUndo(label, [pushTrash(kind, data)]); }
  // reinserta según kind en la colección correcta (respetando ids/orden por ts)
  function restoreTrash(id) {
    const item = trash.find((x) => x.id === id);
    if (!item) return;
    const d = item.data;
    if (item.kind === "invoice") setInvoiceHistory((h) => (h.some((x) => x.ts === d.ts) ? h : [d, ...h].sort((a, b) => (b.ts || 0) - (a.ts || 0))));
    else if (item.kind === "draft") setDrafts((ds) => (ds.some((x) => x.id === d.id) ? ds : [d, ...ds]));
    else if (item.kind === "client") setClients((prev) => (prev.some((x) => x.id === d.id) ? prev : [...prev, d]));
    else if (item.kind === "shipping") setShippings((prev) => (prev.some((x) => x.id === d.id) ? prev : [...prev, d]));
    else if (item.kind === "supplier") setSupplierList((l) => (l.includes(d) ? l : [...l, d]));
    else if (item.kind === "ledger") setLedger((lg) => (lg.some((x) => x.id === d.id) ? lg : [d, ...lg].sort((a, b) => (b.ts || 0) - (a.ts || 0))));
    setTrash((t) => t.filter((x) => x.id !== id));
    setUndoToast((u) => (u && u.ids.includes(id) ? (u.ids.length > 1 ? { ...u, ids: u.ids.filter((i) => i !== id) } : null) : u));
  }
  function restoreMany(ids) { ids.forEach(restoreTrash); }
  // etiqueta legible de un item del papelero (para el toast y el panel)
  function trashLabel(item) {
    const d = item.data;
    if (item.kind === "invoice") return `Factura #${d.no} (${d.client || "—"})`;
    if (item.kind === "draft") return `Pedido ${clients.find((c) => c.id === d.clientId)?.name || d.order?.items?.[0]?.sku || "sin cliente"}`;
    if (item.kind === "client") return `Cliente ${d.name}`;
    if (item.kind === "shipping") return `Envío ${d.label || d.notify || ""}`;
    if (item.kind === "supplier") return `Proveedor ${d}`;
    if (item.kind === "ledger") return `Movimiento ${d.type} ${money(Number(d.amount) || 0)} (${d.party})`;
    return item.kind;
  }
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
    () => catalog.filter((c) => c.dept === selectedDept && (!hideEmpty || aggBySku[c.name]?.min != null)),
    [catalog, aggBySku, hideEmpty, selectedDept]
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
    const c = clients.find((x) => x.id === clientForm.id);
    if (c) trashAndUndo("client", c, `cliente ${c.name}`);
    setClients((prev) => prev.filter((x) => x.id !== clientForm.id));
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
    const sh = shippings.find((x) => x.id === shipForm.id);
    if (sh) trashAndUndo("shipping", sh, `envío ${sh.label || sh.notify || ""}`);
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
    trashAndUndo("supplier", name, `proveedor ${name}`);
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
    const d = drafts.find((x) => x.id === id);
    if (d) trashAndUndo("draft", d, `pedido de ${draftClientName(d)}`);
    setDrafts((ds) => ds.filter((x) => x.id !== id));
    if (id === activeId) resetOrder();
  }
  // nombre de cliente de un draft (para mostrar/buscar)
  function draftClientName(d) { return clients.find((c) => c.id === d.clientId)?.name || d.order?.items?.[0]?.sku || "sin cliente"; }

  // ---- cuentas corrientes ----
  // El cálculo vive en lib/accounts.js (computeAccounts); acá solo se memoiza para el lado activo.
  function canon(name) { return canonName(aliases, name); }

  const accounts = useMemo(
    () => computeAccounts({ invoiceHistory, ledger, aliases }, ledgerSide),
    [invoiceHistory, ledger, ledgerSide, aliases]
  );

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
    const e = ledger.find((x) => x.id === id);
    if (e) trashAndUndo("ledger", e, `movimiento ${e.type} ${money(Number(e.amount) || 0)}`);
    setLedger((lg) => lg.filter((x) => x.id !== id));
  }
  function deleteInvoice(ts, no) {
    if (!confirm(`¿Borrar la factura #${no}? Se recalculan cuentas y PnL.`)) return;
    const rec = invoiceHistory.find((x) => x.ts === ts);
    if (rec) trashAndUndo("invoice", rec, `factura #${no}`);
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
  // Analítica (pestaña + tool del agente) — derivada del historial, sin storage propio
  const analytics = useMemo(() => analyticsData({ invoiceHistory }), [invoiceHistory]);

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
          detalle: "Se borran todos los pedidos a medio armar. Quedan 24 h en el Papelero por si te arrepentís.",
          run: () => {
            showUndo(`${n} pedido(s)`, drafts.map((d) => pushTrash("draft", d)));
            setDrafts([]); resetOrder();
            setAgentLog((l) => [...l, { role: "system", text: `🗑️ Borré ${n} pedido(s) pendiente(s).` }]);
          },
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
        run: () => { trashAndUndo("draft", target, `pedido de ${info.cliente}`); setDrafts((ds) => ds.filter((x) => x.id !== target.id)); if (target.id === activeId) resetOrder(); setAgentLog((l) => [...l, { role: "system", text: `🗑️ Borré el pedido de ${info.cliente}.` }]); },
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
      const existing = supplierList.find((s) => s.toLowerCase() === nm.toLowerCase());
      const canon = existing || nm;
      if (!existing) setSupplierList((l) => [...l, nm]);
      // departamentos que atiende (qué columnas aparecen) — opcional
      const depts = Array.isArray(args.depts) ? args.depts.map((d) => String(d).trim()).filter(Boolean) : [];
      if (depts.length) setSupplierDepts((m) => ({ ...m, [canon]: depts }));
      return { ok: true, creado: !existing, proveedor: canon, departamentos: depts.length ? depts : undefined };
    }
    if (name === "set_supplier_depts") {
      const sp = supplierList.find((s) => s.toLowerCase() === String(args.supplier || "").trim().toLowerCase());
      if (!sp) return { ok: false, error: `No encontré el proveedor "${args.supplier}".`, proveedores: supplierList };
      const depts = Array.isArray(args.depts) ? args.depts.map((d) => String(d).trim()).filter(Boolean) : [];
      setSupplierDepts((m) => { const n = { ...m }; if (depts.length) n[sp] = depts; else delete n[sp]; return n; });
      return { ok: true, proveedor: sp, departamentos: depts.length ? depts : "auto (por uso)" };
    }
    // ---- READ: listar clientes / envíos / proveedores ----
    if (name === "list_clients") return { clientes: clients.map((c) => ({ nombre: c.name, direccion: c.address || "", ruc: c.ruc || "", telefono: c.phone || "", cuenta_corriente: !!c.cuentaCorriente })) };
    if (name === "list_shippings") return { envios: shippings.map((sh) => ({ nombre: sh.label || sh.notify, notify: sh.notify || "", direccion: sh.direccion || "", telefono: sh.telefono || "", contacto: sh.contacto || "" })) };
    if (name === "list_suppliers") return { departamentos: deptList, proveedores: supplierList.map((sp) => ({ nombre: sp, departamentos: supplierDepts[sp] || "auto (aparece donde tenga precios)" })) };
    // ---- MODELOS (catálogo): leer / agregar / editar / borrar / unificar ----
    // mover todos los datos de precio (prices/tiers/times/lista/priceHistory) de un SKU a otro
    const migrateSku = (from, to) => {
      const move = (obj, keepExisting) => { if (!(from in obj)) return obj; const n = { ...obj }; n[to] = keepExisting ? { ...(n[to] || {}), ...n[from] } : (n[to] ?? n[from]); delete n[from]; return n; };
      setPrices((p) => move(p, true)); setTiers((t) => move(t, true)); setTimes((t) => move(t, true)); setLista((l) => move(l, false));
      setPriceHistory((h) => h.map((r) => (r.sku === from ? { ...r, sku: to } : r)));
    };
    const clearSku = (sku) => {
      const drop = (obj) => { if (!(sku in obj)) return obj; const n = { ...obj }; delete n[sku]; return n; };
      setPrices(drop); setTiers(drop); setTimes(drop); setLista(drop);
    };
    if (name === "list_models") { const ms = args.dept ? catalog.filter((c) => c.dept === args.dept) : catalog; return { departamentos: deptList, modelos: ms.map((c) => ({ nombre: c.name, categoria: c.cat, departamento: c.dept })) }; }
    if (name === "add_model") {
      const nm = String(args.name || "").trim();
      if (!nm) return { ok: false, error: "Falta el nombre del modelo." };
      const dept = String(args.dept || DEFAULT_DEPT).trim() || DEFAULT_DEPT;
      // en Teléfonos la categoría se valida contra las de Android; en otros departamentos es libre
      const cat = args.cat ? String(args.cat).trim() : (dept === DEFAULT_DEPT ? "Samsung" : dept);
      if (catalog.some((c) => c.name.toLowerCase() === nm.toLowerCase())) return { ok: true, existe: true, modelo: nm };
      setExtraCatalog((c) => [...c, { name: nm, cat, dept }]);
      return { ok: true, creado: true, modelo: nm, categoria: cat, departamento: dept };
    }
    if (name === "edit_model") {
      const cur = catalog.find((c) => c.name.toLowerCase() === String(args.name || "").trim().toLowerCase());
      if (!cur) return { ok: false, error: `No encontré el modelo "${args.name}".`, modelos: catalog.map((c) => c.name).slice(0, 60) };
      const newName = args.newName ? String(args.newName).trim() : cur.name;
      const newCat = args.cat ? String(args.cat).trim() : cur.cat;
      const newDept = args.dept ? String(args.dept).trim() : (cur.dept || DEFAULT_DEPT);
      if (newName.toLowerCase() !== cur.name.toLowerCase() && catalog.some((c) => c.name.toLowerCase() === newName.toLowerCase()))
        return { ok: false, error: `Ya existe "${newName}". Para juntarlos usá merge_models.` };
      const isBase = CATALOG.some((c) => c.name === cur.name);
      if (newName !== cur.name) {
        if (isBase) { setHiddenModels((h) => (h.includes(cur.name) ? h : [...h, cur.name])); setExtraCatalog((l) => [...l.filter((c) => c.name !== cur.name), { name: newName, cat: newCat, dept: newDept }]); }
        else setExtraCatalog((l) => l.map((c) => (c.name === cur.name ? { name: newName, cat: newCat, dept: newDept } : c)));
        migrateSku(cur.name, newName);
      } else {
        // cambia categoría y/o departamento → override
        setExtraCatalog((l) => (l.some((c) => c.name === cur.name) ? l.map((c) => (c.name === cur.name ? { name: cur.name, cat: newCat, dept: newDept } : c)) : [...l, { name: cur.name, cat: newCat, dept: newDept }]));
      }
      return { ok: true, modelo: newName, categoria: newCat, departamento: newDept, renombrado: newName !== cur.name };
    }
    if (name === "delete_model") {
      const cur = catalog.find((c) => c.name.toLowerCase() === String(args.name || "").trim().toLowerCase());
      if (!cur) return { ok: false, error: `No encontré el modelo "${args.name}".`, modelos: catalog.map((c) => c.name).slice(0, 60) };
      setPendingDelete({
        titulo: `¿Borrar el modelo "${cur.name}"?`,
        detalle: "Sale del catálogo. No toca facturas ya hechas.",
        run: () => {
          setExtraCatalog((l) => l.filter((c) => c.name !== cur.name));
          if (CATALOG.some((c) => c.name === cur.name)) setHiddenModels((h) => (h.includes(cur.name) ? h : [...h, cur.name]));
          clearSku(cur.name);
          setAgentLog((l) => [...l, { role: "system", text: `🗑️ Borré el modelo ${cur.name}.` }]);
        },
      });
      return { status: "needs_confirmation", mensaje: `Esperando confirmación para borrar el modelo ${cur.name}.` };
    }
    if (name === "merge_models") {
      const a = catalog.find((c) => c.name.toLowerCase() === String(args.from || "").trim().toLowerCase());
      const b = catalog.find((c) => c.name.toLowerCase() === String(args.into || "").trim().toLowerCase());
      if (!a || !b) return { ok: false, error: "Alguno de los dos modelos no existe.", modelos: catalog.map((c) => c.name).slice(0, 60) };
      if (a.name === b.name) return { ok: false, error: "Son el mismo modelo." };
      setPendingDelete({
        titulo: `¿Unificar "${a.name}" dentro de "${b.name}"?`,
        detalle: `Los precios de ${a.name} se pasan a ${b.name} (gana ${b.name} si hay conflicto) y ${a.name} se elimina.`,
        run: () => {
          migrateSku(a.name, b.name);
          setExtraCatalog((l) => l.filter((c) => c.name !== a.name));
          if (CATALOG.some((c) => c.name === a.name)) setHiddenModels((h) => (h.includes(a.name) ? h : [...h, a.name]));
          setAgentLog((l) => [...l, { role: "system", text: `🔗 Unifiqué ${a.name} → ${b.name}.` }]);
        },
      });
      return { status: "needs_confirmation", mensaje: `Esperando confirmación para unificar ${a.name} → ${b.name}.` };
    }
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
        run: () => { trashAndUndo("client", t, `cliente ${t.name}`); setClients((prev) => prev.filter((c) => c.id !== t.id)); setAgentLog((l) => [...l, { role: "system", text: `🗑️ Borré el cliente ${t.name}.` }]); },
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
        run: () => { trashAndUndo("shipping", t, `envío ${tn}`); setShippings((prev) => prev.filter((x) => x.id !== t.id)); setAgentLog((l) => [...l, { role: "system", text: `🗑️ Borré el envío ${tn}.` }]); },
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
        run: () => { trashAndUndo("supplier", t, `proveedor ${t}`); setSupplierList((l) => l.filter((s) => s !== t)); setAgentLog((l) => [...l, { role: "system", text: `🗑️ Borré el proveedor ${t}.` }]); },
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
        detalle: `Cliente: ${rec.client || "—"} · Total ${money(rec.total)}. Se recalculan cuentas corrientes y PnL. Queda 24 h en el Papelero.`,
        run: () => { trashAndUndo("invoice", rec, `factura #${rec.no}`); setInvoiceHistory((h) => h.filter((x) => x.ts !== rec.ts)); setAgentLog((l) => [...l, { role: "system", text: `🗑️ Borré la factura #${rec.no}. Se recalcularon cuentas y PnL.` }]); },
      });
      return { status: "needs_confirmation", mensaje: `Le pedí al usuario que confirme borrar la factura #${rec.no} (${rec.client || "—"}, ${money(rec.total)}).` };
    }
    if (name === "analytics_summary") {
      return analyticsSummary({ invoiceHistory, ledger }, args.period || "mes");
    }
    // ---- CUENTAS: consultar saldos y registrar movimientos por chat ----
    if (name === "list_accounts") {
      const side = /prov|supp/i.test(String(args.side || "")) ? "supplier" : "client";
      const accs = computeAccounts({ invoiceHistory, ledger, aliases }, side);
      const cuentas = Object.values(accs)
        .map((a) => ({ cuenta: a.party, saldo: +a.saldo.toFixed(2) }))
        .sort((x, y) => y.saldo - x.saldo);
      return {
        side, perspectiva: side === "client" ? "saldo = lo que NOS DEBE cada cliente" : "saldo = lo que LE DEBEMOS a cada proveedor",
        cuentas, total: +cuentas.reduce((a, c) => a + c.saldo, 0).toFixed(2),
      };
    }
    if (name === "account_balance") {
      const side = /prov|supp/i.test(String(args.side || "")) ? "supplier" : "client";
      const accs = computeAccounts({ invoiceHistory, ledger, aliases }, side);
      const q = canon(String(args.party || "").trim()).toLowerCase();
      const hit = Object.keys(accs).find((n) => n.toLowerCase() === q) || Object.keys(accs).find((n) => n.toLowerCase().includes(q));
      if (!q || !hit) return { ok: false, error: `No encontré la cuenta "${args.party}" del lado ${side}.`, cuentas: Object.keys(accs) };
      const acc = accs[hit];
      return {
        cuenta: acc.party, side, saldo: +acc.saldo.toFixed(2),
        perspectiva: side === "client" ? "saldo = lo que NOS DEBE" : "saldo = lo que LE DEBEMOS",
        ultimos_movimientos: acc.rows.slice(-10).map((m) => ({ fecha: m.date, concepto: m.concept, ref: m.ref || "", cargo: m.cargo || 0, pago: m.pago || 0, saldo: +m.saldo.toFixed(2) })),
      };
    }
    if (name === "add_ledger_entry") {
      const side = /prov|supp/i.test(String(args.side || "")) ? "supplier" : "client";
      const party = canon(String(args.party || "").trim());
      if (!party || party === "—") return { ok: false, error: "Falta la parte (cliente/proveedor) del movimiento." };
      const amt = Number(args.amount) || 0;
      if (amt <= 0) return { ok: false, error: "El monto tiene que ser mayor a 0." };
      const type = ["pago", "gasto", "cargo"].includes(args.type) ? args.type : "pago";
      // mismo shape que registerPay (el form manual de la pestaña Cuentas)
      const entry = {
        id: uid(), ts: Date.now(), side, party,
        type, amount: amt, concept: String(args.concept || "").trim() || (type === "pago" ? "Pago" : type === "gasto" ? "Gasto envío proveedor" : "Cargo"),
        date: args.date || today(), ref: "",
      };
      setLedger((lg) => [entry, ...lg]);
      const accs = computeAccounts({ invoiceHistory, ledger: [entry, ...ledger], aliases }, side);
      const saldo = accs[party]?.saldo;
      setAgentLog((l) => [...l, { role: "system", text: `💰 Registré ${type} de ${money(amt)} en la cuenta de ${party}.` }]);
      return {
        ok: true, movimiento: { party, side, type, amount: amt, concept: entry.concept, date: entry.date },
        nuevo_saldo: saldo != null ? +saldo.toFixed(2) : null,
        nota: "Aplicado directo (reversible borrando la entrada en la pestaña Cuentas).",
      };
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


  // chatbox unificado de escritorio (a la derecha, colapsable)
  const busyChat = asking || parsing || agentBusy;
  const chatBox = (
    <ChatBox
      chatOpen={chatOpen} setChatOpen={setChatOpen} chatScrollRef={chatScrollRef}
      agentLog={agentLog} showSteps={showSteps} setShowSteps={setShowSteps} resetAgent={resetAgent} agentBusy={agentBusy}
      chatText={chatText} setChatText={setChatText} chatImage={chatImage} setChatImage={setChatImage}
      onChatPaste={onChatPaste} submitChat={submitChat} busyChat={busyChat} />
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
        <button onClick={() => setView("analitica")} style={{ ...s.viewTab, ...(view === "analitica" ? s.viewTabOn : {}) }}>🧮 Analítica</button>
        <button onClick={() => setView("historial")} style={{ ...s.viewTab, ...(view === "historial" ? s.viewTabOn : {}) }}>📜 Historial {invoiceHistory.length > 0 ? `(${invoiceHistory.length})` : ""}</button>
        <button onClick={() => setTrashOpen(true)} style={{ ...s.viewTab, marginLeft: "auto" }} title="Lo borrado en las últimas 24 h — se puede restaurar">🗑️ Papelero{trash.length > 0 ? ` (${trash.length})` : ""}</button>
      </div>

      {view === "mesa" && (
        <MesaView
          isMobile={isMobile}
          askMode={askMode} setAskMode={setAskMode} query={query} setQuery={setQuery} asking={asking}
          submitAsk={submitAsk} onAskPaste={onAskPaste} markFromImage={markFromImage}
          answer={answer} answerErr={answerErr} markMsg={markMsg}
          saveSnapshot={saveSnapshot} expireAll={expireAll} snapshots={snapshots} prevSnap={prevSnap}
          loadSeed={loadSeed} prices={prices} tiers={tiers}
          parseSupplier={parseSupplier} setParseSupplier={setParseSupplier} supplierList={supplierList}
          rawText={rawText} setRawText={setRawText} runParse={runParse} parsing={parsing} parseMsg={parseMsg}
          hideEmpty={hideEmpty} setHideEmpty={setHideEmpty} catalog={catalog} visibleCatalog={visibleCatalog}
          deptList={deptList} selectedDept={selectedDept} setSelectedDept={setSelectedDept} deptSuppliers={deptSuppliers}
          selectAll={selectAll} selectPriced={selectPriced} selectNone={selectNone}
          selectedSkus={selectedSkus} selected={selected} toggleSelected={toggleSelected} setSelected={setSelected}
          aggBySku={aggBySku} freshBySku={freshBySku} lista={lista} listaFor={listaFor}
          setListaCell={setListaCell} setCell={setCell} marginNum={marginNum}
          quoteGroups={quoteGroups} quoteSource={quoteSource} changeSource={changeSource}
          copyQuote={copyQuote} copied={copied} quoteOverrides={quoteOverrides}
          baseQuotePrice={baseQuotePrice} setOverride={setOverride} quoteText={quoteText} />
      )}

      {/* Órdenes: inline en su pestaña; cuando editás una factura vieja, flota como modal sobre el Historial (aislado de los pedidos pendientes). */}
      {(view === "ordenes" || editingTs) && (
        <OrdenesView
          editingTs={editingTs} docType={docType} setDocType={setDocType}
          drafts={drafts} activeId={activeId} switchOrder={switchOrder} deleteDraft={deleteDraft} resetOrder={resetOrder}
          clients={clients} orderClientId={orderClientId} setOrderClientId={setOrderClientId} selClient={selClient}
          shippings={shippings} orderShipId={orderShipId} setOrderShipId={setOrderShipId}
          order={order} setOrderField={setOrderField}
          orderQuery={orderQuery} setOrderQuery={setOrderQuery} catalog={catalog} catalogNames={catalogNames}
          addOrderItem={addOrderItem} importMarked={importMarked}
          prices={prices} tiers={tiers} hasTiers={hasTiers} setItem={setItem} setItemSupplier={setItemSupplier}
          splitItem={splitItem} removeItem={removeItem}
          expandedModels={expandedModels} setExpandedModels={setExpandedModels}
          orderPiezas={orderPiezas} orderSubtotal={orderSubtotal} orderCost={orderCost} remitoGroups={remitoGroups}
          downloadDoc={downloadDoc} downloadSupplierRemitos={downloadSupplierRemitos}
          saveEditChanges={saveEditChanges} registerPastOperation={registerPastOperation} pdfBusy={pdfBusy} />
      )}

      {view === "clientes" && (
        <ClientesView
          clients={clients} clientForm={clientForm} setClientField={setClientField}
          loadClient={loadClient} saveClient={saveClient} deleteClient={deleteClient}
          shippings={shippings} shipForm={shipForm} setShipField={setShipField}
          loadShip={loadShip} saveShip={saveShip} deleteShip={deleteShip}
          supplierList={supplierList} newSupplier={newSupplier} setNewSupplier={setNewSupplier}
          addSupplier={addSupplier} removeSupplier={removeSupplier} />
      )}

      {view === "cuentas" && (
        <CuentasView
          ledgerSide={ledgerSide} setLedgerSide={setLedgerSide} ledgerAccount={ledgerAccount} setLedgerAccount={setLedgerAccount}
          totalSaldo={totalSaldo} accounts={accounts} accountNames={accountNames} currentAccount={currentAccount} canon={canon}
          mergeFrom={mergeFrom} setMergeFrom={setMergeFrom} mergeTo={mergeTo} setMergeTo={setMergeTo}
          mergeAccounts={mergeAccounts} aliases={aliases} unmerge={unmerge}
          payForm={payForm} setPayForm={setPayForm} registerPay={registerPay} deleteLedgerEntry={deleteLedgerEntry} />
      )}

      {view === "pnl" && <PnLView pnlView={pnlView} />}

      {view === "analitica" && <AnaliticaView data={analytics} />}

      {view === "historial" && (
        <HistorialView invoiceHistory={invoiceHistory} setInvoiceHistory={setInvoiceHistory}
          loadInvoiceForEdit={loadInvoiceForEdit} downloadFromHistory={downloadFromHistory}
          deleteInvoice={deleteInvoice} pdfBusy={pdfBusy} />
      )}

      {/* Chatbox / asistente — global, en todas las pestañas */}
      {!isMobile && chatBox}
      {!isMobile && !chatOpen && (
        <button onClick={() => setChatOpen(true)} title="Abrir asistente" style={s.chatReopen}>💬 Asistente</button>
      )}

      {/* Modales del agente y de modelos nuevos */}
      <PriceLoadModal pending={pendingPriceLoad} onCancel={() => setPendingPriceLoad(null)} onConfirm={confirmPriceLoad} />
      <AgentCommitModal pending={pendingAgentCommit} onCancel={() => setPendingAgentCommit(null)} onConfirm={confirmAgentCommit} />
      <DeleteModal pending={pendingDelete} onCancel={() => setPendingDelete(null)} onConfirm={confirmDelete} />
      <NewModelsModal pendingNew={pendingNew} editNew={editNew} confirmNew={confirmNew} dismissNew={dismissNew} onClose={() => setPendingNew([])} />

      {/* Papelero: panel + toast "Borrado X · Deshacer" */}
      {trashOpen && <TrashPanel trash={trash} trashLabel={trashLabel} restoreTrash={restoreTrash} onClose={() => setTrashOpen(false)} />}
      {undoToast && undoToast.ids.length > 0 && (
        <div style={{ position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)", background: "#1d2740", border: "1px solid #3a5b8f", color: "#dbe6f7", borderRadius: 8, padding: "10px 14px", zIndex: 1200, display: "flex", gap: 12, alignItems: "center", boxShadow: "0 10px 30px rgba(0,0,0,0.5)", fontSize: 12.5 }}>
          <span>🗑️ Borrado: {undoToast.label}</span>
          <button onClick={() => restoreMany(undoToast.ids)} style={{ background: "#2563eb", border: "none", color: "#fff", padding: "5px 12px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600 }}>Deshacer</button>
          <span style={s.chipX} onClick={() => setUndoToast(null)}>×</span>
        </div>
      )}
    </div>
  );
}

