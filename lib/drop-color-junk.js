// Borra filas del catálogo que son variantes de color SIN precio: proliferación del parser
// ("G06 4GB+64GB Tendril (Naranja)"). En este app el color NO es un modelo aparte, y una fila de
// color sin precio no aporta nada — el modelo base es el que vale. Solo borra las SIN precio: una
// variante de color CON precio (ej. un iPhone Orange que difiere) se conserva. Idempotente. PURO.

const COLOR_RE = /\b(orange|naranja|blue|azul|silver|plata|plateado|black|negro|white|blanco|green|verde|pink|rosa|gold|dorado|gray|grey|purple|violeta|violet|red|rojo|teal|midnight|starlight|titanium|desert|natural|sage|mist|lavender|cream|ultramarine|cosmic|graphite|charcoal|arabesque|tapestry|tendril)\b/i;
const hasPrice = (prices, n) => { const p = prices[n]; return !!p && Object.values(p).some((v) => typeof v === "number"); };

export function dropColorJunk({ catalog = [], prices = {}, times = {}, tiers = {}, lista = {}, hiddenModels = [] }) {
  const rm = new Set();
  for (const c of catalog) if (!hasPrice(prices, c.name) && COLOR_RE.test(c.name)) rm.add(c.name);
  if (rm.size === 0) return { catalog, prices, times, tiers, lista, hiddenModels, changed: false, deleted: [] };
  const strip = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => !rm.has(k)));
  return {
    catalog: catalog.filter((c) => !rm.has(c.name)),
    prices: strip(prices), times: strip(times), tiers: strip(tiers), lista: strip(lista),
    hiddenModels: hiddenModels.filter((n) => !rm.has(n)),
    changed: true, deleted: [...rm],
  };
}
