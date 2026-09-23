# NodeIntel // Project Context & Architecture Guide

NodeIntel is a lightweight, high-performance real-time surveillance and remote telemetry system. It turns any mobile browser or camera-equipped computer into a remote monitoring node that streams live WebRTC video, microphone audio, GPS coordinates, battery status, and sensor data to a centralized command console.

---

## 1. System Overview

```
+-----------------------------------------------------------------------------------+
|                                TARGET DEVICE                                      |
|  (Mobile Phone / Laptop / Tablet via Browser - Front or Rear Camera)              |
|                                                                                   |
|  - WebRTC MediaStream (Camera & Mic Upstream)                                     |
|  - Web Audio Analyser (Real-Time VU Volume Meter)                                 |
|  - Geolocation API (High-Accuracy GPS Watcher)                                    |
|  - Offscreen Canvas Still Capture                                                 |
|  - Audio Synthesizer (Remote Alarm Siren)                                         |
|  - Intercom Audio Player (Receives Admin Voice Broadcast)                         |
+-----------------------------------+-----------------------------------------------+
                                    |
                     WebSockets (WSS) + WebRTC P2P
                                    |
+-----------------------------------v-----------------------------------------------+
|                        NODEINTEL SERVER (Node.js)                                  |
|                                                                                   |
|  +------------------------------+     +----------------------------------------+  |
|  |   PORT 3000 (HTTPS Primary)  |     |      PORT 3001 (HTTP Secondary)        |  |
|  |   Self-Signed SSL (LAN)      |     |      Cloudflare Tunnel Origin          |  |
|  +--------------+---------------+     +-------------------+--------------------+  |
|                 |                                         |                       |
|                 +--------------------+--------------------+                       |
|                                      |                                            |
|                                      v                                            |
|                       UNIFIED WEBSOCKET RELAY (ws)                                |
|                       - Multi-Device Session Registry                             |
|                       - WebRTC SDP & ICE Signal Broker                            |
|                       - Remote Admin Command Dispatcher                           |
|                       - Cloudflare IP & Country Metadata Extractor                |
|                       - 30s Ping/Pong & 25s Heartbeat Watchdog                    |
+--------------------------------------+--------------------------------------------+
                                       |
                        WebSockets (WSS) + WebRTC P2P
                                       |
+--------------------------------------v--------------------------------------------+
|                          ADMIN COMMAND DECK                                       |
|  (Desktop / Mobile Browser - Secured with 4-Digit Numeric PIN)                    |
|                                                                                   |
|  - Multi-Device Selector & Live Metrics Bar                                       |
|  - Full-Width Responsive Command Dashboard Layout                                 |
|  - Real-Time Video Viewport with HUD Overlay                                      |
|  - Speaker Audio Monitoring (Mute / Listen In)                                    |
|  - Intercom Voice Broadcast (Live Admin Mic Transmission to Node)                 |
|  - Leaflet GPS Radar Map with Precision Pin & Radius                              |
|  - Device Controls: Flip Camera, Play Alarm, Force GPS, Capture Photo             |
|  - Captured Photo Gallery with High-Resolution Download                           |
|  - Live Diagnostic Activity Log Terminal                                          |
+-----------------------------------------------------------------------------------+
```

---

## 2. Directory & File Breakdown

```
/home/om/Projects/Survelience/
├── cert.pem                         # Generated self-signed SSL certificate for LAN
├── key.pem                          # Generated private key for LAN SSL
├── package.json                     # Project scripts and dependencies (express, ws)
├── server.js                        # Main HTTP/HTTPS server and application entrypoint
├── project_context.md               # This architectural reference document
│
├── src/
│   ├── config.js                    # Environment constants, ports, cert paths, and PIN
│   ├── ssl.js                       # Automatic self-signed SSL generator (OpenSSL)
│   ├── socketRelay.js               # Unified WebSocket server, device registry & router
│   └── utils/
│       └── network.js               # Network interface enumerator & terminal banner
│
└── public/
    ├── index.html                   # Target device client interface
    ├── admin.html                   # Admin surveillance command console
    │
    ├── css/
    │   ├── theme.css                # OpenCode monospaced design tokens (Light/Dark)
    │   ├── common.css               # Shared utilities, buttons, badges, and modals
    │   ├── client.css               # Minimal target node viewport styles
    │   └── admin.css                # Command deck grid, video HUD, VU meter, and map
    │
    └── js/
        ├── common/
        │   ├── socket.js            # Auto-reconnecting WebSocket helper with keep-alive
        │   ├── theme.js             # LocalStorage-backed Dark/Light mode manager
        │   └── toast.js             # Toast notification queue
        │
        ├── client/
        │   ├── client.js            # Target node orchestration & command execution
        │   ├── sensors.js           # MediaStream, audio VU meter, GPS, and alarm siren
        │   └── webrtc.js            # PeerConnection, Cloudflare STUN, ICE queue, camera flip
        │
        └── admin/
            ├── admin.js             # Admin application entrypoint & state wiring
            ├── pinAuth.js           # Numeric keypad & keyboard PIN lock controller
            ├── deck.js              # Multi-device selector, controls, telemetry, gallery
            ├── webrtc.js            # Video/audio stream receiver, speaker toggle, re-offer
            ├── map.js               # Leaflet GPS radar map, accuracy circle, recentering
            └── logger.js            # In-browser diagnostic activity terminal
```

