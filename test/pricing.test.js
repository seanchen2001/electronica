import { test } from "node:test";
import assert from "node:assert/strict";
import { toNum } from "../lib/ai.js";
import { rowAggregates, median, classifyFreshness, RECENT_MS } from "../price-logic.js";
import { costForQty, hasTiers, bestSuppliers } from "../lib/pricing.js";

test("toNum entiende formato es-AR y US", () => {
  assert.equal(toNum("$1.105,00"), 1105); // punto miles, coma decimal
  assert.equal(toNum("1.125,00"), 1125);
  assert.equal(toNum("1,105.00"), 1105);  // coma miles, punto decimal
  assert.equal(toNum("$630"), 630);
  assert.equal(toNum("630.50"), 630.5);
  assert.equal(toNum("$1,299.99"), 1299.99);
  assert.equal(toNum(""), null);
  assert.equal(toNum("abc"), null);
  assert.equal(toNum(611), 611);
});

test("rowAggregates incluye proveedores NUEVOS (no solo los 5 originales)", () => {
  // South no es uno de los 5 originales — su precio DEBE contar (bug iPhone)
  const agg = rowAggregates({ South: 1105 }, 3);
  assert.equal(agg.count, 1);
  assert.equal(agg.min, 1105);
  assert.equal(agg.client, Math.round(1105 * 1.03));
});

test("rowAggregates: mínimo, mediana y client con margen", () => {
  const agg = rowAggregates({ planET: 100, mirgor: 110, VITEL: 120 }, 10);
  assert.equal(agg.min, 100);
  assert.equal(agg.med, 110);
  assert.equal(agg.client, 110); // base=min=100 (no outlier), +10% = 110
});

test("rowAggregates: outlier (dump) usa la mediana como base", () => {
  // 50 está >15% bajo la mediana → es outlier → base = mediana, no el 50
  const agg = rowAggregates({ planET: 50, mirgor: 100, VITEL: 100 }, 0);
  assert.ok(agg.bestIsOutlier);
  assert.equal(agg.base, agg.med);
});

test("median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test("costForQty: sin tiers usa el precio base; con tiers usa el escalón por cantidad", () => {
  const prices = { S26: { planET: 611 } };
  const tiers = { S26: { planET: [{ min: 1, price: 630 }, { min: 20, price: 621 }, { min: 50, price: 611 }] } };
  assert.equal(costForQty(prices, {}, "S26", "planET", 5), 611);       // sin tiers → base
  assert.equal(costForQty(prices, tiers, "S26", "planET", 1), 630);    // 1 unidad → escalón caro
  assert.equal(costForQty(prices, tiers, "S26", "planET", 25), 621);   // 25 → escalón medio
  assert.equal(costForQty(prices, tiers, "S26", "planET", 80), 611);   // 80 → escalón barato
});

test("hasTiers", () => {
  assert.equal(hasTiers({ S26: { planET: [{ min: 1, price: 1 }, { min: 20, price: 2 }] } }, "S26", "planET"), true);
  assert.equal(hasTiers({ S26: { planET: [{ min: 1, price: 1 }] } }, "S26", "planET"), false);
  assert.equal(hasTiers({}, "S26", "planET"), false);
});

test("bestSuppliers: ranking por costo y brecha con la alternativa", () => {
  const prices = { S26: { planET: 611, mirgor: 620, VITEL: 615 } };
  const r = bestSuppliers({ prices, tiers: {}, prevSnap: null, supplierList: ["planET", "mirgor", "VITEL"] }, "S26", 10);
  assert.equal(r.mejor.proveedor, "planET");
  assert.equal(r.mejor.costo, 611);
  assert.equal(r.brecha_con_alternativa, 4); // 615 - 611
});

test("classifyFreshness: reciente vs actualizado vs expirado", () => {
  const now = new Date("2026-01-07T12:00:00").getTime(); // miércoles fijo (evita flakiness)
  assert.equal(classifyFreshness(now, now), "recent");                      // ahora → recién
  assert.equal(classifyFreshness(now - RECENT_MS - 3600e3, now), "updated"); // ~25h → este ciclo pero no <24h
  assert.equal(classifyFreshness(new Date("2026-01-01T12:00:00").getTime(), now), "expired"); // semana pasada
  assert.equal(classifyFreshness(null, now), "expired");                    // sin fecha → re-pedir
});
