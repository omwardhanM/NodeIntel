/**
 * Client Device Application Entrypoint
 */
import { ThemeManager } from '../common/theme.js';
import { Toast } from '../common/toast.js';
import { RelaySocket } from '../common/socket.js';
import { SensorsManager } from './sensors.js';
import { ClientWebRTC } from './webrtc.js';

class ClientApp {
  constructor() {
    this.isConnected = false;
    this.socket = null;
    this.webrtc = null;
    this.clientId = localStorage.getItem('nodeintel_client_id') || null;
  }

  init() {
    ThemeManager.init('theme-toggle-btn');
    SensorsManager.detectBattery();

    // Check HTTPS Security Context
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      const alertBox = document.getElementById('insecure-context-alert');
      const redirectLink = document.getElementById('https-redirect-link');
      if (alertBox) alertBox.style.display = 'block';
      if (redirectLink) {
        const portStr = location.port === '3001' ? ':3000' : (location.port && location.port !== '80' && location.port !== '443' ? `:${location.port}` : '');
        const targetUrl = `https://${location.hostname}${portStr}${location.pathname}${location.search}`;
        redirectLink.href = targetUrl;
        redirectLink.textContent = targetUrl;
      }
    }

    // Initialize WebSocket Relay
    this.socket = new RelaySocket(
      'client',
      (data) => this.handleServerMessage(data),
      () => this.handleSocketOpen(),
      () => this.handleSocketClose(),
      () => ({
        clientId: this.clientId,
        telemetry: SensorsManager.state
      })
    );

    this.webrtc = new ClientWebRTC(this.socket);

    SensorsManager.onTelemetryChange = (telemetry) => {
      this.socket.send({ type: 'telemetry_update', telemetry });
    };

    const btnConnect = document.getElementById('btn-connect');
    btnConnect?.addEventListener('click', () => {
      if (this.isConnected) {
        this.disconnect();
      } else {
        this.connect();
      }
    });

