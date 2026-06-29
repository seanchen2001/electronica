// Tests for the sourcing planner (cotizador). Run: node cotizador.test.mjs
import { planBestPrice, planMinSuppliers, SUPPLIERS } from "./price-logic.js";

let pass = 0, fail = 0;
const fails = [];
const eq = (a, b, msg) => (JSON.stringify(a) === JSON.stringify(b) ? pass++ : (fail++, fails.push(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)));
const ok = (c, msg) => (c ? pass++ : (fail++, fails.push(msg)));

// Sanity: the real supplier set
ok(SUPPLIERS.length === 5, "5 suppliers");

// Fixture where best-price and min-suppliers DIVERGE.
// VITEL alone can cover A,B,C (cost 66); cheapest-each uses 3 suppliers (cost 60).
const prices = {
  A: { planET: 10, VITEL: 11 },
  B: { SH: 20, VITEL: 22 },
  C: { Bax: 30, VITEL: 33 },
  D: {}, // nobody carries D
};
const needed = { A: 1, B: 1, C: 1, D: 1 };

const bp = planBestPrice(needed, prices);
eq(bp.total, 60, "best-price total = 10+20+30");
ok(bp.suppliers.length === 3, "best-price uses 3 suppliers");
ok(bp.suppliers.includes("planET") && bp.suppliers.includes("SH") && bp.suppliers.includes("Bax"), "best-price picks cheapest-each");
eq(bp.uncoverable, ["D"], "D is uncoverable");
eq(bp.bySupplier.planET, [{ sku: "A", qty: 1, price: 10 }], "planET gets A @10");

const ms = planMinSuppliers(needed, prices);
eq(ms.suppliers, ["VITEL"], "min-suppliers = just VITEL");
eq(ms.total, 66, "min-suppliers total = 11+22+33");
eq(ms.uncoverable, ["D"], "D still uncoverable");
ok(ms.total > bp.total, "fewer suppliers costs a bit more (the trade-off)");

// Quantities scale cost
const bp2 = planBestPrice({ A: 2, C: 3 }, prices);
eq(bp2.total, 2 * 10 + 3 * 30, "qty scales cost (2*10 + 3*30 = 110)");

// A model only one supplier carries forces that supplier into BOTH plans
const forced = { B: 1 }; // only SH and VITEL; cheapest SH
eq(planBestPrice(forced, prices).suppliers, ["SH"], "single-need goes to cheapest (SH @20)");

// Mandatory-supplier case: B2 carried only by Bax => Bax mandatory in min plan
const p2 = { X: { planET: 5, VITEL: 6 }, Y: { Bax: 9 } };
const ms2 = planMinSuppliers({ X: 1, Y: 1 }, p2);
ok(ms2.suppliers.includes("Bax"), "Bax mandatory (only carrier of Y)");
ok(ms2.suppliers.length === 2, "needs 2 suppliers (nobody carries both X and Y)");

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail) { for (const f of fails) console.log("  ✗ " + f); process.exit(1); }
else console.log("  ✓ cotizador planning logic correct");
