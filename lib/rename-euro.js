// Renombra los Motorola EURO a un nombre consistente y legible: "Motorola <modelo> <cap> EURO".
// Antes eran códigos EU ("XT2535 G06 4+256") o sufijo entre paréntesis ("Motorola G06 4+64 (EURO)").
// El sufijo " EURO" va SIN paréntesis a propósito: skuKey borra lo que está entre paréntesis, así
// que "(EURO)" colisionaría con el LATIN homónimo y el dedup los fusionaría; " EURO" sobrevive y
// los mantiene separados. Los 4 con código XT viven en el CATÁLOGO BASE (ya renombrado en el
// código); acá SOLO se mueven sus claves de precio/escala/lista/historial en la DB. Idempotente.

export function euroName(name) {
  let s = String(name ?? "").trim();
  s = s.replace(/^xt\d+\s+/i, "");             // sacar el código EU "XT2535 "
  s = s.replace(/\s*\(\s*euro\s*\)\s*/i, " ");  // sacar "(EURO)"
  s = s.replace(/\s+euro\s*$/i, " ");           // sacar "EURO" final (se reañade)
  s = s.replace(/\s{2,}/g, " ").trim();
  if (!/^motorola\b/i.test(s)) s = "Motorola " + s;
  return s + " EURO";
}

// Mapa de los que están en el catálogo BASE (código EU) → nombre nuevo. La entrada del catálogo se
// renombra en price-logic.js; acá se mueven las claves de la DB que siguen bajo el nombre viejo.
const EURO_RENAMES = {
  "XT2535 G06 4+256": "Motorola G06 4+256 EURO",
  "XT2527 G86 8+256 5G": "Motorola G86 8+256 5G EURO",
  "XT2505 Edge 60 8+256": "Motorola Edge 60 8+256 EURO",
  "XT2509 Edge 60 Neo 12+256": "Motorola Edge 60 Neo 12+256 EURO",
  "Motorola G06 4+64 (EURO)": "Motorola G06 4+64 EURO",
};

export function renameMotorolaEuro({ catalog = [], prices = {}, times = {}, tiers = {}, lista = {}, priceHistory = [] }) {
  const present = (from) =>
    from in prices || from in times || from in tiers || from in lista ||
    catalog.some((c) => c.name === from) || priceHistory.some((r) => r.sku === from);
  const pairs = new Map();
  for (const [from, to] of Object.entries(EURO_RENAMES)) if (present(from)) pairs.set(from, to);
  // regla: cualquier fila EURO del catálogo con nombre no-canónico (cubre futuras cargas)
  for (const c of catalog) {
    if (c.cat !== "Motorola EURO") continue;
    const to = euroName(c.name);
    if (to && to !== c.name) pairs.set(c.name, to);
  }
  if (pairs.size === 0) return { catalog, prices, times, tiers, lista, priceHistory, changed: false, renames: [] };

  const renames = [...pairs.entries()];
  const newCatalog = catalog.map((c) => (pairs.has(c.name) ? { ...c, name: pairs.get(c.name) } : c));
  const moveObj = (obj) => { let n = obj, hit = false; for (const [from, to] of renames) { if (!(from in n)) continue; if (!hit) { n = { ...n }; hit = true; } n[to] = { ...(n[from] || {}), ...(n[to] || {}) }; delete n[from]; } return n; };
  const moveScalar = (obj) => { let n = obj, hit = false; for (const [from, to] of renames) { if (!(from in n)) continue; if (!hit) { n = { ...n }; hit = true; } if (!(to in n)) n[to] = n[from]; delete n[from]; } return n; };
  const newHistory = priceHistory.map((r) => (pairs.has(r.sku) ? { ...r, sku: pairs.get(r.sku) } : r));
  return {
    catalog: newCatalog,
    prices: moveObj(prices), times: moveObj(times), tiers: moveObj(tiers), lista: moveScalar(lista),
    priceHistory: newHistory, changed: true, renames,
  };
}
