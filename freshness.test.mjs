// Tests for the weekly Monday-expiry freshness logic.
// Run: node freshness.test.mjs
import { mondayStart, classifyFreshness, RECENT_MS } from "./price-logic.js";

let pass = 0, fail = 0;
const fails = [];
const ok = (cond, msg) => (cond ? pass++ : (fail++, fails.push(msg)));
const H = 3600 * 1000;

// mondayStart invariants across an arbitrary span of days
for (let i = 0; i < 21; i++) {
  const d = new Date(2026, 5, 10 + i, 14, 30); // mid-afternoon
  const ms = mondayStart(d);
  const m = new Date(ms);
  ok(m.getDay() === 1, `mondayStart(${d.toDateString()}) should land on Monday, got day ${m.getDay()}`);
  ok(m.getHours() === 0 && m.getMinutes() === 0, "mondayStart should be at 00:00");
  const delta = d.getTime() - ms;
  ok(delta >= 0 && delta < 7 * 24 * H, "mondayStart should be the Monday of the same week (0..7d back)");
}

// A Monday at 00:00 maps to itself
const aMonday = new Date(2026, 5, 22, 0, 0); // construct, then verify it's Monday
if (aMonday.getDay() === 1) ok(mondayStart(aMonday) === aMonday.getTime(), "Monday 00:00 maps to itself");
else ok(new Date(mondayStart(aMonday)).getDay() === 1, "fallback: still resolves to a Monday");

// classifyFreshness — anchor "now" mid-week and derive the cycle
const now = new Date(2026, 5, 24, 12, 0).getTime(); // a Wednesday-ish noon
const cycle = mondayStart(new Date(now));

ok(classifyFreshness(null, now) === "expired", "missing timestamp => expired");
ok(classifyFreshness(cycle - 1 * H, now) === "expired", "before this Monday => expired");
ok(classifyFreshness(cycle + 1 * H, now) === "updated", "this cycle but >24h old => updated");
ok(classifyFreshness(now - 1 * H, now) === "recent", "1h ago => recent");
ok(classifyFreshness(now - 25 * H, now) === "updated", "25h ago (still this cycle) => updated");
ok(classifyFreshness(now, now) === "recent", "right now => recent");
ok(RECENT_MS === 24 * H, "recent window is 24h");

// A price from Sunday night is expired on Monday morning even if <24h old
const monMorning = new Date(2026, 5, 22, 8, 0);
if (monMorning.getDay() === 1) {
  const sunNight = monMorning.getTime() - 9 * H; // Sunday ~23:00, <24h before
  ok(classifyFreshness(sunNight, monMorning.getTime()) === "expired",
    "Sunday-night price is expired Monday morning (cycle boundary beats recency)");
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail) { for (const f of fails) console.log("  ✗ " + f); process.exit(1); }
else console.log("  ✓ weekly freshness logic correct");
