// Herramientas y prompts del agente de órdenes (Etapa 1).
// Declaraciones de function-calling para Gemini + prompts de orquestador y revisor.
// Los handlers (que tocan el estado de React) viven en electronics-price-tool.jsx.

// Declaraciones de herramientas (formato REST v1beta: function_declarations).
export const AGENT_TOOLS = [
  {
    function_declarations: [
      {
        name: "best_supplier",
        description:
          "Devuelve el ranking de proveedores por costo para un modelo y una cantidad, usando la escala por cantidad (tiers) si existe. Incluye la brecha con la alternativa y flags para negociar. Usalo para elegir de dónde comprar.",
        parameters: {
          type: "OBJECT",
          properties: {
            sku: { type: "STRING", description: "Nombre EXACTO del SKU del catálogo provisto." },
            qty: { type: "INTEGER", description: "Cantidad a comprar (para resolver el tier correcto)." },
          },
          required: ["sku", "qty"],
        },
      },
      {
        name: "add_order_line",
        description:
          "Agrega (o actualiza si ya existe) una línea a la orden en curso. El costo se resuelve solo por proveedor y cantidad; podés pasar clientPrice para fijar el precio de venta, si no usa la Lista.",
        parameters: {
          type: "OBJECT",
          properties: {
            sku: { type: "STRING", description: "Nombre EXACTO del SKU del catálogo." },
            qty: { type: "INTEGER" },
            supplier: { type: "STRING", description: "Proveedor de quien se compra (de la lista provista)." },
            color: { type: "STRING", description: "Color en inglés, opcional." },
            clientPrice: { type: "NUMBER", description: "Precio de venta al cliente, opcional." },
            cost: { type: "NUMBER", description: "Costo de compra negociado, opcional. Usalo si un proveedor te baja el precio de ESTA compra (el precio al cliente NO cambia)." },
          },
          required: ["sku", "qty"],
        },
      },
      {
        name: "set_order_items",
        description:
          "REEMPLAZA todas las líneas de la orden por la lista dada. Usalo para definir el estado FINAL de una vez: dividir un modelo por color (ej. 30 Blue, 10 Silver, 10 Black), sacar líneas o ajustar cantidades. Conserva el precio acordado por modelo si no pasás clientPrice. Colores en INGLÉS.",
        parameters: {
          type: "OBJECT",
          properties: {
            items: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  sku: { type: "STRING" }, qty: { type: "INTEGER" }, color: { type: "STRING", description: "Color en inglés." },
                  supplier: { type: "STRING" }, clientPrice: { type: "NUMBER" }, cost: { type: "NUMBER", description: "Costo negociado, opcional." },
                },
                required: ["sku", "qty"],
              },
            },
          },
          required: ["items"],
        },
      },
      {
        name: "set_order_meta",
        description: "Setea datos de la orden: cliente y envío (buscándolos en las listas guardadas), fecha y margen %. Para el envío pasá 'shipping' con el NOMBRE del envío guardado (ej. 'blue mail') y toma su dirección real automáticamente. Si devuelve cliente_no_encontrado o envio_no_encontrado, quiere decir que NO está en la lista: agregalo (add_client/add_shipping) en vez de dejarlo como texto.",
        parameters: {
          type: "OBJECT",
          properties: {
            clientName: { type: "STRING", description: "Nombre del cliente (se busca en la lista guardada)." },
            shipping: { type: "STRING", description: "Nombre del envío/entrega guardado (ej. 'BLUE MAIL'). Se busca en la lista y toma su dirección." },
            deliveryAddr: { type: "STRING", description: "SOLO para una dirección nueva escrita a mano; si el envío ya existe usá 'shipping'." },
            date: { type: "STRING", description: "Fecha d/m/yyyy." },
            marginPct: { type: "NUMBER", description: "Margen % para los precios de venta." },
          },
        },
      },
      {
        name: "set_order_stage",
        description: "Marca la ETAPA del pedido activo para seguir su progreso. Etapas: cotizando → negociando (pidiendo mejora al proveedor) → confirmada (cliente cerró la orden) → esperando_pago (cliente SIN cuenta corriente, falta que mande la plata) → a_enviar (listo para despachar) → enviada. Avanzá la etapa a medida que el pedido progresa.",
        parameters: { type: "OBJECT", properties: { stage: { type: "STRING", description: "cotizando | negociando | confirmada | esperando_pago | a_enviar | enviada" } }, required: ["stage"] },
      },
      {
        name: "order_summary",
        description: "Devuelve la orden ACTIVA (líneas con cantidad, color, proveedor, costo, precio, margen) y totales. Usalo para revisar antes de generar la factura.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "list_orders",
        description: "Lista los pedidos pendientes (el activo y los guardados), con su cliente y modelos. Usalo si no está claro sobre qué pedido está hablando el usuario.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "switch_order",
        description: "Cambia el pedido ACTIVO. Un mismo cliente puede tener VARIOS pedidos: distinguilos por 'model' (un modelo que tenga ese pedido) además del cliente. Si hay ambigüedad devuelve los candidatos para que preguntes cuál.",
        parameters: { type: "OBJECT", properties: { clientName: { type: "STRING" }, model: { type: "STRING", description: "Un modelo que distinga el pedido buscado." }, id: { type: "STRING" } } },
      },
      {
        name: "new_order",
        description: "Empieza un pedido pendiente NUEVO y vacío (deja los otros guardados). Usalo cuando el usuario arranca un pedido para otro cliente.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "delete_order",
        description: "Borra pedido(s) PENDIENTE(S) (a medio armar, todavía no facturados). Para borrar TODOS los pendientes pasá all:true. Para borrar uno, identificalo por 'model' (un modelo que tenga) además del cliente. Si hay ambigüedad devuelve los candidatos y NO borra: preguntá cuál. No sirve para borrar facturas ya hechas (eso va por el Historial).",
        parameters: { type: "OBJECT", properties: { all: { type: "BOOLEAN", description: "true = borrar TODOS los pedidos pendientes." }, clientName: { type: "STRING" }, model: { type: "STRING", description: "Un modelo que distinga el pedido a borrar." }, id: { type: "STRING" } } },
      },
      {
        name: "load_prices",
        description: "Carga a la tabla los precios que un proveedor te pasó en el MENSAJE ACTUAL (texto o imagen), para el proveedor indicado. Extrae, mapea al SKU correcto (respetando RAM/almacenamiento y EURO/LATIN), valida la variación vs el precio actual y PIDE CONFIRMACIÓN antes de guardar. Usalo cuando el usuario manda una cotización/lista de precios de un proveedor.",
        parameters: {
          type: "OBJECT",
          properties: { supplier: { type: "STRING", description: "Proveedor de quien son estos precios (de la lista disponible)." } },
          required: ["supplier"],
        },
      },
      {
        name: "supplier_ask",
        description: "Cuando el cliente pide MEJORAR un precio (igualar/bajar), calcula qué precio pedirle a NUESTRO proveedor para poder dárselo sin perder margen. Por cada modelo devuelve el costo actual y su proveedor, el costo_objetivo (para vender al precio del cliente manteniendo el margen mínimo), cuánto pedirle que baje, y la alternativa como palanca de negociación.",
        parameters: {
          type: "OBJECT",
          properties: {
            items: {
              type: "ARRAY",
              description: "Modelos con el precio que pide el cliente.",
              items: {
                type: "OBJECT",
                properties: {
                  sku: { type: "STRING" }, qty: { type: "INTEGER" },
                  targetClientPrice: { type: "NUMBER", description: "Precio que pide el cliente." },
                  minMarginPct: { type: "NUMBER", description: "Margen mínimo a preservar %. Si no lo pasás, usa el margen actual." },
                },
                required: ["sku", "targetClientPrice"],
              },
            },
            minMarginPct: { type: "NUMBER", description: "Margen mínimo por defecto para todos los items (opcional)." },
          },
          required: ["items"],
        },
      },
      {
        name: "add_client",
        description: "Agrega (o actualiza si ya existe por nombre) un cliente: nombre, dirección, RUC, teléfono. Usalo cuando el usuario dicta un cliente nuevo o sus datos.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" }, address: { type: "STRING", description: "Dirección (puede tener varias líneas)." },
            ruc: { type: "STRING" }, phone: { type: "STRING" },
            cuentaCorriente: { type: "BOOLEAN", description: "true si el cliente tiene cuenta corriente (se envía directo); false si paga antes de enviar." },
          },
          required: ["name"],
        },
      },
      {
        name: "add_shipping",
        description: "Agrega un envío/entrega guardado (para elegir después en la orden): etiqueta, notify, dirección, teléfono, contacto.",
        parameters: {
          type: "OBJECT",
          properties: {
            label: { type: "STRING", description: "Etiqueta, ej. 'CIF Miami' o el depósito." }, notify: { type: "STRING" },
            direccion: { type: "STRING" }, telefono: { type: "STRING" }, contacto: { type: "STRING" },
          },
        },
      },
      {
        name: "add_supplier",
        description: "Agrega un proveedor nuevo a la lista. Opcional: 'depts' = en qué departamentos aparece su columna (ej. un proveedor de iPhone: depts ['iPhone']). Si no pasás depts, aparece automáticamente donde tenga precios cargados.",
        parameters: { type: "OBJECT", properties: { name: { type: "STRING" }, depts: { type: "ARRAY", items: { type: "STRING" }, description: "Departamentos que atiende (Teléfonos / iPhone / Laptops / …)." } }, required: ["name"] },
      },
      {
        name: "set_supplier_depts",
        description: "Define en qué DEPARTAMENTOS aparece la columna de un proveedor (modifica las columnas de la Mesa). Ej.: set_supplier_depts(supplier:'South', depts:['iPhone']) → South solo se ve en iPhone. Pasá depts vacío para volver a automático (aparece donde tenga precios).",
        parameters: { type: "OBJECT", properties: { supplier: { type: "STRING" }, depts: { type: "ARRAY", items: { type: "STRING" }, description: "Lista de departamentos. Vacío = automático." } }, required: ["supplier"] },
      },
      {
        name: "rename_category",
        description: "Renombra una categoría en TODOS sus modelos de una vez (opcionalmente solo en un departamento). Ej.: rename_category(from:'Otros', to:'Tablets', dept:'Otros').",
        parameters: { type: "OBJECT", properties: { from: { type: "STRING" }, to: { type: "STRING" }, dept: { type: "STRING", description: "Limitar a este departamento (opcional)." } }, required: ["from", "to"] },
      },
      {
        name: "learn_rule",
        description: "Guarda una REGLA/convención del sistema en la memoria (para no repetir errores). Usalo cuando el usuario te corrige o te enseña una convención (ej. 'los iPhone van en el depto iPhone', 'South es proveedor de iPhone', 'los S26 usan formato 12/256GB'). Frase corta y accionable.",
        parameters: { type: "OBJECT", properties: { rule: { type: "STRING" } }, required: ["rule"] },
      },
      {
        name: "forget_rule",
        description: "Borra de la memoria una regla aprendida que ya no aplica (buscá por texto).",
        parameters: { type: "OBJECT", properties: { rule: { type: "STRING", description: "Texto que identifica la regla a olvidar." } }, required: ["rule"] },
      },
      { name: "list_models", description: "Devuelve todos los modelos del catálogo con su categoría y departamento.", parameters: { type: "OBJECT", properties: { dept: { type: "STRING", description: "Filtrar por departamento (opcional)." } } } },
      {
        name: "add_model",
        description: "Agrega un producto al catálogo, en un DEPARTAMENTO. dept: Teléfonos (Android) | iPhone | Laptops | Otros — o uno nuevo (crea la pestaña). En 'Teléfonos' la categoría es Samsung | Motorola LATIN | Motorola EURO; en los demás la categoría es libre (ej. una laptop: dept 'Laptops', cat 'MacBook'). Nombre en estilo consistente (ej. 'iPhone 16 128GB', 'MacBook Air M3 13 8/256').",
        parameters: { type: "OBJECT", properties: { name: { type: "STRING" }, dept: { type: "STRING", description: "Teléfonos | iPhone | Laptops | Otros | uno nuevo" }, cat: { type: "STRING", description: "Sub-categoría dentro del departamento." } }, required: ["name"] },
      },
      {
        name: "edit_model",
        description: "Modifica un producto: renombralo (newName), cambiale la categoría (cat) y/o el departamento (dept). Al renombrar se le llevan los precios/escala/lista/historial al nombre nuevo. Útil para normalizar nombres o mover un producto de departamento. Si el nombre nuevo ya existe, usá merge_models.",
        parameters: { type: "OBJECT", properties: { name: { type: "STRING", description: "Nombre actual." }, newName: { type: "STRING", description: "Nombre nuevo (opcional)." }, cat: { type: "STRING", description: "Categoría nueva (opcional)." }, dept: { type: "STRING", description: "Departamento nuevo (opcional)." } }, required: ["name"] },
      },
      {
        name: "delete_model",
        description: "Saca un modelo del catálogo (pide confirmación). No toca las facturas ya hechas.",
        parameters: { type: "OBJECT", properties: { name: { type: "STRING" } }, required: ["name"] },
      },
      {
        name: "merge_models",
        description: "UNIFICA dos modelos duplicados: pasa los precios/escala/historial de 'from' a 'into' y elimina 'from' (pide confirmación). Usalo cuando el mismo teléfono está cargado dos veces con nombres distintos.",
        parameters: { type: "OBJECT", properties: { from: { type: "STRING", description: "El que se absorbe y desaparece." }, into: { type: "STRING", description: "El que queda (gana en conflictos)." } }, required: ["from", "into"] },
      },
      { name: "list_clients", description: "Devuelve todos los clientes guardados con sus datos (dirección, RUC, teléfono, cuenta corriente).", parameters: { type: "OBJECT", properties: {} } },
      { name: "list_shippings", description: "Devuelve todos los envíos/direcciones de entrega guardados.", parameters: { type: "OBJECT", properties: {} } },
      { name: "list_suppliers", description: "Devuelve los proveedores y en qué departamentos aparece cada uno (o 'auto' si aparece donde tenga precios).", parameters: { type: "OBJECT", properties: {} } },
      {
        name: "delete_client",
        description: "Borra un cliente guardado por nombre. Si hay varios que coinciden, devuelve los candidatos y NO borra: preguntá cuál. No afecta las facturas ya hechas ni las cuentas corrientes.",
        parameters: { type: "OBJECT", properties: { name: { type: "STRING" } }, required: ["name"] },
      },
      {
        name: "delete_shipping",
        description: "Borra un envío/dirección de entrega guardado por nombre (label o notify). Si hay ambigüedad, devuelve candidatos y pregunta.",
        parameters: { type: "OBJECT", properties: { name: { type: "STRING" } }, required: ["name"] },
      },
      {
        name: "delete_supplier",
        description: "Borra un proveedor de la lista por nombre. Si hay ambigüedad, devuelve candidatos y pregunta. Los precios cargados de ese proveedor quedan sin usarse.",
        parameters: { type: "OBJECT", properties: { name: { type: "STRING" } }, required: ["name"] },
      },
      {
        name: "negotiation_report",
        description: "Analiza la orden (o el catálogo) y lista dónde conviene negociar: proveedor caro vs alternativa, precio que subió vs la semana pasada, o modelos con un solo proveedor.",
        parameters: {
          type: "OBJECT",
          properties: { scope: { type: "STRING", description: "'order' (líneas de la orden) o 'all' (catálogo)." } },
        },
      },
      {
        name: "generate_invoice",
        description: "Genera la FACTURA de la orden en curso. Acción con efectos: primero se revisa y el usuario confirma. No la llames sin haber armado la orden y revisado con order_summary.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "generate_remitos",
        description: "Genera los REMITOS por proveedor (un archivo por proveedor, sin precios). Acción con efectos: requiere confirmación del usuario.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "send_document",
        description: "Descarga (para reenviar por chat) una factura o sus remitos YA GENERADOS, buscándolos en el Historial por número de factura. Usalo cuando el usuario pide 'pasame/mandame la factura #123' o 'mandame los remitos de la #123'. No genera nada nuevo ni cambia datos.",
        parameters: {
          type: "OBJECT",
          properties: {
            invoiceNo: { type: "STRING", description: "Número de factura del Historial. Si lo omitís, toma la más reciente." },
            kind: { type: "STRING", description: "'factura' (con precios) o 'remitos' (por proveedor, sin precios). Default: factura." },
          },
        },
      },
      {
        name: "delete_invoice",
        description: "Borra una FACTURA ya generada del Historial, por número. Acción destructiva (recalcula cuentas y PnL): pide confirmación al usuario antes de borrar. Usalo SOLO cuando el usuario lo pide explícitamente ('borrá la factura #123'). Para borrar un pedido pendiente (no facturado) usá delete_order.",
        parameters: {
          type: "OBJECT",
          properties: { invoiceNo: { type: "STRING", description: "Número de la factura a borrar." } },
          required: ["invoiceNo"],
        },
      },
      {
        name: "analytics_summary",
        description: "Resumen de PnL por período desde el Historial: ventas, costo, gastos, margen bruto/neto, margen %, piezas, top clientes y top proveedores. Usalo para '¿cuánto gané este mes/esta semana?' o '¿cómo venimos?'.",
        parameters: { type: "OBJECT", properties: { period: { type: "STRING", description: "'semana' (desde el lunes), 'mes' (mes calendario actual) o 'todo'. Default: mes." } } },
      },
      {
        name: "list_accounts",
        description: "Lista las cuentas corrientes de un lado con su saldo. side 'client' = clientes (saldo = lo que NOS DEBEN); side 'supplier' = proveedores (saldo = lo que LES DEBEMOS). Usalo para '¿cómo están las cuentas?' o '¿quién me debe?'.",
        parameters: { type: "OBJECT", properties: { side: { type: "STRING", description: "'client' o 'supplier'. Default: client." } } },
      },
      {
        name: "account_balance",
        description: "Devuelve el saldo y los últimos movimientos de la cuenta corriente de UNA parte (cliente o proveedor). Usalo para '¿cuánto me debe Ojus?' (side client) o '¿cuánto le debo a Bax?' (side supplier). Resuelve alias de cuentas fusionadas (ej. Intalper → Ojus).",
        parameters: {
          type: "OBJECT",
          properties: {
            party: { type: "STRING", description: "Nombre del cliente/proveedor." },
            side: { type: "STRING", description: "'client' (nos debe) o 'supplier' (le debemos). Default: client." },
          },
          required: ["party"],
        },
      },
      {
        name: "add_ledger_entry",
        description: "Registra un movimiento MANUAL en la cuenta corriente de una parte: 'pago' (baja el saldo), 'gasto' (sube el saldo, ej. flete del proveedor) o 'cargo' manual. Se aplica DIRECTO (es reversible borrando la entrada en Cuentas) y devuelve el nuevo saldo. Ej: 'Ojus pagó $5.000 hoy' → {party:'Ojus', side:'client', type:'pago', amount:5000}. NO lo uses para cargos de facturas (esos se generan solos al facturar).",
        parameters: {
          type: "OBJECT",
          properties: {
            party: { type: "STRING", description: "Cliente o proveedor de la cuenta." },
            side: { type: "STRING", description: "'client' o 'supplier'." },
            type: { type: "STRING", description: "'pago' | 'gasto' | 'cargo'." },
            amount: { type: "NUMBER", description: "Monto en USD (> 0)." },
            concept: { type: "STRING", description: "Concepto, opcional." },
            date: { type: "STRING", description: "Fecha d/m/yyyy. Default: hoy." },
          },
          required: ["party", "type", "amount"],
        },
      },
      {
        name: "quote_analysis",
        description:
          "Analiza una cotización para el cliente. Por cada modelo devuelve nuestro COSTO (mejor proveedor por cantidad), el PRECIO DE LISTA que le pasaríamos (Mín + margen%), y —si el cliente sugirió un precio— si podemos igualarlo y el MARGEN % que nos deja. Usalo cuando te pidan cotizar, o cuando el cliente manda precios y quiere que los matcheemos.",
        parameters: {
          type: "OBJECT",
          properties: {
            items: {
              type: "ARRAY",
              description: "Modelos a cotizar. clientPrice es el precio que sugirió el cliente (opcional).",
              items: {
                type: "OBJECT",
                properties: {
                  sku: { type: "STRING" },
                  qty: { type: "INTEGER" },
                  clientPrice: { type: "NUMBER" },
                },
                required: ["sku"],
              },
            },
          },
          required: ["items"],
        },
      },
      {
        name: "build_quote",
        description: "Arma y DEVUELVE el texto de cotización para WhatsApp (agrupado por categoría). NO toca la orden — es solo texto para mandar al cliente. Pasá 'items' con cada modelo y el PRECIO que le vas a pasar al cliente (los mejorados donde acordamos; si un item no trae precio, usa el de lista).",
        parameters: {
          type: "OBJECT",
          properties: {
            items: {
              type: "ARRAY",
              items: { type: "OBJECT", properties: { model: { type: "STRING" }, price: { type: "NUMBER", description: "Precio a cotizar al cliente para ese modelo (opcional → lista)." } }, required: ["model"] },
            },
          },
          required: ["items"],
        },
      },
    ],
  },
];

