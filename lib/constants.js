// Constantes compartidas del Price Desk: claves de localStorage, etapas de pedido,
// categorías del catálogo y códigos de proveedor. Sin dependencias de React.

export const PRICES_KEY = "desk-prices-v1";
export const LISTA_KEY = "desk-lista-v1";
export const MARGIN_KEY = "desk-margin-v1";
export const SNAP_KEY = "desk-snapshots-v1";
export const TIMES_KEY = "desk-times-v1";
export const CLIENTS_KEY = "desk-clients-v1";
export const SHIPS_KEY = "desk-ships-v1";
export const HIST_KEY = "desk-invoices-v1";
export const CAT_KEY = "desk-extra-catalog-v1";
export const LEDGER_KEY = "desk-ledger-v1";
export const SUPP_KEY = "desk-suppliers-v1";
export const ALIASES_KEY = "desk-aliases-v1";
export const TIERS_KEY = "desk-tiers-v1";
export const PHIST_KEY = "desk-price-history-v1";
export const DRAFTS_KEY = "desk-drafts-v1";

// Un pedido pendiente se auto-borra si queda SIN TOCARSE más de esto (por inactividad, no por creación).
// El pedido ACTIVO nunca se borra. Cambiá el número si querés darle más/menos margen.
export const DRAFT_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

// Etapas de un pedido (seguimiento del progreso). El id se guarda en order.stage.
export const ORDER_STAGES = [
  { id: "cotizando", label: "Cotizando", emoji: "💬" },
  { id: "negociando", label: "Negociando proveedor", emoji: "🤝" },
  { id: "confirmada", label: "Confirmada", emoji: "✅" },
  { id: "esperando_pago", label: "Esperando pago", emoji: "💰" },
  { id: "a_enviar", label: "A enviar", emoji: "📦" },
  { id: "enviada", label: "Enviada", emoji: "🚚" },
];
export const stageInfo = (id) => ORDER_STAGES.find((x) => x.id === id) || ORDER_STAGES[0];

// Categorías válidas para nuevos modelos.
export const CATEGORIES = ["Samsung", "Motorola LATIN", "Motorola EURO"];

export const COMPANY = { name: "PHOTO IMAGEN & VIDEO EXPORT LLC" };

// códigos cortos de proveedor para el nombre del archivo del remito
export const SUPPLIER_CODES = { planet: "PL", mirgor: "Mir", bax: "Bax", baxcell: "Bax", vitel: "Vit", sh: "SH" };
export function supplierCode(name) {
  const key = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return SUPPLIER_CODES[key] || String(name || "").replace(/[^\w-]+/g, "_") || "prov";
}

export const MONTHS_ES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
