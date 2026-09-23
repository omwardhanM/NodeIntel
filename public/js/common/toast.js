/**
 * Toast Notification System - Monospace Terminal UI
 */
export class Toast {
  static show(msg, type = 'info', containerId = 'toast-container') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let prefix = '[INFO]';
    if (type === 'success') prefix = '[SUCCESS]';
    else if (type === 'error') prefix = '[ERROR]';
    else if (type === 'warn') prefix = '[WARN]';

    toast.innerHTML = `<strong class="toast-prefix">${prefix}</strong> <span>${msg}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-hiding');
      setTimeout(() => toast.remove(), 250);
    }, 3200);
  }
}
