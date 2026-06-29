// Serves the seed prices/lista to the frontend, gated by the app password.
// The data lives in lib/seed-prices.js (server-side only) — it is NEVER imported
// by the frontend, so the price numbers don't end up in the public bundle.

import { SEED_PRICES, SEED_LISTA } from "../lib/seed-prices.js";

export default function handler(req, res) {
  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (APP_PASSWORD && req.headers["x-app-password"] !== APP_PASSWORD) {
    res.status(401).json({ error: "Contraseña incorrecta" });
    return;
  }
  res.status(200).json({ prices: SEED_PRICES, lista: SEED_LISTA });
}
