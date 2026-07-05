// Persistencia de clientes / envíos / historial en Supabase (Postgres).
// Tabla: kv (key text primary key, value jsonb). El service key vive solo acá
// (env var), nunca en el navegador. Gated por APP_PASSWORD.
//
// Env vars en Vercel:
//   SUPABASE_URL          -> https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  -> el "service_role" key (secreto)
//   APP_PASSWORD          -> la misma contraseña de la app

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
// arrays: clients/shippings/invoices/snapshots/catalog ; objetos: prices/times/lista
const KEYS = ["clients", "shippings", "invoices", "snapshots", "catalog", "prices", "times", "lista", "ledger", "suppliers", "aliases", "tiers", "priceHistory", "drafts", "trash"];
const configured = () => !!(URL_ && KEY);
const hdr = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, "content-type": "application/json" });

export default async function handler(req, res) {
  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (APP_PASSWORD && req.headers["x-app-password"] !== APP_PASSWORD) {
    res.status(401).json({ error: "Contraseña incorrecta" });
    return;
  }
  if (!configured()) {
    res.status(200).json({ configured: false }); // sin DB -> el front usa localStorage
    return;
  }

  try {
    if (req.method === "GET") {
      const r = await fetch(`${URL_}/rest/v1/kv?select=key,value`, { headers: hdr() });
      const rows = await r.json();
      const out = { configured: true, clients: [], shippings: [], invoices: [], snapshots: [], catalog: [], prices: {}, times: {}, lista: {}, ledger: [], suppliers: [], aliases: {}, tiers: {}, priceHistory: [], drafts: [], trash: [] };
      for (const row of Array.isArray(rows) ? rows : []) if (row.key in out) out[row.key] = row.value;
      res.status(200).json(out);
      return;
    }
    if (req.method === "POST") {
      const { key, value } = req.body || {};
      if (!KEYS.includes(key)) { res.status(400).json({ error: "key inválida" }); return; }
      const r = await fetch(`${URL_}/rest/v1/kv`, {
        method: "POST",
        headers: { ...hdr(), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) { res.status(502).json({ error: await r.text() }); return; }
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
}