---

## 3. Server Architecture & Dual-Port Strategy

The backend runs an Express application paired with Node's native `http` and `https` modules:

### Dual-Port Configuration
* **Port 3000 (HTTPS Primary)**:
  Uses self-signed SSL certificates (`cert.pem`, `key.pem`) generated automatically by `src/ssl.js`. This creates a browser **Secure Context** (`https://`) required by mobile browsers to access `navigator.mediaDevices.getUserMedia` and `navigator.geolocation` over a Local Area Network (LAN).
* **Port 3001 (HTTP Secondary)**:
  Runs plain HTTP directly on the same Express app and WebSocket handler. This port is specifically dedicated as the **Cloudflare Tunnel origin**. Cloudflare Tunnel terminates SSL at its edge with a publicly trusted SSL certificate. By routing `cloudflared` to port `3001`, there are zero origin TLS handshake warnings.

### Unified WebSocket Relay (`noServer: true`)
Rather than creating separate WebSocket instances per port, `src/socketRelay.js` utilizes `WebSocketServer({ noServer: true })`. Both the HTTPS server (port 3000) and HTTP server (port 3001) pass incoming HTTP upgrade requests to the exact same relay instance:

```javascript
// server.js
httpsServer.on('upgrade', (req, socket, head) => wss.handleUpgrade(...));
httpServer.on('upgrade', (req, socket, head) => wss.handleUpgrade(...));
```

This prevents split-brain silos: an admin viewing the console over Cloudflare Tunnel (port 3001) can monitor and control target phones connecting via LAN Wi-Fi (port 3000) or vice versa.

### Reverse Proxy & Cloudflare Trust
`app.set('trust proxy', true)` is configured in Express. During WebSocket upgrades, `src/socketRelay.js` parses proxy headers (`cf-connecting-ip`, `cf-ipcountry`, `x-forwarded-for`) to resolve the client's actual public IP and geolocation country code, broadcasting it to the admin console.

### Tailscale Funnel & Cloudflare Pages Hybrid Architecture
* **Tailscale Funnel (`https://nodeintel.tail4bd1d1.ts.net`)**:
  Exposes the backend Express server and WebSocket relay (port 3001) to the public internet with zero warning screens and valid Let's Encrypt certificates.
* **Cloudflare Pages (`https://<project>.pages.dev`)**:
  Serves the static frontend (`public/`).
* **Cross-Origin Auto-Relay**:
  When client JS runs on `*.pages.dev`, `public/js/common/socket.js` automatically routes WebSockets to `wss://nodeintel.tail4bd1d1.ts.net`, seamlessly linking the Cloudflare Pages UI to the local monitoring node.
* **CORS Middleware**:
  Express is configured with permissive CORS headers to allow cross-origin requests from any Cloudflare Pages deployment.

---

## 4. WebSocket Signaling & Message Protocol

All real-time communication between the Target Node, Relay Server, and Admin Console is conducted via JSON messages over WebSockets.

### Message Flow Overview