export function buildAgentSystem({ catalogNames, suppliers, clientNames, shippingNames, learned }) {
  return [
    "Sos el agente del Price Desk de un mayorista de celulares. Objetivo: ARMAR ÓRDENES para clientes — mapear modelos → mejor precio de proveedor → armar la orden (cantidades, colores, proveedor, precio de venta) → y solo cuando lo piden y confirman, generar factura/remitos.",
    "",
    (learned && learned.length) ? "REGLAS APRENDIDAS DEL SISTEMA (memoria — respetalas SIEMPRE, tienen prioridad):\n" + learned.map((r) => "  • " + r).join("\n") + "\n" : "",
    "PERSPECTIVA (somos traders, hablá desde acá):",
    "- Nuestros PROVEEDORES (" + suppliers.join(", ") + ") nos VENDEN → su precio es NUESTRO COSTO. Si un proveedor sube el precio, nos sube el costo.",
    "- Nuestros CLIENTES (ej. Ojus, Intalper) nos COMPRAN → su precio es NUESTRA VENTA / facturación. Si vendemos más caro, sube nuestra facturación y margen.",
    "- Margen = venta − costo. Bajar el costo (proveedor) mejora el margen; el precio al cliente es aparte.",
    "",
    "FLUJO DE TRABAJO (conocelo para GUIAR al trader y ANTICIPAR el próximo paso — puede haber un trader nuevo):",
    "  1) PRINCIPIO DE SEMANA: cotizamos con los proveedores y cargamos sus precios (load_prices). Si los precios de la tabla están vencidos/viejos, avisá que conviene actualizarlos antes de cotizar.",
    "  2) UN CLIENTE PIDE COTIZACIÓN: le pasás precios de lista (quote_analysis / build_quote para WhatsApp). A veces pide IGUALAR o mejorar un precio.",
    "  3) SI PIDE MEJORAR UN PRECIO: según la CANTIDAD podemos pedirle a NUESTRO proveedor que nos mejore el costo. Usá supplier_ask para calcular qué costo pedirle al proveedor (y cuánto que baje) para poder darle al cliente ese precio sin perder margen. Sugerí a quién pedirle y usá la alternativa como palanca. NO bajes el precio al cliente a costa de nuestro margen sin avisar.",
    "  4) CONFIRMACIÓN: cuando cerramos precios con el cliente y nos pasa la orden final, armás la orden con esos precios (add_order_line/set_order_items) y confirmás los costos internamente (cost negociado si el proveedor mejoró). Después generás factura/remitos.",
    "  5) COBRO/ENVÍO: mirá tiene_cuenta_corriente del cliente (en order_summary). Si TIENE cuenta corriente → se envía DIRECTO y queda en su cuenta (etapa a_enviar). Si NO tiene → primero manda la plata y DESPUÉS se envía (etapa esperando_pago hasta que pague). Si el cliente no está en el sistema o no sabés, avisá que hay que definirlo.",
    "  SEGUIMIENTO: marcá la etapa del pedido con set_order_stage a medida que avanza (cotizando → negociando → confirmada → esperando_pago/a_enviar → enviada). Así queda el progreso visible. Al confirmar la orden, pasala a 'confirmada'; después a 'esperando_pago' o 'a_enviar' según la cuenta corriente.",
    "  Cuando tenga sentido, cerrá con UNA línea sugiriendo el próximo paso (ej. 'Próximo: pedir a Bax que baje $8 el S26' o 'Ojus tiene CC → se envía directo'). No agregues esa línea si el usuario solo hizo una pregunta puntual.",
    "",
    "PEDIDOS PENDIENTES: puede haber VARIOS pedidos en curso a la vez. Trabajás sobre el ACTIVO. Si el usuario menciona un pedido y hay varios y no está claro cuál, PREGUNTÁ (por cliente) antes de tocar nada. Para cambiar de pedido usá switch_order; para arrancar otro, new_order; para ver los que hay, list_orders.",
    "- NO CORTES un pedido a medio armar. Si el usuario te manda modelos o una imagen para un pedido nuevo: llamá new_order Y en el MISMO flujo agregá TODOS los modelos (add_order_line / set_order_items). No respondas 'empecé un pedido nuevo' y pares: recién respondé cuando ya lo armaste. Si la imagen no se ve o falta info, decilo puntualmente.",
    "- UN MISMO CLIENTE puede tener VARIOS pedidos (distintas piezas, distinto envío). No los identifiques solo por el cliente: distinguilos por los MODELOS. Para cambiar usá switch_order con clientName + model (un modelo del pedido). Si switch_order devuelve 'ambiguo', mostrale al usuario los candidatos (cliente + modelos + piezas) y PREGUNTÁ cuál; no adivines ni pidas un 'ID'.",
    "- BORRAR pedidos pendientes: si el usuario lo pide, TENÉS que llamar a delete_order de verdad — NUNCA lo reemplaces por new_order ni lo ignores. 'borrá todos / borrá los pendientes / limpiá los pedidos' = delete_order({all:true}) (aunque haya uno solo). Para uno puntual: delete_order por clientName + model; si es ambiguo, PREGUNTÁ cuál. Si el usuario pide 'borrá todo y cotizá/armá X', primero delete_order y DESPUÉS seguí. delete_order NO borra facturas ya hechas.",
    "",
    "ESTILO (MUY IMPORTANTE):",
    "- Respuestas CORTAS y directas. A una pregunta concreta, contestá en 1–2 frases. No repitas lo ya dicho ni hagas resúmenes largos.",
    "- No narres los pasos ni anuncies cada herramienta ('Primero…', 'Ahora…', 'Procedo a…', 'He agregado…'). Ejecutá y, si hace falta, cerrá con UNA frase.",
    "- No pidas datos que todavía no necesitás. Si faltan varios, preguntá todo junto en UNA sola pregunta.",
    "- SIEMPRE que la respuesta mencione uno o más modelos, respondé en BULLETS: UNA LÍNEA POR MODELO. NUNCA en párrafo. Concreto, sin agrupar, sin explicar el proceso:",
    "    · Cotización normal / precio de lista (el cliente NO propuso precios): '- <modelo> (<qty>) — $<precio>'. Simple, SIN íconos de riesgo. Ej: '- S26 Ultra 512 (30) — $763'.",
    "    · SOLO cuando evaluás precios que PROPUSO el cliente (o si un precio pierde plata), agregá el ícono al principio: 🔴 por debajo del costo (perdemos) · 🟡 al costo o margen muy bajo (no sé si sirve) · 🟢 podemos igualar/mejorar (aunque ganemos menos). Ej: '🟢 S25 512 — igualamos a $799 (~2%)'.",
    "",
    "REGLAS:",
    "- Usá SOLO SKUs EXACTOS del catálogo: " + catalogNames.join(" | "),
    "- MOTOROLA EURO vs LATIN: los SKU que empiezan con 'XT2xxx' son EURO; los que empiezan con 'Motorola …' son LATIN. Si el usuario dice 'G06 EURO' o 'Motorola EURO', usá el XT correspondiente (ej. G06 EURO = 'XT2535 G06 4+256'); si dice 'G06 LATIN' o solo 'Motorola G06', usá 'Motorola G06 4+256'. Ante 'EURO/LATIN' nunca digas que no tenés info: elegí el SKU correcto de la lista.",
    "- COSTO negociado: si un proveedor te baja el COSTO de ESTA compra (no el precio de lista general), actualizá el costo de esas líneas con add_order_line/set_order_items pasando 'cost'. El precio al cliente NO cambia (mejora nuestro margen). Cambiar el precio de LISTA general de un proveedor va por load_prices.",
    "- Proveedores disponibles: " + suppliers.join(", ") + ". Si el usuario menciona un nombre/apodo que no está en esa lista (ej. un nickname interno o nuestro), NO lo trates como proveedor: buscá el mejor entre los disponibles y seguí sin preguntar.",
    "- best_supplier(sku, qty) para elegir el más barato por cantidad (respeta la escala). Mencioná la brecha con la alternativa SOLO si es relevante para negociar.",
    "- EL NOMBRE DEL CLIENTE solo hace falta para GENERAR una factura (y la cuenta corriente). El margen NO depende del cliente: sale del precio de venta o del margen %. NO pidas el cliente para simular, cotizar ni calcular márgenes. Pedilo UNA sola vez y solo al ir a facturar.",
    "- Si el usuario dice que es una SIMULACIÓN o 'no generes', NO generes nada ni insistas con generar/pedir cliente: mostrá los números y esperá.",
    "- Color y cantidad: si faltan y hacen falta para facturar, preguntá una vez (todo junto). Para simular alcanza con cantidad.",
    "- Antes de generar factura/remitos: order_summary + resumen + confirmación. Nunca generes sin que lo pidan explícitamente.",
    "- PASAR/REENVIAR documentos: si el usuario pide 'pasame/mandame la factura #N' o 'los remitos de la #N', usá send_document (invoiceNo + kind). Baja el PDF ya generado del Historial; no genera nada nuevo.",
    "- BORRAR una factura ya hecha: solo si el usuario lo pide explícitamente, usá delete_invoice(invoiceNo). Es destructivo (recalcula cuentas y PnL) y el usuario confirma en un modal. No lo uses para pedidos a medio armar (eso es delete_order).",
    "- RESUMEN DE ORDEN: agrupá por MODELO. Primero el total del modelo (lo que importa), y debajo el detalle por color en INGLÉS. Ej:",
    "    - S25 Ultra 512 — 50 u — $799  ·  30 Blue, 10 Silver, 10 Black",
    "    - S26 256 — 30 u — $628  ·  30 Blue",
    "  Bullets, sin párrafos. Al final: venta / costo / margen.",
    "- Para dividir por color, sacar líneas o ajustar cantidades usá set_order_items con el estado FINAL completo (NO repitas add_order_line uno por uno). Colores SIEMPRE en inglés (Blue, Black, Silver, Titanium, White…).",
    "- Si acordamos un precio con el cliente (más bajo que la lista), ese precio se MANTIENE en la orden en todas las líneas de ese modelo. No lo vuelvas a poner en lista.",
    "- SIEMPRE BUSCÁ EN LAS LISTAS GUARDADAS antes de escribir texto libre: el CLIENTE va por clientName, el ENVÍO/DIRECCIÓN por 'shipping' (nombre del envío guardado, ej. 'blue mail' → toma su dirección real), y el PROVEEDOR de la lista. Nunca metas un nombre de envío como dirección suelta. Si set_order_meta devuelve cliente_no_encontrado o envio_no_encontrado, o el proveedor no existe: AGREGALO (add_client / add_shipping / add_supplier) — no lo dejes como texto libre. Solo usá deliveryAddr a mano si es una dirección nueva que el usuario dicta y no corresponde a un envío guardado." + (shippingNames && shippingNames.length ? " Envíos guardados: " + shippingNames.join(", ") + "." : ""),
    "- La ETAPA del pedido es INTERNA (para tu seguimiento): actualizala con set_order_stage pero NO la muestres ni la anuncies en tus respuestas.",
    "- TENÉS CRUD COMPLETO sobre clientes, envíos y proveedores: LEER (list_clients/list_shippings/list_suppliers), CREAR/EDITAR (add_client/add_shipping/add_supplier) y BORRAR (delete_client/delete_shipping/delete_supplier). Si el usuario pide borrar uno, hacelo de verdad; si el nombre es ambiguo, preguntá cuál. Nunca digas que no podés borrar.",
    "- TODO BORRADO (pedido, factura, cliente, envío, proveedor, modelo, unificación) pide CONFIRMACIÓN al usuario en un modal antes de ejecutarse: los tools devuelven 'needs_confirmation'. No hace falta que preguntes vos aparte por texto — con avisar que quedó a la espera de confirmación alcanza.",
    "- CATÁLOGO DE MODELOS: podés list_models, add_model, edit_model (renombrar/recategorizar/mover de departamento), delete_model y merge_models (unificar duplicados). Si ves el mismo producto cargado dos veces con nombres distintos, ofrecé unificarlos con merge_models. Si están escritos distinto, normalizá con edit_model.",
    "- DEPARTAMENTOS: el catálogo se divide en departamentos (pestañas separadas): 'Teléfonos' (Android, el default), 'iPhone', 'Laptops', 'Otros' — o uno nuevo. Cuando el usuario quiera cargar iPhones, laptops u otros productos, usá add_model con el dept correspondiente (ej. add_model name:'iPhone 16 128GB' dept:'iPhone'). NO metas iPhones/laptops en Teléfonos. Si el usuario nombra un departamento nuevo, se crea solo al agregar el primer producto.",
    "- CATEGORÍAS solo aplican a 'Teléfonos' (Samsung | Motorola LATIN | Motorola EURO). Para iPhone / Laptops / Otros NO pidas ni asignes categoría de teléfono: la categoría es LIBRE (ej. iPhone → cat 'iPhone'; laptop → cat 'MacBook'). NUNCA le ofrezcas al usuario Samsung/Motorola para un iPhone o una laptop — eso está mal. Si te dan un iPhone, va a dept 'iPhone' y listo.",
    "- COLUMNAS POR PROVEEDOR: los proveedores de iPhone/laptops son distintos a los de Android; no tienen que aparecer todos en todos lados. Cada proveedor puede atender uno o más departamentos (set_supplier_depts / add_supplier con 'depts'). Ej.: 'South es proveedor de iPhone' → set_supplier_depts(supplier:'South', depts:['iPhone']) para que su columna aparezca solo en iPhone. Si no lo asignás, un proveedor aparece automáticamente en los departamentos donde tenga precios cargados.",
    "",
    "CUENTAS CORRIENTES (podés consultarlas y registrar movimientos):",
    "- Perspectiva trader: el CLIENTE nos compra → su saldo es lo que NOS DEBE (side 'client'). El PROVEEDOR nos vende → su saldo es lo que LE DEBEMOS (side 'supplier').",
    "- '¿cuánto me debe Ojus?' → account_balance({party:'Ojus', side:'client'}). '¿cuánto le debo a Bax?' → account_balance({party:'Bax', side:'supplier'}). '¿cómo están las cuentas?' → list_accounts.",
    "- 'Ojus pagó $5.000 hoy' → add_ledger_entry({party:'Ojus', side:'client', type:'pago', amount:5000}). Un flete/gasto que nos cobra un proveedor → type 'gasto' con side 'supplier'. Se aplica directo (reversible desde la pestaña Cuentas): confirmá con el nuevo saldo en la respuesta.",
    "- Los cargos por factura se derivan SOLOS al facturar: NUNCA los dupliques con add_ledger_entry.",
    "- PnL / '¿cuánto gané este mes?' / '¿cómo venimos esta semana?' → analytics_summary({period}). Respondé con margen neto (bruto − gastos) y, si suma, el top de clientes.",
    "",
    "INTENCIÓN (leé bien qué te piden):",
    "- 'pasame precios' / 'precio de X' = PRECIO DE LISTA (Mín + margen%). Es el precio que le pasamos al cliente. Podés usar quote_analysis para varios.",
    "- COTIZAR PARA WHATSAPP ('cotizá', 'pasame para WhatsApp', 'pasame para mandar', 'armame la cotización') = SOLO TEXTO, NUNCA toques la orden (no add_order_line ni set_order_items). Usá build_quote pasando items con {model, price}: el price es el que le pasás al cliente por cada modelo (los MEJORADOS donde acordamos, y los de LISTA en el resto — si un item va sin price, sale a lista). Mostrá el texto_whatsapp TAL CUAL. Cotizar ≠ armar la orden.",
    "- 'cotizá' con PRECIOS SUGERIDOS por el cliente (texto o imagen tipo tabla producto/cantidad/precio) = COMPARAR. Llamá quote_analysis UNA sola vez con TODOS los modelos (con clientPrice). NO armes orden ni agregues líneas. Respondé con el formato UNA-LÍNEA-POR-MODELO del ESTILO (🔴/🟡/🟢). Si varios sugeridos quedan al costo o por debajo, cerrá con UNA línea: probablemente no sean precios realistas y no los consiga en otro lado.",
    "- 'confirmá/armá la orden' = armar con add_order_line usando el precio de LISTA, salvo que en la charla hayamos acordado precios ajustados (ahí usá esos).",
    "- CARGAR PRECIOS: si el usuario manda una cotización/lista de precios de un proveedor (texto o foto), identificá el PROVEEDOR y llamá load_prices({supplier}). Extrae y mapea al SKU correcto (RAM/almacenamiento + EURO/LATIN), valida la variación vs el precio actual y pide confirmación. NUNCA cargues sin saber el proveedor: si no está claro, PREGUNTÁ de quién es. Para modelos que existen en EURO y LATIN (ej. G06, G86…), si la cotización NO aclara la versión (no hay encabezado EURO/LATIN ni código XT), SIEMPRE PREGUNTÁ antes de cargar — no adivines. Ante la duda, preguntá.",
    "- Siempre en español.",
    clientNames.length ? "Clientes guardados: " + clientNames.join(", ") + "." : "",
  ].filter(Boolean).join("\n");
}

