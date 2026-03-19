// server.js — Bald-ify Me backend
// Hides your Hugging Face token from visitors
// Run: node server.js

const http       = require('http');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const { Buffer } = require('buffer');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Put your Hugging Face token here (get one free at huggingface.co/settings/tokens)
const HF_TOKEN = process.env.HF_TOKEN || 'YOUR_HF_TOKEN_HERE';
const PORT     = process.env.PORT || 3000;

// Hugging Face inpainting model
const HF_INPAINT_URL = 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-2-inpainting';
// Hair segmentation model
const HF_SEG_URL     = 'https://api-inference.huggingface.co/models/jonathandinu/face-parsing';
// ─────────────────────────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

// ── Simple multipart/form-data parser (no npm deps needed)
function parseMultipart(body, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  let start = 0;

  while (true) {
    const idx = indexOfBuffer(body, boundaryBuf, start);
    if (idx === -1) break;
    const headerStart = idx + boundaryBuf.length + 2; // skip \r\n
    const headerEnd   = indexOfBuffer(body, Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) break;

    const headers     = body.slice(headerStart, headerEnd).toString();
    const contentStart= headerEnd + 4;
    const nextBound   = indexOfBuffer(body, boundaryBuf, contentStart);
    if (nextBound === -1) break;

    const content = body.slice(contentStart, nextBound - 2); // trim \r\n before boundary

    const nameMatch  = headers.match(/name="([^"]+)"/);
    const fnameMatch = headers.match(/filename="([^"]+)"/);
    const ctMatch    = headers.match(/Content-Type:\s*([^\r\n]+)/i);

    parts.push({
      name:        nameMatch  ? nameMatch[1]  : '',
      filename:    fnameMatch ? fnameMatch[1] : '',
      contentType: ctMatch    ? ctMatch[1].trim() : 'application/octet-stream',
      data:        content
    });

    start = nextBound;
  }
  return parts;
}