| Message Type | Sender | Recipient | Payload Description |
| :--- | :--- | :--- | :--- |
| `register` | Client / Admin | Relay Server | Registers socket role (`'client'` or `'admin'`). For admins, requires verified `token`. |
| `admin_auth` | Admin | Relay Server | In-socket session upgrade supplying server-issued cryptographically verified `token`. |
| `auth_required` | Relay Server | Admin | Emitted when unauthenticated socket attempts to access admin role without valid token. |
| `auth_success` | Relay Server | Admin | Emitted when socket session token is validated, elevating socket to admin. |
| `assigned_id` | Relay Server | Client | Confirms assigned client ID (e.g., `node_7x9a2`). Saved in `localStorage`. |
| `device_list` | Relay Server | Admin | Array of all currently connected target devices with their latest telemetry. |
| `initial_state` | Relay Server | Admin | Sent immediately to an authenticated admin on connection with active device inventory. |
| `telemetry_update` | Client | Relay -> Admin | Periodic or event-driven updates (camera, battery, audio level, GPS coords). |
| `admin_command` | Admin | Relay -> Client | Remote instructions targeted to a specific device ID or `'all'`. |
| `webrtc_signal` | Client / Admin | Relay -> Peer | Relays SDP offers, SDP answers, and ICE candidate objects. |
| `snapshot_data` | Client | Relay -> Admin | Transmits high-resolution Base64 PNG image captured from target video feed. |
| `heartbeat` | Client / Admin | Relay Server | Keepalive ping sent every 25s to prevent Cloudflare / proxy timeout. |
| `heartbeat_ack` | Relay Server | Client / Admin | Server keepalive acknowledgment with server timestamp. |

### Supported Admin Commands (`admin_command`)

1. **`switch_camera`**:
   Instructs the target device to flip between front (`'user'`) and rear (`'environment'`) camera. The target stops the active video track, requests a new stream via `getUserMedia`, replaces the WebRTC sender track via `RTCRtpSender.replaceTrack()`, and updates the admin telemetry.
2. **`request_offer`**:
   Instructs the target device to create a fresh WebRTC SDP offer and transmit it to the admin.
3. **`trigger_alarm`**:
   Activates the target device's Web Audio API oscillator, sounding an audible alternating alert siren through the device speaker.
4. **`refresh_gps`**:
   Forces the target device to re-poll `navigator.geolocation.getCurrentPosition` with `enableHighAccuracy: true`.
5. **`take_snapshot`**:
   Triggers an offscreen HTML5 `<canvas>` capture of the target's current video frame and sends it back to the admin as a base64 PNG data URL.
6. **`intercom_state`**:
   Notifies the target device that an admin microphone voice broadcast is active or stopped (`payload: { active: true / false }`). Displays a glowing `[RECEIVING VOICE...]` HUD row on the target node and unmutes the incoming audio element.
7. **`set_camera`**:
   Remotely toggles the target device's camera hardware on or off (`payload: { enabled: true / false }`). When turned off, the video track is stopped to release the hardware sensor and LED, and `RTCRtpSender.replaceTrack(null)` halts frame transmission. When turned on, `getUserMedia` acquires the camera and transmits frames instantly.

---

## 5. WebRTC Media Architecture

NodeIntel supports bidirectional real-time peer-to-peer media streaming over WebRTC:

```
[Target Device]                                           [Admin Console]
      |                                                          |
      |--------- 1. Creates Offer (with Camera & Mic Tracks) --->| (via Relay)
      |<-------- 2. Returns Answer (SDP) ------------------------| (via Relay)
      |                                                          |
      |<=======> 3. Exchanges ICE Candidates (Cloudflare/Google) <=======>|
      |                                                          |
      |================= 4. Upstream Video & Mic Feed ===========>|
      |                                                          |
      |<================ 5. Downstream Intercom Mic Feed =========| (Admin Broadcast)
```

### STUN Servers
Both client and admin use a multi-STUN configuration featuring Cloudflare's Anycast STUN network and Google's public STUN servers:
* `stun:stun.cloudflare.com:3478`
* `stun:stun.l.google.com:19302`
* `stun:stun1.l.google.com:19302`
* `stun:stun2.l.google.com:19302`

### ICE Candidate Buffering
To prevent race conditions across WAN and mobile networks where ICE candidates arrive before `setRemoteDescription()` completes, both endpoints maintain a `candidateQueue`. Candidates received prior to SDP resolution are held and flushed immediately once the remote description is applied.

### Auto-Reconnection & Track Replacement
* **Camera Flipping**: Accomplished dynamically using `RTCRtpSender.replaceTrack()` without terminating the peer connection.
* **Connection Recovery**: `RTCPeerConnection.onconnectionstatechange` watches for `'failed'` states and automatically re-initiates negotiation.
* **Bidirectional Audio Stream**:
  * Upstream: Target node captures microphone audio and sends it to the admin console.
  * Downstream: Admin console acquires microphone via `navigator.mediaDevices.getUserMedia`, adds the track to `RTCPeerConnection`, and initiates renegotiation or track unmute.
  * Target node handles `peerConnection.ontrack` for incoming audio and plays it through an `<audio id="incoming-audio" autoplay playsinline>` element.

---

## 6. Two-Way Audio, VU Meter & Intercom Voice Broadcast

