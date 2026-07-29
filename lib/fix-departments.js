// Corrige departamentos mal asignados. Idempotente: solo escribe si hay algo para corregir.
//  - Mac/MacBook/iMac → dept "Laptops" (y saca la categoría de teléfono si la tenía).
//  - iPhone fuera del dept "iPhone": con precio → se mueve a iPhone; variante de color SIN precio
//    (Blue/Silver/Orange…) → es basura suelta → se borra.
// PURO: recibe los bloques y devuelve las versiones nuevas.

const isMac = (n) => /\bmac\b|macbook|imac/i.test(String(n ?? ""));
const isIphone = (n) => /iphone/i.test(String(n ?? ""));
const PHONE_CATS = new Set(["Samsung", "Motorola LATIN", "Motorola EURO", "Xiaomi y Redmi"]);
const COLOR_RE = /\b(orange|naranja|blue|azul|silver|plata|plateado|black|negro|white|blanco|green|verde|pink|rosa|gold|dorado|gray|grey|purple|violeta|violet|red|rojo|teal|midnight|starlight|titanium|desert|natural|sage|mist|lavender|cream|ultramarine|cosmic)\b/i;
const hasPrice = (prices, n) => { const p = prices[n]; return !!p && Object.values(p).some((v) => typeof v === "number"); };

export function fixDepartments({ catalog = [], prices = {}, times = {}, tiers = {}, lista = {}, hiddenModels = [] }) {
  const out = [], deleted = [];
  let touched = false;
  for (const c of catalog) {
    const dept = c.dept || "Teléfonos";
    if (isMac(c.name)) {
      const cat = PHONE_CATS.has(c.cat) || !c.cat ? "Mac" : c.cat;
      if (dept === "Laptops" && c.cat === cat) { out.push(c); continue; }
      out.push({ ...c, dept: "Laptops", cat }); touched = true; continue;
    }
    if (isIphone(c.name) && dept !== "iPhone") {
      if (!hasPrice(prices, c.name) && COLOR_RE.test(c.name)) { deleted.push(c.name); touched = true; continue; }
      out.push({ ...c, dept: "iPhone", cat: "iPhone" }); touched = true; continue;
    }
    out.push(c);
  }
  if (!touched) return { catalog, prices, times, tiers, lista, hiddenModels, changed: false, deleted: [] };
  const rm = new Set(deleted);
  const strip = (obj) => (rm.size ? Object.fromEntries(Object.entries(obj).filter(([k]) => !rm.has(k))) : obj);
  return {
    catalog: out,
    prices: strip(prices), times: strip(times), tiers: strip(tiers), lista: strip(lista),
    hiddenModels: hiddenModels.filter((n) => !rm.has(n)),
    changed: true, deleted,
  };
}
