/**
 * GT Companion - Shared Navigation
 * Injected into every page. Sets active link based on current page.
 */
(function () {
  const pages = [
    { href: 'dashboard.html', label: '📊 Dashboard' },
    { href: 'contracts.html', label: '📋 Contracts' },
    { href: 'cost-calc.html', label: '🧮 Cost Calc' },
    { href: 'base-planner.html', label: '🏗 Base Planner' },
    { href: 'market.html',    label: '📈 Market' },
  ];

  const currentPage = window.location.pathname.split('/').pop() || 'index.html';

  const navHtml = `
    <a href="index.html" class="nav-brand">GT Companion</a>
    <nav class="nav-links">
      ${pages.map(p => `
        <a href="${p.href}" class="nav-link ${currentPage === p.href ? 'active' : ''}">${p.label}</a>
      `).join('')}
    </nav>
    <div class="nav-right">
      <span id="nav-rate-limit" class="rate-limit-badge hidden"></span>
      <span id="nav-company" class="nav-company"></span>
      <button class="btn-settings" onclick="document.getElementById('settings-modal').classList.remove('hidden')">⚙ Settings</button>
    </div>
  `;

  const settingsModal = `
    <div id="settings-modal" class="modal-overlay hidden">
      <div class="modal">
        <div class="modal-title">⚙ Settings</div>
        <div class="form-group">
          <label class="form-label">API Key</label>
          <input id="settings-api-key" type="password" class="form-input"
            placeholder="Your Extended API Key"
            value="${GtApi.getStoredKey() || ''}">
          <p style="margin-top:6px;font-size:11px;color:var(--text-muted)">
            Stored locally in your browser only. Never sent to any external server.
          </p>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="document.getElementById('settings-modal').classList.add('hidden')">Cancel</button>
          <button class="btn btn-secondary" onclick="window._clearApiKey()" style="color:var(--red);border-color:rgba(255,68,68,0.3)">Clear Key</button>
          <button class="btn btn-primary" onclick="window._saveSettings()">Save & Reload</button>
        </div>
      </div>
    </div>
  `;

  // Inject nav
  const nav = document.getElementById('gt-nav');
  if (nav) {
    nav.innerHTML = navHtml;
    document.body.insertAdjacentHTML('beforeend', settingsModal);
  }

  // Settings actions
  window._saveSettings = function () {
    const key = document.getElementById('settings-api-key').value.trim();
    if (key) {
      GtApi.saveKey(key);
      window.location.reload();
    }
  };

  window._clearApiKey = function () {
    if (confirm('Clear your API key and all cached data?')) {
      GtApi.clearAll();
      window.location.href = 'index.html';
    }
  };

  // Update company name in nav when available
  window._setNavCompany = function (name) {
    const el = document.getElementById('nav-company');
    if (el) el.textContent = name;
  };

  // Update rate limit indicator
  window._updateRateLimit = function (api) {
    const status = api.getRateStatus();
    const el = document.getElementById('nav-rate-limit');
    if (!el || status.remaining === null) return;
    el.classList.remove('hidden');
    el.textContent = `${status.remaining} pts`;
    el.className = 'rate-limit-badge' + (status.warning ? ' warning' : '');
  };
})();
