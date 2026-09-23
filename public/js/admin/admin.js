/**
 * Admin Surveillance Console Application Entrypoint
 */
import { ThemeManager } from '../common/theme.js';
import { Toast } from '../common/toast.js';
import { RelaySocket } from '../common/socket.js';
import { PinAuth } from './pinAuth.js';
import { AdminLogger } from './logger.js';
import { MapTracker } from './map.js';
import { AdminWebRTC } from './webrtc.js';
import { CommandDeck } from './deck.js';

class AdminApp {
  constructor() {
    this.socket = null;
    this.webrtc = null;
    this.deck = null;
    this.auth = null;
  }

  init() {
    ThemeManager.init('admin-theme-toggle');
    AdminLogger.init('admin-logs-container');
    MapTracker.init();

    // Setup PIN + Passkey Authentication (Validated on local server)
    this.auth = new PinAuth((token) => {
      AdminLogger.log('Admin session authenticated with server', 'success');
      // If socket is open, upgrade socket session to admin
      if (this.socket && this.socket.isOpen() && token) {
        this.socket.send({ type: 'admin_auth', token });
      }
      // Trigger resize for leaflet map to render properly on unlock
      setTimeout(() => {
        if (MapTracker.map) MapTracker.map.invalidateSize();
      }, 200);
    });
    this.auth.init();

    // Initialize WebSocket Relay with Session Token
    this.socket = new RelaySocket(
      'admin',
      (data) => this.handleServerMessage(data),
      () => this.handleSocketOpen(),
      () => this.handleSocketClose(),
      () => ({
        token: sessionStorage.getItem('nodeintel_admin_token')
      })
    );

    this.webrtc = new AdminWebRTC(this.socket);
    this.deck = new CommandDeck(this.socket);

    // Device switch callback -> rebind WebRTC to newly selected device
    this.deck.onDeviceSwitch = (deviceId) => {
      this.webrtc.resetMediaViews();
      this.webrtc.createPeerConnection(deviceId);
      setTimeout(() => {
        this.deck.sendCommand('request_offer');
      }, 200);
    };

    this.deck.init();

    // Listen In (Speaker) audio button
    document.getElementById('btn-toggle-listen')?.addEventListener('click', () => {
      this.webrtc.toggleListen();
    });

    // Broadcast Mic (Intercom to target) button
    document.getElementById('btn-broadcast-mic')?.addEventListener('click', () => {
      this.webrtc.toggleBroadcast();
    });

    // Clear Logs button
    document.getElementById('btn-clear-admin-logs')?.addEventListener('click', () => {
      AdminLogger.clear();
    });
  }

  handleSocketOpen() {
    const wsStatusEl = document.getElementById('admin-val-ws');
    if (wsStatusEl) wsStatusEl.textContent = 'CONNECTED [WSS]';
    AdminLogger.log('Connected to relay server', 'info');

    const token = sessionStorage.getItem('nodeintel_admin_token');
    if (token) {
      this.socket.send({ type: 'admin_auth', token });
    }
  }

  handleSocketClose() {
    const wsStatusEl = document.getElementById('admin-val-ws');
    if (wsStatusEl) wsStatusEl.textContent = 'DISCONNECTED [RETRYING]';
    AdminLogger.log('Relay connection closed. Retrying in 3s...', 'warn');
  }

  handleServerMessage(data) {
    if (data.type === 'auth_required') {
      AdminLogger.log('Server requires PIN + Passkey authentication', 'warn');
      if (this.auth) this.auth.lock();
      return;
    }

    if (data.type === 'auth_success') {
      AdminLogger.log('WebSocket admin privileges granted by server', 'success');
      if (data.devices) {
        this.deck.setDeviceList(data.devices);
      }
      return;
    }

    if (data.type === 'initial_state' || data.type === 'device_list') {
      this.deck.setDeviceList(data.devices);
    } else if (data.type === 'telemetry_update') {
      if (data.devices) this.deck.devices = data.devices;
      if (!this.deck.selectedDeviceId || data.clientId === this.deck.selectedDeviceId) {
        this.deck.applyTelemetry(data.telemetry);
      }
    } else if (data.type === 'snapshot_data') {
      this.deck.addSnapshotToGallery(data.dataUrl, data.timestamp, data.clientId);
    } else if (data.type === 'webrtc_signal') {
      if (!this.deck.selectedDeviceId || !data.clientId || data.clientId === this.deck.selectedDeviceId) {
        this.webrtc.handleSignal(data.signal, data.clientId);
      }
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new AdminApp();
  app.init();
});
