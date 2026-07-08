# Smoke test — repasar después de cada cambio

Automático (obligatorio antes de pushear):

```bash
npm test          # tests de lógica central (precios, tiers, trades/IMEIs)
npx vite build    # que compile
```

Manual (en el preview, ~2 min) — probar los flujos core:

## Mesa / precios
- [ ] Se ven los precios; "Ocultar sin precio" esconde SOLO lo que no tiene precio (los que tienen precio quedan, aunque sea de un proveedor nuevo).
- [ ] Coloreo: el mejor precio pinta verde; expirado pinta rojo. Vale también para proveedores nuevos (iPhone/South).
- [ ] Departamentos: cada pestaña muestra sus modelos y solo sus proveedores.
- [ ] Escala por cantidad: muestra el precio más barato + "mín Xu".

## Órdenes
- [ ] Armar una orden, agregar modelos, elegir proveedor (costo sigue la cantidad si hay escala).
- [ ] Generar factura → aparece en Historial, PnL y Cuentas.
- [ ] Editar una factura desde el Historial (modal) y guardar.

## IMEIs (por unidad)
- [ ] Botón 📱 X/N en la factura; pegar la columna llena la línea; con líneas de color reparte por cantidad.
- [ ] Al completar todas las unidades, el checkpoint "IMEIs" del trade se cierra.

## Catálogo (agente)
- [ ] list_models trae precios; limpiar duplicados/sobrantes con batch_catalog = UN solo modal.
- [ ] Merge/borrado persiste tras recargar.

## Operador / trades
- [ ] Panel 🔔 Pendientes con los checks (afuera/local/pago); con cuenta corriente el pago va al final, sin cuenta primero.

## Agente
- [ ] Modo 🧠 inteligente (Pro) responde sin error 400.
- [ ] Multi-paso: arma el plan (checklist) y lo completa en orden.
- [ ] Tablas/gráficos generativos se dibujan en el chat.