    const btnNodeCam = document.getElementById('btn-node-toggle-cam');
    btnNodeCam?.addEventListener('click', () => {
      this.toggleCamera();
    });
  }

  handleSocketOpen() {
    // Socket open event (registration already sent by RelaySocket)
  }

  handleSocketClose() {
    // Retry state automatically handled by RelaySocket
  }

  async connect() {
    const btn = document.getElementById('btn-connect');
    const btnText = document.getElementById('btn-connect-text');
    const statusLabel = document.getElementById('status-label');
    const descText = document.getElementById('card-desc-text');
    const btnNodeCam = document.getElementById('btn-node-toggle-cam');

    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      Toast.show('HTTPS required for permissions. Please open via https://' + location.host, 'error');
      return;
    }

    btn.disabled = true;
    if (btnText) btnText.textContent = 'CONNECTING...';
    if (statusLabel) statusLabel.textContent = 'CONNECTING...';

    try {
      // 1. Request Media streams (Camera kept OFF by default)
      const stream = await SensorsManager.startMediaStreams({ enableCamera: false, facingMode: 'user' });

      // 2. Request Geolocation
      await SensorsManager.startGeolocation();

      // 3. Negotiate WebRTC
      await this.webrtc.setup(stream);

      // Pre-unlock incoming audio and AudioContext inside user gesture
      const incomingAudio = document.getElementById('incoming-audio');
      if (incomingAudio) {
        incomingAudio.muted = false;
        incomingAudio.volume = 1.0;
        incomingAudio.play().catch(() => {});
      }
      SensorsManager.resumeAudioContext();

      this.isConnected = true;
      btn.disabled = false;
      btn.classList.add('connected-state');
      if (btnText) btnText.textContent = 'DISCONNECT DEVICE';
      if (statusLabel) statusLabel.textContent = 'CONNECTED';
      if (descText) descText.textContent = 'Device connected to admin console.';

      this.updateCameraUI(false);
      if (btnNodeCam) btnNodeCam.style.display = 'flex';

      Toast.show('Device connected (Camera OFF by default)', 'success');
    } catch (err) {
      this.isConnected = false;
      btn.disabled = false;
      if (btnText) btnText.textContent = 'CONNECT DEVICE';
      if (statusLabel) statusLabel.textContent = 'PERMISSION ERROR';
      Toast.show(`Permission error: ${err.message || 'Access denied'}`, 'error');
    }
  }

  disconnect() {
    SensorsManager.stopAll();
    this.webrtc.close();

    this.isConnected = false;
    const btn = document.getElementById('btn-connect');
    const btnText = document.getElementById('btn-connect-text');
    const statusLabel = document.getElementById('status-label');
    const descText = document.getElementById('card-desc-text');
    const btnNodeCam = document.getElementById('btn-node-toggle-cam');

    btn?.classList.remove('connected-state');
    if (btnText) btnText.textContent = 'CONNECT DEVICE';
    if (statusLabel) statusLabel.textContent = 'DISCONNECTED';
    if (descText) descText.textContent = 'Stream camera, microphone, and location to the admin console.';

    this.updateCameraUI(false);
    if (btnNodeCam) btnNodeCam.style.display = 'none';

    Toast.show('Device disconnected', 'info');
  }

  async toggleCamera() {
    await this.setCameraState(!SensorsManager.isCameraActive());
  }

  async setCameraState(enable) {
    if (!this.isConnected) return;
    try {
      if (enable) {
        const videoTrack = await SensorsManager.startCamera();
        await this.webrtc.enableVideo(videoTrack);
        this.updateCameraUI(true);
        Toast.show('Camera turned ON', 'success');
      } else {
        SensorsManager.stopCamera();
        await this.webrtc.disableVideo();
        this.updateCameraUI(false);
        Toast.show('Camera turned OFF', 'info');
      }
    } catch (err) {
      Toast.show(`Camera error: ${err.message}`, 'error');
      this.updateCameraUI(SensorsManager.isCameraActive());
    }
  }

  updateCameraUI(isActive) {
    const camStatusVal = document.getElementById('node-cam-status');
    const camBtnText = document.getElementById('node-cam-btn-text');
    const btnNodeCam = document.getElementById('btn-node-toggle-cam');

    if (camStatusVal) {
      camStatusVal.textContent = isActive 
        ? `[ONLINE - ${SensorsManager.currentFacing.toUpperCase()}]` 
        : '[OFF]';
      camStatusVal.style.color = isActive ? 'var(--color-success)' : 'var(--text-dim)';
    }

    if (camBtnText) {
      camBtnText.textContent = isActive ? 'TURN CAMERA OFF' : 'TURN CAMERA ON';
    }

    if (btnNodeCam) {
      btnNodeCam.classList.toggle('cam-active', isActive);
    }
  }

  async handleServerMessage(data) {
    if (data.type === 'assigned_id') {
      this.clientId = data.clientId;
      localStorage.setItem('nodeintel_client_id', data.clientId);
    } else if (data.type === 'admin_command') {
      this.handleAdminCommand(data.command, data.payload);
    } else if (data.type === 'webrtc_signal') {
      await this.webrtc.handleSignal(data.signal);
    }
  }

  async handleAdminCommand(command, payload = {}) {
    switch (command) {
      case 'intercom_state': {
        const isLive = payload && payload.active;
        const intercomRow = document.getElementById('intercom-row');
        const audioEl = document.getElementById('incoming-audio');
        if (intercomRow) {
          intercomRow.style.display = isLive ? 'flex' : 'none';
        }
        if (audioEl) {
          audioEl.muted = false;
          audioEl.volume = 1.0;
          if (isLive) {
            audioEl.play().catch(e => console.warn('[INTERCOM] audio.play() error:', e));
          }
        }
        if (isLive) {
          SensorsManager.resumeAudioContext();
          Toast.show('Intercom active: Receiving voice from Admin', 'warn');
        }
        break;
      }

      case 'set_camera': {
        const targetState = payload && typeof payload.enabled === 'boolean'
          ? payload.enabled
          : !SensorsManager.isCameraActive();
        await this.setCameraState(targetState);
        break;
      }

      case 'toggle_camera':
        await this.toggleCamera();
        break;

      case 'switch_camera':
        try {
          await this.webrtc.switchCamera();
          this.updateCameraUI(SensorsManager.isCameraActive());
          Toast.show(`Camera facing: [${SensorsManager.currentFacing.toUpperCase()}]`, 'info');
        } catch (err) {
          Toast.show(`Camera switch failed: ${err.message}`, 'error');
        }
        break;

      case 'request_offer':
        if (this.isConnected && SensorsManager.mediaStream) {
          await this.webrtc.setup(SensorsManager.mediaStream);
        }
        break;

      case 'trigger_alarm':
        SensorsManager.playAlarmTone();
        Toast.show('Alarm sound played', 'warn');
        break;

      case 'refresh_gps':
        await SensorsManager.startGeolocation();
        Toast.show('Location refreshed', 'info');
        break;

      case 'take_snapshot': {
        const dataUrl = SensorsManager.captureStillSnapshot();
        if (dataUrl) {
          this.socket.send({
            type: 'snapshot_data',
            dataUrl,
            timestamp: Date.now()
          });
          Toast.show('Photo sent to admin', 'info');
        }
        break;
      }
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new ClientApp();
  app.init();
});
