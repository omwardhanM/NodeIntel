/**
 * PinAuth - Two-Factor PIN + Passkey Authentication
 * Validated against credentials.json on the local server
 */
import { Toast } from '../common/toast.js';
import {
  startAuthentication,
  browserSupportsWebAuthn
} from '../common/simplewebauthn-browser.js';
import { CONFIG } from '../common/config.js';

function getApiBaseUrl() {
  const isPagesHost = window.location.hostname.endsWith('pages.dev') ||
                      window.location.hostname.endsWith('cloudflarepages.com');
  if (isPagesHost) {
    const stored = localStorage.getItem('nodeintel_relay_host');
    return `https://${stored || CONFIG.TAILSCALE_RELAY_HOST}`;
  }
  return window.location.origin;
}

export class PinAuth {
  constructor(onUnlock = null) {
    this.onUnlock = onUnlock;
    this.enteredPin = '';
    this.maxDigits = 4;
    this.isAuthenticating = false;
  }

  async init() {
    this.setupListeners();

    // Check for existing valid session
    const existingToken = sessionStorage.getItem('nodeintel_admin_token');
    if (existingToken) {
      const isValid = await this.verifyExistingSession(existingToken);
      if (isValid) {
        this.unlock(existingToken);
        return;
      } else {
        sessionStorage.removeItem('nodeintel_admin_token');
      }
    }

    this.lock();
  }

  setupListeners() {
    // Keypad number buttons
    document.querySelectorAll('.key-btn[data-key]').forEach(btn => {
      btn.addEventListener('click', () => {
        const digit = btn.getAttribute('data-key');
        this.addDigit(digit);
      });
    });

    // Keypad actions
    document.getElementById('key-clear')?.addEventListener('click', () => this.clearPin());
    document.getElementById('key-backspace')?.addEventListener('click', () => this.backspace());

    // Physical Keyboard Listener
    window.addEventListener('keydown', (e) => {
      const modal = document.getElementById('pin-lock-modal');
      const pinStep = document.getElementById('auth-step-pin');
      if (modal && modal.style.display !== 'none' && pinStep && pinStep.style.display !== 'none') {
        if (/^[0-9]$/.test(e.key)) {
          this.addDigit(e.key);
        } else if (e.key === 'Backspace') {
          this.backspace();
        } else if (e.key === 'Escape') {
          this.clearPin();
        }
      }
    });

    // Passkey trigger button
    document.getElementById('btn-trigger-passkey')?.addEventListener('click', () => {
      this.triggerPasskey();
    });

    // Back to PIN button
    document.getElementById('btn-back-to-pin')?.addEventListener('click', () => {
      this.goToPinStep();
    });

    // Dashboard Logout / Lock Button
    document.getElementById('btn-lock-admin')?.addEventListener('click', () => {
      this.lock();
      Toast.show('Admin session locked', 'info', 'admin-toast-container');
    });
  }

