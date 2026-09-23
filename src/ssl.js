const fs = require('fs');
const { execSync } = require('child_process');
const config = require('./config');

function getSSLOptions() {
  if (!fs.existsSync(config.CERT_PATH) || !fs.existsSync(config.KEY_PATH)) {
    console.log('[*] Generating self-signed SSL certificates for Secure Context (HTTPS)...');
    try {
      execSync(
        `openssl req -nodes -new -x509 -keyout "${config.KEY_PATH}" -out "${config.CERT_PATH}" -days 365 -subj "/CN=NodeIntel"`
      );
      console.log('[+] SSL certificates generated successfully.');
    } catch (err) {
      console.error('Failed to generate SSL certificates:', err.message);
    }
  }

  return {
    key: fs.readFileSync(config.KEY_PATH),
    cert: fs.readFileSync(config.CERT_PATH)
  };
}

module.exports = { getSSLOptions };
