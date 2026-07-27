// Junta las variedades de iPhone: los colores NO-naranja de un mismo modelo se pliegan en un
// solo modelo "base" (sin color), tomando el MÍNIMO por proveedor; el NARANJA queda aparte
// (cuando el precio difiere, que es lo único que a veces cambia). La basura sin precio (CA,
// Damaged Box, "US SPECS" mal ubicados, combos "Blue/Silver") se descarta.
// PURO: recibe los bloques (catalog/prices/times/tiers/lista) y devuelve las versiones nuevas.

const COLORS = [
  "cosmic orange", "deep blue", "space black", "space gray", "space grey", "sierra blue",
  "natural titanium", "desert titanium", "blue titanium", "black titanium", "white titanium",
  "rose gold", "titanium", "orange", "naranja", "blue", "azul", "silver", "plata", "plateado",
  "black", "negro", "white", "blanco", "green", "verde", "pink", "rosa", "gold", "dorado",
  "gray", "grey", "purple", "violeta", "violet", "red", "rojo", "teal", "midnight", "starlight",
  "desert", "natural", "sage", "mist", "lavender", "cream", "ultramarine",
];
function extractColor(name) {
  const s = String(name ?? "");
  for (const c of COLORS) {
    const re = new RegExp(`\\b${c.replace(/ /g, "\\s+")}\\b`, "i");
    const m = re.exec(s);
    if (m) {
      const base = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/\s{2,}/g, " ").trim();
      if (base) return { color: m[0].toLowerCase(), base };
    }
  }
  return { color: null, base: s.trim() };
}
// nombre base "limpio": sin color, sin "US SPECS", sin "(CA)"/"(Damaged Box)", sin barras sueltas
function cleanBaseName(name) {
  const { base } = extractColor(name);
  return base
    .replace(/\bus\s*specs?\b/gi, "")
    .replace(/\(\s*ca\s*\)/gi, "")
    .replace(/\(\s*damaged box\s*\)/gi, "")
    .replace(/\/\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
const isOrange = (name) => { const { color } = extractColor(name); return !!color && /orange|naranja/.test(color); };
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const isIphone = (name) => /iphone/i.test(name);
const hasPrice = (prices, m) => { const p = prices[m]; return !!p && Object.values(p).some((v) => typeof v === "number"); };

/** min por proveedor entre varios modelos */
function minPerSupplier(prices, names) {
  const out = {};
  for (const n of names) for (const [s, v] of Object.entries(prices[n] || {})) {
    if (typeof v !== "number") continue;
    if (out[s] == null || v < out[s]) out[s] = v;
  }
  return out;
}
/** max (más fresco) por proveedor, solo para los supplier que quedaron en `keepPrices` */
function maxTimePerSupplier(times, names, keepPrices) {
  const out = {};
  for (const n of names) for (const [s, t] of Object.entries(times[n] || {})) {
    if (!(s in keepPrices)) continue;
    if (typeof t !== "number") continue;
    if (out[s] == null || t > out[s]) out[s] = t;
  }
  return out;
}

/**
 * Devuelve { catalog, prices, times, tiers, lista, changed, deleted, mergedInto }.
 * Solo toca modelos iPhone; el resto queda igual.
 */
export function mergeIphoneColors({ catalog = [], prices = {}, times = {}, tiers = {}, lista = {} }) {
  const iphNames = new Set([...Object.keys(prices), ...catalog.map((c) => c.name)].filter(isIphone));
  if (iphNames.size === 0) return { catalog, prices, times, tiers, lista, changed: false, deleted: [], mergedInto: [] };

  // familias por base limpio
  const fams = new Map(); // key → { base, members: [] }
  for (const n of iphNames) {
    const base = cleanBaseName(n);
    const key = norm(base);
    if (!fams.has(key)) fams.set(key, { base, members: [] });
    fams.get(key).members.push(n);
  }

  // target: por familia, base (no-naranja con precio) + base Orange (naranja con precio)
  const newIphPrices = {}, newIphTimes = {}, newIphLista = {};
  const targetNames = new Set();
  const deleted = [], mergedInto = [];
  for (const { base, members } of fams.values()) {
    const nonOrange = members.filter((m) => !isOrange(m) && hasPrice(prices, m));
    const oranges = members.filter((m) => isOrange(m) && hasPrice(prices, m));
    const build = (name, srcs) => {
      if (srcs.length === 0) return;
      const p = minPerSupplier(prices, srcs);
      newIphPrices[name] = p;
      newIphTimes[name] = maxTimePerSupplier(times, srcs, p);
      const ls = srcs.map((s) => lista[s]).filter((v) => typeof v === "number");
      if (ls.length) newIphLista[name] = Math.min(...ls);
      targetNames.add(name);
      if (srcs.length > 1 || srcs[0] !== name) mergedInto.push(`${name} ⟵ ${srcs.join(", ")}`);
    };
    // el naranja queda APARTE solo si difiere en un proveedor compartido; si no, se pliega al base
    const basePrices = minPerSupplier(prices, nonOrange);
    const orangePrices = minPerSupplier(prices, oranges);
    const orangeDiffiere =
      oranges.length > 0 &&
      Object.keys(orangePrices).some((s) => s in basePrices && basePrices[s] !== orangePrices[s]);
    if (orangeDiffiere) {
      build(base, nonOrange);
      build(`${base} Orange`, oranges);
    } else {
      build(base, [...nonOrange, ...oranges]); // naranja == base → una sola fila
    }
    // todo lo que era iPhone y no es un target sobrevive como basura → se elimina
    for (const m of members) if (!targetNames.has(m)) deleted.push(m);
  }

  // reconstruir bloques: sacar TODO lo iPhone viejo, poner los targets nuevos
  const notIph = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => !iphNames.has(k)));
  const newPrices = { ...notIph(prices), ...newIphPrices };
  const newTimes = { ...notIph(times), ...newIphTimes };
  const newTiers = notIph(tiers); // iPhones: sin escala (precio único)
  const newLista = { ...notIph(lista), ...newIphLista };
  // catalog: sacar entradas iPhone, agregar los targets (dept iPhone)
  const newCatalog = catalog.filter((c) => !iphNames.has(c.name));
  for (const name of targetNames) newCatalog.push({ name, cat: "iPhone", dept: "iPhone" });

  const changed = deleted.length > 0 || mergedInto.length > 0 ||
    JSON.stringify(Object.keys(newPrices).filter(isIphone).sort()) !== JSON.stringify([...iphNames].filter((n) => hasPrice(prices, n)).sort());
  return { catalog: newCatalog, prices: newPrices, times: newTimes, tiers: newTiers, lista: newLista, changed, deleted, mergedInto };
}
