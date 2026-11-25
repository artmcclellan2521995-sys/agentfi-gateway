# AgentFi Live Web Extraction Gateway (x402 V2 + Bazaar)
Autonomous HTTP 402 micropayment gateway for real-time structured web, metadata, JSON, and link extraction on Base Mainnet (`eip155:8453`).
## Endpoints
- **Service Endpoint**: `POST https://agentfi.vip/v1/extract` (Body: `{"url": "https://example.com"}`)
- **Discovery Metadata**: `GET https://agentfi.vip/x402/discovery`
## Settlement Details
- **Network**: Base Mainnet (`eip155:8453`)
- **Asset**: USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- **Price**: `0.05 USDC` (`50000` atomic units) per call (`exact` scheme via `https://x402.org/facilitator`)
