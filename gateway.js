const http = require('http');
const https = require('https');
const crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const WALLET_ADDRESS = '0x545Eefe13dCeA73D5293187886D756D7293F1dD4'.toLowerCase();
const REQUIRED_USDC = 0.05;
const REQUIRED_USDC_ATOMIC = '50000';
const BASE_USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'.toLowerCase();
const FACILITATOR_URL = process.env.FACILITATOR_URL || 'https://x402.org/facilitator';
const QUOTE_SECRET = process.env.QUOTE_SECRET || 'agentfi-x402-v2-hmac-secret';
const redeemedTxs = new Set();
function buildPaymentRequirements(resourceUrl) {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    maxAmountRequired: REQUIRED_USDC_ATOMIC,
    resource: resourceUrl,
    description: 'Real-time structured web content, metadata, and link extraction for autonomous agents',
    mimeType: 'application/json',
    payTo: WALLET_ADDRESS,
    maxTimeoutSeconds: 300,
    asset: BASE_USDC_CONTRACT,
    extensions: {
      bazaar: {
        info: {
          input: { url: 'https://example.com', target: 'clean_markdown' },
          output: { title: 'Example Domain', description: 'Extracted summary', markdown: 'Clean extracted text...', links: [] }
        },
        schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            input: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'Target HTTP/HTTPS URL to fetch and extract' },
                target: { type: 'string', description: 'Extraction mode: clean_markdown or links' }
              },
              required: ['url']
            }
          }
        }
      }
    }
  };
}
function buildSignedQuote(resourceUrl) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const reqObj = buildPaymentRequirements(resourceUrl);
  const quoteObj = { x402Version: 2, accepts: [reqObj], extensions: reqObj.extensions, nonce, expiresAt };
  const payloadB64 = Buffer.from(JSON.stringify(quoteObj)).toString('base64');
  const sig = crypto.createHmac('sha256', QUOTE_SECRET).update(payloadB64).digest('hex');
  return { nonce, expiresAt, reqObj, headerValue: payloadB64, signature: sig };
}
function postJson(urlStr, bodyObj) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const payload = JSON.stringify(bodyObj);
      const req = https.request({
        hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, data: JSON.parse(data) }); }
          catch { resolve({ ok: false, data: null }); }
        });
      });
      req.on('error', () => resolve({ ok: false, data: null }));
      req.write(payload);
      req.end();
    } catch { resolve({ ok: false, data: null }); }
  });
}
function readRequestBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function fetchAndExtractUrl(targetUrl, redirects = 0) {
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) return resolve({ ok: false, error: 'Only HTTP/HTTPS supported' });
      if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\])/i.test(parsedUrl.hostname)) {
        return resolve({ ok: false, error: 'Private network targets blocked' });
      }
    } catch { return resolve({ ok: false, error: 'Invalid URL format' }); }
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const req = client.get(parsedUrl.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentFi-Extractor/2.0; +https://agentfi.vip)', 'Accept': 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8' },
      timeout: 12000
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
        return resolve(fetchAndExtractUrl(new URL(res.headers.location, parsedUrl.href).href, redirects + 1));
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (raw.length < 500000) raw += chunk; });
      res.on('end', () => {
        const contentType = res.headers['content-type'] || '';
        if (contentType.includes('application/json')) {
          try {
            return resolve({ ok: true, sourceUrl: parsedUrl.href, statusCode: res.statusCode, title: parsedUrl.hostname + ' JSON', json: JSON.parse(raw), markdown: '```json\n' + raw.slice(0, 12000) + '\n```' });
          } catch {}
        }
        const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : parsedUrl.hostname;
        const descMatch = raw.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || raw.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
        const description = descMatch ? descMatch[1].trim() : '';
        const links = [];
        const linkRegex = /<a\s+[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while ((m = linkRegex.exec(raw)) !== null && links.length < 25) {
          try {
            const absHref = new URL(m[1], parsedUrl.href).href;
            const anchorText = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (anchorText && absHref.startsWith('http')) links.push({ text: anchorText.slice(0, 100), url: absHref });
          } catch {}
        }
        const cleanText = raw
          .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
          .replace(/<\/(p|div|h1|h2|h3|h4|li|tr|br)>/gi, '\n').replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
          .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim().slice(0, 15000);
        resolve({ ok: true, sourceUrl: parsedUrl.href, statusCode: res.statusCode, title, description, markdown: `# ${title}\n\n${description ? '> ' + description + '\n\n' : ''}${cleanText}`, links });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Fetch timed out (12s)' }); });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}
async function verifyViaFacilitator(rawHeader, paymentRequirements) {
  try {
    const paymentPayload = JSON.parse(Buffer.from(rawHeader, 'base64').toString('utf8'));
    if (!paymentPayload || !paymentPayload.x402Version) return null;
    const settleRes = await postJson(`${FACILITATOR_URL}/settle`, { x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements });
    if (settleRes.ok && settleRes.data && (settleRes.data.success || settleRes.data.txHash || settleRes.data.transaction)) {
      return (settleRes.data.txHash || settleRes.data.transaction || 'facilitator_settled').toLowerCase();
    }
    return null;
  } catch { return null; }
}
async function verifyBaseDirectTx(rawHeader) {
  const cleanTx = (rawHeader || '').trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(cleanTx)) return null;
  const normalized = cleanTx.toLowerCase();
  if (redeemedTxs.has(normalized)) return 'ALREADY_REDEEMED';
  const rpcRes = await postJson('https://mainnet.base.org', { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [normalized] });
  const receipt = rpcRes.data && rpcRes.data.result;
  if (!receipt || receipt.status !== '0x1') return null;
  const transfer = (receipt.logs || []).find(l => l.address.toLowerCase() === BASE_USDC_CONTRACT && l.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' && ('0x' + l.topics[2].slice(26)).toLowerCase() === WALLET_ADDRESS);
  if (!transfer) return null;
  return (parseInt(transfer.data, 16) / 1e6) >= REQUIRED_USDC ? normalized : null;
}
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'agentfi.vip'}`);
  const path = urlObj.pathname;
  const resourceUrl = `https://${req.headers.host || 'agentfi.vip'}/v1/extract`;
  if ((path === '/x402/discovery' || path === '/.well-known/x402') && req.method === 'GET') {
    const reqObj = buildPaymentRequirements(resourceUrl);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ x402Version: 2, provider: 'AgentFi M2M Clearing Gateway', facilitator: FACILITATOR_URL, accepts: [reqObj], extensions: reqObj.extensions }, null, 2));
  }
  if ((path === '/v1/extract' || path === '/') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;line-height:1.6;padding:20px;"><h2>AgentFi Live Web Extraction Gateway (x402 V2 + Bazaar)</h2><p>Status: <span style="color:green;font-weight:bold;">Active & Live Extraction Ready</span></p><p><strong>Pricing:</strong> 0.05 USDC per call on Base Mainnet (<code>eip155:8453</code>)</p><p><strong>Payment Address:</strong><br><code>0x545Eefe13dCeA73D5293187886D756D7293F1dD4</code></p><p><strong>Usage:</strong> <code>POST /v1/extract</code> with JSON body <code>{"url": "https://target-site.com"}</code></p></body></html>`);
  }
  if (path === '/v1/extract' && req.method === 'POST') {
    const rawSig = req.headers['payment-signature'] || req.headers['x-402-signature'];
    const quote = buildSignedQuote(resourceUrl);
    if (!rawSig) {
      res.writeHead(402, { 'Content-Type': 'application/json', 'PAYMENT-REQUIRED': quote.headerValue, 'X-Quote-Signature': quote.signature, 'X-Toll-Nonce': quote.nonce });
      return res.end(JSON.stringify({ x402Version: 2, error: 'Payment Required', accepts: [quote.reqObj], extensions: quote.reqObj.extensions }));
    }
    let settledTx = await verifyViaFacilitator(rawSig, quote.reqObj);
    if (!settledTx) settledTx = await verifyBaseDirectTx(rawSig);
    if (settledTx === 'ALREADY_REDEEMED') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Already Redeemed' }));
    }
    if (!settledTx) {
      res.writeHead(402, { 'Content-Type': 'application/json', 'PAYMENT-REQUIRED': quote.headerValue });
      return res.end(JSON.stringify({ error: 'Payment Verification Failed', accepts: [quote.reqObj] }));
    }
    if (settledTx.startsWith('0x')) redeemedTxs.add(settledTx);
    const bodyParams = await readRequestBody(req);
    const targetUrl = bodyParams.url || urlObj.searchParams.get('url') || 'https://example.com';
    const extracted = await fetchAndExtractUrl(targetUrl);
    const receiptId = 'rcpt_' + crypto.randomBytes(8).toString('hex');
    const responseBody = JSON.stringify({
      success: extracted.ok, receipt_id: receiptId,
      settlement: { network: 'eip155:8453', asset: 'USDC', amount: String(REQUIRED_USDC), txHash: settledTx },
      data: extracted.ok ? { sourceUrl: extracted.sourceUrl, statusCode: extracted.statusCode, title: extracted.title, description: extracted.description, markdown: extracted.markdown, links: extracted.links, json: extracted.json || undefined } : { sourceUrl: targetUrl, error: extracted.error }
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, receiptId, txHash: settledTx })).toString('base64'), 'X-Payload-Hash': crypto.createHash('sha256').update(responseBody).digest('hex') });
    return res.end(responseBody);
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});
server.listen(PORT, () => console.log(`AgentFi x402 V2 Live Extraction Gateway running on port ${PORT}`));