  async verifyExistingSession(token) {
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/admin/auth/session`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      return !!data.valid;
    } catch (e) {
      return false;
    }
  }

  addDigit(digit) {
    if (this.enteredPin.length < this.maxDigits) {
      this.enteredPin += digit;
      this.updateDots();
      const errEl = document.getElementById('pin-error-text');
      if (errEl) errEl.textContent = '';

      if (this.enteredPin.length === this.maxDigits) {
        setTimeout(() => this.goToPasskeyStep(), 150);
      }
    }
  }

  backspace() {
    if (this.enteredPin.length > 0) {
      this.enteredPin = this.enteredPin.slice(0, -1);
      this.updateDots();
      const errEl = document.getElementById('pin-error-text');
      if (errEl) errEl.textContent = '';
    }
  }

  clearPin() {
    this.enteredPin = '';
    this.updateDots();
    const errEl = document.getElementById('pin-error-text');
    if (errEl) errEl.textContent = '';
  }

  updateDots() {
    for (let i = 0; i < this.maxDigits; i++) {
      const dot = document.getElementById(`dot-${i}`);
      if (dot) {
        if (i < this.enteredPin.length) {
          dot.classList.add('filled');
          dot.textContent = '*';
        } else {
          dot.classList.remove('filled');
          dot.textContent = '_';
        }
      }
    }
  }

  goToPinStep() {
    const stepPin = document.getElementById('auth-step-pin');
    const stepPasskey = document.getElementById('auth-step-passkey');
    const errPasskey = document.getElementById('passkey-error-text');

    if (stepPin) stepPin.style.display = 'flex';
    if (stepPasskey) stepPasskey.style.display = 'none';
    if (errPasskey) errPasskey.textContent = '';
    this.clearPin();
  }

  goToPasskeyStep() {
    const stepPin = document.getElementById('auth-step-pin');
    const stepPasskey = document.getElementById('auth-step-passkey');
    const errPasskey = document.getElementById('passkey-error-text');

    if (stepPin) stepPin.style.display = 'none';
    if (stepPasskey) stepPasskey.style.display = 'flex';
    if (errPasskey) errPasskey.textContent = '';

    // Automatically trigger passkey prompt after step transition
    setTimeout(() => {
      this.triggerPasskey();
    }, 250);
  }

  async triggerPasskey() {
    if (this.isAuthenticating) return;
    this.isAuthenticating = true;

    const btnText = document.getElementById('passkey-btn-text');
    const errEl = document.getElementById('passkey-error-text');
    if (errEl) errEl.textContent = '';
    if (btnText) btnText.textContent = 'CHECKING PASSKEY...';

    try {
      if (!browserSupportsWebAuthn()) {
        throw new Error('WebAuthn / Passkeys not supported by this browser');
      }

      const hostname = window.location.hostname;
      const origin = window.location.origin;

      if (btnText) btnText.textContent = 'FETCHING CHALLENGE...';
      const optRes = await fetch(`${getApiBaseUrl()}/api/admin/auth/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostname,
          origin
        })
      });

      const optData = await optRes.json();
      if (!optRes.ok) {
        throw new Error(optData.error || 'Failed to initialize passkey authentication');
      }

      if (btnText) btnText.textContent = 'CONFIRM PASSKEY...';
      const authResponse = await startAuthentication({ optionsJSON: optData.options });

      if (btnText) btnText.textContent = 'VERIFYING WITH SERVER...';
      const verifyRes = await fetch(`${getApiBaseUrl()}/api/admin/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response: authResponse,
          challengeId: optData.challengeId,
          pin: this.enteredPin
        })
      });

      const verifyData = await verifyRes.json();
      if (!verifyRes.ok || !verifyData.verified) {
        throw new Error(verifyData.error || 'Invalid PIN or passkey');
      }

      sessionStorage.setItem('nodeintel_admin_token', verifyData.token);
      Toast.show('Passkey verified. Welcome back!', 'success', 'admin-toast-container');
      this.unlock(verifyData.token);
    } catch (err) {
      console.warn('[AUTH] Passkey verification failed:', err);
      const isPinError = err.message.toLowerCase().includes('pin');
      
      if (errEl) {
        errEl.textContent = `[!] ${err.message || 'Authentication cancelled'}`;
      }

      if (isPinError) {
        this.shakeCard();
        setTimeout(() => this.goToPinStep(), 1200);
      }
    } finally {
      this.isAuthenticating = false;
      if (btnText) btnText.textContent = 'USE PASSKEY';
    }
  }

  shakeCard() {
    const card = document.getElementById('pin-card-box');
    if (card) {
      card.classList.add('pin-shake');
      setTimeout(() => card.classList.remove('pin-shake'), 400);
    }
  }

  lock() {
    sessionStorage.removeItem('nodeintel_admin_token');
    this.goToPinStep();
    const modal = document.getElementById('pin-lock-modal');
    const mainView = document.getElementById('admin-main-view');
    if (modal) modal.style.display = 'flex';
    if (mainView) mainView.style.display = 'none';
  }

  unlock(token) {
    const modal = document.getElementById('pin-lock-modal');
    const mainView = document.getElementById('admin-main-view');
    if (modal) modal.style.display = 'none';
    if (mainView) mainView.style.display = 'flex';
    if (this.onUnlock) this.onUnlock(token);
  }
}
