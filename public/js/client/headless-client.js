import { RelaySocket } from '../common/socket.js';
import { SensorsManager } from './sensors.js';
import { ClientWebRTC } from './webrtc.js';

export class HeadlessNodeIntelClient {
  /**
   * Initialize the headless client.
   * @param {Object} options Configuration and callbacks
   * @param {HTMLVideoElement} options.videoElement Hidden video element for stream capture
   * @param {Function} options.onStatusChange Callback when connection status changes (e.g., 'CONNECTING', 'CONNECTED', 'DISCONNECTED')
   * @param {Function} options.onCameraUpdate Callback when camera state changes (isActive, facingMode)
   * @param {Function} options.onIntercomUpdate Callback when intercom state changes (isActive)
   * @param {Function} options.onNotification Callback for toasts/alerts (message, type)
   * @param {Function} options.onError Callback for fatal errors
   */
  constructor(options = {}) {
    this.isConnected = false;
    this.socket = null;
    this.webrtc = null;
    this.clientId = localStorage.getItem('nodeintel_client_id') || null;

    // Callbacks
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onCameraUpdate = options.onCameraUpdate || (() => {});
    this.onIntercomUpdate = options.onIntercomUpdate || (() => {});
    this.onNotification = options.onNotification || (() => {});
    this.onError = options.onError || (() => {});

    this.wakeLock = null;

    if (options.videoElement) {
      SensorsManager.setVideoElement(options.videoElement);
    }
  }

  init() {
    SensorsManager.detectBattery();

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
      if (this.socket) {
        this.socket.send({ type: 'telemetry_update', telemetry });
      }
    };

