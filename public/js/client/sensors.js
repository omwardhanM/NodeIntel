/**
 * SensorsManager - Handles Camera, Microphone, Geolocation, and Device Telemetry
 */

export class SensorsManager {
  static mediaStream = null;
  static currentFacing = 'user';
  static geoWatchId = null;
  static audioContext = null;
  static analyser = null;
  static incomingAudioSource = null;
  static incomingAudioGain = null;
  static onTelemetryChange = null;
  static videoElement = null;

  static setVideoElement(el) {
    this.videoElement = el;
  }

  static state = {
    camera: { active: false, label: '', resolution: '', facingMode: 'user' },
    microphone: { active: false, label: '', volumeLevel: 0 },
    location: { active: false, latitude: null, longitude: null, accuracy: null, altitude: null, heading: null, speed: null, timestamp: null },
    system: { userAgent: navigator.userAgent, online: navigator.onLine, battery: 'Unknown' }
  };

  static async startMediaStreams({ enableCamera = false, facingMode = 'user' } = {}) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera/Microphone API unavailable in this context');
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }

    this.currentFacing = facingMode;

    // Prompt for both video and audio during user gesture to pre-authorize permissions
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 960 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (e) {
      console.warn('Combined camera/mic request failed, falling back to audio-only:', e);
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    }

    this.mediaStream = stream;

    const audioTrack = this.mediaStream.getAudioTracks()[0];
    this.state.microphone = {
      active: !!audioTrack,
      label: audioTrack ? audioTrack.label : 'Active Microphone',
      volumeLevel: 0
    };

    if (enableCamera) {
      const videoTrack = this.mediaStream.getVideoTracks()[0];
      const settings = videoTrack && videoTrack.getSettings ? videoTrack.getSettings() : {};
      this.state.camera = {
        active: true,
        label: videoTrack ? videoTrack.label : 'Active Camera',
        resolution: `${settings.width || 1280} x ${settings.height || 960}`,
        facingMode: facingMode
      };
      if (this.videoElement) this.videoElement.srcObject = this.mediaStream;
    } else {
      // OFF BY DEFAULT: Stop video tracks immediately so camera hardware & LED turn off
      const videoTracks = this.mediaStream.getVideoTracks();
      videoTracks.forEach(t => {
        t.stop();
        this.mediaStream.removeTrack(t);
      });
      this.state.camera = {
        active: false,
        label: 'Camera Off',
        resolution: '--',
        facingMode: facingMode
      };
      if (this.videoElement) this.videoElement.srcObject = null;
    }

    this.setupAudioAnalyser();
    this.emitTelemetry();
    return this.mediaStream;
  }

  static async startCamera(facingMode = null) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera API unavailable');
    }
    const facing = facingMode || this.currentFacing || 'user';
    this.currentFacing = facing;

    // Stop any existing video tracks first
    if (this.mediaStream) {
      this.mediaStream.getVideoTracks().forEach(t => {
        t.stop();
        this.mediaStream.removeTrack(t);
      });
    }

    let videoStream;
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: facing }, width: { ideal: 1280 }, height: { ideal: 960 } }
      });
    } catch (e) {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 960 } }
      });
    }

    const videoTrack = videoStream.getVideoTracks()[0];
    if (!videoTrack) {
      throw new Error('Could not acquire video track');
    }

    if (!this.mediaStream) {
      this.mediaStream = new MediaStream();
    }
    this.mediaStream.addTrack(videoTrack);

    const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
    this.state.camera = {
      active: true,
      label: videoTrack.label || 'Active Camera',
      resolution: `${settings.width || 1280} x ${settings.height || 960}`,
      facingMode: facing
    };

    if (this.videoElement) this.videoElement.srcObject = this.mediaStream;

    this.emitTelemetry();
    return videoTrack;
  }

  static stopCamera() {
    if (this.mediaStream) {
      const videoTracks = this.mediaStream.getVideoTracks();
      videoTracks.forEach(t => {
        t.stop();
        this.mediaStream.removeTrack(t);
      });
    }

    this.state.camera = {
      active: false,
      label: 'Camera Off',
      resolution: '--',
      facingMode: this.currentFacing
    };

    if (this.videoElement) this.videoElement.srcObject = null;

    this.emitTelemetry();
  }

  static async switchCamera() {
    const targetFacing = this.currentFacing === 'user' ? 'environment' : 'user';
    this.currentFacing = targetFacing;

    if (this.isCameraActive()) {
      return await this.startCamera(targetFacing);
    } else {
      this.state.camera.facingMode = targetFacing;
      this.emitTelemetry();
      return null;
    }
  }

  static isCameraActive() {
    return !!(this.state.camera && this.state.camera.active);
  }

  static getVideoTrack() {
    if (!this.mediaStream) return null;
    return this.mediaStream.getVideoTracks()[0] || null;
  }

  static setupAudioAnalyser() {
    try {
      if (this.audioContext) {
        try { this.audioContext.close(); } catch (e) {}
        this.audioContext = null;
      }

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx();
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;
      source.connect(this.analyser);

      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      let lastTime = 0;

      const checkVolume = () => {
        if (!this.mediaStream || !this.mediaStream.active) return;
        requestAnimationFrame(checkVolume);

        this.analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
        const avg = sum / bufferLength;
        const volumePercent = Math.min(100, Math.round((avg / 128) * 100));
        this.state.microphone.volumeLevel = volumePercent;

        const now = Date.now();
        if (now - lastTime > 400) {
          lastTime = now;
          this.emitTelemetry();
        }
      };
      checkVolume();
    } catch (err) {
      console.error('Audio analyser error:', err);
    }
  }

  static async startGeolocation() {
    if (!('geolocation' in navigator)) return;

    return new Promise((resolve) => {
      const options = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };
      this.geoWatchId = navigator.geolocation.watchPosition(
        (pos) => {
          const { coords, timestamp } = pos;
          this.state.location = {
            active: true,
            latitude: coords.latitude,
            longitude: coords.longitude,
            accuracy: coords.accuracy,
            altitude: coords.altitude,
            heading: coords.heading,
            speed: coords.speed,
            timestamp: timestamp
          };
          this.emitTelemetry();
          resolve();
        },
        () => resolve(), // Non-blocking if GPS permission is denied
        options
      );
    });
  }

  static async detectBattery() {
    if ('getBattery' in navigator) {
      try {
        const battery = await navigator.getBattery();
        const update = () => {
          const pct = Math.round(battery.level * 100);
          const chg = battery.charging ? ' (CHG)' : '';
          this.state.system.battery = `${pct}%${chg}`;
          this.emitTelemetry();
        };
        update();
        battery.addEventListener('levelchange', update);
        battery.addEventListener('chargingchange', update);
      } catch {
        this.state.system.battery = 'N/A';
      }
    }
  }

  static captureStillSnapshot() {
    if (!this.isCameraActive()) return null;
    if (!this.videoElement || !this.mediaStream) return null;

    const canvas = document.createElement('canvas');
    canvas.width = this.videoElement.videoWidth || 1280;
    canvas.height = this.videoElement.videoHeight || 960;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.videoElement, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png', 0.92);
  }

  static playAlarmTone() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1600, ctx.currentTime + 0.3);
      osc.frequency.exponentialRampToValueAtTime(800, ctx.currentTime + 0.6);

      gain.gain.setValueAtTime(0.7, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 1.2);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 1.2);
    } catch (err) {
      console.error('Alarm error:', err);
    }
  }

  static routeIncomingAudio(stream) {
    try {
      if (!this.audioContext) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AudioCtx();
      }
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume().catch(() => {});
      }
      if (this.incomingAudioSource) {
        try { this.incomingAudioSource.disconnect(); } catch (e) {}
      }
      this.incomingAudioSource = this.audioContext.createMediaStreamSource(stream);
      this.incomingAudioGain = this.audioContext.createGain();
      this.incomingAudioGain.gain.value = 1.0;
      this.incomingAudioSource.connect(this.incomingAudioGain);
      this.incomingAudioGain.connect(this.audioContext.destination);
      console.log('[AUDIO] Routed incoming intercom stream to AudioContext.destination');
    } catch (err) {
      console.warn('[AUDIO] Failed to route to AudioContext.destination:', err);
    }
  }

  static resumeAudioContext() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }
  }

  static stopAll() {
    if (this.incomingAudioSource) {
      try { this.incomingAudioSource.disconnect(); } catch (e) {}
      this.incomingAudioSource = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      try { this.audioContext.close(); } catch (e) {}
      this.audioContext = null;
    }
    if (this.geoWatchId !== null) {
      navigator.geolocation.clearWatch(this.geoWatchId);
      this.geoWatchId = null;
    }

    this.state.camera.active = false;
    this.state.microphone.active = false;
    this.state.location.active = false;
    this.emitTelemetry();
  }

  static emitTelemetry() {
    if (this.onTelemetryChange) {
      this.onTelemetryChange(this.state);
    }
  }
}
