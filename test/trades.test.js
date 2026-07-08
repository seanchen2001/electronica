import { test } from "node:test";
import assert from "node:assert/strict";
import { tradeStatus } from "../lib/trades.js";

// Helpers para armar una factura mínima
const cliente = { id: "c1", name: "Ojus", cuentaCorriente: true };
const factura = (items, extra = {}) => ({ type: "factura", no: "1001", ts: Date.now() - 5 * 86400000, client: "Ojus", clientId: "c1", items, ...extra });

test("checkpoint 'IMEIs' se completa con un IMEI por unidad (por línea), sin exigir color", () => {
  // línea de 2 unidades SIN color pero CON sus 2 IMEIs → datos completo
  const inv = [factura([{ sku: "S25 ULTRA 12+512 5G DS", qty: 2, imeis: ["111", "222"] }])];
  const [t] = tradeStatus({ drafts: [], invoiceHistory: inv, opsTracking: {}, clients: [cliente] }, "1001");
  const datos = t.checkpoints.find((c) => c.id === "datos");
  assert.equal(datos.done, true, "con todos los IMEIs, 'datos' debe estar completo aunque no haya color");
});

test("checkpoint 'IMEIs' NO se completa si faltan IMEIs para alguna unidad", () => {
  const inv = [factura([{ sku: "S25 ULTRA", qty: 3, imeis: ["111", "222"] }])]; // 2 de 3
  const [t] = tradeStatus({ drafts: [], invoiceHistory: inv, opsTracking: {}, clients: [cliente] }, "1001");
  const datos = t.checkpoints.find((c) => c.id === "datos");
  assert.equal(datos.done, false);
});

test("IMEIs repartidos entre líneas de color del mismo modelo → completo", () => {
  // 3 líneas (30/10/10) del mismo modelo, cada una con sus IMEIs
  const mk = (n) => Array.from({ length: n }, (_, i) => `imei${i}`);
  const inv = [factura([
    { sku: "S25 ULTRA", qty: 30, color: "Black", imeis: mk(30) },
    { sku: "S25 ULTRA", qty: 10, color: "Silver", imeis: mk(10) },
    { sku: "S25 ULTRA", qty: 10, color: "White", imeis: mk(10) },
  ])];
  const [t] = tradeStatus({ drafts: [], invoiceHistory: inv, opsTracking: {}, clients: [cliente] }, "1001");
  assert.equal(t.checkpoints.find((c) => c.id === "datos").done, true);
});

test("con cuenta corriente: el pago va al FINAL; sin cuenta: el pago va PRIMERO", () => {
  const inv = [factura([{ sku: "S25", qty: 1, imeis: ["x"] }])];
  const [conCC] = tradeStatus({ drafts: [], invoiceHistory: inv, opsTracking: {}, clients: [{ id: "c1", name: "Ojus", cuentaCorriente: true }] }, "1001");
  const [sinCC] = tradeStatus({ drafts: [], invoiceHistory: inv, opsTracking: {}, clients: [{ id: "c1", name: "Ojus", cuentaCorriente: false }] }, "1001");
  const ids = (t) => t.checkpoints.filter((c) => !c.skipped).map((c) => c.id);
  const pagoConCC = ids(conCC).indexOf("pago");
  const pagoSinCC = ids(sinCC).indexOf("pago");
  assert.ok(pagoSinCC < pagoConCC, "sin cuenta corriente el pago debe ir antes que con cuenta corriente");
});

test("trade se cierra (no aparece como abierto) cuando todos los checkpoints están hechos", () => {
  const inv = [factura([{ sku: "S25", qty: 1, imeis: ["x"] }])];
  const ops = { [inv[0].ts]: { afuera: true, local: true, pago: true, cargamosNosotros: true } };
  const abiertos = tradeStatus({ drafts: [], invoiceHistory: inv, opsTracking: ops, clients: [cliente] }); // sin ref = solo abiertos
  assert.equal(abiertos.length, 0, "con afuera+local+pago hechos, el trade no debe estar abierto");
});
