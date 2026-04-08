/**
 * GT Companion — Dashboard Logic
 */
(function () {
  const api = new GtApi(GtApi.getStoredKey());

  if (!GtApi.getStoredKey()) {
    window.location.href = 'index.html';
    return;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function fuelColor(pct) {
    if (pct < 20) return 'red';
    if (pct < 50) return 'yellow';
    return 'green';
  }

  function condColor(cond) {
    const pct = cond * 100;
    if (pct < 60) return 'var(--red)';
    if (pct < 85) return 'var(--yellow)';
    return 'var(--green)';
  }

  function satColor(sat) {
    if (sat >= 1)    return 'full';
    if (sat >= 0.8)  return 'medium';
    return 'low';
  }

  function warehousePct(wh) {
    if (!wh || !wh.cap || wh.cap === 0) return 0;
    const used = (wh.mats || []).reduce((s, m) => s + (m.qty || m.q || 0), 0);
    return Math.min(100, Math.round((used / wh.cap) * 100));
  }

  function progressColor(pct) {
    if (pct >= 90) return 'red';
    if (pct >= 70) return 'yellow';
    return 'green';
  }

  // ─── Render company stats ──────────────────────────────────────────────────

  function renderCompanyStats(company) {
    document.getElementById('stat-cash').textContent  = GtApi.formatCredits(company.cash);
    document.getElementById('stat-rank').textContent  = `#${company.rank}`;
    document.getElementById('stat-pr').textContent    = `${GtApi.formatNum(company.pr)} PR`;
    document.getElementById('stat-stars').textContent = GtApi.formatNum(company.stars);
    document.getElementById('stat-bases').textContent = (company.bases || []).length;
    document.getElementById('stat-ships').textContent = (company.ships || []).length;
    document.getElementById('stat-guild').textContent =
      company.gId ? `Guild #${company.gId} (Rank ${company.gRank})` : 'No Guild';

    window._setNavCompany(company.name);
  }

  // ─── Render fleet ──────────────────────────────────────────────────────────

  function renderFleet(ships) {
    document.getElementById('fleet-count').textContent = `${ships.length} ships`;
    const tbody = document.getElementById('fleet-tbody');

    if (!ships.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-muted text-center" style="padding:20px">No ships found.</td></tr>`;
      return;
    }

    tbody.innerHTML = ships.map(ship => {
      const bp = ship.blueprint || {};
      const fuelPct = ship.fuelCapacity > 0
        ? Math.round((ship.fuel / ship.fuelCapacity) * 100)
        : 0;
      const condPct = Math.round(ship.condition * 100);
      const color = fuelColor(fuelPct);

      let statusHtml;
      if (ship.flight) {
        const f = ship.flight;
        const eta = GtApi.timeUntil(f.aDate);
        statusHtml = `<span class="in-flight-badge">✈ In Flight → P${f.destPId} · ETA ${eta}</span>`;
      } else {
        statusHtml = `<span style="color:var(--text-muted);font-size:12px">Docked @ P${ship.pId}</span>`;
      }

      return `
        <tr>
          <td><strong>${ship.name}</strong></td>
          <td>
            <div class="ship-fuel">
              <div class="fuel-dot ${color}"></div>
              <span class="mono" style="color:${color === 'red' ? 'var(--red)' : color === 'yellow' ? 'var(--yellow)' : 'var(--green)'}">
                ${fuelPct}%
              </span>
              <span class="text-muted" style="font-size:11px">${ship.fuel.toFixed(1)}/${ship.fuelCapacity}</span>
            </div>
          </td>
          <td>
            <span class="mono" style="color:${condColor(ship.condition)}">${condPct}%</span>
          </td>
          <td class="mono text-dim">${GtApi.formatNum(bp.cargoCapacity || 0)}</td>
          <td>${statusHtml}</td>
        </tr>
      `;
    }).join('');
  }

  // ─── Render base cards ─────────────────────────────────────────────────────

  function renderBases(bases) {
    const grid = document.getElementById('base-grid');

    if (!bases.length) {
      grid.innerHTML = `<div class="info-box">No bases found.</div>`;
      return;
    }

    grid.innerHTML = bases.map(base => {
      const wf = base.workforce || {};
      const needed  = wf.workersNeeded  || [0,0,0,0];
      const count   = wf.workersCount   || [0,0,0,0];
      const sat     = wf.workersSatisfaction || [0,0,0,0];
      const wh      = base.warehouse || {};
      const whPct   = warehousePct(wh);
      const whColor = progressColor(whPct);
      const poCount = (base.productionOrders || []).length;
      const bCount  = (base.buildingSlots || []).filter(s => s.building).length;

      const satDots = sat.map((s, i) => {
        if (needed[i] === 0) return '';
        const cls = satColor(s);
        return `<div class="sat-dot ${cls}" title="Tier ${i+1}: ${Math.round(s*100)}% satisfaction"></div>`;
      }).join('');

      const expLabels = ['', '★ Colony', '★★ Outpost', '★★★ Advanced'];
      const expBadge = expLabels[base.exp || 0] || '';

      return `
        <div class="base-card">
          <div class="base-card-header">
            <div>
              <div class="base-name">${base.name}</div>
              <div class="base-planet">Planet #${base.planetId}</div>
            </div>
            ${expBadge ? `<span class="base-exp-badge">${expBadge}</span>` : ''}
          </div>
          <div class="base-stats">
            <div class="base-stat-row">
              <span class="base-stat-label">Production Orders</span>
              <span class="base-stat-value">${poCount}</span>
            </div>
            <div class="base-stat-row">
              <span class="base-stat-label">Buildings</span>
              <span class="base-stat-value">${bCount} / ${(base.buildingSlots||[]).length}</span>
            </div>
            <div class="base-stat-row">
              <span class="base-stat-label">Workforce</span>
              <div class="sat-dots">${satDots}</div>
            </div>
            <div>
              <div class="base-stat-row">
                <span class="base-stat-label">Warehouse</span>
                <span class="base-stat-value ${whColor === 'red' ? 'text-red' : ''}">${whPct}%</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill ${whColor}" style="width:${whPct}%"></div>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ─── Render contract pulse ─────────────────────────────────────────────────

  function renderContractPulse(contracts) {
    const now = Date.now();
    const in24h = now + 24 * 3600 * 1000;

    const active   = contracts.filter(c => c.status === 1);
    const selling  = active.filter(c => c.type === 1);
    const buying   = active.filter(c => c.type === 2);
    const pending  = contracts.filter(c => c.status === 0);
    const expiring = active.filter(c => c.expires && new Date(c.expires) < in24h);
    const issues   = active.filter(c =>
      (c.type === 1 && !c.state?.hasMat) ||
      (c.type === 2 && !c.state?.hasSpace) ||
      !c.state?.hasCredits
    );

    document.getElementById('pulse-active').textContent   = active.length;
    document.getElementById('pulse-selling').textContent  = selling.length;
    document.getElementById('pulse-buying').textContent   = buying.length;
    document.getElementById('pulse-expiring').textContent = expiring.length;
    document.getElementById('pulse-issues').textContent   = issues.length;
    document.getElementById('pulse-pending').textContent  = pending.length;
  }

  // ─── Render exchange orders ────────────────────────────────────────────────

  function renderExchangeOrders(orders, gamedata) {
    const tbody = document.getElementById('exchange-tbody');
    document.getElementById('exchange-count').textContent = `${orders.length} listings`;

    if (!orders.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-muted text-center" style="padding:20px">No active exchange listings.</td></tr>`;
      return;
    }

    tbody.innerHTML = orders.map(o => {
      const name  = gamedata.getMaterialName(o.matId);
      const total = (o.qty || 0) * ((o.unitPrice || 0) / 100);
      return `
        <tr>
          <td><strong>${name}</strong> <span class="text-muted" style="font-size:11px">#${o.matId}</span></td>
          <td class="mono text-right">${GtApi.formatNum(o.qty)}</td>
          <td class="mono text-right text-dim">${GtApi.formatNum(o.qtyTot)}</td>
          <td class="mono text-right text-gold">${GtApi.formatPrice(o.unitPrice)}</td>
          <td class="mono text-right">${GtApi.formatCredits(total)}</td>
        </tr>
      `;
    }).join('');
  }

  // ─── Error display ─────────────────────────────────────────────────────────

  function showError(message) {
    const isAuth = message.includes('AUTH_INVALID') || message.includes('AUTH_INSUFFICIENT');
    const box = document.createElement('div');
    box.className = 'error-box';
    box.style.cssText = 'margin-bottom:16px';
    box.innerHTML = `
      <div class="error-title">${isAuth ? '🔑 Authentication Error' : '⚠ Error Loading Data'}</div>
      <div>${message.replace(/^[A-Z_]+: /, '')}</div>
      ${isAuth ? `<div style="margin-top:8px"><a href="index.html" style="color:var(--accent)">→ Update your API key</a></div>` : ''}
    `;
    document.querySelector('.page-content').prepend(box);
  }

  // ─── Main load ─────────────────────────────────────────────────────────────

  async function loadAll() {
    try {
      // Load game data and company data in parallel
      const [company, contracts, exchangeOrders] = await Promise.all([
        api.getCompany(),
        api.getContracts(),
        api.getExchangeOrders(),
        gameData.load()
      ]);

      renderCompanyStats(company);
      renderFleet(company.ships || []);
      renderContractPulse(contracts);
      renderExchangeOrders(exchangeOrders, gameData);
      window._updateRateLimit(api);

      // Update last refresh time
      document.getElementById('last-refresh').textContent =
        `Last updated: ${new Date().toLocaleTimeString()} · Auto-refreshes every 60s`;
    } catch (err) {
      showError(err.message);
    }

    // Load bases separately (heavier call — 20 pts)
    try {
      const bases = await api.getBases();
      renderBases(bases);
    } catch (err) {
      document.getElementById('base-grid').innerHTML =
        `<div class="error-box">${err.message.replace(/^[A-Z_]+: /, '')}</div>`;
    }
  }

  // ─── Auto-refresh ──────────────────────────────────────────────────────────

  loadAll();

  let refreshTimer = setInterval(() => {
    if (!document.hidden) loadAll();
  }, 60 * 1000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadAll();
  });
})();
