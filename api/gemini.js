// Vercel serverless proxy for Gemini.
// The browser calls /api/gemini with an app password; the real Gemini API key
// lives only in the GEMINI_API_KEY env var (set in Vercel), never in the client.
//
// Env vars (set in Vercel → Project → Settings → Environment Variables):
//   GEMINI_API_KEY  — your Google AI Studio key (required)
//   APP_PASSWORD    — shared password to gate access (optional but recommended)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (APP_PASSWORD && req.headers["x-app-password"] !== APP_PASSWORD) {
    res.status(401).json({ error: "Contraseña incorrecta" });
    return;
  }

  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) {
    res.status(500).json({ error: "GEMINI_API_KEY no está configurada en el servidor" });
    return;
  }

  const {
    system,
    content,
    images = [],
    json = false,
    maxTokens = 2048,
    model = "gemini-2.5-flash",
    contents,   // conversación multi-turno completa (agente / function-calling)
    tools,      // function declarations
    toolConfig,
  } = req.body || {};

  // Si viene `contents` (agente), se usa tal cual; si no, se arma como siempre.
  let convo = contents;
  if (!Array.isArray(convo)) {
    const parts = [];
    for (const im of images) parts.push({ inline_data: { mime_type: im.mimeType, data: im.data } });
    if (content) parts.push({ text: content });
    convo = [{ role: "user", parts }];
  }

  // thinkingBudget: 0 solo sirve para Flash (rápido, sin pensar). Los modelos Pro/2.5-pro
  // EXIGEN thinking mode → si les mandás budget 0 tiran 400. Para esos, no lo mandamos.
  const gc = { temperature: 0, maxOutputTokens: maxTokens };
  if (/flash/i.test(model)) gc.thinkingConfig = { thinkingBudget: 0 };
  const gBody = { contents: convo, generationConfig: gc };
  if (system) gBody.system_instruction = { parts: [{ text: system }] };
  if (json) gBody.generationConfig.responseMimeType = "application/json";
  if (tools) gBody.tools = tools;
  if (toolConfig) gBody.tool_config = toolConfig;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(KEY)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(gBody) }
    );
    const data = await r.json();
    res.status(r.status).json(data); // pass Gemini's response (and status) straight through
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
}