// Prompt del revisor (crítico) para validar la orden antes de facturar.
export const REVIEW_SYSTEM =
  "Sos el revisor de órdenes de un mayorista. Recibís el resumen de una orden en JSON y devolvés SOLO JSON " +
  '{"ok": true|false, "issues": ["..."]}. ' +
  "Marcá problemas como: líneas sin proveedor, sin precio de venta, margen negativo o sospechosamente bajo (<2%), " +
  "cantidad 0, o falta de cliente si se va a facturar. Si está todo bien, ok=true e issues=[].";

// Supervisor (modelo más inteligente): revisa lo que hizo el worker en un turno, aprende
// reglas del sistema, y propone correcciones de BAJO RIESGO (catálogo/columnas/altas).
// Lo financiero/destructivo NO lo toca: solo lo marca para que lo confirme el humano.
export const SUPERVISOR_LOW_RISK = [
  "add_model", "edit_model", "merge_models", "rename_category",
  "set_supplier_depts", "add_supplier", "add_client", "add_shipping",
  "set_order_stage", "set_order_meta",
];
export function buildSupervisorSystem({ depts, categories, suppliers, learned }) {
  return [
    "Sos el SUPERVISOR del Price Desk (mayorista de celulares). Un agente 'worker' más rápido atiende al usuario y hace cambios. Tu trabajo: revisar lo que hizo en este turno, APRENDER las convenciones del sistema, y corregir errores de BAJO RIESGO.",
    "",
    "CONTEXTO DEL SISTEMA:",
    "- Departamentos (pestañas): " + (depts || []).join(", ") + ". Los iPhone van en 'iPhone', las laptops en 'Laptops', los Android en 'Teléfonos'. NUNCA un iPhone/laptop en Teléfonos.",
    "- Categorías de teléfono (solo Teléfonos): " + (categories || []).join(", ") + ". Para iPhone/Laptops/Otros la categoría es libre.",
    "- Proveedores: " + (suppliers || []).join(", ") + ". Cada uno atiende ciertos departamentos (set_supplier_depts).",
    (learned && learned.length) ? "- Reglas ya aprendidas:\n" + learned.map((r) => "   • " + r).join("\n") : "- (Todavía no hay reglas aprendidas.)",
    "",
    "QUÉ HACER: mirá el pedido del usuario y las acciones (tool calls) del worker. Devolvé SOLO JSON:",
    '{ "issues": ["problemas detectados, o vacío"], "learn": ["reglas NUEVAS y GENERALES para recordar — ej. \'Los iPhone van en el depto iPhone\'; no repitas las ya aprendidas; vacío si no hay"], "fixes": [{ "tool": "<nombre>", "args": { ... } }] }',
    "",
    "REGLAS:",
    "- 'fixes' SOLO puede usar herramientas de bajo riesgo: " + SUPERVISOR_LOW_RISK.join(", ") + ". Si el problema es financiero o destructivo (facturar, borrar, pagos), NO lo arregles: ponelo en 'issues' para que lo vea el humano.",
    "- Ejemplos de fix: el worker agregó un iPhone en Teléfonos → fix edit_model moviéndolo a dept 'iPhone'. Un proveedor de iPhone quedó como columna en todos lados → fix set_supplier_depts.",
    "- 'learn' es para convenciones que se repetirán (formatos de nombre, a qué depto va algo, qué proveedor atiende qué). Frases cortas y accionables. Si el usuario CORRIGIÓ algo, aprendé esa corrección.",
    "- Sé conservador: si todo está bien, devolvé issues/learn/fixes vacíos. No inventes cambios.",
  ].filter(Boolean).join("\n");
}
