const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const config = require('./src/config');
const { getSSLOptions } = require('./src/ssl');
const { SocketRelay } = require('./src/socketRelay');
const { authManager } = require('./src/auth');
const { printServerBanner } = require('./src/utils/network');

const app = express();

// Enable trust proxy for Cloudflare Tunnel and reverse proxies
app.set('trust proxy', true);

// Enable CORS for external frontends (e.g. Cloudflare Pages)
const allowedOrigins = [
  'https://nodeintel.pages.dev',
  'http://localhost:3000',
  'https://localhost:3000',
  'http://127.0.0.1:3000',
  'https://127.0.0.1:3000',
  `https://${config.TAILSCALE_RELAY_HOST}`
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // Allow direct non-CORS requests (like Postman or direct browser hits)
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-admin-token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// JSON body parser
app.use(express.json());

// Serve static frontend assets from public/
app.use(express.static(config.PUBLIC_DIR));

// Target node page
app.get('/', (req, res) => {
  res.sendFile(path.join(config.PUBLIC_DIR, 'index.html'));
});

// Admin surveillance console
app.get('/admin', (req, res) => {
  res.sendFile(path.join(config.PUBLIC_DIR, 'admin.html'));
});

// Health check endpoint for tunnel verification
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    remoteIp: req.headers['cf-connecting-ip'] || req.ip,
    protocol: req.protocol,
    secure: req.secure
  });
});

// ============================================================================
// Admin Security & Passkey Authentication REST Endpoints
// ============================================================================

// 1. Generate Authentication Options (Login)
app.post('/api/admin/auth/options', async (req, res) => {
  const ip = req.headers['cf-connecting-ip'] || req.ip || '127.0.0.1';
  const rate = authManager.checkRateLimit(ip);
  if (!rate.allowed) {
    return res.status(429).json({ error: rate.error });
  }

  const { hostname, origin } = req.body || {};
  try {
    const data = await authManager.getAuthenticationOptions(hostname, origin);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 2. Verify Authentication Response (Login)
app.post('/api/admin/auth/verify', async (req, res) => {
  const ip = req.headers['cf-connecting-ip'] || req.ip || '127.0.0.1';
  const rate = authManager.checkRateLimit(ip);
  if (!rate.allowed) {
    return res.status(429).json({ error: rate.error });
  }

  const { response, challengeId, pin } = req.body || {};

  try {
    const result = await authManager.verifyAuthentication(response, challengeId, pin);
    authManager.recordSuccess(ip);
    res.json(result);
  } catch (err) {
    authManager.recordFailedAttempt(ip);
    res.status(400).json({ error: err.message });
  }
});

// 4. Verify Active Session
app.get('/api/admin/auth/session', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '') || req.headers['x-admin-token'];
  const valid = authManager.verifySessionToken(token);
  res.json({ valid });
});

// HTTPS Primary Server
const sslOptions = getSSLOptions();
const httpsServer = https.createServer(sslOptions, app);

// HTTP Secondary Server (Serves directly on HTTP_PORT for testing/local admin)
const httpServer = http.createServer(app);

// Unified WebSocket Relay across both HTTPS and HTTP servers
new SocketRelay([httpsServer, httpServer]);

// Start Servers
httpsServer.listen(config.PORT, '0.0.0.0', () => {
  httpServer.listen(config.HTTP_PORT, '0.0.0.0', () => {
    printServerBanner(config.PORT, config.HTTP_PORT);
  });
});
