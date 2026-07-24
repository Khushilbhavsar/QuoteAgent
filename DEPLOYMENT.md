# Deployment

Two free services, no credit card:

- **API (this repo's `server/`)** → **Render** free web service
- **Widget (`widget/`)** → **Vercel** free static site

They are deployed separately and wired together with two environment
variables. Deploy the **API first** so you have its URL for the widget.

```
 Browser ── https ──▶ Vercel (widget, static)
                          │  fetch VITE_API_URL
                          ▼
                     Render (API, Node) ── Gemini API (key stays server-side)
```

---

## 0. Before you start

1. Push this repo to GitHub (Render and Vercel both deploy from GitHub).
2. Get a free Gemini API key: <https://aistudio.google.com/apikey>.
3. Confirm `server/db/product-index.json` is committed (it is, by design) —
   the server loads it instead of re-embedding the catalogue at boot.

---

## 1. Deploy the API to Render

You can use the included `render.yaml` (Blueprint) **or** click through the
dashboard. The Blueprint is fewer clicks.

### Option A — Blueprint (uses `render.yaml`)

1. Go to <https://dashboard.render.com/blueprints> → **New Blueprint Instance**.
2. Connect your GitHub and pick this repository. Render detects `render.yaml`.
3. It creates a service named **quoteagent-api**. Before the first deploy,
   open **Environment** and set:
   - `GEMINI_API_KEY` = your key from step 0.
   - `WIDGET_ORIGIN` = leave as a placeholder for now (e.g.
     `https://example.vercel.app`); you'll correct it after step 2.
4. Click **Apply** / **Create**. Wait for the build and first deploy.

### Option B — Manual web service

1. <https://dashboard.render.com> → **New +** → **Web Service** → connect this repo.
2. Fill in:
   - **Runtime:** Node
   - **Build Command:** `npm install && (npm run prewarm || true)`
   - **Start Command:** `npm run serve`
   - **Instance Type:** Free
   - **Health Check Path:** `/api/health`
3. **Environment** → **Add Environment Variable** (twice):
   - `GEMINI_API_KEY` = your key
   - `WIDGET_ORIGIN` = your Vercel URL (fill after step 2; use a placeholder now)
   - `NODE_VERSION` = `20`
4. **Create Web Service**.

### Verify the API

- Copy the service URL, e.g. `https://quoteagent-api.onrender.com`.
- Open `https://<your-api>.onrender.com/api/health` → you should see
  `{"ok":true}`.

> **Note the API URL** — you need it for the widget.

---

## 2. Deploy the widget to Vercel

1. <https://vercel.com/new> → **Import** this GitHub repo.
2. **IMPORTANT — set Root Directory to `widget`** (Edit → Root Directory →
   `widget`). Vercel then reads `widget/vercel.json` (framework: Vite,
   install: `npm ci`, output: `dist`).
3. **Environment Variables** → add:
   - `VITE_API_URL` = your Render API URL from step 1
     (e.g. `https://quoteagent-api.onrender.com`, **no trailing slash**).
4. **Deploy**. Vercel gives you a URL like `https://quoteagent.vercel.app`.

---

## 3. Wire them together (CORS)

The API only accepts browser calls from the widget's origin.

1. Back in **Render → quoteagent-api → Environment**, set
   `WIDGET_ORIGIN` to your exact Vercel URL from step 2
   (e.g. `https://quoteagent.vercel.app`, **no trailing slash**).
2. Save — Render redeploys automatically.

---

## 4. Test the live app

1. Open your Vercel URL.
2. First message may take **~30–60s** (Render free tier waking from sleep) —
   the widget shows a "waking up the server" note. This is expected.
3. Try the full flow:
   - "Do you have 200mm circular duct?" → product answer.
   - "I'd like a quote for 5 of GD-CIRC-1M, I'm Jo Bloggs, jo@example.com" →
     the agent confirms details, then shows an **approval card**.
   - Click **Approve** → the quote is saved and you get a `Q-…` confirmation.
     Click **Decline** → nothing is saved.
4. Edge cases to confirm:
   - A message over 500 characters → friendly error, no crash.
   - 21 messages within an hour on one session → friendly rate-limit reply.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Widget shows a CORS error in the console | `WIDGET_ORIGIN` on Render doesn't exactly match the Vercel origin (scheme + host, no trailing slash). |
| Every request fails immediately | `VITE_API_URL` on Vercel is wrong, or the API is still building. Check `/api/health`. |
| First request is very slow | Expected free-tier cold start (~30–60s). Subsequent requests are fast until it idles for 15 min. |
| Agent replies with a "something went wrong" error | Check the `GEMINI_API_KEY` on Render, and that your key still has free-tier quota. |
| Quotes/escalations "disappear" after a redeploy | Expected: `quotes.jsonl` and in-memory sessions live on the ephemeral free instance. Production would use a database. |

---

## What production would change (honest notes)

- **Sessions** are an in-memory `Map` → use Redis or a database so they
  survive restarts and scale past one instance.
- **Rate limiting** is in-memory per instance → use a shared store
  (Redis) or an edge/WAF rate limiter.
- **Quotes** are appended to a local `quotes.jsonl` on an ephemeral disk →
  use a real database and a transactional email provider.
