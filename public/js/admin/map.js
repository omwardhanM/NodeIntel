/**
 * MapTracker - Leaflet GPS Satellite & Telemetry Radar Tracker
 */
import { AdminLogger } from './logger.js';
import { Toast } from '../common/toast.js';

export class MapTracker {
  static map = null;
  static marker = null;
  static circle = null;
  static lastCoords = null;

  static init() {
    const mapEl = document.getElementById('admin-leaflet-map');
    if (!mapEl || typeof L === 'undefined') return;

    // Default global view (Center of Atlantic Ocean, low zoom)
    this.map = L.map('admin-leaflet-map', {
      zoomControl: true,
      attributionControl: false
    }).setView([20, -30], 2);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19
    }).addTo(this.map);

    // High-precision radar pin
    const customIcon = L.divIcon({
      className: 'custom-map-radar-pin',
      html: `
        <div style="position:relative; width:20px; height:20px;">
          <div style="position:absolute; inset:2px; background:#007aff; border-radius:50%; border:2px solid #ffffff;"></div>
          <div style="position:absolute; inset:-4px; border:1px solid #007aff; border-radius:50%;"></div>
        </div>
      `,
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });

    this.marker = L.marker([0, 0], { icon: customIcon, opacity: 0 }).addTo(this.map);
    this.circle = L.circle([0, 0], { radius: 0, color: '#007aff', fillOpacity: 0 }).addTo(this.map);

    document.getElementById('btn-recenter-map')?.addEventListener('click', () => {
      if (this.lastCoords) {
        this.map.flyTo([this.lastCoords.latitude, this.lastCoords.longitude], 16, { duration: 1.2 });
        AdminLogger.log('Map view centered on target GPS pin', 'info');
      } else {
        Toast.show('No GPS fix available yet', 'info', 'admin-toast-container');
      }
    });

    window.addEventListener('resize', () => {
      if (this.map) this.map.invalidateSize();
    });
  }

  static updatePosition(locationData) {
    if (!locationData || locationData.latitude === null || locationData.longitude === null) return;

    this.lastCoords = locationData;
    const { latitude, longitude, accuracy, altitude, heading, speed } = locationData;
    const latLng = [latitude, longitude];

    if (this.map && this.marker && this.circle) {
      this.marker.setLatLng(latLng);
      this.marker.setOpacity(1);
      this.circle.setLatLng(latLng);
      this.circle.setStyle({ fillOpacity: 0.12, opacity: 0.8, color: '#007aff' });
      if (accuracy) this.circle.setRadius(accuracy);

      if (this.map.getZoom() <= 3) {
        this.map.setView(latLng, 15);
      }
    }

    // Telemetry display readout
    const valLat = document.getElementById('admin-val-lat');
    const valLng = document.getElementById('admin-val-lng');
    const valAcc = document.getElementById('admin-val-acc');
    const valAlt = document.getElementById('admin-val-alt');
    const valHead = document.getElementById('admin-val-head');
    const valSpd = document.getElementById('admin-val-spd');

    if (valLat) valLat.textContent = `${latitude.toFixed(6)}°`;
    if (valLng) valLng.textContent = `${longitude.toFixed(6)}°`;
    if (valAcc) valAcc.textContent = accuracy ? `${Math.round(accuracy)} m` : 'N/A';
    if (valAlt) valAlt.textContent = altitude !== null ? `${Math.round(altitude)} m` : 'N/A';
    if (valHead) valHead.textContent = heading !== null ? `${Math.round(heading)}°` : 'N/A';
    if (valSpd) valSpd.textContent = speed !== null ? `${(speed * 3.6).toFixed(1)} km/h` : '0.0 km/h';

    const badgeGps = document.getElementById('badge-remote-gps');
    if (badgeGps) {
      badgeGps.textContent = '[FIXED]';
      badgeGps.className = 'badge badge-active';
    }

    const metricGps = document.getElementById('metric-gps-status');
    if (metricGps) {
      metricGps.textContent = `FIXED (±${Math.round(accuracy || 0)}m)`;
    }

    const mapLink = document.getElementById('admin-btn-maps-link');
    if (mapLink) {
      mapLink.href = `https://www.google.com/maps?q=${latitude},${longitude}`;
      mapLink.style.opacity = '1';
      mapLink.style.pointerEvents = 'auto';
    }
  }
}