NodeIntel features full-duplex, two-way audio between the Admin Command Deck and target devices:

### 1. Target Node Upstream Mic & Audio VU Meter
* The target node captures ambient sound using the Web Audio API:
  1. `AudioContext.createMediaStreamSource(mediaStream)` captures input.
  2. An `AnalyserNode` with `fftSize = 64` calculates real-time frequency data.
  3. An animation frame loop averages frequency buckets to derive a `0-100%` volume level.
  4. Throttled volume readings are dispatched to the admin console for the live segmented VU meter.
* **Admin Listening**: The audio stream is received via WebRTC. A **`[LISTEN (SPEAKER)]`** button toggles `audioEl.muted`, giving the operator full control to listen in or mute output to prevent acoustic feedback.

### 2. Admin Intercom Voice Broadcast (To Node)
* Operators can talk directly to the target device via the **`[BROADCAST (MIC)]`** button.
* **Full-Duplex WebRTC Audio Negotiation**:
  * Both Node and Admin negotiate the audio transceiver with `direction: 'sendrecv'` during initial SDP offer/answer exchanges. This keeps the reverse RTP audio path open and ready for immediate transmission without connection renegotiation delay.
  * When broadcast is activated, Admin attaches the microphone track to the audio transceiver sender. If the connection was not previously negotiated as bidirectional, Admin automatically triggers a renegotiation offer.
* **Guaranteed Speaker Output on Node (Dual-Playback Pipeline)**:
  * To bypass mobile browser autoplay restrictions (e.g., iOS Safari / Android Chrome blocking background media), the target node pre-activates its audio context and HTMLAudioElement during the initial user gesture tap on `[ CONNECT DEVICE ]`.
  * The incoming audio player is positioned offscreen rather than hidden via `display: none` (which can cause WebKit to suspend media decoding).
  * The incoming WebRTC audio stream is simultaneously fed to:
    1. An offscreen `<audio id="incoming-audio">` element with `autoplay` and `playsinline`.
    2. The active `AudioContext.destination` via `MediaStreamAudioSourceNode` for hardware-level speaker playback.
  * When toggled on, an `intercom_state: true` signal ensures unmuting, resumes the audio context, and triggers the animated `[RECEIVING VOICE...]` HUD row.
* **Zero-Latency Silence**:
  * Toggling broadcast off sets `micTrack.enabled = false` and signals `intercom_state: false`, instantly silencing transmission without closing the WebRTC peer connection.

### 3. Admin Microphone Sound Level VU Meter
* Directly below the **TARGET SOUND LEVEL** VU bar, the LIVE AUDIO panel includes an **ADMIN MIC LEVEL** meter.
* An `AnalyserNode` connected to the admin's `localMicStream` samples microphone input volume in real time (`requestAnimationFrame`) using byte frequency analysis.
* Renders an electric blue VU progress bar (`var(--color-accent)`) and live percentage readout (`0%` to `100%`) when broadcasting.
* Immediately stops animation and zeroes out when broadcast is turned off or idle, minimizing CPU/battery overhead.

---

## 7. GPS Radar Tracking & Mapping

The Admin Console embeds a Leaflet radar map utilizing OpenStreetMap tiles:
* **Target Node**: Continuously monitors `navigator.geolocation.watchPosition` with `enableHighAccuracy: true`, streaming latitude, longitude, accuracy (meters), altitude, heading, and speed.
* **Admin Radar**:
  * Renders a custom glowing blue radar coordinate pin.
  * Plots a dynamic semi-transparent accuracy radius circle that scales with GPS precision.
  * Displays latitude, longitude, and accuracy in meters.
  * Features a **`[RECENTER]`** button to animate the map view back to the target coordinates.

---

## 8. Security & Admin Authentication

* **Numeric PIN Gate**: The Admin Console is protected by a 4-digit PIN lock screen (`src/public/js/admin/pinAuth.js`). Default PIN is `1234` (configurable via `ADMIN_PIN` environment variable).
* **Keypad & Keyboard Support**: Users can enter the PIN using either the onscreen monospaced number pad or physical keyboard number keys.
* **Session Persistence**: Successful authentication stores an authorization flag in `sessionStorage`. Operators can lock the session at any time with the `[LOCK]` button.
* **Secure Context Protection**: The client automatically checks `window.isSecureContext`. If a device accesses the app over insecure HTTP on a remote network, it displays a banner guiding the user to the HTTPS URL.

---

## 9. Design System & Aesthetics

