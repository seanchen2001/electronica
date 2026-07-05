# Handoff — Refactor + 3 features (Price Desk)

Para el modelo que ejecute esto (Fable/Opus) dentro de **Claude Code**. Leé todo antes de tocar nada.

## Qué es la app
Herramienta interna de un mayorista de celulares: tabla de precios por proveedor, armado de órdenes → factura/remitos (PDF), cuentas corrientes, PnL y un **agente** (function-calling con Gemini) en el chatbox que arma órdenes, cotiza, carga precios y hace ABM de clientes/envíos/proveedores.

## Archivos clave (todo en la raíz del repo)
- `electronics-price-tool.jsx` — **~2.900 líneas, un solo componente React** con un objeto `styles` gigante al final. Acá vive casi todo: estado (`useState` + `localStorage` + sync a Supabase), lógica de precios, el dispatcher del agente `runTool(name,args)`, y el JSX de todas las vistas.
- `lib/agent-tools.js` — `AGENT_TOOLS` (declaraciones de function-calling), `buildAgentSystem()` (prompt del orquestador) y `REVIEW_SYSTEM` (revisor).
- `InvoiceDoc.jsx` — PDF de factura/remito con `@react-pdf/renderer`.
- `api/gemini.js` — proxy serverless a Gemini (la API key vive solo en env de Vercel).
- `api/store.js` — kv store en Supabase; el array `KEYS` lista todo lo que se persiste.

## Reglas duras (NO negociables)
1. **Rama nueva** `refactor/modularizacion` a partir de `feature/agente`. **No** tocar `main` ni mergear.
2. **`npx vite build` después de CADA paso.** Si no compila, no se commitea. Commits chicos.
3. **Comportamiento idéntico** en el refactor: no cambiar UX ni lógica, solo mover código.
4. **Secretos nunca en el código**: `APP_PASSWORD`, `GEMINI_API_KEY`, claves de Supabase van SOLO en env vars de Vercel. No hardcodear ni commitear.
5. Cada commit termina con: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (o el modelo que corresponda).
6. Persistencia: cualquier dato nuevo que haya que guardar se agrega al array `KEYS` de `api/store.js` **y** con su `useState`+`localStorage`+`syncUp` como los existentes (mirá cómo se hace con `ledger`/`drafts`).

---

# PARTE A — Refactor (primero, sin cambiar comportamiento)

Objetivo: partir el mono-archivo en módulos. Orden de menor a mayor riesgo. Compilar entre cada uno.

### A1. `styles.js` (riesgo mínimo)
Mover el objeto `styles` (al final de `electronics-price-tool.jsx`) a `styles.js` y `export default`. Importarlo. Verificar build.

### A2. `lib/constants.js` + `lib/helpers.js`
Mover constantes y helpers puros: claves de storage (`*_KEY`), `SUPPLIERS`, `SUPPLIER_CODES`/`supplierCode`, `ORDER_STAGES`/`stageInfo`, `DRAFT_TTL_MS`, `MONTHS_ES`, y funciones puras: `uid`, `today`, `parseDMY`, `fmtDMY`, `mondayStart`, `money`, `blankClient`, `blankShip`, `nextInvoiceNo`. Exportar/importar. Build.

### A3. `lib/pricing.js` (funciones puras, reciben args — no estado)
Mover la lógica de precios que no dependa de React: `rowAggregates`, `upsertWeekly`, `costForQty`, `hasTiers`, `bestSuppliers`, `negotiationReport`. Donde usen estado (`prices`, `tiers`, `catalog`, `marginNum`), pasarlo por parámetro. Build + probar la Mesa y el agente.

### A4. `lib/ai.js`
Mover `callGemini`, `callGeminiTools`, `parseSupplierQuote`, `classifyIntent`, `resolveSku`/`resolveSkuSmart`, `whatsappQuoteText`. Build.

### A5. Vistas como componentes (el grueso)
Partir el JSX del `return` en componentes bajo `components/`, cada uno recibiendo props (estado + setters + handlers):
`MesaView`, `OrdenesView` (incluye el modal de edición), `ClientesView`, `CuentasView`, `PnLView`, `HistorialView`, `ChatBox`, y `modals/` (los `pending*`: `pendingAgentCommit`, `pendingPriceLoad`, `pendingDelete`, `pendingNew`).
`electronics-price-tool.jsx` queda como **orquestador**: mantiene el estado y compone las vistas. **Build después de extraer cada vista** (no todas juntas).

