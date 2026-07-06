// Capa de AI (Gemini) del Price Desk: llamadas al modelo, prompts, parseo de
// cotizaciones, matching de modelos y armado de texto de cotización.
// Sin React: lo que necesita estado lo recibe por parámetro.

export const GEMINI_MODEL = "gemini-2.5-flash";

// Shared disambiguation rules: section headers (EURO/LATIN) + base-variant hint.
const DISAMBIG =
  "If the text has section headers like EURO or LATIN, use them to disambiguate (EURO = the 'XT2xxx ...' models; LATIN = the 'Motorola ...' models). A bare base name like 'Edge 60' (no Neo/Fusion/Pro) means the base variant of that section.";

// Prompts se construyen del catálogo (dinámico). El parser devuelve {matched, new}:
// matched = SKU existente -> precio; new = modelos que no están en el catálogo.
export function buildParseSystem(lines) {
  return (
    "You are a price extraction assistant for a phone wholesaler. The user pastes ONE supplier's raw quote (Spanish, messy, with quantities/colors/section headers). Map each model to the closest standard SKU from this EXACT list (category in brackets):\n" +
    lines.join("\n") +
    "\n\nRules:\n- Ignore colors.\n" +
    "- 'price' = the base price = the HIGHEST price (worst / smallest-quantity). This is what goes in 'matched'.\n" +
    "- If a model lists a QUANTITY LADDER (several prices by pieces, e.g. $630 base, $621 for 20, $615 for 21-49, $611 for 50+), ALSO return the full ladder in 'tiers' as [{\"min\": <min qty for that price>, \"price\": N}], including the base as {\"min\":1,\"price\":<base>}. Ascending by min. If there is a single price, omit that SKU from 'tiers'.\n- " + DISAMBIG +
    "\n- For models that clearly do NOT match any SKU in the list, do NOT force them. Put them under \"new\" with a normalized name in the SAME naming style as the list, a category (one of: Samsung, Motorola LATIN, Motorola EURO), and the price (same highest-price rule).\n" +
    'Respond ONLY with JSON: {"matched": {"<exact SKU>": price, ...}, "tiers": {"<exact SKU>": [{"min":1,"price":N},{"min":20,"price":N}], ...}, "new": [{"name": "...", "cat": "...", "price": N}, ...]}. No markdown, no commentary.'
  );
}

export function buildMarkSystem(lines) {
  return (
    "El usuario manda una lista o screenshot de modelos a cotizar (texto libre, español, con precios/colores/cantidades/encabezados). Devolvé SOLO un array JSON con los SKU EXACTOS de esta lista que correspondan (categoría entre corchetes):\n" +
    lines.join("\n") +
    "\n\nReglas: ignorá precios, colores y cantidades. " + DISAMBIG +
    ' Omití solo lo que realmente no puedas mapear. Ejemplo: ["XT2505 Edge 60 8+256", "A17 4+128 DS"]. Sin markdown, sin texto extra.'
  );
}

export const DESK_SYSTEM =
  "You are a trading-desk analyst for a phone wholesaler. Answer using ONLY the supplied JSON data: rows of {sku, cat, prices (per supplier, USD), min, median, client}, the margin %, and optionally a 'previous' snapshot. Be concise and quantitative, cite supplier names, and when asked about changes compare against 'previous'. If the data doesn't cover the question, say so plainly.";

export function stripFences(t) {
  let s = (t || "").trim();
  if (s.startsWith("```")) s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  return s;
}

export const toNum = (v) => {
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.]/g, "")) : v;
  return typeof n === "number" && !Number.isNaN(n) ? n : null;
};

// ---- Gemini ----
// In dev (npm run dev) `apiKey` is your Gemini key → call Google directly.
// In production (Vercel) `apiKey` is the app password → go through the
// /api/gemini proxy, where the real key lives server-side.
export async function callGemini({ system, content, apiKey, maxTokens = 2048, json = false, images = [] }) {
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

// Variante con function-calling: manda la conversación completa + tools y devuelve
// el turno del modelo (content con parts que pueden ser text o functionCall).
export async function callGeminiTools({ system, contents, tools, apiKey, maxTokens = 2048 }) {
  let data;
  if (import.meta.env.DEV) {
    const body = { contents, tools, generationConfig: { temperature: 0, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } } };
    if (system) body.system_instruction = { parts: [{ text: system }] };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    );
    if (!res.ok) { let d = ""; try { d = (await res.json())?.error?.message || ""; } catch {} throw new Error(`Gemini ${res.status}: ${d}`); }
    data = await res.json();
  } else {
    const res = await fetch("/api/gemini", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-password": apiKey || "" },
      body: JSON.stringify({ system, contents, tools, maxTokens, model: GEMINI_MODEL }),
    });
    if (!res.ok) { let d = ""; try { const e = await res.json(); d = e?.error?.message || e?.error || ""; } catch {} throw new Error(`Error ${res.status}: ${d}`); }
    data = await res.json();
  }
  return data.candidates?.[0]?.content || { role: "model", parts: [] };
}

