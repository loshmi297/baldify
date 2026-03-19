// server.js — Bald-ify Me (powered by FLUX.1 Kontext Pro)
// Run: node server.js

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const { Buffer } = require('buffer');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const REPLICATE_TOKEN = process.env.REPLICATE_TOKEN || 'YOUR_REPLICATE_TOKEN_HERE';
const PORT            = process.env.PORT || 3000;
// ──────────────────────────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(body, boundary) {
  const parts = [];
  const sep   = Buffer.from('--' + boundary);
  function indexOf(buf, needle, from = 0) {
    outer: for (let i = from; i <= buf.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) { if (buf[i+j] !== needle[j]) continue outer; }
      return i;
    }
    return -1;
  }
  let pos = 0;
  while (true) {
    const si = indexOf(body, sep, pos);
    if (si === -1) break;
    const hs = si + sep.length + 2;
    const he = indexOf(body, Buffer.from('\r\n\r\n'), hs);
    if (he === -1) break;
    const hdrs    = body.slice(hs, he).toString();
    const cs      = he + 4;
    const ns      = indexOf(body, sep, cs);
    if (ns === -1) break;
    const content = body.slice(cs, ns - 2);
    const name    = (hdrs.match(/name="([^"]+)"/)    || [])[1] || '';
    const fname   = (hdrs.match(/filename="([^"]+)"/) || [])[1] || '';
    const ct      = (hdrs.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || 'application/octet-stream';
    parts.push({ name, filename: fname, contentType: ct.trim(), data: content });
    pos = ns;
  }
  return parts;
}

function httpsRequest(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const buf  = body ? (typeof body === 'string' ? Buffer.from(body) : body) : null;
    const u    = new URL(url);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      port:     443,
      method,
      headers:  { ...(buf ? { 'Content-Length': buf.length } : {}), ...headers }
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

function downloadURL(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.request({ hostname: u.hostname, path: u.pathname + u.search, port: 443, method: 'GET' }, res => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return downloadURL(res.headers.location).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
    }).on('error', reject).end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Upload image to Replicate and get a URL back (required by Kontext)
async function uploadImageToReplicate(imageBuffer, mime) {
  console.log('  → Uploading image to Replicate...');

  // Use Replicate's file upload endpoint
  const res = await httpsRequest(
    'POST',
    'https://api.replicate.com/v1/files',
    imageBuffer,
    {
      'Authorization': `Token ${REPLICATE_TOKEN}`,
      'Content-Type':  mime,
      'Content-Length': imageBuffer.length
    }
  );

  if (res.status === 401) throw new Error('Invalid Replicate token.');
  if (res.status !== 201) {
    // If file upload not supported, fall back to base64 data URL
    console.log('  → File upload not available, using base64 data URL');
    return `data:${mime};base64,${imageBuffer.toString('base64')}`;
  }

  const json = JSON.parse(res.body.toString());
  console.log(`  → Uploaded: ${json.urls?.get || json.url}`);
  return json.urls?.get || json.url;
}

// ── Create prediction with retry on 429
async function createPrediction(payload) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await httpsRequest(
      'POST',
      'https://api.replicate.com/v1/predictions',
      JSON.stringify(payload),
      { 'Authorization': `Token ${REPLICATE_TOKEN}`, 'Content-Type': 'application/json' }
    );

    if (res.status === 401) throw new Error('Invalid Replicate token. Check REPLICATE_TOKEN in Railway Variables.');
    if (res.status === 402) throw new Error('Replicate billing issue. Check replicate.com/account/billing');

    if (res.status === 429) {
      const wait = attempt * 12000;
      console.log(`  → Rate limited, waiting ${wait/1000}s (attempt ${attempt}/5)...`);
      await sleep(wait);
      continue;
    }

    if (res.status !== 201) {
      throw new Error(`Replicate error (${res.status}): ${res.body.toString().slice(0, 300)}`);
    }

    const pred = JSON.parse(res.body.toString());
    console.log(`  → Prediction: ${pred.id}`);
    return pred.id;
  }
  throw new Error('Still rate limited after retries. Wait 1 minute and try again.');
}

// ── Poll until prediction is done
async function pollPrediction(id) {
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const res  = await httpsRequest('GET',
      `https://api.replicate.com/v1/predictions/${id}`, null,
      { 'Authorization': `Token ${REPLICATE_TOKEN}` });
    const poll = JSON.parse(res.body.toString());
    console.log(`  → [${id.slice(0,8)}] ${poll.status}`);

    if (poll.status === 'succeeded') {
      const out = Array.isArray(poll.output) ? poll.output[0] : poll.output;
      if (!out) throw new Error('No output from model');
      return out;
    }
    if (poll.status === 'failed' || poll.status === 'canceled') {
      throw new Error(`Failed: ${poll.error || 'unknown error'}`);
    }
  }
  throw new Error('Timed out. Please try again.');
}

// ── Main: use FLUX Kontext Pro to make person bald via text instruction
// This model understands the image and follows text edits — no mask needed!
async function makeBald(imageBuffer, mime) {
  // Upload image to get a URL (Kontext needs a URL, not raw bytes)
  const imageURL = await uploadImageToReplicate(imageBuffer, mime);

  console.log('  → Calling FLUX Kontext Pro...');

  const predId = await createPrediction({
    // FLUX.1 Kontext Pro — text-based image editing, no mask required
    model: 'black-forest-labs/flux-kontext-pro',
    input: {
      prompt:        "Make this person completely bald. Remove all hair from the top and sides of their head. Keep their face, expression, clothing, background, and lighting exactly the same. Realistic skin texture on the scalp.",
      input_image:   imageURL,
      output_format: 'png',
      safety_tolerance: 6
    }
  });

  const outputURL = await pollPrediction(predId);
  console.log('  → Downloading result...');
  return await downloadURL(outputURL);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve static files
  if (req.method === 'GET') {
    const filePath = path.join(__dirname, url === '/' ? 'index.html' : url);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
    const mime = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // POST /baldify
  if (req.method === 'POST' && url === '/baldify') {
    try {
      console.log('\n[Request] ─────────────────────────────');

      const ct       = req.headers['content-type'] || '';
      const boundary = ct.match(/boundary=([^\s;]+)/)?.[1];
      if (!boundary) throw new Error('Invalid form: no boundary');

      const body    = await readBody(req);
      const parts   = parseMultipart(body, boundary);
      const imgPart = parts.find(p => p.name === 'image');
      if (!imgPart) throw new Error('No image in request');

      const mime = imgPart.contentType.includes('png')  ? 'image/png'
                 : imgPart.contentType.includes('webp') ? 'image/webp'
                 : 'image/jpeg';

      console.log(`  → Image: ${mime}, ${imgPart.data.length} bytes`);

      const resultBuf = await makeBald(imgPart.data, mime);
      console.log(`  → Done! Sending ${resultBuf.length} bytes`);

      res.writeHead(200, {
        'Content-Type':   'image/png',
        'Content-Length': resultBuf.length,
        'Cache-Control':  'no-cache'
      });
      res.end(resultBuf);

    } catch(e) {
      console.error('  ✗', e.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(e.message);
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🦲 Bald-ify Me running on http://localhost:${PORT}`);
  console.log(`   Token: ${REPLICATE_TOKEN === 'YOUR_REPLICATE_TOKEN_HERE' ? '⚠️  NOT SET' : '✓ Set'}\n`);
});