> Nota: el dispatcher `runTool` y los `useState`/efectos pueden quedar en el orquestador o, si el modelo se anima, migrar a un hook `hooks/useDeskState.js`. Solo si el build queda verde y el comportamiento igual.

---

# PARTE B — Features nuevas (después del refactor, o en paralelo si preferís, cada una en su commit)

## B1. Cuentas corrientes por chat (tools del agente)
Hoy las cuentas se **derivan** de las facturas (cargos) + entradas manuales de `ledger` (pagos/gastos). El form manual es `registerPay()`. Forma de una entrada de ledger:
`{ id, ts, side: "client"|"supplier", party, type: "pago"|"gasto"|"cargo", amount, concept, date, ref }`.
`canon(name)` resuelve alias (Intalper→Ojus). El memo `accounts` calcula saldos por parte.

Agregar tools (declaración en `lib/agent-tools.js`, handler en `runTool`):
- `list_accounts({ side })` → cuentas de ese lado con su `saldo` (leer del memo `accounts`).
- `account_balance({ party, side })` → saldo + últimos movimientos de una parte (usar `canon`).
- `add_ledger_entry({ party, side, type, amount, concept, date })` → agrega un pago/gasto/cargo manual (mismo shape que `registerPay`, con `uid()` y `ts`). Aplicar directo (es reversible borrando la entrada); devolver el nuevo saldo.

Prompt (`buildAgentSystem`): sección CUENTAS. Perspectiva trader ya definida (proveedor=costo, cliente=venta). Ejemplos: *"¿cuánto me debe Ojus?"* → `account_balance`; *"Ojus pagó $5.000 hoy"* → `add_ledger_entry(type:"pago", side:"client")`.

**Aceptación:** por chat puedo consultar el saldo de un cliente/proveedor y registrar un pago/gasto, y se refleja en la pestaña Cuentas.

## B2. Analítica simple (vista nueva + tool)
Nueva pestaña **"Analítica"** (o extender PnL). Todo **derivado** de `invoiceHistory` (solo `type==="factura"`) y `priceHistory` — no agrega storage nuevo. Mostrar:
- Ventas / costo / **margen por mes** (últimos ~6 meses) con barras simples.
- **Top clientes** por facturación y por margen.
- **Top proveedores** por compra (usar `supplierCosts` de cada factura).
- Margen % promedio y total de piezas.
- (Opcional) top modelos por volumen/margen; tendencia de precio por modelo desde `priceHistory`.

Además tool `analytics_summary({ period })` (ej. "mes", "semana", "todo") para que el agente responda *"¿cuánto gané este mes?"*.

**Aceptación:** la pestaña muestra los agregados correctos vs el Historial, y el agente responde preguntas de PnL por período.

## B3. Deshacer borrado (papelero)
Hoy los borrados son definitivos. Los puntos de borrado: `deleteInvoice`, `deleteDraft`, `deleteLedgerEntry`, `deleteClient`, `deleteShip`, `removeSupplier`, y el `confirmDelete().run()` del agente (factura/pedido/cliente/envío/proveedor).

Diseño: estado `trash` (persistido en `localStorage` + `KEYS`), items `{ id, kind, data, deletedAt }` donde `kind ∈ {invoice, draft, client, shipping, supplier, ledger}` y `data` es el registro completo borrado (serializable).
- Al borrar cualquier cosa → `pushTrash({ kind, data })` **antes** de removerla.
- **Toast** "Borrado X · Deshacer" ~10 s que restaura al toque.
- Panel/menú **"Papelero"** con lo borrado en las últimas 24 h, botón **Restaurar** por item. Auto-purga > 24 h.
- `restore(item)` reinserta según `kind` en la colección correcta (respetando ids).

Envolver los borrados existentes para que registren en trash (idealmente un helper único que usan tanto la UI como `confirmDelete`).

**Aceptación:** borro algo (por UI o por agente), aparece "Deshacer", lo restauro y vuelve idéntico; el papelero lista lo de las últimas 24 h.

---

## Verificación final
`npx vite build` verde, y smoke test manual: Mesa (precios/lista), armar orden + factura, editar factura (modal), cuentas (consultar + registrar pago por chat), analítica vs historial, borrar + deshacer. Recién ahí, push de `refactor/modularizacion`.
