// Proves the seeded data + pricing logic reproduces the trader's sheet.
// Run: node seed-validation.test.mjs
import { CATALOG, SUPPLIERS, rowAggregates } from "./price-logic.js";
import { SEED_PRICES, SEED_LISTA, SHEET_REF } from "./lib/seed-prices.js";

const MARGIN = 3; // their 1.03 column
let pass = 0, fail = 0;
const fails = [], review = [];

// Structural checks
const names = CATALOG.map((c) => c.name);
if (new Set(names).size !== names.length) { fail++; fails.push("duplicate SKU names in CATALOG"); } else pass++;
for (const sku of Object.keys(SEED_PRICES))
  if (!names.includes(sku)) { fail++; fails.push(`SEED_PRICES has SKU not in CATALOG: ${sku}`); }
for (const sku of Object.keys(SEED_PRICES))
  for (const sp of Object.keys(SEED_PRICES[sku]))
    if (!SUPPLIERS.includes(sp)) { fail++; fails.push(`unknown supplier ${sp} on ${sku}`); }

// Per-SKU: recompute min/median/client and compare to the sheet
for (const { name: sku } of CATALOG) {
  const agg = rowAggregates(SEED_PRICES[sku] || {}, MARGIN);
  const ref = SHEET_REF[sku];

  if (!ref) {
    // Rows the sheet left unpriced. If we have prices anyway, flag for review.
    if (agg.count > 0)
      review.push(`${sku}: sheet has no client value, but seed has ${agg.count} quote(s) -> computed min ${agg.min}, client ${agg.client}`);
    continue;
  }
  let okRow = true;
  if (agg.min !== ref.min) { okRow = false; fails.push(`${sku}: min ${agg.min} != sheet ${ref.min}`); }
  if (agg.med !== ref.med) { okRow = false; fails.push(`${sku}: median ${agg.med} != sheet Medio ${ref.med}`); }
  if (agg.client !== ref.cli) { okRow = false; fails.push(`${sku}: client ${agg.client} != sheet 1.03 ${ref.cli}`); }
  // independent cross-check: their column should be round(min * 1.03)
  if (agg.client !== Math.round(ref.min * 1.03))
    { okRow = false; fails.push(`${sku}: client ${agg.client} != round(min*1.03)=${Math.round(ref.min * 1.03)}`); }
  if (okRow) pass++; else fail++;
}

console.log(`\n  ${pass} SKU checks passed, ${fail} failed`);
console.log(`  ${CATALOG.length} SKUs in catalog, ${Object.keys(SEED_PRICES).length} seeded\n`);
if (review.length) {
  console.log("  REVIEW (sheet quirks — not failures):");
  for (const r of review) console.log("    • " + r);
  console.log("");
}
if (fail) { for (const f of fails) console.log("  ✗ " + f); process.exit(1); }
else console.log("  ✓ seed reproduces the sheet's Minimo / Medio / client column exactly");
