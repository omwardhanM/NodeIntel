# NodeIntel

NodeIntel is a self-hosted, real-time surveillance and telemetry dashboard. It connects remote client devices (phones, tablets, laptops) to a secure admin console, broadcasting live video, audio, GPS location, and system telemetry over a unified WebSocket/WebRTC layer.

## Architecture

*   **Target Node (Client)**: The device capturing sensor data. Delivered as a lightweight web app that runs in any modern browser.
*   **Admin Console (Deck)**: A centralized, secure dashboard used to view the live video feeds, listen to audio, send voice commands, and track targets on a live GPS map.
*   **WebSocket Relay (Server)**: A Node.js backend acting as the signaling and relay server for real-time data and commands.

### External Deployment
NodeIntel is designed to run securely over the internet without complex firewall rules using Tailscale and Cloudflare.
*   **Tailscale Funnel**: Exposes the local Node.js WebSocket relay server to the public internet securely.
*   **Cloudflare Pages**: Hosts the static frontend interface (Client and Admin Deck), which automatically routes its connections to the Tailscale Funnel.

## Security

NodeIntel utilizes **FIDO2 Passkeys** alongside a 4-digit PIN for strong two-factor authentication on the admin panel, with all credentials stored locally.

## Setup Instructions

1.  **Clone and Install:**
    ```bash
    git clone https://github.com/omwardhanM/NodeIntel.git
    cd NodeIntel
    npm install
    ```

2.  **Generate Local SSL Certificates (Required for local sensor access):**
    ```bash
    openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=NodeIntel"
    ```

3.  **Start the Relay Server:**
    ```bash
    npm start
    ```

4.  **Connect:**
    *   **Local Network**: `https://<YOUR_LOCAL_IP>:3000`
    *   **Admin Console**: `https://<YOUR_LOCAL_IP>:3000/admin` (Default PIN: 0192)

## Production Deployment (Cloudflare + Tailscale)

1.  Start a Tailscale funnel on your server: `tailscale funnel --bg 3001`
2.  Deploy the `public/` folder to Cloudflare Pages.
3.  Access your app via the Cloudflare Pages URL (e.g., `https://nodeintel.pages.dev`). The frontend automatically routes WebSockets to your Tailscale Funnel.
