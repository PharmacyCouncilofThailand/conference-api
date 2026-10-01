import http from 'node:http';

if (process.env.NODE_ENV !== 'test') throw new Error('Fake mail requires NODE_ENV=test');

const modes = new Set(['success', 'fail-before-send', 'unknown-after-capture', 'block-until-release']);
let mode = 'success';
const messages = [];
const held = new Set();

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function body(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 262144) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/messages') return json(res, 200, { messages });
    if (req.method === 'POST' && req.url === '/reset') {
      messages.length = 0;
      mode = 'success';
      for (const response of held) response.destroy();
      held.clear();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && req.url === '/mode') {
      const input = await body(req);
      if (!modes.has(input.mode)) return json(res, 400, { code: 'INVALID_MODE' });
      mode = input.mode;
      return json(res, 200, { ok: true, mode });
    }
    if (req.method === 'POST' && req.url === '/release') {
      for (const response of held) {
        if (!response.destroyed) json(response, 200, { messageId: 'synthetic-released' });
      }
      held.clear();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/messages') {
      const input = await body(req);
      if (
        typeof input.recipient !== 'string'
        || !/@example\.(test|invalid)$/.test(input.recipient)
        || typeof input.subject !== 'string'
        || typeof input.html !== 'string'
      ) {
        return json(res, 400, { code: 'SYNTHETIC_RECIPIENT_REQUIRED' });
      }
      if (mode === 'fail-before-send') return json(res, 422, { code: 'FAKE_PRE_SEND_FAILED' });
      messages.push({ recipient: input.recipient, subject: input.subject, html: input.html });
      process.stdout.write(JSON.stringify({ calls: messages.length, bytes: Buffer.byteLength(input.html) }) + '\n');
      if (mode === 'unknown-after-capture' || mode === 'block-until-release') {
        held.add(res);
        res.once('close', () => held.delete(res));
        return;
      }
      return json(res, 200, { messageId: `synthetic-${messages.length}` });
    }
    return json(res, 404, { code: 'NOT_FOUND' });
  } catch {
    if (!res.headersSent) json(res, 400, { code: 'INVALID_REQUEST' });
    else res.destroy();
  }
});

server.listen(8025, '0.0.0.0');
process.once('SIGTERM', () => {
  for (const response of held) response.destroy();
  server.close(() => process.exit(0));
});
