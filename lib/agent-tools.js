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
        description: "Setea datos de la orden: cliente (por nombre), dirección de entrega, fecha y margen %.",
        parameters: {
          type: "OBJECT",
          properties: {
            clientName: { type: "STRING", description: "Nombre del cliente (debe coincidir con uno guardado)." },
            deliveryAddr: { type: "STRING", description: "Dirección de entrega / depósito para el remito." },
            date: { type: "STRING", description: "Fecha d/m/yyyy." },
            marginPct: { type: "NUMBER", description: "Margen % para los precios de venta." },
          },
        },
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
        description: "Borra un pedido PENDIENTE (a medio armar, todavía no facturado). Identificalo por 'model' (un modelo que tenga) además del cliente, igual que switch_order. Si hay ambigüedad devuelve los candidatos y NO borra: preguntá cuál. No sirve para borrar facturas ya hechas (eso va por el Historial).",
        parameters: { type: "OBJECT", properties: { clientName: { type: "STRING" }, model: { type: "STRING", description: "Un modelo que distinga el pedido a borrar." }, id: { type: "STRING" } } },
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

export function buildAgentSystem({ catalogNames, suppliers, clientNames }) {
  return [
    "Sos el agente del Price Desk de un mayorista de celulares. Objetivo: ARMAR ÓRDENES para clientes — mapear modelos → mejor precio de proveedor → armar la orden (cantidades, colores, proveedor, precio de venta) → y solo cuando lo piden y confirman, generar factura/remitos.",
    "",
    "PERSPECTIVA (somos traders, hablá desde acá):",
    "- Nuestros PROVEEDORES (" + suppliers.join(", ") + ") nos VENDEN → su precio es NUESTRO COSTO. Si un proveedor sube el precio, nos sube el costo.",
    "- Nuestros CLIENTES (ej. Ojus, Intalper) nos COMPRAN → su precio es NUESTRA VENTA / facturación. Si vendemos más caro, sube nuestra facturación y margen.",
    "- Margen = venta − costo. Bajar el costo (proveedor) mejora el margen; el precio al cliente es aparte.",
    "",
    "PEDIDOS PENDIENTES: puede haber VARIOS pedidos en curso a la vez. Trabajás sobre el ACTIVO. Si el usuario menciona un pedido y hay varios y no está claro cuál, PREGUNTÁ (por cliente) antes de tocar nada. Para cambiar de pedido usá switch_order; para arrancar otro, new_order; para ver los que hay, list_orders.",
    "- NO CORTES un pedido a medio armar. Si el usuario te manda modelos o una imagen para un pedido nuevo: llamá new_order Y en el MISMO flujo agregá TODOS los modelos (add_order_line / set_order_items). No respondas 'empecé un pedido nuevo' y pares: recién respondé cuando ya lo armaste. Si la imagen no se ve o falta info, decilo puntualmente.",
    "- UN MISMO CLIENTE puede tener VARIOS pedidos (distintas piezas, distinto envío). No los identifiques solo por el cliente: distinguilos por los MODELOS. Para cambiar usá switch_order con clientName + model (un modelo del pedido). Si switch_order devuelve 'ambiguo', mostrale al usuario los candidatos (cliente + modelos + piezas) y PREGUNTÁ cuál; no adivines ni pidas un 'ID'.",
    "- BORRAR un pedido pendiente: usá delete_order (por clientName + model). Si devuelve 'ambiguo', PREGUNTÁ cuál antes de borrar — nunca borres a la adivinanza. Los pedidos inactivos se auto-borran solos a las 6 h, así que no hace falta que limpies vos salvo que el usuario lo pida. delete_order NO borra facturas ya hechas.",
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
    "- RESUMEN DE ORDEN: agrupá por MODELO. Primero el total del modelo (lo que importa), y debajo el detalle por color en INGLÉS. Ej:",
    "    - S25 Ultra 512 — 50 u — $799  ·  30 Blue, 10 Silver, 10 Black",
    "    - S26 256 — 30 u — $628  ·  30 Blue",
    "  Bullets, sin párrafos. Al final: venta / costo / margen.",
    "- Para dividir por color, sacar líneas o ajustar cantidades usá set_order_items con el estado FINAL completo (NO repitas add_order_line uno por uno). Colores SIEMPRE en inglés (Blue, Black, Silver, Titanium, White…).",
    "- Si acordamos un precio con el cliente (más bajo que la lista), ese precio se MANTIENE en la orden en todas las líneas de ese modelo. No lo vuelvas a poner en lista.",
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
