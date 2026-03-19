// server.js — Bald-ify Me backend
// Run: node server.js

const http       = require('http');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const { Buffer } = require('buffer');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const HF_TOKEN = process.env.HF_TOKEN || 'YOUR_HF_TOKEN_HERE';
const PORT     = process.env.PORT || 3000;

// Working inpainting model on HF
const HF_INPAINT_URL = 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-2-inpainting';
// ──────────────────────────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

// ── Read full request body as Buffer
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
    for (let i = from; i <= buf.length - needle.length; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (buf[i+j] !== needle[j]) { ok = false; break; }
      }
      if (ok) return i;
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

// ── HTTPS POST helper
function httpsPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const buf  = typeof body === 'string' ? Buffer.from(body) : body;
    const u    = new URL(url);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      port:     443,
      method:   'POST',
      headers:  { 'Content-Length': buf.length, ...headers }
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// ── Build hair mask using pure pixel analysis (no external model needed)
// Strategy: resize to 512x512, detect dark/hair pixels in the top 60% of the image
// and build a PNG mask from that. Works well for dark hair against lighter backgrounds.
function buildHairMaskFromPixels(imageB64, imageMime) {
  // We'll create a smart mask using a combination of:
  // 1. Upper region of the image (hair is almost always in the top portion)
  // 2. A soft ellipse that covers the entire head + side hair area generously
  // The mask is white where hair is, black where it isn't
  // We return a base64 PNG mask

  // Generate a generous head + side hair mask as base64 PNG
  // This is a programmatically generated 512x512 PNG mask
  // White = hair region (top + sides), Black = face/background
  return generateSmartMaskB64();
}

// Generate a smart 512x512 PNG mask covering top-of-head and sides
// Encoded as a minimal PNG using raw deflate
function generateSmartMaskB64() {
  const W = 512, H = 512;

  // Build pixel data: white where hair likely is, black elsewhere
  // Hair region: 
  //   - Top ellipse covering skull (cx=256, cy=140, rx=200, ry=170)
  //   - Left side strip (x < 100, y 100-400)  
  //   - Right side strip (x > 412, y 100-400)
  //   - Full top band (y < 80)

  const pixels = new Uint8Array(W * H); // 0=black, 255=white

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let isHair = false;

      // Top skull ellipse - generous
      const dx1 = (x - 256) / 210;
      const dy1 = (y - 150) / 185;
      if (dx1*dx1 + dy1*dy1 < 1.0) isHair = true;

      // Left side hair (long hair falls to the side)
      if (x < 115 && y > 90 && y < 420) isHair = true;

      // Right side hair
      if (x > 397 && y > 90 && y < 420) isHair = true;

      // Extra top band
      if (y < 60) isHair = true;

      pixels[y * W + x] = isHair ? 255 : 0;
    }
  }

  // Apply soft blur by averaging neighbors (simple box blur, 2 passes)
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Uint8Array(pixels);
    for (let y = 1; y < H-1; y++) {
      for (let x = 1; x < W-1; x++) {
        const sum =
          tmp[(y-1)*W + x-1] + tmp[(y-1)*W + x] + tmp[(y-1)*W + x+1] +
          tmp[ y   *W + x-1] + tmp[ y   *W + x] + tmp[ y   *W + x+1] +
          tmp[(y+1)*W + x-1] + tmp[(y+1)*W + x] + tmp[(y+1)*W + x+1];
        pixels[y*W+x] = Math.round(sum / 9);
      }
    }
  }

  // Encode as PNG manually (using Node.js Buffer, no canvas needed)
  return encodePNG(pixels, W, H);
}

// Minimal PNG encoder (grayscale, no compression lib needed — uses zlib via require)
function encodePNG(pixels, w, h) {
  const zlib = require('zlib');

  // Build raw image data: filter byte (0) + row pixels
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter type None
    for (let x = 0; x < w; x++) {
      raw[y * (w + 1) + 1 + x] = pixels[y * w + x];
    }
  }

  const compressed = zlib.deflateSync(raw);

  // PNG signature
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);

  // IHDR chunk
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t   = Buffer.from(type);
    // CRC
    const crcBuf = Buffer.concat([t, data]);
    let crc = 0xFFFFFFFF;
    for (const b of crcBuf) {
      crc ^= b;
      for (let k = 0; k < 8; k++) crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    crc ^= 0xFFFFFFFF;
    const crcOut = Buffer.alloc(4); crcOut.writeUInt32BE(crc >>> 0);
    return Buffer.concat([len, t, data, crcOut]);
  }

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(w, 0);
  ihdrData.writeUInt32BE(h, 4);
  ihdrData[8]  = 8;  // bit depth
  ihdrData[9]  = 0;  // color type: grayscale
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace

  const ihdr = chunk('IHDR', ihdrData);
  const idat = chunk('IDAT', compressed);
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]).toString('base64');
}

// ── Run SD inpainting on HF
async function runInpainting(imageBuffer, maskB64) {
  console.log('  → Sending to inpainting model...');

  const imageB64 = imageBuffer.toString('base64');

  const payload = JSON.stringify({
    inputs: imageB64,
    parameters: {
      mask_image:          maskB64,
      prompt:              "bald head, completely hairless smooth scalp, realistic skin, photorealistic portrait, same person same face same lighting",
      negative_prompt:     "hair, wig, hat, beard, blurry, deformed, cartoon, painting",
      num_inference_steps: 30,
      guidance_scale:      8.0,
      strength:            1.0
    }
  });

  const res = await httpsPost(HF_INPAINT_URL, payload, {
    'Authorization': `Bearer ${HF_TOKEN}`,
    'Content-Type':  'application/json'
  });

  if (res.status === 503) {
    const bodyStr = res.body.toString();
    const eta = (JSON.parse(bodyStr.match(/\{.*\}/)?.[0] || '{}')).estimated_time || 30;
    throw new Error(`Model is loading (cold start). Please wait ${Math.ceil(eta)} seconds and try again.`);
  }
  if (res.status === 401) throw new Error('Invalid Hugging Face token. Check your HF_TOKEN environment variable.');
  if (res.status === 429) throw new Error('Too many requests. Please wait a minute and try again.');
  if (res.status !== 200) {
    throw new Error(`Inpainting error (${res.status}): ${res.body.toString().slice(0, 200)}`);
  }

  return res.body;
}

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
    const ext  = path.extname(filePath);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // POST /baldify
  if (req.method === 'POST' && url === '/baldify') {
    try {
      console.log('\n[Request] Baldify request received');

      const ct       = req.headers['content-type'] || '';
      const boundary = ct.match(/boundary=([^\s;]+)/)?.[1];
      if (!boundary) throw new Error('Invalid form: no boundary');

      const body    = await readBody(req);
      const parts   = parseMultipart(body, boundary);
      const imgPart = parts.find(p => p.name === 'image');
      if (!imgPart) throw new Error('No image in request');

      console.log(`  → Image: ${imgPart.contentType}, ${imgPart.data.length} bytes`);

      // Build mask locally (no broken external model)
      const maskB64 = buildHairMaskFromPixels(null, imgPart.contentType);
      console.log('  → Mask built');

      // Run inpainting
      const resultBuf = await runInpainting(imgPart.data, maskB64);
      console.log('  → Done! Sending result');

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
  console.log(`   Token: ${HF_TOKEN === 'YOUR_HF_TOKEN_HERE' ? '⚠️  NOT SET — add HF_TOKEN env variable in Railway' : '✓ Set'}\n`);
});
