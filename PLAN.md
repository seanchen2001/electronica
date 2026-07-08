# Plan del agente integral — 4 pilares

Leyenda: ✅ hecho y sólido · ⚠️ existe pero frágil (endurecer + tests) · ❌ falta (construir)

## 1. Precios prolijos semana a semana
- ✅ Cargar precios (load_prices), escala por cantidad (tiers), historial de precios, snapshots semanales.
- ✅ Unificar duplicados (merge_models) y limpiar en lote (batch_catalog), dedup de catálogo.
- ⚠️ Consistencia al guardar listas/modelos (el bug de rowAggregates mostró fragilidad).
- ⚠️ El agente no siempre PREGUNTA ante ambigüedad (EURO/LATIN, iPhone color/región, nombre duplicado).
- Trabajo: endurecer el flujo de guardado + tests de dedup/merge/parser + reforzar "preguntá cuando hay duda antes de guardar".

## 2. Órdenes con lógica (mejores precios, mix & match)
- ✅ best_supplier (de dónde pedir cada modelo por cantidad), set_order_items (mix por proveedor).
- ✅ supplier_ask (qué pedirle al proveedor para igualar al cliente), quote_analysis, build_quote, negotiation_report.
- ✅ Memoria de reglas (knowledge base) que se le inyecta al agente.
- ❌ Memoria de precios negociados POR CLIENTE (hoy el precio acordado vive en la orden, no persiste por cliente).
- Trabajo: flujo confiable "armá la mejor orden con mix de mínimos" + memoria de precios por cliente.

## 3. Seguimiento de órdenes (fulfillment)
- ✅ Generar factura y remitos por proveedor.
- ✅ Cuentas corrientes (derivadas de facturas + pagos/gastos manuales), pago por chat.
- ✅ IMEIs por unidad (carga por columna, reparto por color, por chat o UI), colores.
- ✅ Línea de tiempo del trade (cotizado→facturado→IMEIs→Miami→Argentina→pago) + operador que reclama.
- Trabajo: mayormente endurecer + tests (es lo más completo).

## 4. Modular, auto-corrección y memoria
- ✅ Refactor modular (componentes + lib pura). ABM de clientes/envíos/proveedores/modelos por el agente.
- ✅ Supervisor (Gemini Pro) que auto-corrige lo de bajo riesgo y aprende reglas.
- ✅ Mejorador de conversaciones (revisa chats → ajusta la memoria de reglas).
- ❌ Memoria POR CLIENTE/ORDEN de problemas y reclamos (una especie de historial/CRM).
- Trabajo: agregar historial de problemas/reclamos por cliente; que el supervisor lo alimente.

## Cómo lo atacamos (estabilización pillar por pillar)
Regla: NO más features hasta que cada pilar esté sólido. Por cada pilar: extraer la lógica a
funciones puras → tests (npm test) → endurecer → smoke manual → recién ahí lo nuevo.

Orden sugerido: **1 (precios) primero** — es la base: si los precios están sucios/inconsistentes,
las órdenes salen mal y todo lo demás hereda el problema. Después 2 (órdenes), 3 (seguimiento), 4 (memoria).