export async function parseSupplierQuote(rawText, apiKey, system, names, images = []) {
  const content = rawText || (images.length ? "Extraé los precios de este screenshot de la cotización del proveedor." : "");
  const text = await callGemini({ system, content, apiKey, json: true, images, maxTokens: 8192 });
  let parsed;
  try { parsed = JSON.parse(stripFences(text)); }
  catch { throw new Error("La respuesta se cortó o vino mal formada (lista muy larga). Probá con menos modelos o de a partes."); }
  const matchedRaw = parsed.matched && typeof parsed.matched === "object" ? parsed.matched : parsed;
  const matched = {};
  for (const sku of names) { const n = toNum(matchedRaw[sku]); if (n != null) matched[sku] = n; }
  // escalas por cantidad (tiers) — solo para SKU con más de un escalón
  const tiersRaw = parsed.tiers && typeof parsed.tiers === "object" ? parsed.tiers : {};
  const tiers = {};
  for (const sku of names) {
    const arr = Array.isArray(tiersRaw[sku]) ? tiersRaw[sku] : null;
    if (!arr) continue;
    const clean = arr.map((t) => ({ min: toNum(t?.min) ?? 1, price: toNum(t?.price) })).filter((t) => t.price != null).sort((a, b) => a.min - b.min);
    // base = el escalón MÁS BARATO (mayor cantidad); costForQty igual devuelve el correcto por cantidad
    if (clean.length > 1) { tiers[sku] = clean; matched[sku] = Math.min(...clean.map((t) => t.price)); }
  }
  const known = new Set(names);
  const newModels = (Array.isArray(parsed.new) ? parsed.new : [])
    .map((m) => ({ name: String(m?.name || "").trim(), cat: m?.cat || "Samsung", price: toNum(m?.price) }))
    .filter((m) => m.name && !known.has(m.name));
  return { matched, tiers, newModels };
}

export async function matchModels(text, apiKey, system, names, images = []) {
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

// ---- router de intent del chatbox unificado ----
export async function classifyIntent({ supplierList, apiKey }, text) {
  const sys = "Sos el router de una mesa de precios de celulares. Clasificá el mensaje del usuario y devolvé SOLO JSON " +
    '{"intent":"ask|parse|mark","supplier":""}. ' +
    "intent 'parse' = es una cotización/lista de precios de un proveedor para cargar a la tabla (varios modelos con números). " +
    "intent 'mark' = pide seleccionar/tildar modelos para armar una cotización al cliente. " +
    "intent 'ask' = una pregunta sobre los datos/precios. " +
    "supplier: si el texto menciona uno de estos proveedores, ponelo exacto, si no dejalo vacío: " + supplierList.join(", ") + ".";
  const out = await callGemini({ system: sys, content: text, apiKey, json: true, maxTokens: 200 });
  const p = JSON.parse(stripFences(out));
  return { intent: ["ask", "parse", "mark"].includes(p.intent) ? p.intent : "ask", supplier: p.supplier || "" };
}

// ---- resolución de SKUs ----
// resuelve un nombre aproximado al SKU EXACTO del catálogo (tolera / vs +, GB, espacios)
function normSku(x) { return String(x || "").toLowerCase().replace(/gb/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " "); }
export function resolveSku({ catalog, catalogNames }, name) {
  if (catalogNames.includes(name)) return name;
  const n = normSku(name);
  const hit = catalog.find((c) => normSku(c.name) === n);
  return hit ? hit.name : null;
}
// Agente matcher: entra SOLO cuando el match determinista falla. Un LLM mapea el
// nombre raro al SKU exacto (o null si de verdad no está en el catálogo).
export async function resolveSkuSmart({ catalog, catalogNames, apiKey }, name) {
  const det = resolveSku({ catalog, catalogNames }, name);
  if (det) return det;
  try {
    const sys = "Mapeá el modelo del usuario al SKU EXACTO de esta lista, o null si no corresponde a ninguno. Respetá RAM/almacenamiento. Motorola EURO = los 'XT2xxx …'; Motorola LATIN = los 'Motorola …' (ej. 'G06 EURO' → 'XT2535 G06 4+256'; 'G06 LATIN' → 'Motorola G06 4+256'). SOLO JSON {\"sku\": \"<exacto de la lista>\" o null}.\nLista:\n" + catalogNames.join("\n");
    const out = await callGemini({ system: sys, content: String(name || ""), apiKey, json: true, maxTokens: 120 });
    const p = JSON.parse(stripFences(out));
    return p && p.sku && catalogNames.includes(p.sku) ? p.sku : null;
  } catch { return null; }
}

// texto de cotización WhatsApp para una lista de SKUs (agrupado por categoría del catálogo).
// priceMap[sku] fija el precio por modelo; si no, usa lista (o client).
export function whatsappQuoteText({ catalog, listaFor, aggBySku }, skus, source = "lista", priceMap = null) {
  const priceOf = (sku) => (priceMap && priceMap[sku] != null ? priceMap[sku] : source === "lista" ? listaFor(sku) : aggBySku[sku]?.client);
  const set = new Set(skus);
  const groups = []; let cur = null;
  for (const { name, cat } of catalog) {
    if (!set.has(name)) continue;
    if (!cur || cur.cat !== cat) { cur = { cat, items: [] }; groups.push(cur); }
    cur.items.push(name);
  }
  return groups.map((g) => `${g.cat}\n${g.items.map((sku) => { const p = priceOf(sku); return `${sku}\t${p == null ? "—" : "$" + Math.round(p)}`; }).join("\n")}`).join("\n\n");
}
