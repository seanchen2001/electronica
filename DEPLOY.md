# Deploy a Vercel — Price Desk

App estática (Vite + React) con una función serverless (`/api/gemini`) que
esconde la API key de Gemini. Plan **Hobby (gratis)** alcanza.

## Qué hace cada cosa
- **Frontend** (`dist/`): la app. En producción NO tiene la key NI los precios;
  manda los pedidos a `/api/*` con una contraseña.
- **`/api/gemini`**: función serverless. Valida `APP_PASSWORD` y llama a Gemini
  con la key real (`GEMINI_API_KEY`). La key nunca llega al navegador.
- **`/api/data`**: función serverless. Valida `APP_PASSWORD` y devuelve los
  precios sembrados (`lib/seed-prices.js`, solo del lado del servidor). **Los
  números de precio NO están en el bundle público** — la app los pide al entrar
  con la contraseña.

## Paso a paso

### 1. Subir el código a GitHub
```bash
cd /Users/seanchen
git init
git add .
git commit -m "Price Desk"
# Creá un repo vacío en github.com y luego:
git remote add origin https://github.com/TU_USUARIO/price-desk.git
git branch -M main
git push -u origin main
```
> `.gitignore` ya excluye `node_modules`, `dist` y `.env*` — no se sube nada sensible.

### 2. Importar en Vercel
1. Entrá a https://vercel.com → **Add New → Project** → importá el repo.
2. Framework: **Vite** (lo detecta solo). Build `npm run build`, Output `dist`. No tocar nada.
3. Antes de **Deploy**, agregá las **Environment Variables**:
   | Name | Value |
   |---|---|
   | `GEMINI_API_KEY` | tu key de Google AI Studio (la que arranca con `AIza…`) |
   | `APP_PASSWORD` | una contraseña a elección |
4. **Deploy**. En ~1 min tenés la URL.

### 3. Usar
- Abrís la URL → en el campo **CONTRASEÑA** ponés la `APP_PASSWORD`.
- Eso es todo: ya no hay que iniciar nada, es una URL fija.

## Probar local antes (opcional)
```bash
npm install
npm run dev          # usás tu Gemini key directo en el campo (modo dev)
```
Para probar el proxy local como en producción:
```bash
npm i -g vercel
vercel dev           # corre la función /api también; pedí las env vars
```

## Notas honestas
- ✅ **Precios fuera del bundle**: los números viven en `lib/seed-prices.js`
  (solo servidor) y se sirven por `/api/data` con contraseña. Verificado: la
  estructura de precios aparece 0 veces en el `dist/`.
- Los **nombres** de proveedores (5) y de modelos sí están en el bundle — son
  nombres, no precios. Si querés ocultarlos también, es otro paso (avisá).
- El plan Hobby de Vercel es para uso **personal/no comercial** según sus términos.
- La contraseña es un secreto compartido, no login real — alcanza para algo privado.
- **Primer uso**: la app arranca vacía; ponés la contraseña arriba y tocás
  "Cargar datos" (o "Cargar / Reset datos" en la barra). Después queda en tu
  navegador (localStorage).
