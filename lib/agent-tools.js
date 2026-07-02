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
            color: { type: "STRING", description: "Color, opcional." },
            clientPrice: { type: "NUMBER", description: "Precio de venta al cliente, opcional." },
          },
          required: ["sku", "qty"],
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
        description: "Devuelve la orden en curso (líneas con cantidad, color, proveedor, costo, precio, margen) y totales. Usalo para revisar antes de generar la factura.",
        parameters: { type: "OBJECT", properties: {} },
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
        name: "build_quote",
        description: "Arma el texto de cotización para el cliente a partir de los modelos de la orden.",
        parameters: {
          type: "OBJECT",
          properties: { source: { type: "STRING", description: "'lista' o 'client' (precio a usar)." } },
        },
      },
    ],
  },
];

export function buildAgentSystem({ catalogNames, suppliers, clientNames }) {
  return [
    "Sos el agente del Price Desk de un mayorista de celulares. Tu objetivo principal es ARMAR ÓRDENES PARA CLIENTES de punta a punta:",
    "el cliente pasa modelos → buscás el mejor precio de nuestros proveedores → armás la orden (cantidades, colores, proveedor) → definís el precio de venta → y cuando el usuario confirma, generás la factura y los remitos.",
    "",
    "Reglas:",
    "- Usá SOLO nombres de SKU EXACTOS de este catálogo:",
    catalogNames.join(" | "),
    "- Proveedores disponibles: " + suppliers.join(", ") + ".",
    "- Clientes guardados: " + (clientNames.length ? clientNames.join(", ") : "(ninguno)") + ".",
    "- Para elegir de dónde comprar, llamá a best_supplier(sku, qty) — respeta la escala por cantidad. Si un proveedor está caro vs la alternativa, decilo (sugerí negociar) pero igual armá con el mejor disponible.",
    "- Agregá cada modelo con add_order_line. Si el cliente no aclaró color o cantidad, preguntá antes de asumir.",
    "- Antes de generar la factura, llamá a order_summary y mostrale al usuario el resumen (venta, costo, margen) y pedí confirmación. NO generes factura ni remitos sin que el usuario lo pida explícitamente.",
    "- Si te piden cargar/cambiar precios, todavía no está habilitado en esta etapa: avisá que eso va por 'Cargar precios'.",
    "- Respondé SIEMPRE en español, breve y concreto. Cuando termines un paso, resumí qué hiciste.",
  ].join("\n");
}

// Prompt del revisor (crítico) para validar la orden antes de facturar.
export const REVIEW_SYSTEM =
  "Sos el revisor de órdenes de un mayorista. Recibís el resumen de una orden en JSON y devolvés SOLO JSON " +
  '{"ok": true|false, "issues": ["..."]}. ' +
  "Marcá problemas como: líneas sin proveedor, sin precio de venta, margen negativo o sospechosamente bajo (<2%), " +
  "cantidad 0, o falta de cliente si se va a facturar. Si está todo bien, ok=true e issues=[].";
