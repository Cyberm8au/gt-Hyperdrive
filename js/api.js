/**
 * GT Companion - Galactic Tycoons API Client
 * All API calls are made directly from the browser to the GT API.
 * The API key is stored only in localStorage and never sent anywhere else.
 */

const GT_API_BASE = 'https://api.g2.galactictycoons.com';

// Cache TTLs in milliseconds
const CACHE_TTL = {
  company:        2 * 60 * 1000,   // 2 min
  bases:          2 * 60 * 1000,   // 2 min
  contracts:      2 * 60 * 1000,   // 2 min
  exchangeOrders: 2 * 60 * 1000,   // 2 min
  matPrices:      5 * 60 * 1000,   // 5 min
  matDetails:     5 * 60 * 1000,   // 5 min
  cashHistory:    5 * 60 * 1000,   // 5 min
  guild:          5 * 60 * 1000,   // 5 min
  wishlists:      2 * 60 * 1000,   // 2 min
};

class GtApi {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.remainingPoints = null;
    this.pointsResetAt = null;
  }

  /** Read API key from localStorage */
  static getStoredKey() {
    return localStorage.getItem('gt_api_key');
  }

  /** Save API key to localStorage */
  static saveKey(key) {
    localStorage.setItem('gt_api_key', key.trim());
  }

  /** Clear API key and all cached data */
  static clearAll() {
    const keys = Object.keys(localStorage).filter(k => k.startsWith('gt_'));
    keys.forEach(k => localStorage.removeItem(k));
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  _cacheKey(endpoint) {
    return `gt_cache_${endpoint.replace(/\//g, '_')}`;
  }

  _getCached(endpoint, ttl) {
    try {
      const raw = localStorage.getItem(this._cacheKey(endpoint));
      if (!raw) return null;
      const { data, timestamp } = JSON.parse(raw);
      if (Date.now() - timestamp < ttl) return data;
    } catch (_) {}
    return null;
  }

  _setCache(endpoint, data) {
    try {
      localStorage.setItem(this._cacheKey(endpoint), JSON.stringify({
        data,
        timestamp: Date.now()
      }));
    } catch (_) {}
  }

  invalidateCache(endpoint) {
    localStorage.removeItem(this._cacheKey(endpoint));
  }

  // ─── Core fetch ───────────────────────────────────────────────────────────

  async _fetch(endpoint, ttl = 0, isPublic = false) {
    if (ttl > 0) {
      const cached = this._getCached(endpoint, ttl);
      if (cached !== null) return cached;
    }

    const url = `${GT_API_BASE}${endpoint}`;
    const headers = {};
    if (this.apiKey && !isPublic) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    } else if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    let response;
    try {
      response = await fetch(url, { headers });
    } catch (err) {
      if (err.name === 'TypeError' && err.message.includes('fetch')) {
        throw new Error('CORS_OR_NETWORK: Cannot reach the Galactic Tycoons API. This may be a network issue or a browser CORS restriction. Try opening the app from a different location, or check your connection.');
      }
      throw err;
    }

    // Track rate limit headers
    const remaining = response.headers.get('X-RateLimit-Remaining');
    const resetAt = response.headers.get('X-RateLimit-Reset');
    if (remaining !== null) this.remainingPoints = parseInt(remaining, 10);
    if (resetAt !== null) this.pointsResetAt = resetAt;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 401) throw new Error('AUTH_INVALID: Your API key is invalid or expired. Please check your key in Settings.');
      if (response.status === 403) throw new Error('AUTH_INSUFFICIENT: This action requires an Extended API key. Please generate one in the game settings.');
      if (response.status === 429) throw new Error('RATE_LIMITED: You have exceeded the API rate limit. Please wait a moment and try again.');
      if (response.status === 404) throw new Error(`NOT_FOUND: ${endpoint} not found.`);
      throw new Error(`API_ERROR ${response.status}: ${text}`);
    }

    const data = await response.json();
    if (ttl > 0) this._setCache(endpoint, data);
    return data;
  }

  // ─── Company endpoints ────────────────────────────────────────────────────

  async getCompany() {
    return this._fetch('/public/company', CACHE_TTL.company);
  }

  async getBases() {
    return this._fetch('/public/company/bases', CACHE_TTL.bases);
  }

  async getBase(baseId) {
    return this._fetch(`/public/company/base/${baseId}`, CACHE_TTL.bases);
  }

  async getWarehouses() {
    return this._fetch('/public/company/warehouses', CACHE_TTL.bases);
  }

  async getWarehouse(warehouseId) {
    return this._fetch(`/public/company/warehouse/${warehouseId}`, CACHE_TTL.bases);
  }

  async getExchangeOrders() {
    return this._fetch('/public/company/exchangeorders', CACHE_TTL.exchangeOrders);
  }

  async getContracts() {
    return this._fetch('/public/company/contracts', CACHE_TTL.contracts);
  }

  async getCashHistory() {
    return this._fetch('/public/company/cash-history', CACHE_TTL.cashHistory);
  }

  // ─── Exchange / Market endpoints ──────────────────────────────────────────

  async getMatPrices() {
    const data = await this._fetch('/public/exchange/mat-prices', CACHE_TTL.matPrices, true);
    // Returns { prices: [...] } — return the array for convenience
    return data.prices || data;
  }

  async getMatPrice(materialId) {
    return this._fetch(`/public/exchange/mat-prices/${materialId}`, CACHE_TTL.matPrices, true);
  }

  async getMatDetails(materialId) {
    return this._fetch(`/public/exchange/mat-details/${materialId}`, CACHE_TTL.matDetails, true);
  }

  // ─── Guild endpoints ──────────────────────────────────────────────────────

  async getGuild() {
    return this._fetch('/public/guild', CACHE_TTL.guild);
  }

  async getGuildById(guildId) {
    return this._fetch(`/public/guild/${guildId}/detail`, CACHE_TTL.guild, true);
  }

  async getGuildDonations() {
    return this._fetch('/public/guild/donations', CACHE_TTL.guild);
  }

  // ─── Wishlist endpoints ───────────────────────────────────────────────────

  async getWishlists() {
    return this._fetch('/public/wishlists', CACHE_TTL.wishlists);
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

  /** Test if the API key is valid by fetching company data */
  async testKey() {
    this.invalidateCache('/public/company');
    return this.getCompany();
  }

  /** Format a credit/cash value as a readable dollar string */
  static formatCredits(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + (Math.round(n * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** Format a raw API price value (API stores prices as integer cents, ÷100 for display) */
  static formatPrice(v) {
    if (v === null || v === undefined) return '—';
    return GtApi.formatCredits(v / 100);
  }

  /** Format a number with commas */
  static formatNum(n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toLocaleString();
  }

  /** Format a UTC date string as a relative time string */
  static timeUntil(isoString) {
    if (!isoString) return '—';
    const diff = new Date(isoString) - Date.now();
    if (diff < 0) return 'Expired';
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (h >= 24) return `${Math.floor(h/24)}d ${h%24}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  /** Format a UTC date string as a short date/time */
  static formatDate(isoString) {
    if (!isoString) return '—';
    return new Date(isoString).toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  /** Get rate limit status object */
  getRateStatus() {
    return {
      remaining: this.remainingPoints,
      resetAt: this.pointsResetAt,
      warning: this.remainingPoints !== null && this.remainingPoints < 100
    };
  }
}

// Export as global (no module system needed for static HTML pages)
window.GtApi = GtApi;
