// server.js — Bald-ify Me backend (Replicate powered)
// Run: node server.js

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');
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

// ── Read full request body
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Simple multipart parser (zero npm deps)
function parseMultipart(body, boundary) {
  const parts = [];
  const sep   = Buffer.from('--' + boundary);

  function indexOf(buf, needle, from = 0) {
    outer: for (let i = from; i <= buf.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (buf[i+j] !== needle[j]) continue outer;
      }
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
    const hdrs = body.slice(hs, he).toString();
    const cs   = he + 4;
    const ns   = indexOf(body, sep, cs);
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

// ── HTTPS helper
function httpsRequest(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const buf  = body ? (typeof body === 'string' ? Buffer.from(body) : body) : null;
    const u    = new URL(url);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      port:     443,
      method,
      headers:  {
        ...(buf ? { 'Content-Length': buf.length } : {}),
        ...headers
      }
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

// ── Download a URL to a Buffer
function downloadURL(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, port: 443, method: 'GET' };
    const req = https.request(opts, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadURL(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Build hair mask PNG (top-of-head + sides) — no external API needed
function buildHairMask() {
  const W = 512, H = 512;
  const pixels = new Uint8Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;

      // Main skull ellipse (top of head)
      const dx = (x - 256) / 215;
      const dy = (y - 148) / 190;
      if (dx*dx + dy*dy < 1.0) v = 255;

      // Left side long hair
      if (x < 120 && y > 80 && y < 430) v = 255;

      // Right side long hair
      if (x > 392 && y > 80 && y < 430) v = 255;

      // Very top strip
      if (y < 55) v = 255;

      pixels[y * W + x] = v;
    }
  }

  // Simple blur (3 passes to soften edges)
  for (let pass = 0; pass < 3; pass++) {
    const tmp = new Uint8Array(pixels);
    for (let y = 1; y < H-1; y++) {
      for (let x = 1; x < W-1; x++) {
        const s =
          tmp[(y-1)*W+x-1] + tmp[(y-1)*W+x] + tmp[(y-1)*W+x+1] +
          tmp[ y   *W+x-1] + tmp[ y   *W+x] + tmp[ y   *W+x+1] +
          tmp[(y+1)*W+x-1] + tmp[(y+1)*W+x] + tmp[(y+1)*W+x+1];
        pixels[y*W+x] = Math.round(s / 9);
      }
    }
  }

  // Encode as PNG
  const raw = Buffer.alloc(H * (W + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W + 1)] = 0;
    for (let x = 0; x < W; x++) {
      raw[y * (W + 1) + 1 + x] = pixels[y * W + x];
    }
  }

  const compressed = zlib.deflateSync(raw);

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t   = Buffer.from(type);
    const crcVal = Buffer.alloc(4);
    crcVal.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crcVal]);
  }

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(W, 0);
  ihdrData.writeUInt32BE(H, 4);
  ihdrData[8] = 8; ihdrData[9] = 0; // 8-bit grayscale

  const sig  = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = pngChunk('IHDR', ihdrData);
  const idat = pngChunk('IDAT', compressed);
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]).toString('base64');
}

// ── Replicate: create prediction and poll until done
async function replicateInpaint(imageBuffer, maskB64, imageMime) {
  const imageB64 = imageBuffer.toString('base64');
  const imageDataURL = `data:${imageMime};base64,${imageB64}`;
  const maskDataURL  = `data:image/png;base64,${maskB64}`;

  console.log('  → Creating Replicate prediction...');

  // Create prediction
  const createRes = await httpsRequest(
    'POST',
    'https://api.replicate.com/v1/predictions',
    JSON.stringify({
      version: "e490d072a34a94a11e9711ed5a6ba621c3fab884eda1665d9d3a282d65a21180", // stability-ai/stable-diffusion-inpainting
      input: {
        image:           imageDataURL,
        mask:            maskDataURL,
        prompt:          "bald head, completely hairless smooth scalp, realistic skin texture, photorealistic portrait, same person same face same lighting same background",
        negative_prompt: "hair, wig, hat, beard, mustache, blurry, deformed, ugly, artifacts, cartoon",
        num_outputs:     1,
        num_inference_steps: 30,
        guidance_scale:  7.5,
        prompt_strength: 0.99
      }
    }),
    {
      'Authorization': `Token ${REPLICATE_TOKEN}`,
      'Content-Type':  'application/json'
    }
  );

  if (createRes.status === 401) throw new Error('Invalid Replicate token. Check your REPLICATE_TOKEN variable in Railway.');
  if (createRes.status === 402) throw new Error('Replicate account needs payment setup. Add a card at replicate.com/account/billing (you get free credits first).');
  if (createRes.status !== 201) {
    throw new Error(`Replicate error (${createRes.status}): ${createRes.body.toString().slice(0, 200)}`);
  }

  const prediction = JSON.parse(createRes.body.toString());
  const predictionId = prediction.id;
  console.log(`  → Prediction created: ${predictionId}`);

  // Poll until done
  let attempts = 0;
  while (attempts < 60) { // max 2 minutes
    await sleep(2000);
    attempts++;

    const pollRes = await httpsRequest(
      'GET',
      `https://api.replicate.com/v1/predictions/${predictionId}`,
      null,
      { 'Authorization': `Token ${REPLICATE_TOKEN}` }
    );

    const poll = JSON.parse(pollRes.body.toString());
    console.log(`  → Status: ${poll.status}`);

    if (poll.status === 'succeeded') {
      const outputURL = Array.isArray(poll.output) ? poll.output[0] : poll.output;
      if (!outputURL) throw new Error('No output URL from Replicate');
      console.log('  → Downloading result...');
      return await downloadURL(outputURL);
    }

    if (poll.status === 'failed' || poll.status === 'canceled') {
      throw new Error(`Prediction ${poll.status}: ${poll.error || 'unknown error'}`);
    }
  }

  throw new Error('Timed out waiting for result. Please try again.');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP Server
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
      console.log('\n[Request] New baldify request');

      const ct       = req.headers['content-type'] || '';
      const boundary = ct.match(/boundary=([^\s;]+)/)?.[1];
      if (!boundary) throw new Error('Invalid form: no boundary');

      const body    = await readBody(req);
      const parts   = parseMultipart(body, boundary);
      const imgPart = parts.find(p => p.name === 'image');
      if (!imgPart) throw new Error('No image found in request');

      console.log(`  → Image: ${imgPart.contentType}, ${imgPart.data.length} bytes`);

      // Build mask locally
      const maskB64 = buildHairMask();
      console.log('  → Mask built');

      // Run inpainting via Replicate
      const imageMime = imgPart.contentType.includes('png') ? 'image/png'
                      : imgPart.contentType.includes('webp') ? 'image/webp'
                      : 'image/jpeg';

      const resultBuf = await replicateInpaint(imgPart.data, maskB64, imageMime);
      console.log(`  → Done! ${resultBuf.length} bytes`);

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
  console.log(`   Replicate token: ${REPLICATE_TOKEN === 'YOUR_REPLICATE_TOKEN_HERE' ? '⚠️  NOT SET — add REPLICATE_TOKEN in Railway Variables' : '✓ Set'}\n`);
});
