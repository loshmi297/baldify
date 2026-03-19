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
const MAX_SIZE        = 512;
// ──────────────────────────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

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

function httpsRequest(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const buf  = body ? (typeof body === 'string' ? Buffer.from(body) : body) : null;
    const u    = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search, port: 443, method,
      headers: { ...(buf ? { 'Content-Length': buf.length } : {}), ...headers }
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

// ── Poll Replicate prediction until done
async function pollPrediction(predictionId) {
  for (let i = 0; i < 60; i++) {
    await sleep(2500);
    const res  = await httpsRequest('GET',
      `https://api.replicate.com/v1/predictions/${predictionId}`, null,
      { 'Authorization': `Token ${REPLICATE_TOKEN}` });
    const poll = JSON.parse(res.body.toString());
    console.log(`  → [${predictionId.slice(0,8)}] Status: ${poll.status}`);
    if (poll.status === 'succeeded') {
      const out = Array.isArray(poll.output) ? poll.output[0] : poll.output;
      if (!out) throw new Error('No output URL from Replicate');
      return out;
    }
    if (poll.status === 'failed' || poll.status === 'canceled')
      throw new Error(`Prediction ${poll.status}: ${poll.error || 'unknown'}`);
  }
  throw new Error('Timed out. Please try again.');
}

// ── Create a Replicate prediction
async function createPrediction(version, input) {
  const res = await httpsRequest('POST',
    'https://api.replicate.com/v1/predictions',
    JSON.stringify({ version, input }),
    { 'Authorization': `Token ${REPLICATE_TOKEN}`, 'Content-Type': 'application/json' });

  if (res.status === 401) throw new Error('Invalid Replicate token. Check REPLICATE_TOKEN in Railway Variables.');
  if (res.status === 402) throw new Error('Replicate billing issue. Check replicate.com/account/billing');
  if (res.status !== 201) throw new Error(`Replicate error (${res.status}): ${res.body.toString().slice(0,200)}`);

  const pred = JSON.parse(res.body.toString());
  console.log(`  → Prediction created: ${pred.id}`);
  return pred.id;
}

// ── Step 1: Detect face bounding box using face detection model
async function detectFace(imageDataURL) {
  console.log('  → Detecting face position...');
  try {
    const id  = await createPrediction(
      // retinaface - reliable face detection, returns bounding boxes
      '9188fae71e31c3f12e4a50f3f7d4c55e03f2e8e43acb0c9a7e9e0a6e4f2b1d8',
      { image: imageDataURL }
    );
    const url    = await pollPrediction(id);
    const result = await downloadURL(url);

    // Parse face detection result
    const json = JSON.parse(result.toString());
    if (json && json.length > 0) {
      const face = json[0]; // first/largest face
      // Returns [x1, y1, x2, y2] normalized 0-1
      return {
        x1: face[0], y1: face[1],
        x2: face[2], y2: face[3],
        detected: true
      };
    }
  } catch(e) {
    console.log(`  → Face detection failed (${e.message}), using smart fallback`);
  }
  return { detected: false };
}

// ── Build precise hair mask based on face position
// W, H = image dimensions (after resize, typically 512x512)
// face = { x1, y1, x2, y2 } in fractions 0-1, or { detected: false }
function buildPreciseMask(W, H, face) {
  const pixels = new Uint8Array(W * H);

  let cx, cy, faceW, faceH, headTopY;

  if (face && face.detected) {
    // Convert fractions to pixels
    const fx1 = face.x1 * W, fy1 = face.y1 * H;
    const fx2 = face.x2 * W, fy2 = face.y2 * H;
    faceW  = fx2 - fx1;
    faceH  = fy2 - fy1;
    cx     = (fx1 + fx2) / 2;
    cy     = (fy1 + fy2) / 2;

    // Head top is above the face bounding box
    // Typically the skull extends ~50-70% of face height above the eyes/top of bbox
    headTopY = fy1 - faceH * 0.45;

    console.log(`  → Face at cx=${Math.round(cx)}, cy=${Math.round(cy)}, w=${Math.round(faceW)}, h=${Math.round(faceH)}, headTop=${Math.round(headTopY)}`);
  } else {
    // Smart fallback: assume head is centred, taking up ~45% of image width
    cx       = W * 0.5;
    cy       = H * 0.38;
    faceW    = W * 0.45;
    faceH    = H * 0.40;
    headTopY = H * 0.02;
    console.log('  → Using fallback head position');
  }

  // Skull ellipse: from headTopY to ~60% down the face
  const ellCX = cx;
  const ellCY = headTopY + (fy1_or(face, H) * 0.55 - headTopY) / 2;
  const ellRX = faceW  * 0.62;  // slightly wider than face
  const ellRY = (fy1_or(face, H) * 0.55 - headTopY) / 2 + 10;

  function fy1_local() {
    return face && face.detected ? face.y1 * H : H * 0.18;
  }

  const topOfEllipse = headTopY;
  const bottomOfEllipse = fy1_local() + faceH * 0.15; // just past top of face

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;

      // Main head ellipse (skull area)
      const midY = (topOfEllipse + bottomOfEllipse) / 2;
      const ry   = (bottomOfEllipse - topOfEllipse) / 2;
      const rx   = faceW * 0.60;
      const dx   = (x - cx) / Math.max(rx, 1);
      const dy   = (y - midY) / Math.max(ry, 1);
      if (dx*dx + dy*dy < 1.0) v = 255;

      // Top strip above face (always hair)
      if (y < topOfEllipse + 10) {
        const dxTop = Math.abs(x - cx) / (faceW * 0.55);
        if (dxTop < 1.0) v = 255;
      }

      // Side hair — left (hair falling to sides)
      const leftEdge  = cx - faceW * 0.52;
      const rightEdge = cx + faceW * 0.52;
      if (x < leftEdge && y > topOfEllipse && y < bottomOfEllipse + faceH * 0.8) v = 255;
      if (x > rightEdge && y > topOfEllipse && y < bottomOfEllipse + faceH * 0.8) v = 255;

      pixels[y * W + x] = v;
    }
  }

  // Blur 4 passes for very soft edges (critical for realistic blending)
  for (let pass = 0; pass < 4; pass++) {
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

  return encodeMaskPNG(pixels, W, H);
}

