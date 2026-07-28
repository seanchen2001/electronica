// Elimina modelos "sombra": una fila del catálogo SIN precio cuyo nombre —quitando la marca
// líder (Motorola/Samsung/Galaxy/Xiaomi/Redmi/…) y la puntuación— coincide con OTRO modelo que
// SÍ tiene precio. Son duplicados por formato de nombre (ej. "G06 4+128" cat=Samsung sin precio,
// sombra de "Motorola G06 4+128" con precio). No se pierde nada: la sombra no tenía datos. PURO.

const LEAD_BRAND = /^(motorola|samsung|galaxy|xiaomi|redmi|poco|apple|iphone)\s+/i;
function brandKey(name) {
  let s = String(name ?? "").toLowerCase().trim();
  s = s.replace(LEAD_BRAND, "").replace(LEAD_BRAND, ""); // hasta 2 ("samsung galaxy s26")
  return s.replace(/[^a-z0-9]/g, "");
}
const priced = (prices, m) => { const p = prices[m]; return !!p && Object.values(p).some((v) => typeof v === "number"); };

/** Devuelve { catalog, prices, times, tiers, lista, hiddenModels, changed, removed:[{name,twin}] } */
export function dedupePricelessShadows({ catalog = [], prices = {}, times = {}, tiers = {}, lista = {}, hiddenModels = [] }) {
  // brandKey → nombre de un modelo CON precio (el "canónico" que se queda)
  const pricedKeys = new Map();
  for (const name of new Set([...Object.keys(prices), ...catalog.map((c) => c.name)])) {
    if (!priced(prices, name)) continue;
    const k = brandKey(name);
    if (!pricedKeys.has(k)) pricedKeys.set(k, name);
  }
  // candidatos: fila del catálogo sin precio cuyo brandKey tiene un twin CON precio y OTRO nombre
  const removed = [];
  for (const c of catalog) {
    if (priced(prices, c.name)) continue;
    const twin = pricedKeys.get(brandKey(c.name));
    if (twin && twin !== c.name) removed.push({ name: c.name, twin });
  }
  if (removed.length === 0) return { catalog, prices, times, tiers, lista, hiddenModels, changed: false, removed: [] };

  const rm = new Set(removed.map((r) => r.name));
  const strip = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => !rm.has(k)));
  return {
    catalog: catalog.filter((c) => !rm.has(c.name)),
    prices: strip(prices), times: strip(times), tiers: strip(tiers), lista: strip(lista),
    hiddenModels: hiddenModels.filter((n) => !rm.has(n)),
    changed: true, removed,
  };
}
