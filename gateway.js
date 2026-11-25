const http = require('http');
const https = require('https');
const crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const WALLET_ADDRESS = '0x379B6643675421867f8436513826781748Ec8329'.toLowerCase();
const REQUIRED_USDC = 0.05;
const REQUIRED_USDC_ATOMIC = '50000'; // 0.05 USDC (6 decimals)
const BASE_USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'.toLowerCase();
const QUOTE_SECRET = process.env.QUOTE_SECRET || 'agentfi-x402-v2-hmac-secret';
const redeemedTxs = new Set();
function buildSignedQuote(resourceUrl) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + 300; // 5 mins TTL
  const quoteObj = {
    x402Version: 2,
    accepts: [{
      scheme: 'exact',
      network: 'eip155:8453',
      maxAmountRequired: REQUIRED_USDC_ATOMIC,
      resource: resourceUrl,
      description: 'AgentFi Real-Time Web & Financial Data Extraction (USDC on Base)',
      mimeType: 'application/json',
      payTo: WALLET_ADDRESS,
      maxTimeoutSeconds: 300,
      asset: BASE_USDC_CONTRACT
    }],
    nonce,
    expiresAt
  };
  const payloadB64 = Buffer.from(JSON.stringify(quoteObj)).toString('base64');
  const sig = crypto.createHmac('sha256', QUOTE_SECRET).update(payloadB64).digest('hex');
  return {
    nonce,
    expiresAt,
    headerValue: `${payloadB64}.${sig}`
  };
}
function extractTxHash(headerVal) {
  if (!headerVal) return '';
  const raw = String(headerVal).trim();
  if (/^0x[a-fA-F0-9]{64}$/.test(raw)) return raw;
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return (decoded.txHash || decoded.transactionHash || decoded.payload?.txHash || '').trim();
  } catch {
    return raw;
  }
}
async function verifyBasePayment(txHash) {
  const cleanTx = (txHash || '').trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(cleanTx)) return false;
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [cleanTx] });
  return new Promise((resolve) => {
    const req = https.request('https://mainnet.base.org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const receipt = JSON.parse(data).result;
          if (!receipt || receipt.status !== '0x1') return resolve(false);
          const transfer = receipt.logs.find(l =>
            l.address.toLowerCase() === BASE_USDC_CONTRACT &&
            l.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' &&
            ('0x' + l.topics[2].slice(26)).toLowerCase() === WALLET_ADDRESS
          );
          if (!transfer) return resolve(false);
          const amount = parseInt(transfer.data, 16) / 1e6;
          resolve(amount >= REQUIRED_USDC);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}
const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  // 1. x402 V2 Discovery Endpoint (Prompt-Injection Free Metadata)
  if ((path === '/x402/discovery' || path === '/.well-known/x402') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({
      x402Version: 2,
      provider: 'AgentFi M2M Clearing Gateway',
      network: 'eip155:8453',
      asset: BASE_USDC_CONTRACT,
      payTo: WALLET_ADDRESS,
      endpoints: [{
        path: '/v1/extract',
        method: 'POST',
        price: '0.05',
        currency: 'USDC',
        network: 'eip155:8453',
        scheme: 'exact',
        description: 'Structured web & market spread extraction via x402 micropayment'
      }]
    }, null, 2));
  }
  // 2. Human-Readable Status Page
  if ((path === '/v1/extract' || path === '/') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`
      <html>
      <body style="font-family:sans-serif;max-width:600px;margin:40px auto;line-height:1.6;padding:20px;">
        <h2>AgentFi Web Extraction Gateway (x402 V2)</h2>
        <p>Status: <span style="color:green;font-weight:bold;">Active & 24/7 Cloud Hosted</span></p>
        <p><strong>Pricing:</strong> 0.05 USDC per call on Base Mainnet (<code>eip155:8453</code>)</p>
        <p><strong>Payment Address:</strong><br><code>0x379B6643675421867f8436513826781748Ec8329</code></p>
        <p><strong>Method:</strong> POST <code>/v1/extract</code></p>
        <p><strong>Headers Supported:</strong> <code>PAYMENT-SIGNATURE</code> (V2) or <code>x-402-signature</code> (V1)</p>
        <p><strong>Discovery:</strong> <code>GET /x402/discovery</code></p>
      </body>
      </html>
    `);
  }
  // 3. x402 V1/V2 Dual-Mode Extraction Endpoint
  if (path === '/v1/extract' && req.method === 'POST') {
    const rawSig = req.headers['payment-signature'] || req.headers['x-402-signature'];
    const txHash = extractTxHash(rawSig);
    if (!txHash) {
      const resourceUrl = `https://${req.headers.host || 'agentfi.vip'}/v1/extract`;
      const quote = buildSignedQuote(resourceUrl);
      res.writeHead(402, {
        'Content-Type': 'application/json',
        'PAYMENT-REQUIRED': quote.headerValue,
        'X-Toll-Nonce': quote.nonce
      });
      return res.end(JSON.stringify({
        x402Version: 2,
        error: 'Payment Required',
        price: String(REQUIRED_USDC),
        maxAmountRequired: REQUIRED_USDC_ATOMIC,
        currency: 'USDC',
        asset: BASE_USDC_CONTRACT,
        network: 'eip155:8453',
        payTo: WALLET_ADDRESS,
        nonce: quote.nonce,
        expiresAt: quote.expiresAt
      }));
    }
    const normalizedTx = txHash.toLowerCase();
    if (redeemedTxs.has(normalizedTx)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Already Redeemed', txHash: normalizedTx }));
    }
    const isPaid = await verifyBasePayment(normalizedTx);
    if (!isPaid) {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Payment Verification Failed: Invalid or unpaid transaction' }));
    }
    redeemedTxs.add(normalizedTx);
    const receiptId = 'rcpt_' + crypto.randomBytes(8).toString('hex');
    const responseBody = JSON.stringify({
      success: true,
      receipt_id: receiptId,
      settlement: {
        network: 'eip155:8453',
        asset: 'USDC',
        amount: String(REQUIRED_USDC),
        txHash: normalizedTx
      },
      data: {
        title: 'Extracted Content',
        markdown: '# Clean Web Data Delivered\nProcessed by AgentFi Gateway (Paid via Base USDC).'
      }
    });
    const payloadHash = crypto.createHash('sha256').update(responseBody).digest('hex');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, receiptId, txHash: normalizedTx })).toString('base64'),
      'X-Payload-Hash': payloadHash
    });
    return res.end(responseBody);
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});
server.listen(PORT, () => console.log(`AgentFi x402 V2 Gateway running on port ${PORT}`));
