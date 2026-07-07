# HANDOFF-FABLE-2 — Fase C: el agente como trader

> Continuación de `HANDOFF-FABLE.md` (Parte A refactor + Parte B cuentas/analítica/papelero, ya mergeadas en `refactor/modularizacion`).
> Autor del plan: sesión de diseño con el dueño. Ejecutor: Fable.

## 0. Reglas de trabajo (no negociables)

- **Rama:** crear `feature/trader` desde `refactor/modularizacion`. No tocar `main` ni `feature/agente`.
- **Build verde entre cada paso:** `npx vite build` debe compilar sin error antes de commitear. Commits chicos, uno por paso (C1…C7).
- **Secretos SOLO en env de Vercel:** `GEMINI_API_KEY`, `APP_PASSWORD`, claves Supabase. Nunca en el código.
- **Patrón del repo:** la lógica pura va a `lib/*.js` recibiendo el estado por parámetro (como `lib/accounts.js`, `lib/analytics.js`). Los componentes reciben estado y callbacks por props. Persistencia nueva = `useState` + `localStorage` (useEffect) + `syncUp(key, value)` + agregar la key al array `KEYS` de `api/store.js`.
- **Al terminar:** `git push -u origin feature/trader` y avisar. Limpiar datos de prueba de localStorage tras verificar.
- **Co-autoría en commits:** `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## 1. Contexto y objetivo

El agente ya es competente: worker `gemini-2.5-flash` + supervisor `gemini-2.5-pro`, 41 tools, modales de confirmación, papelero de 24 h, `reviewOrder`, y knowledge base `desk-knowledge-v1` que persiste reglas aprendidas. Lo que falta para que **"casi reemplace al trader"** no es más inteligencia — es **estructura de autoridad, memoria y percepción**. Esta fase le da:

1. Una **escala de riesgo** de escritura (no todo confirma igual).
2. **Inventario + costo promedio real** (derivados).
3. **Detección de arbitraje** como alerta (la primitiva ya existe).
4. **Pulso de clientes** (qué está pasando con cada uno).
5. **Estado del trade end-to-end** (el ciclo largo: cotizar → confirmar → facturar → colores/IMEI → Miami FOB → Argentina → pago).
6. La **estructura de auto-mejora** lista pero desconectada (conversaciones persistidas, reviewers stub).
7. Un **system prompt reescrito** que reencuadra al agente de "agente de órdenes" a **trader**.

Las 5 responsabilidades que pidió el dueño: (1) manejar DB (cargar/modificar precios), (2) cotizar y armar órdenes, (3) anotar cuentas + facturas/remitos, (4) avisar de todo lo que pasa con cada cliente, (5) encontrar arbitrajes.

## 2. Decisiones cerradas (respetar tal cual)

| Tema | Decisión |
|------|----------|
| **Autoridad DB** | Escala de riesgo. Precios/catálogo/clientes/proveedores/direcciones = **auto**. Pagos = **confirmación simple**. Órdenes/facturas/remitos = **revisión pesada**. |
| **Arbitraje** | **Solo avisar** (detecta + dice si el precio bajo está desactualizado). No estima montos ni prepara órdenes. |
| **Inventario** | **Derivado**: ventas a clientes reales = salida; compras a una cuenta marcada "nuestra" = entrada. Sin carga manual de stock. |
| **Auto-mejora** | **Diseñar ahora, correr después.** Persistir conversaciones + métricas; reviewers como stubs con botón manual. Auto-trigger cada 25 chats queda OFF. |

---

## C1 — Escala de riesgo de escritura

**El cambio central.** Hoy la autoridad es binaria: read-only vs. modal pesado (`needs_confirmation`). Formalizar tres tiers.

### Definir en `lib/agent-tools.js` (junto a `SUPERVISOR_LOW_RISK`):

```js
// Escala de riesgo de escritura del agente. Rige cómo runTool aplica cada mutación.
export const RISK_TIER = {
  // T0 — AUTO: aplican directo (reversibles por papelero/log). Casi todo el CRUD.
  add_model: 0, edit_model: 0, rename_category: 0, merge_models: 0,
  add_client: 0, add_supplier: 0, add_shipping: 0, set_supplier_depts: 0,
  set_order_meta: 0, set_order_stage: 0, add_order_line: 0, set_order_items: 0,
  learn_rule: 0, forget_rule: 0,
  // T1 — CONFIRM SIMPLE: confirmación liviana de un click.
  add_ledger_entry: 1, set_trade_status: 1,
  delete_client: 1, delete_shipping: 1, delete_supplier: 1, delete_model: 1, delete_order: 1,
  // T2 — REVISIÓN PESADA: reviewOrder reforzado + AgentCommitModal + confirmación explícita.
  generate_invoice: 2, generate_remitos: 2, delete_invoice: 2,
};
export const riskTier = (tool) => RISK_TIER[tool] ?? 0;
```

### En `runTool` (electronics-price-tool.jsx):

- **`load_prices` → T0 condicional.** Hoy siempre abre `PriceLoadModal`. Cambiar a: si TODOS los deltas están dentro de `PRICE_AUTO_THRESHOLD` (±15%) y no hay modelos nuevos → **aplicar directo** (setPrices/setTiers/stampTimes/logPrices) y devolver `{status:"ok", aplicado:true}`. Si hay algún delta grande o modelos nuevos → mantener el modal actual. El umbral de "variación grande" ya se calcula en el preview (flag `big`), reusarlo.
- **`add_ledger_entry` → T1.** Hoy aplica directo. Envolver en confirmación simple: reusar `DeleteModal` genérico (o un mini-confirm equivalente) con copy tipo *"Registrar pago de $X en la cuenta de Ojus"* → al confirmar corre el `setLedger` actual. Devolver `{status:"needs_confirmation"}` como los demás. Sigue reversible desde Cuentas.
- **Los `delete_*` de bajo valor** ya usan `DeleteModal` (T1) — no cambian.
- **`generate_invoice`/`generate_remitos`/`delete_invoice`** ya son T2 vía `reviewOrder` + `AgentCommitModal` — se refuerzan en C2/C6.

**Aceptación C1:** cargar precios con deltas chicos aplica sin modal; con un delta >15% o modelo nuevo abre `PriceLoadModal`. Registrar un pago por el agente pide confirmación simple. Actualizar las `description` de `load_prices` y `add_ledger_entry` en `AGENT_TOOLS` para reflejar el nuevo comportamiento.

---

## C2 — Inventario + costo promedio (derivado)

Nuevo `lib/inventory.js`, patrón función pura (como `accounts.js`).

- **Fuente de entradas (compras nuestras):** flag nuevo `esNuestra: bool` en el registro de cliente. Agregarlo al form de `ClientesView.jsx` (checkbox "Es cuenta nuestra (compras a inventario)") y al tool `add_client` (param `esNuestra`). Una factura/remito cuyo cliente tiene `esNuestra=true` → sus items son **stock IN**. Toda factura a cliente real → **stock OUT**.

```js
// lib/inventory.js
// Inventario y costo promedio REAL, derivados del historial. Sin storage propio.
// Entrada = facturas a cuentas nuestras (esNuestra); salida = ventas a clientes reales.
export function computeInventory({ invoiceHistory, clients }) {
  const ownIds = new Set(clients.filter((c) => c.esNuestra).map((c) => c.id));
  const ownNames = new Set(clients.filter((c) => c.esNuestra).map((c) => (c.name || "").toLowerCase()));
  const isOwn = (inv) => ownIds.has(inv.clientId) || ownNames.has((inv.client || "").toLowerCase());
  const bySku = {};
  for (const inv of invoiceHistory || []) {
    if (inv.type !== "factura" && inv.type !== "remito") continue;
    const inbound = isOwn(inv);
    for (const it of inv.items || []) {
      const s = (bySku[it.sku] ||= { sku: it.sku, entradas: 0, salidas: 0, costEntradas: 0, lastTs: 0 });
      const q = Number(it.qty) || 0;
      if (inbound) { s.entradas += q; s.costEntradas += q * (Number(it.cost) || 0); }
      else s.salidas += q;
      s.lastTs = Math.max(s.lastTs, inv.ts || 0);
    }
  }
  const out = {};
  for (const s of Object.values(bySku)) {
    out[s.sku] = {
      sku: s.sku,
      onHand: s.entradas - s.salidas,
      avgCost: s.entradas ? +(s.costEntradas / s.entradas).toFixed(2) : null,
      entradas: s.entradas, salidas: s.salidas, lastTs: s.lastTs,
    };
  }
  return out;
}
```

- **Memo** en el orquestador: `const inventory = useMemo(() => computeInventory({ invoiceHistory, clients }), [invoiceHistory, clients])`.
- **Tool read-only `inventory_status(sku?)`** → devuelve el/los SKU con `onHand` y `avgCost`.
- **Card en `AnaliticaView.jsx`:** stock actual + costo promedio vs. precio de lista → margen real por modelo.
- **Reforzar `reviewOrder`:** si una línea vende más que `inventory[sku].onHand` (y el cliente no es `esNuestra`), agregar issue *"vendés N de X pero hay M en stock"*. NO bloquea (warning).

**Aceptación C2:** marcar un cliente `esNuestra`, registrar una compra a esa cuenta y una venta a un cliente real → `inventory_status` da `onHand` y `avgCost` correctos; sobrevender dispara el warning en el commit.

---

## C3 — Arbitraje (solo avisar)

Nuevo `lib/arbitrage.js`. **Reusar** `rowAggregates` (mediana + outliers) y `classifyFreshness` de `price-logic.js`, y `TIMES_KEY` (`times[sku][supplier] = ts`).

```js
// lib/arbitrage.js
import { classifyFreshness } from "../price-logic.js";
// Detecta SKUs donde un proveedor está MUY por debajo de la mediana.
// Distingue oportunidad real de precio viejo/desactualizado (el caso Planet A17 131 vs 138).
export function arbitrageScan({ prices, times, supplierList, catalog }, { gapPct = 3 } = {}) {
  const out = [];
  for (const c of catalog) {
    const row = prices[c.name]; if (!row) continue;
    const vals = Object.values(row).filter((v) => typeof v === "number");
    if (vals.length < 2) continue;
    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const [lowSupplier, lowPrice] = Object.entries(row).sort((a, b) => a[1] - b[1])[0];
    const gap = median ? +(((median - lowPrice) / median) * 100).toFixed(1) : 0;
    if (gap < gapPct) continue;
    const fresh = classifyFreshness(times?.[c.name]?.[lowSupplier]);
    const stale = fresh === "expired";
    out.push({
      sku: c.name, lowSupplier, lowPrice, median, gapPct: gap, stale,
      nota: stale
        ? "posiblemente desactualizado — verificar antes de comprar"
        : "gap real vs. mediana — oportunidad",
    });
  }
  return out.sort((a, b) => b.gapPct - a.gapPct);
}
```

- **Tool read-only `arbitrage_scan()`** → lista ordenada por gap.
- **Alerta/card en `MesaView.jsx`:** badge cuando hay gaps ≥ umbral; al abrir, tabla con SKU / proveedor bajo / mediana / gap% / nota (stale en amarillo, real en verde).
- Constante `ARB_GAP_PCT = 3` en `lib/constants.js`.

**Aceptación C3:** sembrar un proveedor bajo con ts viejo → aparece marcado `stale`; bajo con ts fresco → "oportunidad". El agente puede invocarlo ante "¿dónde hay oportunidad?".

---

## C4 — Pulso de clientes (responsabilidad #4)

Extender lo que ya hace `pending_operations`. `clientPulse` puede vivir en `lib/accounts.js` (ya tiene `computeAccounts`) o un nuevo `lib/clients.js`.

- **`clientPulse({ invoiceHistory, ledger, aliases, clients }, clientName?)`** → por cliente: saldo (de `computeAccounts` side client), pagos vencidos, entregas pendientes (de la lógica de `pending_operations`), última orden y días desde entonces. Flags: *"debe $X hace N días"*, *"sin comprar hace N días"*. Excluir cuentas `esNuestra`.
- **Tool read-only `client_activity(clientName?)`** → digest de uno o de todos (ordenados por urgencia: más deuda vencida primero).
- El agente arma su briefing ("¿cómo venimos con los clientes?") con esto.

**Aceptación C4:** con una factura impaga → `client_activity` reporta saldo y días de atraso.

---

## C5 — Estado del trade (ciclo de vida end-to-end)

El pilar que ata todo. **Unificar** `ORDER_STAGES` (pre-venta) + `opsTracking` (`desk-ops-v1`, post-venta afuera/local/pago) en una **línea de tiempo por trade** que el agente lee y actualiza. Checkpoints (algunos condicionales):

1. **Cotizado** — se pasó precio (order.stage `cotizando`/`negociando`).
2. **Confirmado** — cliente aceptó (order.stage `confirmada`).
3. **Facturado** — existe registro en `invoiceHistory`.
4. **Datos completos** — todos los items tienen `color` e `imei` (checkpoint NUEVO, derivado de `items[]`; hoy no se trackea).
5. **Miami FOB** — llegó afuera (check `afuera` actual).
6. **En Argentina** — solo si `cargamos_nosotros` (flag por trade); check `local` actual.
7. **Pagado** — cliente pagó (check `pago`; si no tiene `cuenta_corriente`, va antes del envío).

### Cambios

- **Extender `opsTracking`** por trade: además de `{afuera, local, pago}`, guardar el flag `cargamos_nosotros` (bool). `datos` es **derivado** (no se setea a mano) — se calcula de los items de la factura.
- **`lib/trades.js` → `tradeStatus({ drafts, invoiceHistory, opsTracking, ledger, aliases, clients }, ref?)`** → por trade abierto: cliente, checkpoint actual, **próximo paso pendiente**, flags de atraso (días desde facturación sin avanzar). `ref` opcional (clientName/model/invoiceNo) para uno; sin `ref` = todos ordenados por urgencia. El checkpoint "Pagado" se deriva cruzando con `computeAccounts` (saldo 0 del trade) o el check `pago`.
- **Tools:**
  - `trade_status(ref?)` — read-only.
  - `set_trade_status(ref, checkpoint, done)` — **T1 confirm simple**. Setea `afuera`/`local`/`pago`/`cargamos_nosotros`. "Datos" es derivado, rechazar si lo intentan setear a mano.
- **Card de línea de tiempo** en `OrdenesView.jsx` (trades en curso) y/o `HistorialView.jsx`: barra de 7 pasos con el actual resaltado y "qué falta". Reusar `pending_operations` como fuente, presentado como timeline.
- El agente reporta trades trabados en su briefing y proactivamente: *"Factura #123 de Ojus: facturada hace 5 días, faltan IMEIs"*, *"Trade de Bax: llegó a Miami, falta pago"*.

**Aceptación C5:** una orden facturada sin IMEIs → `trade_status` la muestra en checkpoint "Datos", próximo paso "pedir IMEIs". Marcar "llegó a Miami" por el agente → confirm simple, avanza. `cargamos_nosotros=false` → el paso "En Argentina" se saltea.

---

## C6 — Prompt trader (reescritura de `buildAgentSystem`)

Reencuadrar el system prompt. Mantener lo que ya funciona (perspectiva trader, reglas de SKU EURO/LATIN, formato bullets con 🔴/🟡/🟢, intención cotizar/parsear/cargar, CRUD de clientes/proveedores, departamentos) y AGREGAR:

- **Identidad:** *"Sos el trader del Price Desk, no un asistente pasivo. Manejás la operación de punta a punta y avisás vos las cosas antes de que te pregunten."*
- **Las 5 responsabilidades**, explícitas.
- **Escala de riesgo:** qué hacés solo (precios dentro de rango, altas de clientes/proveedores/direcciones, catálogo) vs. qué confirmás (pagos = confirm simple; facturas/remitos/borrados = revisión). *"No pidas permiso para lo que es T0; ejecutá y seguí."*
- **Estado del trade:** *"Para cada trade sabé siempre en qué checkpoint está y cuál es el próximo paso pendiente. Usá trade_status. Si algo está trabado (facturado sin IMEIs, en Miami sin pago, sin comprar hace mucho), avisalo."*
- **Arbitraje proactivo:** *"Si ves un proveedor muy por debajo de la mediana, avisá — y aclará si el precio parece desactualizado (verificar) o es oportunidad real. Usá arbitrage_scan."*
- **Costo real:** *"Para juzgar margen usá el costo promedio real del inventario (inventory_status), no solo el precio de lista del proveedor."*
- **Pulso de clientes:** *"Ante '¿cómo venimos?' o al empezar el día, resumí con client_activity: quién debe, qué está vencido, qué trades están frenados."*

Ajustar `REVIEW_SYSTEM` con los checks nuevos: **stock insuficiente** (sobreventa), **margen contra costo promedio real** (no solo lista), **factura# duplicada**.

Declarar en `AGENT_TOOLS` los tools read-only nuevos: `inventory_status`, `arbitrage_scan`, `client_activity`, `trade_status`, y el T1 `set_trade_status`.

**Aceptación C6:** el agente, sin que se lo pidan explícito, menciona un arbitraje o un trade trabado cuando corresponde; no pide confirmación para altas T0; pide confirm simple para pagos.

---

## C7 — Sustrato de auto-mejora (estructura, desconectado)

Dejar todo listo pero **sin** el trigger automático.

- **Persistir conversaciones:** `CHAT_LOG_KEY = "desk-chat-log-v1"`. Al final de `runAgent`, append `{ ts, userText, actions: [{tool, args}], finalText }` (acotar a ~500, tirar los viejos). `useState` + localStorage + `syncUp`. Agregar `"chatLog"` al array `KEYS` de `api/store.js` y al objeto `out` del GET.
- **Reviewer de conversaciones (stub):** `buildImprovementSystem()` en `lib/agent-tools.js` + `reviewConversations(logs)` que, dados N logs, propone altas/ediciones a la knowledge base (`desk-knowledge-v1`, ya cableada en `buildAgentSystem`). Disparo **manual**: botón "Revisar conversaciones" en ChatBox o Analítica. El auto-trigger `chatLog.length % 25 === 0` queda comentado con un `// TODO fase 2` y un flag `AUTO_IMPROVE = false`.
- **Reviewer de profitabilidad (stub):** tool `profitability_review()` que cruza `analyticsData` + `computeInventory().avgCost` para rankear modelos/clientes/proveedores por **margen real** (contra costo promedio) y marcar perdedores. Mostrar en `AnaliticaView.jsx`. Sin scheduling.