The application adheres to the **OpenCode monospaced design system**:
* **Typography**: Strict 100% monospaced typography (`Berkeley Mono`, `JetBrains Mono`, `Fira Code`, `Consolas`).
* **Palette**:
  * **Dark Mode (Default)**: `#0d0f12` background, `#f0f2f5` text, `#1c2128` card surfaces, `#2d333b` borders.
  * **Light Mode**: `#fdfcfc` canvas, `#201d1d` ink, `#f4f4f4` surfaces, `#e5e5e5` borders.
* **Status Badges & Markers**: Bracketed ASCII indicators replace decorative icons: `[+]`, `[-]`, `[LIVE]`, `[OFFLINE]`, `[ONLINE]`, `[LOCK]`, `[THEME]`.
* **Video HUD**: Surveillance-style scanline overlay with target device ID, live timestamp, resolution badge, and audio status indicators.
* **Theme Switching**: Instant toggle persisted via `localStorage` with smooth CSS token transitions.

---

## 10. How to Run & Operate

### Prerequisites
* Node.js v18+ installed.
* Optional for remote access: `cloudflared` CLI installed (`/usr/local/bin/cloudflared`).

### 1. Local Network (LAN) Operation
1. Start the server:
   ```bash
   npm start
   ```
2. The terminal displays local LAN URLs:
   ```
   ====================================================
   [*] NodeIntel Surveillance Telemetry Server
   - Local Target URL:   https://localhost:3000
   - Local Admin URL:    https://localhost:3000/admin
   ----------------------------------------------------
   Local Area Network (LAN):
     Target Node:  https://192.168.x.x:3000
     Admin Deck:   https://192.168.x.x:3000/admin
   ====================================================
   ```
3. Open `https://192.168.x.x:3000` on the target mobile phone. Accept the self-signed certificate warning once.
4. Open `https://192.168.x.x:3000/admin` on your computer. Enter PIN `1234`.

### 2. Remote Internet Operation via Cloudflare Tunnel
Cloudflare Tunnel exposes the local server to the internet with a trusted public SSL certificate, avoiding self-signed certificate warnings and enabling camera/mic permissions seamlessly on any mobile network (4G/5G).

1. In Terminal 1, start the server:
   ```bash
   npm start
   ```
2. In Terminal 2, launch the tunnel pointing to **HTTP port 3001**:
   ```bash
   npm run tunnel
   # Alternatively: cloudflared tunnel --url http://localhost:3001
   ```
3. Copy the generated URL (e.g., `https://xxxx.trycloudflare.com`):
   * **Target Phone Link**: `https://xxxx.trycloudflare.com/`
   * **Admin Deck Link**: `https://xxxx.trycloudflare.com/admin`
4. The admin console will display the remote phone's public IP address and country code (e.g. `172.56.x.x [US]`).

---

## 11. Diagnostic & Health Endpoints

* **`GET /api/health`**:
  Returns operational status, timestamp, detected client IP (from reverse proxy headers), protocol (`http`/`https`), and SSL security context.
  ```json
  {
    "status": "ok",
    "timestamp": 1790176554330,
    "remoteIp": "203.0.113.195",
    "protocol": "https",
    "secure": true
  }
  ```

---

## 12. Two-Factor PIN + Passkey Security (FIDO2 / WebAuthn)

NodeIntel employs hardware-grade two-factor authentication validated directly on the local Node.js server:

### Authentication Mechanics
1. **Factor 1: Numeric PIN**:
   * 4-digit PIN (Default: `0192`) validated server-side using constant-time comparison (`crypto.timingSafeEqual`).
2. **Factor 2: FIDO2 / WebAuthn Passkey**:
   * Uses `@simplewebauthn/server` and `@simplewebauthn/browser`.
   * Integrates seamlessly with browser passkeys, hardware security keys, and device authenticators (Touch ID, Face ID, Windows Hello).
   * Dynamic Relying Party ID (`rpID`) negotiation allows passkey authentication whether accessing from Cloudflare Pages (`*.pages.dev`), Tailscale Funnel (`*.ts.net`), or local LAN (`localhost`).
   * Credentials (PIN and enrolled passkeys) are stored securely in a dedicated **`credentials.json`** file in the project root.

### WebSocket Authorization Gating
* Unauthenticated connections can never receive device telemetry, GPS coordinates, or WebRTC camera/audio streams.
* The WebSocket server rejects unauthenticated admin registrations with `auth_required`.
* Upon completing PIN + Passkey verification, the server issues a cryptographically secure random session token (`crypto.randomBytes(32)`), elevating the socket session to `admin`.
* The admin console includes a `[+PASSKEY]` button in the top navigation bar to enroll additional passkeys across multiple devices.

