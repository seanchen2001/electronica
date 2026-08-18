# Price Desk — instrucciones para Claude

Herramienta mayorista de teléfonos y electrónica. La usa una sola persona (el dueño)
para comparar precios de proveedores, armar pedidos, facturar y llevar cuentas corrientes.

**Desde 2026-08-18 las cargas de datos las hace Claude, no un agente dentro de la app.**
El usuario pega la lista del proveedor como venga (texto de WhatsApp, foto, Excel) y Claude
la interpreta, la normaliza y la escribe en la base. El chat que la app tenía adentro se
quitó (commit 971d6bc) porque se confundía con listas desprolijas.

## Dónde está todo

- Repo: `github.com/seanchen2001/electronica`, local en `~/Documents/Code/price-desk`.
- Rama de trabajo: **`feature/trader`**. Vercel deploya **`main`**. Al terminar:
  `git push origin feature/trader && git push origin feature/trader:main`.
  Siempre `git fetch && git rebase origin/feature/trader` antes de pushear: el usuario
  edita desde otras sesiones y el remoto suele estar adelante.
- App publicada: https://project-tfw0a.vercel.app
- Verificar que compila antes de pushear: `npm run build`.

## La base de datos

Supabase, **una sola tabla `kv`** (`key` text PK, `value` jsonb). Cada clave guarda un blob
entero. La app le pega vía `api/store.js` (service key en env vars de Vercel), pero desde
acá se escribe directo con la key publicable — RLS está abierto:

```
URL  https://ayzvbtvmzqmiivxykhyz.supabase.co/rest/v1/kv
KEY  sb_publishable_MGFSWdMeQ87YL4JJ5rebBA_fj3BqT7K
```

Claves: `prices` `times` `lista` `tiers` `catalog` `priceHistory` `snapshots` `invoices`
`ledger` `clients` `shippings` `suppliers` `supplierDepts` `aliases` `ops` `drafts`
`trash` `hiddenModels` `knowledge` `chatLog`.

`prices[sku][proveedor] = número` · `times[sku][proveedor] = ms` · `lista[sku] = precio de venta`
· `tiers[sku][proveedor] = [{min, price}]` · `catalog = [{cat, dept, name}]`.

### Protocolo de escritura (no negociable)

1. **Backup primero**: bajar toda la tabla a `backups/kv-backup-YYYY-MM-DD-HHMM.json`.
2. **Leer fresco** justo antes de escribir. Los blobs se pisan enteros (last-writer-wins) y
   la app puede estar abierta escribiendo en paralelo.
3. **Mergear, nunca pisar a ciegas.**
4. **Verificar `assert`** que cada SKU destino existe ANTES de escribir; si algo no matchea,
   abortar y preguntar en vez de inventar.
5. Un script por carga en `scripts/load-<proveedor>-<fecha>.py`, idempotente.

**Si el proyecto está pausado** (Supabase free se duerme a los ~7 días sin uso), la API
devuelve **521** y el DNS puede fallar. Solo el usuario lo restaura desde el dashboard.
Mientras está caída, la app corre en localStorage y **descarta todo al volver**: avisarle
que no cargue nada ahí.

## Cómo se carga una lista

- **Proveedor**: suele estar al final del mensaje ("… vitel", "planet tambien").
- **Mapear contra los SKU existentes**, no crear duplicados. El mismo teléfono aparece como
  "A566 (Galaxy A56 5G) 12+256GB DS" o "A56 12+256" según el proveedor.
- **Refrescar `times` SIEMPRE**, aunque el precio no cambie: eso es lo que marca la
  cotización como vigente. Agregar a `priceHistory` **solo si el precio cambió**.
- **Fechar con la fecha del listado** si viene fechado, no con la hora de ejecución
  (importa en el borde del lunes, que es cuando expiran los precios).
- **Renglones sin precio**: no tocar el SKU. Conserva su cotización anterior y envejece solo.
- **Cantidades y stock**: todavía NO hay campo. Se descartan y se mencionan en la respuesta.
- **Escribir `prices`, `times` y `priceHistory` en la MISMA pasada.** Si el historial se
  escribe al final por separado y la carga se interrumpe, quedan precios sin movimiento
  registrado (ya pasó con Bax el 18/08).
- Al terminar, **reportar los cambios de precio**, no solo "cargué N modelos".

### Nombres

Estilo del board: `A56 12+256 5G DS`, `Motorola G17 4+128`, `iPhone 17 Pro Max 512GB`,
`Tab S11 Wi-Fi 12+128 (SM-X730)`, `Lenovo IdeaPad Slim 3i 15.6" 2K Touch Core 7-350 16+512`.
RAM+disco siempre como `8+256`. Los códigos de modelo (SM-…, XT…) van entre paréntesis
cuando distinguen algo.

**El color se descarta… salvo que cambie el precio.** En teléfonos todos los colores valen
igual → un solo SKU. En los controles DualSense cada color tiene precio distinto ($52,50 a
$76) → un SKU por color. Los SKU "Orange" de iPhone existen porque algunos proveedores los
cotizan aparte.

