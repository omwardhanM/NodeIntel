const fs = require('fs');
const crypto = require('crypto');
const {
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const config = require('./config');

class AuthManager {
  constructor() {
    this.pin = config.DEFAULT_PIN;
    this.credentials = [];
    this.pendingChallenges = new Map(); // challengeId -> { challenge, expectedOrigin, expectedRPID, expiresAt, pinVerified }
    this.activeSessions = new Map(); // token -> { createdAt, expiresAt }
    this.failedAttempts = new Map(); // ip -> { count, lockedUntil }
    this.loadCredentials();
    this.startCleanupTimer();
  }

  loadCredentials() {
    try {
      if (fs.existsSync(config.CREDENTIALS_FILE)) {
        const raw = fs.readFileSync(config.CREDENTIALS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // Legacy format migration
          this.credentials = parsed;
          this.pin = config.DEFAULT_PIN;
        } else if (parsed && typeof parsed === 'object') {
          this.pin = String(parsed.pin || config.DEFAULT_PIN);
          this.credentials = Array.isArray(parsed.passkeys) ? parsed.passkeys : [];
        }
        console.log(`[AUTH] Credentials loaded from ${config.CREDENTIALS_FILE} (PIN configured, ${this.credentials.length} passkey(s))`);
      } else {
        this.pin = config.DEFAULT_PIN;
        this.credentials = [];
        this.saveCredentials();
      }
    } catch (err) {
      console.error('[AUTH] Failed to load credentials file:', err.message);
      this.pin = config.DEFAULT_PIN;
      this.credentials = [];
    }
  }

  saveCredentials() {
    try {
      const data = {
        pin: this.pin,
        passkeys: this.credentials
      };
      fs.writeFileSync(config.CREDENTIALS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[AUTH] Failed to save credentials file:', err.message);
    }
  }

  startCleanupTimer() {
    setInterval(() => {
      const now = Date.now();
      // Clean expired challenges
      for (const [id, record] of this.pendingChallenges.entries()) {
        if (record.expiresAt < now) {
          this.pendingChallenges.delete(id);
        }
      }
      // Clean expired sessions
      for (const [token, session] of this.activeSessions.entries()) {
        if (session.expiresAt < now) {
          this.activeSessions.delete(token);
        }
      }
      // Clean old lockouts
      for (const [ip, attempt] of this.failedAttempts.entries()) {
        if (attempt.lockedUntil && attempt.lockedUntil < now) {
          this.failedAttempts.delete(ip);
        }
      }
    }, 60000);
  }

  checkRateLimit(ip) {
    const record = this.failedAttempts.get(ip);
    if (!record) return { allowed: true };
    const now = Date.now();
    if (record.lockedUntil && record.lockedUntil > now) {
      const waitSeconds = Math.ceil((record.lockedUntil - now) / 1000);
      return { allowed: false, error: `Too many failed attempts. Locked for ${waitSeconds} seconds.` };
    }
    if (record.lockedUntil && record.lockedUntil <= now) {
      this.failedAttempts.delete(ip);
    }
    return { allowed: true };
  }

  recordFailedAttempt(ip) {
    const now = Date.now();
    const record = this.failedAttempts.get(ip) || { count: 0, lockedUntil: null };
    record.count += 1;
    if (record.count >= 5) {
      record.lockedUntil = now + 5 * 60 * 1000; // 5 minute lockout
      console.warn(`[!] Auth rate limit triggered for IP [${ip}]. Locked for 5m.`);
    }
    this.failedAttempts.set(ip, record);
  }

  recordSuccess(ip) {
    this.failedAttempts.delete(ip);
  }

  verifyPin(pin) {
    if (typeof pin !== 'string') return false;
    const expected = String(this.pin);
    if (pin.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(expected));
    } catch (e) {
      return false;
    }
  }



  createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.activeSessions.set(token, {
      createdAt: now,
      expiresAt: now + config.SESSION_TTL_MS
    });
    return token;
  }

  verifySessionToken(token) {
    if (!token || typeof token !== 'string') return false;
    const session = this.activeSessions.get(token);
    if (!session) return false;
    if (session.expiresAt < Date.now()) {
      this.activeSessions.delete(token);
      return false;
    }
    return true;
  }

  // --- Authentication Options (Logins) ---
  async getAuthenticationOptions(hostname, origin) {
    if (this.credentials.length === 0) {
      throw new Error('NO_PASSKEYS_REGISTERED');
    }

    const cleanHostname = (hostname || 'localhost').split(':')[0];
    const cleanOrigin = origin || `https://${cleanHostname}`;

    const allowCredentials = this.credentials.map(c => ({
      id: c.id,
      transports: c.transports || []
    }));

    const options = await generateAuthenticationOptions({
      rpID: cleanHostname,
      allowCredentials,
      userVerification: 'preferred'
    });

    const challengeId = crypto.randomBytes(16).toString('hex');
    this.pendingChallenges.set(challengeId, {
      challenge: options.challenge,
      expectedOrigin: cleanOrigin,
      expectedRPID: cleanHostname,
      expiresAt: Date.now() + 5 * 60 * 1000,
      pinVerified: false
    });

    return { options, challengeId };
  }

  // --- Verify Authentication Response ---
  async verifyAuthentication(response, challengeId, pin) {
    if (!this.verifyPin(pin)) {
      throw new Error('Invalid PIN');
    }

    const pending = this.pendingChallenges.get(challengeId);
    if (!pending) {
      throw new Error('Authentication challenge expired or invalid');
    }
    this.pendingChallenges.delete(challengeId);

    const cred = this.credentials.find(c => c.id === response.id);
    if (!cred) {
      throw new Error('Unknown passkey. Not enrolled on this server.');
    }

    const dbCredential = {
      id: cred.id,
      publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
      counter: cred.counter,
      transports: cred.transports || []
    };

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.expectedOrigin,
      expectedRPID: pending.expectedRPID,
      credential: dbCredential,
      requireUserVerification: false
    });

    if (!verification.verified) {
      throw new Error('Passkey signature validation failed');
    }

    // Update counter
    cred.counter = verification.authenticationInfo.newCounter;
    this.saveCredentials();

    console.log(`[AUTH] Admin authenticated successfully with passkey [${cred.name || cred.id.substring(0, 10)}]`);
    const token = this.createSession();
    return { verified: true, token };
  }
}

const authManager = new AuthManager();
module.exports = { authManager };
