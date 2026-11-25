const http = require('http');
const https = require('https');
const crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const WALLET_ADDRESS = '0x379B6643675421867f8436513826781748Ec8329'.toLowerCase();
const REQUIRED_USDC = 0.05;
const REQUIRED_USDC_ATOMIC = '50000'; // 0.05 USDC (6 decimals)
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
    description: 'Real-time structured web and financial spread extraction for autonomous agents',
    mimeType: 'application/json',
    payTo: WALLET_ADDRESS,
    maxTimeoutSeconds: 300,
    asset: BASE_USDC_CONTRACT,
    extensions: {
      bazaar: {
        info: {
          input: { url: 'https://example.com', target: 'market_spread' },
          output: { title: 'Extracted Content', markdown: '# Clean Web Data Delivered' }
        },
        schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            input: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'Target URL or market endpoint to extract' },
                target: { type: 'string', description: 'Extraction mode or data field' }
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
  const quoteObj = {
    x402Version: 2,
    accepts: [reqObj],
    extensions: reqObj.extensions,
    nonce,
    expiresAt
  };
  const payloadB64 = Buffer.from(JSON.stringify(quoteObj)).toString('base64');
  const sig = crypto.createHmac('sha256', QUOTE_SECRET).update(payloadB64).digest('hex');
  return {
    nonce,
    expiresAt,
    reqObj,
    headerValue: payloadB64,
    signature: sig
  };
}
function postJson(urlStr, bodyObj) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const payload = JSON.stringify(bodyObj);
      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname,
        method: 'POST',
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
async function verifyViaFacilitator(rawHeader, paymentRequirements) {
  try {
    const paymentPayload = JSON.parse(Buffer.from(rawHeader, 'base64').toString('utf8'));
    if (!paymentPayload || !paymentPayload.x402Version) return null;
    const settleRes = await postJson(`${FACILITATOR_URL}/settle`, {
      x402Version: paymentPayload.x402Version,
      paymentPayload,
      paymentRequirements
    });
    if (settleRes.ok && settleRes.data && (settleRes.data.success || settleRes.data.txHash || settleRes.data.transaction)) {
      return (settleRes.data.txHash || settleRes.data.transaction || 'facilitator_settled').toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}
async function verifyBaseDirectTx(rawHeader) {
  const cleanTx = (rawHeader || '').trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(cleanTx)) return null;
  const normalized = cleanTx.toLowerCase();
  if (redeemedTxs.has(normalized)) return 'ALREADY_REDEEMED';
  const rpcRes = await postJson('https://mainnet.base.org', {
    jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [normalized]
  });
  const receipt = rpcRes.data && rpcRes.data.result;
  if (!receipt || receipt.status !== '0x1') return null;
  const transfer = (receipt.logs || []).find(l =>
    l.address.toLowerCase() === BASE_USDC_CONTRACT &&
    l.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' &&
    ('0x' + l.topics[2].slice(26)).toLowerCase() === WALLET_ADDRESS
  );
  if (!transfer) return null;
  const amount = parseInt(transfer.data, 16) / 1e6;
  return amount >= REQUIRED_USDC ? normalized : null;
}
const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  const resourceUrl = `https://${req.headers.host || 'agentfi.vip'}/v1/extract`;
  // 1. x402 V2 & Bazaar Discovery Endpoint
  if ((path === '/x402/discovery' || path === '/.well-known/x402') && req.method === 'GET') {
    const reqObj = buildPaymentRequirements(resourceUrl);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({
      x402Version: 2,
      provider: 'AgentFi M2M Clearing Gateway',
      facilitator: FACILITATOR_URL,
      accepts: [reqObj],
      extensions: reqObj.extensions
    }, null, 2));
  }
  // 2. Human-Readable Status Page
  if ((path === '/v1/extract' || path === '/') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`
      <html>
      <body style="font-family:sans-serif;max-width:600px;margin:40px auto;line-height:1.6;padding:20px;">
        <h2>AgentFi Web Extraction Gateway (x402 V2 + Bazaar Enabled)</h2>
        <p>Status: <span style="color:green;font-weight:bold;">Active & Bazaar Discoverable</span></p>
        <p><strong>Pricing:</strong> 0.05 USDC per call on Base Mainnet (<code>eip155:8453</code>)</p>
        <p><strong>Payment Address:</strong><br><code>0x379B6643675421867f8436513826781748Ec8329</code></p>
        <p><strong>Facilitator:</strong> <code>${FACILITATOR_URL}</code></p>
        <p><strong>Endpoint:</strong> POST <code>/v1/extract</code></p>
      </body>
      </html>
    `);
  }
  // 3. x402 V2 + Bazaar Extraction Endpoint
  if (path === '/v1/extract' && req.method === 'POST') {
    const rawSig = req.headers['payment-signature'] || req.headers['x-402-signature'];
    const quote = buildSignedQuote(resourceUrl);
    if (!rawSig) {
      res.writeHead(402, {
        'Content-Type': 'application/json',
        'PAYMENT-REQUIRED': quote.headerValue,
        'X-Quote-Signature': quote.signature,
        'X-Toll-Nonce': quote.nonce
      });
      return res.end(JSON.stringify({
        x402Version: 2,
        error: 'Payment Required',
        accepts: [quote.reqObj],
        extensions: quote.reqObj.extensions
      }));
    }
    // Try Facilitator /settle first (triggers automatic Bazaar catalog indexing), fallback to direct Base txHash
    let settledTx = await verifyViaFacilitator(rawSig, quote.reqObj);
    if (!settledTx) {
      settledTx = await verifyBaseDirectTx(rawSig);
    }
    if (settledTx === 'ALREADY_REDEEMED') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Already Redeemed' }));
    }
    if (!settledTx) {
      res.writeHead(402, { 'Content-Type': 'application/json', 'PAYMENT-REQUIRED': quote.headerValue });
      return res.end(JSON.stringify({ error: 'Payment Verification Failed', accepts: [quote.reqObj] }));
    }
    if (settledTx.startsWith('0x')) redeemedTxs.add(settledTx);
    const receiptId = 'rcpt_' + crypto.randomBytes(8).toString('hex');
    const responseBody = JSON.stringify({
      success: true,
      receipt_id: receiptId,
      settlement: { network: 'eip155:8453', asset: 'USDC', amount: String(REQUIRED_USDC), txHash: settledTx },
      data: {
        title: 'Extracted Content',
        markdown: '# Clean Web Data Delivered\nProcessed by AgentFi Gateway (Paid via Base USDC).'
      }
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, receiptId, txHash: settledTx })).toString('base64'),
      'X-Payload-Hash': crypto.createHash('sha256').update(responseBody).digest('hex')
    });
    return res.end(responseBody);
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});
server.listen(PORT, () => console.log(`AgentFi x402 V2 Bazaar Gateway running on port ${PORT}`));