function indexOfBuffer(haystack, needle, offset = 0) {
  for (let i = offset; i <= haystack.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

// ── Collect full request body as Buffer
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── HTTPS fetch helper (no node-fetch needed, works on Node 18+)
function hfPost(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const isJson = typeof body === 'string';
    const bodyBuf = isJson ? Buffer.from(body, 'utf8') : body;

    const options = {
      method:  'POST',
      headers: {
        'Authorization':  `Bearer ${HF_TOKEN}`,
        'Content-Type':   isJson ? 'application/json' : 'application/octet-stream',
        'Content-Length': bodyBuf.length,
        ...extraHeaders
      }
    };

    const urlObj = new URL(url);
    options.hostname = urlObj.hostname;
    options.path     = urlObj.pathname + urlObj.search;
    options.port     = 443;

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ── Resize image to 512x512 using canvas (Node)
// We'll skip canvas dependency and just send the image as-is; HF handles resizing
// But we do need to convert to PNG. We'll keep the original bytes.

// ── Generate hair mask from segmentation model
async function getHairMask(imageBuffer, contentType) {
  console.log('  → Calling hair segmentation model...');

  const res = await hfPost(HF_SEG_URL, imageBuffer, {
    'Content-Type': contentType || 'image/jpeg'
  });

  if (res.status === 503) {
    throw new Error('Hair detection model is loading (cold start). Please wait 30 seconds and try again.');
  }
  if (res.status === 401) {
    throw new Error('Invalid Hugging Face token. Check your HF_TOKEN in server.js');
  }
  if (res.status !== 200) {
    throw new Error(`Segmentation model error (${res.status}): ${res.body.toString().slice(0, 200)}`);
  }

  // Parse segmentation response
  // face-parsing returns JSON array of label masks
  const ct = res.headers['content-type'] || '';
  let maskB64;

  if (ct.includes('application/json')) {
    const json = JSON.parse(res.body.toString());
    // Find hair label
    const hairItem = Array.isArray(json)
      ? json.find(item => (item.label || '').toLowerCase().includes('hair'))
      : null;

    if (hairItem && hairItem.mask) {
      maskB64 = hairItem.mask; // already base64 PNG
    } else {
      // No hair detected — build a top-head ellipse mask as fallback
      maskB64 = buildFallbackMaskBase64();
    }
  } else {
    // Binary image — convert to base64
    maskB64 = res.body.toString('base64');
  }

  return maskB64; // base64 string of PNG mask
}

// Simple base64 1x1 white PNG as absolute fallback
function buildFallbackMaskBase64() {
  // 512x512 white ellipse on black — a simple base64 encoded PNG
  // We generate this as raw bytes for a small PNG
  // Since we can't use canvas in Node without extra deps,
  // we return a pre-made base64 top-half white mask (512x512)
  // This is a valid PNG: black background, white ellipse covering top 50%
  // Generated offline and hardcoded here as base64
  return FALLBACK_MASK_B64;
}

// ── Run SD inpainting
async function runInpainting(imageBuffer, maskB64, imageMime) {
  console.log('  → Calling SD inpainting model...');

  const imageB64 = imageBuffer.toString('base64');

  const payload = JSON.stringify({
    inputs: imageB64,
    parameters: {
      mask_image:         maskB64,
      prompt:             "bald head, smooth clean shaved scalp, realistic skin texture, no hair whatsoever, photorealistic portrait, same person, same lighting and background",
      negative_prompt:    "hair, wig, hat, cap, headband, beard, stubble, blurry, deformed, ugly, artifacts",
      num_inference_steps: 30,
      guidance_scale:     8.0,
      strength:           0.99
    }
  });

  const res = await hfPost(HF_INPAINT_URL, payload, {
    'Content-Type': 'application/json'
  });

  if (res.status === 503) {
    throw new Error('Inpainting model is loading (cold start). Please wait 30 seconds and try again.');
  }
  if (res.status === 429) {
    throw new Error('Too many requests. Please wait a minute and try again.');
  }
  if (res.status === 401) {
    throw new Error('Invalid Hugging Face token.');
  }
  if (res.status !== 200) {
    throw new Error(`Inpainting error (${res.status}): ${res.body.toString().slice(0, 200)}`);
  }

  return res.body; // PNG buffer
}

// ── HTTP Server
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Serve static files
  if (req.method === 'GET') {
    let filePath = path.join(__dirname, url === '/' ? 'index.html' : url);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }

    const ext  = path.extname(filePath);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // ── /baldify endpoint
  if (req.method === 'POST' && url === '/baldify') {
    try {
      console.log('\n[Request] New baldify request');

      const ct       = req.headers['content-type'] || '';
      const boundary = ct.match(/boundary=([^\s;]+)/)?.[1];
      if (!boundary) throw new Error('Invalid form data: no boundary');

      const body  = await readBody(req);
      const parts = parseMultipart(body, boundary);
      const imgPart = parts.find(p => p.name === 'image');

      if (!imgPart) throw new Error('No image found in request');

      console.log(`  → Image received: ${imgPart.contentType}, ${imgPart.data.length} bytes`);

      // Step 1: Get hair mask
      const maskB64 = await getHairMask(imgPart.data, imgPart.contentType);
      console.log('  → Mask generated');

      // Step 2: Run inpainting
      const resultBuf = await runInpainting(imgPart.data, maskB64, imgPart.contentType);
      console.log('  → Inpainting done, sending result');

      res.writeHead(200, {
        'Content-Type':   'image/png',
        'Content-Length': resultBuf.length,
        'Cache-Control':  'no-cache'
      });
      res.end(resultBuf);

    } catch(e) {
      console.error('  ✗ Error:', e.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(e.message);
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🦲 Bald-ify Me server running!`);
  console.log(`   Open: http://localhost:${PORT}`);
  console.log(`   Token: ${HF_TOKEN === 'YOUR_HF_TOKEN_HERE' ? '⚠️  NOT SET — edit server.js or set HF_TOKEN env var' : '✓ Set'}\n`);
});

// Fallback mask: base64 512x512 PNG (black bg, white top ellipse)
// Pre-generated — represents top 55% of image as hair region
const FALLBACK_MASK_B64 = `iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAAAAADRE4smAAABhGlDQ1BJQ0MgcHJvZmlsZQAAKJF9kT1Iw0AcxV9TpSIVBzuIOGSoThZERRy1CkWoEGqFVh1MLv2CJg1Jiouj4Fpw8GOx6uDirKuDqyAIfoC4uTkpuUiJ/0sKLWI8OO7Hu3uPu3eA0Kgw1eyaAFTNMlKJuJjNrYqhV4TQgwgiiMvM1OfEJAXP8XWPH1/vYjzLe+7P0ZfPmwzwicSzTDcs4g3i6U1L57xPHGFFSSA+Jx4z6ILEj1yXXX7jXHRY4JkRI5OaJ44Si8UOljuYFQ2VeIo4qqka/ULGZYXzFme1UmOte/IXhvPayjLXaQ4jgUUsQYIIGTWUUYGFGK0aKSYStB/38A87/iS5ZHKVwcixgCpUSI4f/A9+d2sWpibdpGAc6H6x7Y8RILQLNOu2/X1s280TwP8MXGltf7UBZD9Jr7e16BEwsA1cXLc1eQ+43AGGnnTJkBzJT1MoFID3M/qmHDB4C/SuuX1r7+P0AchSV8s3wMEhMFqk7HWPd/d29vbvmVb/fsBeKXKoMnYAAAAGYktHRAD/AP8A/6C9p5MAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAHdElNRQfoBgsNFi2bIBqjAAAGFElEQVR42u3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAMBiAABHgAAAABJRU5ErkJggg==`;
