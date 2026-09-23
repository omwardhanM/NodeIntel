/**
 * AdminWebRTC - Receives Target WebRTC Video/Audio streams and manages media elements
 */
import { AdminLogger } from './logger.js';

// Multi-STUN configuration including Cloudflare's global anycast STUN network
export const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 2
};

export class AdminWebRTC {
  constructor(socket) {
    this.socket = socket;
    this.peerConnection = null;
    this.isListening = false;
    this.activeClientId = null;
    this.candidateQueue = [];
    this.localMicStream = null;
    this.isBroadcasting = false;
    this.micSender = null;
    this.micAudioContext = null;
    this.micAnalyser = null;
    this.micAnimId = null;
  }

  createPeerConnection(targetClientId = null) {
    if (this.peerConnection) {
      try { this.peerConnection.close(); } catch (e) {}
      this.peerConnection = null;
      this.micSender = null;
    }

    this.activeClientId = targetClientId;
    this.candidateQueue = [];
    this.peerConnection = new RTCPeerConnection(RTC_CONFIG);

    // If local microphone stream was previously acquired, attach its audio track
    if (this.localMicStream) {
      const micTrack = this.localMicStream.getAudioTracks()[0];
      if (micTrack) {
        this.micSender = this.peerConnection.addTrack(micTrack, this.localMicStream);
        micTrack.enabled = this.isBroadcasting;
      }
    }

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      if (state) {
        AdminLogger.log(`WebRTC state: ${state}`, state === 'connected' ? 'success' : 'info');
      }
      if (state === 'failed') {
        AdminLogger.log('WebRTC connection failed. Requesting fresh offer...', 'error');
        if (this.socket && this.socket.isOpen()) {
          this.socket.send({
            type: 'admin_command',
            command: 'request_offer',
            targetClientId: this.activeClientId
          });
        }
      }
    };

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.send({
          type: 'webrtc_signal',
          targetClientId: this.activeClientId,
          signal: { candidate: event.candidate }
        });
      }
    };

    this.peerConnection.ontrack = (event) => {
      AdminLogger.log(`Received media track: ${event.track.kind}`, 'success');
      const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);

      if (event.track.kind === 'video') {
        const videoEl = document.getElementById('remote-video-el');
        const placeholder = document.getElementById('remote-video-placeholder');
        const overlay = document.getElementById('remote-video-overlay');
        const canvas = document.getElementById('remote-canvas-fallback');

        event.track.onmute = () => {
          if (videoEl) videoEl.style.display = 'none';
          if (overlay) overlay.style.display = 'none';
          if (placeholder) placeholder.style.display = 'flex';
        };

        event.track.onunmute = () => {
          if (videoEl) {
            videoEl.style.display = 'block';
            videoEl.play().catch(e => console.warn('Video play prevented:', e));
          }
          if (canvas) canvas.style.display = 'none';
          if (placeholder) placeholder.style.display = 'none';
          if (overlay) overlay.style.display = 'flex';
        };

        if (videoEl) {
          videoEl.srcObject = stream;
          if (event.track.enabled && !event.track.muted) {
            videoEl.style.display = 'block';
            videoEl.play().catch(e => console.warn('Video play prevented:', e));
            if (canvas) canvas.style.display = 'none';
            if (placeholder) placeholder.style.display = 'none';
            if (overlay) overlay.style.display = 'flex';
          }
        }
      } else if (event.track.kind === 'audio') {
        const audioEl = document.getElementById('remote-audio-el');
        if (audioEl) {
          audioEl.srcObject = stream;
          audioEl.muted = !this.isListening;
          audioEl.play().catch(e => console.warn('Audio play prevented:', e));
        }
      }
    };
  }

  async handleSignal(signal, fromClientId = null) {
    if (this.activeClientId && fromClientId && fromClientId !== this.activeClientId) {
      return;
    }

    if (!this.peerConnection || (fromClientId && this.activeClientId && fromClientId !== this.activeClientId)) {
      this.createPeerConnection(fromClientId);
    }

    if (signal.sdp) {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));

      // Flush queued candidates that arrived before remoteDescription was set
      while (this.candidateQueue.length > 0) {
        const candidate = this.candidateQueue.shift();
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn('Buffered ICE candidate error:', e);
        }
      }

      if (signal.sdp.type === 'offer') {
        // Ensure audio transceiver direction is 'sendrecv' so Admin can transmit mic voice back
        const transceivers = this.peerConnection.getTransceivers();
        const audioTransceiver = transceivers.find(t => 
          (t.receiver && t.receiver.track && t.receiver.track.kind === 'audio') ||
          (t.sender && t.sender.track && t.sender.track.kind === 'audio') ||
          t.sender?.kind === 'audio'
        );
        if (audioTransceiver) {
          audioTransceiver.direction = 'sendrecv';
          if (this.localMicStream) {
            const micTrack = this.localMicStream.getAudioTracks()[0];
            if (micTrack) {
              audioTransceiver.sender.replaceTrack(micTrack).catch(e => console.warn(e));
              micTrack.enabled = this.isBroadcasting;
            }
          }
        }

        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        this.socket.send({
          type: 'webrtc_signal',
          targetClientId: fromClientId || this.activeClientId,
          signal: { sdp: this.peerConnection.localDescription }
        });
      }
    } else if (signal.candidate) {
      if (!this.peerConnection || !this.peerConnection.remoteDescription) {
        this.candidateQueue.push(signal.candidate);
      } else {
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (e) {
          console.warn('ICE candidate error:', e);
        }
      }
    }
  }

  toggleListen() {
    this.isListening = !this.isListening;
    const audioEl = document.getElementById('remote-audio-el');
    const btnListen = document.getElementById('btn-toggle-listen');
    const listenText = document.getElementById('listen-btn-text');

    if (audioEl) {
      audioEl.muted = !this.isListening;
      if (this.isListening) {
        audioEl.play().catch(e => console.warn('Audio play prevented:', e));
        AdminLogger.log('Speaker unmuted', 'success');
      } else {
        AdminLogger.log('Speaker muted', 'info');
      }
    }

    if (listenText) {
      listenText.textContent = this.isListening ? 'MUTE SPEAKER' : 'LISTEN (SPEAKER)';
    }
    btnListen?.classList.toggle('active-state', this.isListening);
  }

  async toggleBroadcast() {
    if (this.isBroadcasting) {
      this.stopBroadcast();
    } else {
      await this.startBroadcast();
    }
  }

  async startBroadcast() {
    if (!this.activeClientId) {
      AdminLogger.log('Cannot broadcast: No target device selected', 'warn');
      return;
    }

    try {
      if (!this.localMicStream) {
        AdminLogger.log('Requesting local microphone access...', 'info');
        this.localMicStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        AdminLogger.log('Local microphone acquired', 'success');
      }

      const micTrack = this.localMicStream.getAudioTracks()[0];
      if (!micTrack) {
        throw new Error('No audio track available from microphone');
      }

      micTrack.enabled = true;
      this.isBroadcasting = true;

      // Attach track to peer connection and ensure direction is sendrecv
      if (this.peerConnection) {
        const transceivers = this.peerConnection.getTransceivers();
        let audioTransceiver = transceivers.find(t => 
          (t.sender && t.sender.track && t.sender.track.kind === 'audio') ||
          (t.receiver && t.receiver.track && t.receiver.track.kind === 'audio') ||
          t.sender?.kind === 'audio'
        );

        let needsRenegotiation = false;

        if (audioTransceiver) {
          if (audioTransceiver.direction !== 'sendrecv') {
            audioTransceiver.direction = 'sendrecv';
            needsRenegotiation = true;
          }
          await audioTransceiver.sender.replaceTrack(micTrack);
          this.micSender = audioTransceiver.sender;
        } else {
          this.micSender = this.peerConnection.addTrack(micTrack, this.localMicStream);
          needsRenegotiation = true;
        }

        if (needsRenegotiation || (audioTransceiver && audioTransceiver.currentDirection !== 'sendrecv')) {
          AdminLogger.log('Renegotiating bidirectional audio with target node...', 'info');
          const offer = await this.peerConnection.createOffer();
          await this.peerConnection.setLocalDescription(offer);
          this.socket.send({
            type: 'webrtc_signal',
            targetClientId: this.activeClientId,
            signal: { sdp: this.peerConnection.localDescription }
          });
        }
      }

      // Notify target node that intercom is active
      if (this.socket && this.socket.isOpen()) {
        this.socket.send({
          type: 'admin_command',
          command: 'intercom_state',
          targetClientId: this.activeClientId,
          payload: { active: true }
        });
      }

      this.updateBroadcastUI(true);
      this.setupMicAnalyser();
      AdminLogger.log(`Microphone broadcast ACTIVE to device [${this.activeClientId}]`, 'success');
    } catch (err) {
      this.isBroadcasting = false;
      this.updateBroadcastUI(false);
      this.setAdminMicUI(0);
      AdminLogger.log(`Microphone broadcast error: ${err.message}`, 'error');
    }
  }

  stopBroadcast() {
    this.isBroadcasting = false;
    if (this.micAnimId) {
      cancelAnimationFrame(this.micAnimId);
      this.micAnimId = null;
    }
    this.setAdminMicUI(0);

    if (this.localMicStream) {
      const micTrack = this.localMicStream.getAudioTracks()[0];
      if (micTrack) {
        micTrack.enabled = false;
      }
    }

    if (this.socket && this.socket.isOpen() && this.activeClientId) {
      this.socket.send({
        type: 'admin_command',
        command: 'intercom_state',
        targetClientId: this.activeClientId,
        payload: { active: false }
      });
    }

    this.updateBroadcastUI(false);
    AdminLogger.log('Microphone broadcast STOPPED', 'info');
  }

  setupMicAnalyser() {
    if (!this.localMicStream) return;
    try {
      if (this.micAudioContext) {
        try { this.micAudioContext.close(); } catch (e) {}
        this.micAudioContext = null;
      }

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.micAudioContext = new AudioCtx();
      const source = this.micAudioContext.createMediaStreamSource(this.localMicStream);
      this.micAnalyser = this.micAudioContext.createAnalyser();
      this.micAnalyser.fftSize = 64;
      source.connect(this.micAnalyser);

      const bufferLength = this.micAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const updateMicVolume = () => {
        if (!this.isBroadcasting || !this.localMicStream) {
          this.setAdminMicUI(0);
          return;
        }
        this.micAnimId = requestAnimationFrame(updateMicVolume);

        this.micAnalyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
        const avg = sum / bufferLength;
        const volumePercent = Math.min(100, Math.round((avg / 128) * 100));
        this.setAdminMicUI(volumePercent);
      };

      this.micAnimId = requestAnimationFrame(updateMicVolume);
    } catch (err) {
      console.warn('Admin mic analyser setup error:', err);
    }
  }

  setAdminMicUI(volumePercent) {
    const micFill = document.getElementById('admin-mic-vu-fill');
    const micStat = document.getElementById('admin-mic-stat-volume');
    if (micFill) {
      micFill.style.width = `${volumePercent}%`;
    }
    if (micStat) {
      micStat.textContent = `${volumePercent}%`;
    }
  }

  updateBroadcastUI(active) {
    const btnBroadcast = document.getElementById('btn-broadcast-mic');
    const textBroadcast = document.getElementById('broadcast-btn-text');
    const statusBroadcast = document.getElementById('admin-broadcast-status');

    if (btnBroadcast) {
      btnBroadcast.classList.toggle('active-transmitting', active);
    }
    if (textBroadcast) {
      textBroadcast.textContent = active ? 'STOP BROADCAST' : 'BROADCAST (MIC)';
    }
    if (statusBroadcast) {
      statusBroadcast.textContent = active ? '[TRANSMITTING LIVE]' : '[IDLE]';
      statusBroadcast.className = active ? 'stat-value text-accent' : 'stat-value';
    }
  }

  resetMediaViews() {
    const videoEl = document.getElementById('remote-video-el');
    const placeholder = document.getElementById('remote-video-placeholder');
    const overlay = document.getElementById('remote-video-overlay');

    if (videoEl) {
      videoEl.pause();
      videoEl.srcObject = null;
      videoEl.style.display = 'none';
    }
    if (placeholder) placeholder.style.display = 'flex';
    if (overlay) overlay.style.display = 'none';

    const audioEl = document.getElementById('remote-audio-el');
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
    }
  }

  close() {
    this.stopBroadcast();
    if (this.micAudioContext) {
      try { this.micAudioContext.close(); } catch (e) {}
      this.micAudioContext = null;
    }
    if (this.localMicStream) {
      this.localMicStream.getTracks().forEach(t => t.stop());
      this.localMicStream = null;
    }
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
  }
}