### Renombrar un SKU o un proveedor

El catálogo sale de **DOS lados**: el `CATALOG` fijo de `price-logic.js` (43 modelos, sin
campo dept) **unido** al blob `catalog` de la base. Mismo nombre en ambos = una sola fila.
Renombrar solo en la base deja la fila base sin precios (vacía) y el SKU renombrado sin fila
(invisible). **Chequear las dos direcciones después de cualquier renombre.**

Para proveedores hay que renombrar en TODOS lados: `suppliers`, `supplierDepts`, `prices`,
`times`, `tiers`, `priceHistory`, `snapshots` (si no, se rompen las flechas ▲▼ contra la
semana pasada) **y `invoices`** (`items[].supplier`, `order.items[].supplier` y las claves de
`supplierCosts`). Dejar una referencia colgada hace que la app reasigne esa línea a otro
proveedor al re-guardar. Sumar `aliases[viejo] = nuevo` para consolidar la cuenta corriente
y verificar con `computeAccounts(..., "supplier")` que ningún saldo se movió.

## Taxonomía

`dept` = las pestañas de la Mesa · `cat` = los subtítulos que agrupan adentro.
**El dept se deriva de la cat** (`DEPT_BY_CAT` / `deptForCat` en `lib/constants.js`).

| Departamento | Categorías |
|---|---|
| Apple | iPhone, iPad, Mac, Accesorios Apple |
| Samsung | alta gama (serie S y plegables), baja gama (serie A), Tablets, Watch, Earbuds, Fundas, Accesorios |
| Motorola | LATIN, EURO, Accesorios Motorola |
| Laptops | Dell, HP, Lenovo, Samsung Laptops (las que no son Apple) |
| Gaming | PlayStation, Nintendo |
| Otros | Xiaomi y Redmi, Honor, Accesorios Amazon |

Agregar una categoría o departamento hoy **requiere editar `lib/constants.js` y deployar**.

## Qué vende cada proveedor

- **mirgor** = Motorola **LATIN**, o sea **con cargador incluido**. Su lista trae también
  accesorios y a veces una sección "BONDED" (mercadería en depósito fiscal).
- **SH** cubre Motorola, Samsung, laptops (Dell/HP/Lenovo) y gaming (PS5/Switch).
- **VITEL** y **planET**: Samsung y Motorola, más accesorios y tablets.
- **Bax**: Samsung. **South**, **Boston** y **Janice Keyton**: Apple (y South además Samsung
  y MacBooks). Janice Keyton aclara siempre que **el precio es negociable**.
- Boston se llamaba *Iphone Miami* y Janice Keyton se llamaba *Primeway* (renombrados 18/08).

## Precios rojos

`classifyFreshness` marca **expirado** todo lo anterior al lunes de la semana en curso, y la
Mesa lo pinta de rojo. **Nunca comparar proveedores sin mirar `times`**: un precio viejo
parece la mejor oferta y no lo es. Al comparar, marcar explícitamente cuáles están vencidos.

## Detalles que ya mordieron

- **IMEIs desactivados** (commit 9a3de61): el checkpoint `datos` era derivado de tener un
  IMEI por unidad, así que ninguna factura cerraba nunca. Está `skipped` en `lib/trades.js`.
  Se conserva el export a Excel y todos los datos.
- Los 7 modelos `S26 12/256GB 5G` y similares están en `hiddenModels` a propósito: son
  nombres crudos de proveedor.
- Las tres casillas de una factura son **afuera** (llegó a Miami), **local** (llegó a
  Argentina) y **pago** (pagó el cliente). Son seguimiento operativo: marcar "pago" **no**
  toca la cuenta corriente, eso necesita un movimiento en `ledger`.

## Verificación después de cada carga

```
prices y times con las mismas claves · catalog sin nombres repetidos
ningún SKU con precio fuera de (CATALOG base ∪ catalog) → sería invisible en la Mesa
ninguna fila base sin precio que no esté en hiddenModels → saldría vacía
```

## Cómo responderle

En español rioplatense. Primero **qué cambió de precio y qué conviene**, después el detalle.
Marcar siempre lo que se descartó o no se pudo interpretar en vez de inventarlo: si un número
no cierra (un AirPods a $395 cuando valen $150), decirlo y no cargarlo.

## Contraseña y conexión a la base (arreglado 18/08, commit 646f817)

La contraseña se confirma con **Enter** o al salir del campo, nunca en cada tecla. Antes se
mandaba con cada pulsación: el primer caracter daba 401, `storeLoaded` quedaba en `true` y la
sesión entera se quedaba **sin base, en silencio** — la app seguía andando sobre localStorage
sin persistir nada. Si alguien reporta "cargué algo y se perdió", revisar esto primero.
El indicador al lado del campo dice `conectado` / `incorrecta` / `sin conexión`.
