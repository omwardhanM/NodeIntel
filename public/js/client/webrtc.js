/**
 * ClientWebRTC - Handles WebRTC PeerConnection, track streaming, and seamless camera flipping
 */
import { SensorsManager } from './sensors.js';

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

export class ClientWebRTC {
  constructor(socket) {
    this.socket = socket;
    this.peerConnection = null;
    this.candidateQueue = [];
    this.videoSender = null;
  }

  async setup(mediaStream) {
    if (this.peerConnection) {
      try { this.peerConnection.close(); } catch (e) {}
      this.peerConnection = null;
    }

    this.candidateQueue = [];
    this.peerConnection = new RTCPeerConnection(RTC_CONFIG);

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      if (state === 'failed' && SensorsManager.mediaStream) {
        console.warn('WebRTC peer connection failed, attempting reconnection...');
        this.setup(SensorsManager.mediaStream).catch(e => console.error(e));
      }
    };

    this.peerConnection.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.send({
          type: 'webrtc_signal',
          signal: { candidate: e.candidate }
        });
      }
    };

    // Receive incoming audio stream broadcast from Admin
    this.peerConnection.ontrack = (event) => {
      console.log('[WEBRTC CLIENT] Received incoming track:', event.track.kind, event.track.id);
      if (event.track.kind === 'audio') {
        const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
        let audioEl = document.getElementById('incoming-audio');
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.id = 'incoming-audio';
          audioEl.autoplay = true;
          audioEl.playsInline = true;
          audioEl.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0.01;pointer-events:none;';
          document.body.appendChild(audioEl);
        }
        audioEl.srcObject = stream;
        audioEl.muted = false;
        audioEl.volume = 1.0;
        audioEl.play().catch(e => console.warn('[WEBRTC CLIENT] audioEl.play() warning:', e));

        // Connect directly to AudioContext destination for reliable speaker playback
        SensorsManager.routeIncomingAudio(stream);
      }
    };

    // Add audio track if present, and explicitly set direction to 'sendrecv'
    if (mediaStream) {
      const audioTrack = mediaStream.getAudioTracks()[0];
      if (audioTrack) {
        const audioSender = this.peerConnection.addTrack(audioTrack, mediaStream);
        const transceivers = this.peerConnection.getTransceivers();
        const audioTransceiver = transceivers.find(t => t.sender === audioSender || t.receiver?.track?.kind === 'audio');
        if (audioTransceiver) {
          audioTransceiver.direction = 'sendrecv';
        }
      }
    }

    // Always create a video transceiver so SDP has video line pre-negotiated
    try {
      const transceiver = this.peerConnection.addTransceiver('video', { direction: 'sendonly' });
      this.videoSender = transceiver.sender;
      const videoTrack = mediaStream ? mediaStream.getVideoTracks()[0] : null;
      if (videoTrack) {
        await this.videoSender.replaceTrack(videoTrack);
      } else {
        await this.videoSender.replaceTrack(null);
      }
    } catch (e) {
      console.warn('Transceiver creation fallback:', e);
      const videoTrack = mediaStream ? mediaStream.getVideoTracks()[0] : null;
      if (videoTrack) {
        this.videoSender = this.peerConnection.addTrack(videoTrack, mediaStream);
      }
    }

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    this.socket.send({
      type: 'webrtc_signal',
      signal: { sdp: this.peerConnection.localDescription }
    });
  }

  async handleSignal(signal) {
    if (!this.peerConnection) {
      if (SensorsManager.mediaStream) {
        await this.setup(SensorsManager.mediaStream);
      }
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
        const transceivers = this.peerConnection.getTransceivers();
        const audioTransceiver = transceivers.find(t => 
          (t.receiver && t.receiver.track && t.receiver.track.kind === 'audio') ||
          (t.sender && t.sender.track && t.sender.track.kind === 'audio')
        );
        if (audioTransceiver) {
          audioTransceiver.direction = 'sendrecv';
        }

        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        this.socket.send({
          type: 'webrtc_signal',
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

  async enableVideo(videoTrack) {
    if (!this.peerConnection || !videoTrack) return;
    if (this.videoSender) {
      await this.videoSender.replaceTrack(videoTrack);
    } else {
      this.videoSender = this.peerConnection.addTrack(videoTrack, SensorsManager.mediaStream);
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);
      this.socket.send({
        type: 'webrtc_signal',
        signal: { sdp: this.peerConnection.localDescription }
      });
    }
  }

  async disableVideo() {
    if (!this.peerConnection) return;
    if (this.videoSender) {
      await this.videoSender.replaceTrack(null);
    }
  }

  async switchCamera() {
    try {
      const newVideoTrack = await SensorsManager.switchCamera();
      if (newVideoTrack && this.videoSender) {
        await this.videoSender.replaceTrack(newVideoTrack);
      }
      return newVideoTrack;
    } catch (err) {
      console.error('WebRTC Camera flip error:', err);
      throw err;
    }
  }

  close() {
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
      this.videoSender = null;
    }
  }
}