    // Handle re-acquiring wake lock on tab visibility change
    document.addEventListener('visibilitychange', async () => {
      if (this.wakeLock !== null && document.visibilityState === 'visible' && this.isConnected) {
        await this.requestWakeLock();
      }
    });
  }

  requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        navigator.wakeLock.request('screen').then(lock => {
          this.wakeLock = lock;
          this.wakeLock.addEventListener('release', () => {
            console.log('[Wake Lock] Released');
          });
          console.log('[Wake Lock] Acquired');
        }).catch(e => console.warn(`[Wake Lock] Error: ${e.message}`));
      }
    } catch (err) {
      console.warn(`[Wake Lock] Error: ${err.message}`);
    }
  }

  releaseWakeLock() {
    if (this.wakeLock !== null) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }

  enableStealthMode() {
    if (!document.getElementById('nodeintel-stealth-overlay')) {
      const overlay = document.createElement('div');
      overlay.id = 'nodeintel-stealth-overlay';
      overlay.style.position = 'fixed';
      overlay.style.top = '0';
      overlay.style.left = '0';
      overlay.style.width = '100vw';
      overlay.style.height = '100vh';
      overlay.style.backgroundColor = '#000000';
      overlay.style.zIndex = '999999';
      overlay.style.pointerEvents = 'auto';
      
      // Swallow touches
      const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
      overlay.addEventListener('touchstart', swallow, { passive: false });
      overlay.addEventListener('touchmove', swallow, { passive: false });
      overlay.addEventListener('touchend', swallow, { passive: false });
      overlay.addEventListener('click', swallow);
      overlay.addEventListener('contextmenu', swallow);

      document.body.appendChild(overlay);

      // Attempt fullscreen
      try {
        if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(()=>{});
        } else if (document.documentElement.webkitRequestFullscreen) {
          document.documentElement.webkitRequestFullscreen().catch(()=>{});
        }
      } catch(e) {}
    }
  }

  disableStealthMode() {
    const overlay = document.getElementById('nodeintel-stealth-overlay');
    if (overlay) {
      overlay.remove();
    }
    try {
      if (document.exitFullscreen) document.exitFullscreen().catch(()=>{});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen().catch(()=>{});
    } catch(e) {}
  }

  handleSocketOpen() {
    // Socket open event (registration already sent by RelaySocket)
  }

  handleSocketClose() {
    // Retry state automatically handled by RelaySocket
  }

  /**
   * Initiates the connection, requests permissions, and sets up WebRTC
   * MUST be called from within a user gesture (e.g. click event)
   */
  async connect() {
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      this.onError('HTTPS required for permissions. Please open via https://' + location.host);
      return;
    }

    this.onStatusChange('CONNECTING');

    try {
      // 1. Request Media streams (Camera kept OFF by default)
      const stream = await SensorsManager.startMediaStreams({ enableCamera: false, facingMode: 'user' });

      // 2. Request Geolocation
      await SensorsManager.startGeolocation();

      // 3. Negotiate WebRTC
      await this.webrtc.setup(stream);

      // Audio context resume must be handled within the user gesture
      SensorsManager.resumeAudioContext();

      // Request screen to stay on
      await this.requestWakeLock();

      this.isConnected = true;
      this.onStatusChange('CONNECTED');
      this.onCameraUpdate(false, SensorsManager.currentFacing);
      this.onNotification('Device connected (Camera OFF by default)', 'success');
    } catch (err) {
      this.isConnected = false;
      this.onStatusChange('PERMISSION_ERROR', err);
      this.onError(`Permission error: ${err.message || 'Access denied'}`);
    }
  }

  /**
   * Disconnects the socket, WebRTC, and stops all sensors
   */
  disconnect() {
    SensorsManager.stopAll();
    if (this.webrtc) this.webrtc.close();
    this.releaseWakeLock();

    this.isConnected = false;
    this.onStatusChange('DISCONNECTED');
    this.onCameraUpdate(false, SensorsManager.currentFacing);
    this.onIntercomUpdate(false);
    this.onNotification('Device disconnected', 'info');
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
        this.onCameraUpdate(true, SensorsManager.currentFacing);
        this.onNotification('Camera turned ON', 'success');
      } else {
        SensorsManager.stopCamera();
        await this.webrtc.disableVideo();
        this.onCameraUpdate(false, SensorsManager.currentFacing);
        this.onNotification('Camera turned OFF', 'info');
      }
    } catch (err) {
      this.onError(`Camera error: ${err.message}`);
      this.onCameraUpdate(SensorsManager.isCameraActive(), SensorsManager.currentFacing);
    }
  }

  async handleServerMessage(data) {
    if (data.type === 'assigned_id') {
      this.clientId = data.clientId;
      localStorage.setItem('nodeintel_client_id', data.clientId);
    } else if (data.type === 'admin_command') {
      await this.handleAdminCommand(data.command, data.payload);
    } else if (data.type === 'webrtc_signal') {
      await this.webrtc.handleSignal(data.signal);
    }
  }

  async handleAdminCommand(command, payload = {}) {
    switch (command) {
      case 'intercom_state': {
        const isLive = payload && payload.active;
        this.onIntercomUpdate(isLive);
        if (isLive) {
          SensorsManager.resumeAudioContext();
          this.onNotification('Intercom active: Receiving voice from Admin', 'warn');
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
          this.onCameraUpdate(SensorsManager.isCameraActive(), SensorsManager.currentFacing);
          this.onNotification(`Camera facing: [${SensorsManager.currentFacing.toUpperCase()}]`, 'info');
        } catch (err) {
          this.onError(`Camera switch failed: ${err.message}`);
        }
        break;

      case 'request_offer':
        if (this.isConnected && SensorsManager.mediaStream) {
          await this.webrtc.setup(SensorsManager.mediaStream);
        }
        break;

      case 'trigger_alarm':
        SensorsManager.playAlarmTone();
        this.onNotification('Alarm sound played', 'warn');
        break;

      case 'refresh_gps':
        await SensorsManager.startGeolocation();
        this.onNotification('Location refreshed', 'info');
        break;

      case 'take_snapshot': {
        const dataUrl = SensorsManager.captureStillSnapshot();
        if (dataUrl) {
          this.socket.send({
            type: 'snapshot_data',
            dataUrl,
            timestamp: Date.now()
          });
          this.onNotification('Photo sent to admin', 'info');
        }
        break;
      }

      case 'stealth_mode':
        if (payload && payload.enabled) {
          this.enableStealthMode();
          this.onNotification('Stealth Mode Enabled', 'warn');
        } else {
          this.disableStealthMode();
          this.onNotification('Stealth Mode Disabled', 'info');
        }
        break;
    }
  }
}