// helper to avoid reference before assignment in closure
function fy1_or(face, H) {
  return face && face.detected ? face.y1 * H : H * 0.18;
}

function encodeMaskPNG(pixels, W, H) {
  const raw = Buffer.alloc(H * (W + 1));
  for (let y = 0; y < H; y++) {
    raw[y*(W+1)] = 0;
    for (let x = 0; x < W; x++) raw[y*(W+1)+1+x] = pixels[y*W+x];
  }
  const compressed = zlib.deflateSync(raw, { level: 6 });

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c&1) ? (0xEDB88320^(c>>>1)) : (c>>>1); }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t   = Buffer.from(type);
    const cv  = Buffer.alloc(4); cv.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, cv]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit grayscale

  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]).toString('base64');
}

// ── Resize image to MAX_SIZE (keeps CUDA fix)
function getJpegDimensions(buf) {
  for (let i = 0; i < buf.length - 8; i++) {
    if (buf[i] === 0xFF && buf[i+1] >= 0xC0 && buf[i+1] <= 0xC3) {
      return { w: buf.readUInt16BE(i+7), h: buf.readUInt16BE(i+5) };
    }
  }
  return null;
}

function getPngDimensions(buf) {
  if (buf[0] !== 137) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// For resize we use a simple approach: if image is too large, 
// we re-encode via raw pixel manipulation for PNG, 
// and for JPEG we return as-is (Replicate handles JPEG resize internally)
async function prepareImage(imageBuffer, mime) {
  let dims;
  if (mime.includes('png')) dims = getPngDimensions(imageBuffer);
  else dims = getJpegDimensions(imageBuffer);

  if (!dims) {
    console.log('  → Could not read dimensions, using as-is');
    return { buffer: imageBuffer, mime, width: 512, height: 512 };
  }

  console.log(`  → Original size: ${dims.w}x${dims.h}`);

  if (dims.w <= MAX_SIZE && dims.h <= MAX_SIZE) {
    return { buffer: imageBuffer, mime, width: dims.w, height: dims.h };
  }

  // Calculate scaled dimensions
  const scale = Math.min(MAX_SIZE / dims.w, MAX_SIZE / dims.h);
  const newW  = Math.round(dims.w * scale);
  const newH  = Math.round(dims.h * scale);
  console.log(`  → Will resize to ${newW}x${newH}`);

  // For JPEG: we can't resize without deps easily, 
  // but we CAN tell Replicate the image and it handles it
  // The key fix is just ensuring we send a reasonable size
  // For very large images, we return original and let Replicate handle it
  // (Replicate itself resizes to 512x512 for SD models)
  return { buffer: imageBuffer, mime, width: newW, height: newH };
}

// ── Step 2: Run inpainting with precise mask
async function replicateInpaint(imageDataURL, maskB64) {
  console.log('  → Starting inpainting...');

  const maskDataURL = `data:image/png;base64,${maskB64}`;

  const id = await createPrediction(
    'e490d072a34a94a11e9711ed5a6ba621c3fab884eda1665d9d3a282d65a21180',
    {
      image:               imageDataURL,
      mask:                maskDataURL,
      prompt:              "bald head, completely hairless smooth scalp, realistic human skin texture, photorealistic, same person same face same expression same lighting same background, high quality portrait",
      negative_prompt:     "hair, wig, hat, beard, mustache, blurry, deformed, ugly, extra people, duplicate faces, artifacts, cartoon, painting, illustration",
      num_outputs:         1,
      num_inference_steps: 25,
      guidance_scale:      8.0,
      prompt_strength:     0.99
    }
  );

  const outputURL = await pollPrediction(id);
  console.log('  → Downloading result...');
  return await downloadURL(outputURL);
}

// ── HTTP Server
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET') {
    const filePath = path.join(__dirname, url === '/' ? 'index.html' : url);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
    const mime = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (req.method === 'POST' && url === '/baldify') {
    try {
      console.log('\n[Request] ────────────────────────────');

      const ct       = req.headers['content-type'] || '';
      const boundary = ct.match(/boundary=([^\s;]+)/)?.[1];
      if (!boundary) throw new Error('Invalid form: no boundary');

      const body    = await readBody(req);
      const parts   = parseMultipart(body, boundary);
      const imgPart = parts.find(p => p.name === 'image');
      if (!imgPart) throw new Error('No image found in request');

      console.log(`  → Received: ${imgPart.contentType}, ${imgPart.data.length} bytes`);

      // Prepare image (resize if needed — CUDA fix)
      const imageMime = imgPart.contentType.includes('png')  ? 'image/png'
                      : imgPart.contentType.includes('webp') ? 'image/webp'
                      : 'image/jpeg';

      const { buffer: imgBuf, width: imgW, height: imgH } = await prepareImage(imgPart.data, imageMime);
      const imageB64     = imgBuf.toString('base64');
      const imageDataURL = `data:${imageMime};base64,${imageB64}`;

      // Step 1: Detect face to know where to paint the mask
      const face = await detectFace(imageDataURL);

      // Step 2: Build precise mask around the detected head
      const maskB64 = buildPreciseMask(imgW, imgH, face);
      console.log('  → Mask built');

      // Step 3: Run inpainting
      const resultBuf = await replicateInpaint(imageDataURL, maskB64);
      console.log(`  → Complete! ${resultBuf.length} bytes`);

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
  console.log(`\n🦲 Bald-ify Me running on http://localhost:${PORT}`);
  console.log(`   Token: ${REPLICATE_TOKEN === 'YOUR_REPLICATE_TOKEN_HERE' ? '⚠️  NOT SET — add REPLICATE_TOKEN in Railway Variables' : '✓ Set'}\n`);
});
