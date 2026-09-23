const path = require('path');

module.exports = {
  PORT: process.env.PORT || 3000,
  HTTP_PORT: process.env.HTTP_PORT || 3001,
  CERT_PATH: path.join(__dirname, '..', 'cert.pem'),
  KEY_PATH: path.join(__dirname, '..', 'key.pem'),
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),
  CREDENTIALS_FILE: path.join(__dirname, '..', 'credentials.json'),
  DEFAULT_PIN: process.env.ADMIN_PIN || '0192',
  SESSION_TTL_MS: 24 * 60 * 60 * 1000, // 24 hours
  TAILSCALE_RELAY_HOST: 'nodeintel.tail4bd1d1.ts.net'
};