**Aceptación C7:** cada turno del agente se apendea a `desk-chat-log-v1`; el botón manual de "Revisar conversaciones" corre y propone reglas sin romper nada; el auto-trigger sigue OFF.

---

## 3. Verificación (end-to-end)

Por paso: `npx vite build` verde. Al final, levantar el dev server y probar en el navegador (usar las herramientas de preview; hay una config `price-desk` en el launch.json de Arlem, puerto 5199):

- **Riesgo:** precios delta chico sin modal; delta >15% con `PriceLoadModal`; pago con confirm simple; factura con `AgentCommitModal`.
- **Inventario:** cliente `esNuestra` + compra + venta → `onHand`/`avgCost` correctos; sobreventa → warning.
- **Arbitraje:** proveedor bajo+viejo → `stale`; bajo+fresco → oportunidad.
- **Clientes:** factura impaga → `client_activity` con saldo y atraso.
- **Trade:** facturada sin IMEIs → checkpoint "Datos"; marcar Miami → avanza; `cargamos_nosotros=false` saltea Argentina.
- **Auto-mejora:** turnos apendeados a `desk-chat-log-v1`; botón manual corre; auto-trigger OFF.

Limpiar los datos de prueba de localStorage al terminar (como en la verificación de B1–B3).

## 4. Orden sugerido y por qué

C1 (riesgo) primero porque cambia el contrato de `runTool` que todo lo demás usa. C2–C4 (inventario/arbitraje/clientes) son derivaciones puras independientes, en cualquier orden. C5 (trade) depende de C2/C4 para el pulso. C6 (prompt) va después de que existan los tools nuevos para poder declararlos. C7 (auto-mejora) al final, aislado. Cada uno es un commit.
