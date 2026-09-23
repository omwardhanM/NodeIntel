/**
 * AdminLogger - Monospace Audit Log Terminal
 */
export class AdminLogger {
  static container = null;

  static init(containerId = 'admin-logs-container') {
    this.container = document.getElementById(containerId);
  }

  static log(msg, type = 'info') {
    if (!this.container) {
      this.container = document.getElementById('admin-logs-container');
    }

    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    entry.innerHTML = `
      <span class="log-time">[${time}]</span>
      <span class="log-type">[${type.toUpperCase()}]</span>
      <span class="log-msg">${msg}</span>
    `;

    if (this.container) {
      this.container.appendChild(entry);
      this.container.scrollTop = this.container.scrollHeight;
    }
  }

  static clear() {
    if (this.container) {
      this.container.innerHTML = '';
      this.log('Audit log terminal cleared', 'info');
    }
  }
}
