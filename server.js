// server.js — Bald-ify Me (FLUX Kontext Pro, two-pass)
// Run: node server.js

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const { Buffer } = require('buffer');

const REPLICATE_TOKEN = process.env.REPLICATE_TOKEN || 'YOUR_REPLICATE_TOKEN_HERE';
const PORT            = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
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
  const sep = Buffer.from('--' + boundary);
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
    const cs = he + 4;
    const ns = indexOf(body, sep, cs);
    if (ns === -1) break;
    const content = body.slice(cs, ns - 2);
    parts.push({
      name:        (hdrs.match(/name="([^"]+)"/)    || [])[1] || '',
      contentType: ((hdrs.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || 'application/octet-stream').trim(),
      data:        content
    });
    pos = ns;
  }
  return parts;
}

function httpsRequest(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const buf = body ? (typeof body === 'string' ? Buffer.from(body) : body) : null;
    const u   = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, port: 443, method,
      headers: { ...(buf ? { 'Content-Length': buf.length } : {}), ...headers }
    }, res => {
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
    https.request({ hostname: u.hostname, path: u.pathname + u.search, port: 443 }, res => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return downloadURL(res.headers.location).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
    }).on('error', reject).end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function uploadImage(buffer, mime) {
  console.log('  -> Uploading image...');
  const res = await httpsRequest('POST', 'https://api.replicate.com/v1/files', buffer, {
    'Authorization': `Token ${REPLICATE_TOKEN}`,
    'Content-Type':  mime,
  });
  if (res.status === 201) {
    const json = JSON.parse(res.body.toString());
    const url  = json.urls?.get || json.url;
    console.log('  -> Uploaded:', url.slice(0, 60) + '...');
    return url;
  }
  console.log('  -> Using base64 fallback');
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function createPrediction(input) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await httpsRequest(
      'POST',
      'https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions',
      JSON.stringify({ input }),
      { 'Authorization': `Token ${REPLICATE_TOKEN}`, 'Content-Type': 'application/json' }
    );
    if (res.status === 401) throw new Error('Invalid Replicate token. Check REPLICATE_TOKEN in Railway Variables.');
    if (res.status === 402) throw new Error('Replicate billing issue. Visit replicate.com/account/billing');
    if (res.status === 429) {
      const wait = attempt * 12000;
      console.log(`  -> Rate limited, waiting ${wait/1000}s (attempt ${attempt}/5)...`);
      await sleep(wait);
      continue;
    }
    if (res.status !== 201)
      throw new Error(`Replicate error (${res.status}): ${res.body.toString().slice(0, 300)}`);
    const pred = JSON.parse(res.body.toString());
    console.log(`  -> Prediction: ${pred.id}`);
    return pred.id;
  }
  throw new Error('Rate limited after all retries. Wait 1 minute and try again.');
}

async function pollPrediction(id) {
  for (let i = 0; i < 80; i++) {
    await sleep(3000);
    const res  = await httpsRequest('GET', `https://api.replicate.com/v1/predictions/${id}`,
      null, { 'Authorization': `Token ${REPLICATE_TOKEN}` });
    const poll = JSON.parse(res.body.toString());
    console.log(`  -> [${id.slice(0,8)}] ${poll.status}`);
    if (poll.status === 'succeeded') {
      const out = Array.isArray(poll.output) ? poll.output[0] : poll.output;
      if (!out) throw new Error('No output from model');
      return out;
    }
    if (poll.status === 'failed' || poll.status === 'canceled')
      throw new Error(`Prediction ${poll.status}: ${poll.error || 'unknown'}`);
  }
  throw new Error('Timed out. Please try again.');
}

async function fluxPass(imageURL, prompt) {
  const predId = await createPrediction({
    prompt,
    input_image:      imageURL,
    output_format:    'png',
    safety_tolerance: 6
  });
  return await pollPrediction(predId);
}

async function makeBald(imageBuffer, mime) {
  // Upload original image
  const imageURL = await uploadImage(imageBuffer, mime);

  // Pass 1: remove top/scalp hair
  console.log('  -> Pass 1: removing scalp hair...');
  const pass1URL = await fluxPass(
    imageURL,
    "Make this person completely bald. Remove every single strand of hair from the top of their head and scalp. The scalp must be completely smooth with zero hair. Keep the face, eyes, makeup, skin tone, clothing, background and lighting completely identical."
  );

  // Wait before second call
  await sleep(4000);

  // Download and re-upload pass 1 result
  console.log('  -> Re-uploading for pass 2...');
  const pass1Buf       = await downloadURL(pass1URL);
  const pass1UploadURL = await uploadImage(pass1Buf, 'image/png');

  // Pass 2: remove all remaining side and shoulder hair
  console.log('  -> Pass 2: removing side and shoulder hair...');
  const pass2URL = await fluxPass(
    pass1UploadURL,
    "Remove every single remaining strand of hair from this image. The person is bald. Remove all hair falling on the sides, shoulders, neck and chest. There should be absolutely zero hair anywhere in the image. Keep everything else — face, makeup, clothing, background — completely unchanged."
  );

  console.log('  -> Downloading final result...');
  return await downloadURL(pass2URL);
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET') {
    const fp = path.join(__dirname, url === '/' ? 'index.html' : url);
    if (!fs.existsSync(fp)) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
    return;
  }

  if (req.method === 'POST' && url === '/baldify') {
    try {
      console.log('\n[Request] ───────────────────────────────────');
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

      console.log(`  -> Image: ${mime}, ${imgPart.data.length} bytes`);

      const resultBuf = await makeBald(imgPart.data, mime);
      console.log(`  -> Done! ${resultBuf.length} bytes`);

      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': resultBuf.length, 'Cache-Control': 'no-cache' });
      res.end(resultBuf);

    } catch(e) {
      console.error('  X', e.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(e.message);
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\nBald-ify Me on http://localhost:${PORT}`);
  console.log(`   Token: ${REPLICATE_TOKEN === 'YOUR_REPLICATE_TOKEN_HERE' ? 'NOT SET — add REPLICATE_TOKEN in Railway Variables' : 'Set'}\n`);
});
