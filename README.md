# 🦲 Bald-ify Me
**by Loshmi — v1.0.15.1**

Real AI hair inpainting. Users upload a photo, AI removes the hair and generates a bald head. Zero signup required for visitors.

---

## Files
- `index.html` — the frontend website
- `server.js`  — the backend (hides your API token, handles AI calls)
- `package.json` — project config

---

## How to deploy (step by step)

### Step 1 — Get a free Hugging Face token
1. Go to https://huggingface.co/join — create a free account
2. Go to https://huggingface.co/settings/tokens
3. Click **New token** → name it anything → Role: **Read**
4. Copy the token (looks like `hf_xxxxxxxxxxxxxx`)

---

### Step 2 — Test locally first (optional but recommended)
1. Make sure Node.js is installed: https://nodejs.org (download the LTS version)
2. Open a terminal in this folder
3. Run: `node server.js`
4. Open http://localhost:3000 in your browser — it should work!

---

### Step 3 — Deploy to Railway (FREE, easiest, visitors get zero-friction experience)

Railway gives you a free server that runs 24/7.

1. Go to https://railway.app — sign up free (use GitHub login)
2. Click **New Project → Deploy from GitHub repo**
   - First, push this folder to GitHub:
     - Go to https://github.com/new → create repo called `baldify-me`
     - Upload all 3 files (index.html, server.js, package.json)
3. In Railway, select your `baldify-me` repo
4. Railway auto-detects Node.js and deploys it
5. Go to **Variables** tab → Add variable:
   - Key: `HF_TOKEN`
   - Value: your Hugging Face token from Step 1
6. Go to **Settings → Networking → Generate Domain**
7. You get a free URL like `baldify-me.up.railway.app` 🎉

That's it — share that link with anyone. They upload a photo, get a bald version. No token, no signup.

---

### Alternative: Deploy to Render (also free)

1. Go to https://render.com — sign up free
2. New → Web Service → Connect GitHub repo
3. Build Command: (leave empty)
4. Start Command: `node server.js`
5. Add Environment Variable: `HF_TOKEN` = your token
6. Click Deploy — you get a free `.onrender.com` URL

---

### Custom domain (optional, ~$10/year)
1. Buy a domain on Namecheap or GoDaddy
2. In Railway/Render settings, go to Custom Domain
3. Follow the DNS instructions
4. Done — your site is live at your own address

---

## Important notes

- **First request might be slow (30–60 sec)** — Hugging Face free models "sleep" and need to wake up. After the first one, subsequent requests are fast.
- **Free tier limits** — Hugging Face free API allows ~100-200 requests/day. If you get popular, upgrade to their Pro plan ($9/month).
- **Privacy** — photos are sent to Hugging Face for processing and not stored by your server.
