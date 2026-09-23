const os = require('os');
const config = require('../config');

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const config of iface) {
      if (config.family === 'IPv4' && !config.internal) {
        ips.push(config.address);
      }
    }
  }
  return ips;
}

function printServerBanner(port, httpPort) {
  const ips = getLocalIPs();
  console.log('\n====================================================');
  console.log('[*] NodeIntel Surveillance Telemetry Server');
  console.log(`- Local Target URL:   https://localhost:${port}`);
  console.log(`- Local Admin URL:    https://localhost:${port}/admin`);
  console.log('----------------------------------------------------');
  console.log('Local Area Network (LAN):');
  ips.forEach(ip => {
    console.log(`  Target Node:  https://${ip}:${port}`);
    console.log(`  Admin Deck:   https://${ip}:${port}/admin`);
  });
  console.log('----------------------------------------------------');
  console.log('Tailscale Funnel (Permanent Remote WAN):');
  console.log(`  Target Node:  https://${config.TAILSCALE_RELAY_HOST}/`);
  console.log(`  Admin Deck:   https://${config.TAILSCALE_RELAY_HOST}/admin`);
  console.log('----------------------------------------------------');
  console.log('Cloudflare Pages Frontend:');
  console.log('  Deploy Folder: public/');
  console.log(`  Auto-Relay:    wss://${config.TAILSCALE_RELAY_HOST}`);
  console.log('====================================================\n');
}

module.exports = { getLocalIPs, printServerBanner };
