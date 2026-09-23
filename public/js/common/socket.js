/**
 * WebSocket Helper - Connects to local relay and automatically reconnects
 */
export class RelaySocket {
  constructor(role, onMessage, onOpen, onClose, getRegisterPayload = null) {
    this.role = role;
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.getRegisterPayload = getRegisterPayload;
    this.ws = null;
    this.heartbeatTimer = null;
    this.connect();
  }

  connect() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    
    // Default fallback host: current page origin
    let wsHost = window.location.host;

    // Tailscale Funnel backend relay target:
    const TAILSCALE_RELAY_HOST = 'nodeintel.tail4bd1d1.ts.net';

    // Allow override via URL query parameter (?relay=...) or saved preference
    const urlParams = new URLSearchParams(window.location.search);
    const relayQuery = urlParams.get('relay');
    if (relayQuery) {
      try {
        localStorage.setItem('nodeintel_relay_host', relayQuery);
      } catch (e) {}
    }
    const storedRelay = (() => {
      try { return localStorage.getItem('nodeintel_relay_host'); } catch (e) { return null; }
    })();

    // When running on Cloudflare Pages (*.pages.dev) or remote CDN:
    const isPagesHost = window.location.hostname.endsWith('pages.dev') ||
                        window.location.hostname.endsWith('cloudflarepages.com');

    if (relayQuery) {
      wsHost = relayQuery;
    } else if (isPagesHost) {
      wsHost = storedRelay || TAILSCALE_RELAY_HOST;
    } else if (storedRelay && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
      wsHost = storedRelay;
    }

    const wsUrl = (wsHost.startsWith('ws://') || wsHost.startsWith('wss://'))
      ? wsHost
      : `${protocol}//${wsHost}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      const extra = this.getRegisterPayload ? this.getRegisterPayload() : {};
      this.send({ type: 'register', role: this.role, ...extra });

      // Keep connection alive through Cloudflare Tunnel proxy (25s interval)
      this.heartbeatTimer = setInterval(() => {
        if (this.isOpen()) {
          this.send({ type: 'heartbeat' });
        }
      }, 25000);

      if (this.onOpen) this.onOpen();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'heartbeat_ack') {
          return; // Keep-alive acknowledge
        }
        if (this.onMessage) this.onMessage(data);
      } catch (err) {
        console.error('WS Parse Error:', err);
      }
    };

    this.ws.onclose = () => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (this.onClose) this.onClose();
      setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = (err) => {
      console.error('WS Connection Error:', err);
    };
  }

  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  isOpen() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
