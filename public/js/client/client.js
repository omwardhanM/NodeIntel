/**
 * Client Device Application Entrypoint - UI Binder
 */
import { ThemeManager } from '../common/theme.js';
import { Toast } from '../common/toast.js';
import { HeadlessNodeIntelClient } from './headless-client.js';

document.addEventListener('DOMContentLoaded', () => {
  ThemeManager.init('theme-toggle-btn');

  // DOM Elements
  const btnConnect = document.getElementById('btn-connect');
  const btnConnectText = document.getElementById('btn-connect-text');
  const statusLabel = document.getElementById('status-label');
  const descText = document.getElementById('card-desc-text');
  const btnNodeCam = document.getElementById('btn-node-toggle-cam');
  const camStatusVal = document.getElementById('node-cam-status');
  const camBtnText = document.getElementById('node-cam-btn-text');
  const intercomRow = document.getElementById('intercom-row');
  const incomingAudio = document.getElementById('incoming-audio');
  const videoPreview = document.getElementById('video-preview');
  const statusPill = document.getElementById('status-pill');

  // Initialize the Headless Client with our custom UI bindings
  const client = new HeadlessNodeIntelClient({
    videoElement: videoPreview,
    
    onStatusChange: (status, err = null) => {
      switch(status) {
        case 'CONNECTING':
          btnConnect.disabled = true;
          if (btnConnectText) btnConnectText.textContent = 'CONNECTING...';
          else btnConnect.textContent = 'CONNECTING...';
          if (statusLabel) statusLabel.textContent = 'CONNECTING...';
          if (statusPill) statusPill.textContent = '[ INIT ]';
          break;
        case 'CONNECTED':
          btnConnect.disabled = false;
          btnConnect.classList.add('connected-state');
          if (btnConnectText) btnConnectText.textContent = 'DISCONNECT DEVICE';
          else btnConnect.textContent = 'DISCONNECT';
          if (statusLabel) statusLabel.textContent = 'CONNECTED';
          if (descText) descText.textContent = 'Device connected to admin console.';
          if (btnNodeCam) btnNodeCam.style.display = 'flex';
          if (statusPill) statusPill.textContent = '[ LIVE ]';
          
          // Safari/iOS autoplay requirement: Try to play silent audio element on user gesture
          if (incomingAudio) {
            incomingAudio.muted = false;
            incomingAudio.volume = 1.0;
            incomingAudio.play().catch(() => {});
          }
          break;
        case 'DISCONNECTED':
          btnConnect.disabled = false;
          btnConnect.classList.remove('connected-state');
          if (btnConnectText) btnConnectText.textContent = 'CONNECT DEVICE';
          else btnConnect.textContent = 'CONNECT';
          if (statusLabel) statusLabel.textContent = 'DISCONNECTED';
          if (descText) descText.textContent = 'Stream camera, microphone, and location to the admin console.';
          if (btnNodeCam) btnNodeCam.style.display = 'none';
          if (statusPill) statusPill.textContent = '[ READY ]';
          break;
        case 'PERMISSION_ERROR':
          btnConnect.disabled = false;
          if (btnConnectText) btnConnectText.textContent = 'CONNECT DEVICE';
          else btnConnect.textContent = 'CONNECT';
          if (statusLabel) statusLabel.textContent = 'PERMISSION ERROR';
          if (statusPill) statusPill.textContent = '[ ERROR ]';
          break;
      }
    },

    onCameraUpdate: (isActive, facingMode) => {
      if (camStatusVal) {
        camStatusVal.textContent = isActive 
          ? `[ONLINE - ${facingMode.toUpperCase()}]` 
          : '[OFF]';
        camStatusVal.style.color = isActive ? 'var(--color-success)' : 'var(--text-dim)';
      }
      if (camBtnText) {
        camBtnText.textContent = isActive ? 'TURN CAMERA OFF' : 'TURN CAMERA ON';
      }
      if (btnNodeCam) {
        btnNodeCam.classList.toggle('cam-active', isActive);
      }
    },

    onIntercomUpdate: (isActive) => {
      if (intercomRow) {
        intercomRow.style.display = isActive ? 'flex' : 'none';
      }
      if (incomingAudio) {
        incomingAudio.muted = false;
        incomingAudio.volume = 1.0;
        if (isActive) {
          incomingAudio.play().catch(e => console.warn('[INTERCOM] audio.play() error:', e));
        }
      }
    },

    onNotification: (msg, type) => {
      Toast.show(msg, type);
    },

    onError: (msg) => {
      Toast.show(msg, 'error');
    }
  });

  // Check HTTPS Security Context UI
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

  // Bind Buttons
  if (btnConnect) {
    btnConnect.addEventListener('click', () => {
      if (client.isConnected) {
        client.disconnect();
      } else {
        client.connect();
      }
    });
  }

  if (btnNodeCam) {
    btnNodeCam.addEventListener('click', () => {
      client.toggleCamera();
    });
  }

  // Start internal initialization
  client.init();
});
