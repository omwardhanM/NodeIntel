/**
 * ThemeManager - Manages Dark and Light theme persistence
 */
export class ThemeManager {
  static init(toggleBtnId = 'theme-toggle-btn') {
    const savedTheme = localStorage.getItem('nodeintel_theme') || 
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', savedTheme);

    const btn = document.getElementById(toggleBtnId);
    btn?.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('nodeintel_theme', next);
    });
  }

  static getTheme() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }
}
