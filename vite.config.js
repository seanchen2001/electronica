import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, serve /api/data by reading lib/seed-prices.js server-side (Node),
// so the price numbers are never bundled into the client even locally.
const devApiData = {
  name: "dev-api-data",
  configureServer(server) {
    server.middlewares.use("/api/data", async (_req, res) => {
      const { SEED_PRICES, SEED_LISTA } = await import("./lib/seed-prices.js");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ prices: SEED_PRICES, lista: SEED_LISTA }));
    });
  },
};

export default defineConfig({ server: { port: 5173 }, plugins: [react(), devApiData] });
