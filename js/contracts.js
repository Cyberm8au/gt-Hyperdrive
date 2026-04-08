/**
 * GT Companion — Contract Monitor Logic
 */
(function () {
  if (!GtApi.getStoredKey()) { window.location.href = 'index.html'; return; }

  const api = new GtApi(GtApi.getStoredKey());

  let allContracts = [];
  let marketPrices = {};   // matId → currentPrice
  let myCompanyId  = null; // set after company fetch
  let sortCol = 'expiry';
  let sortDir = 1; // 1 = asc, -1 = desc

  const STATUS_LABEL = { 0: 'Pending', 1: 'Active', 2: 'Completed', 3: 'Cancelled' };
  const STATUS_BADGE = { 0: 'badge-pending', 1: 'badge-active', 2: 'badge-done', 3: 'badge-cancelled' };

  // ─── Data loading ──────────────────────────────────────────────────────────

  async function loadData() {
    try {
      const [contracts, pricesRaw, company] = await Promise.all([
        api.getContracts(),
        api.getMatPrices(),
        api.getCompany(),
        gameData.load()
      ]);
      myCompanyId = company.id;
      window._setNavCompany(company.name);

      // Build price map
      const pricesArr = Array.isArray(pricesRaw) ? pricesRaw : (pricesRaw.prices || []);
      marketPrices = {};
      for (const p of pricesArr) {
        marketPrices[p.matId] = p.currentPrice / 100; // API returns integer cents
      }

      allContracts = contracts;

      // Populate partner dropdown
      const partners = [...new Set(contracts.map(c => {
        const other = c.company.id === 12965 ? c.otherCompany : c.company;
        return other ? other.name : null;
      }).filter(Boolean))].sort();

      const partnerSel = document.getElementById('f-partner');
      const existing = partnerSel.querySelector('option[value=""]');
      partnerSel.innerHTML = '';
      partnerSel.appendChild(existing || Object.assign(document.createElement('option'), { value: '', textContent: 'All Partners' }));
      partners.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        partnerSel.appendChild(opt);
      });

      renderSummary(contracts);
      applyFilters();
      window._updateRateLimit(api);
      document.getElementById('c-refresh').textContent =
        `Updated ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      showError(err.message);
    }
  }

  // ─── Summary bar ───────────────────────────────────────────────────────────

  function renderSummary(contracts) {
    const now = Date.now();
    const active    = contracts.filter(c => c.status === 1);
    const selling   = active.filter(c => c.type === 1);
    const buying    = active.filter(c => c.type === 2);
    const expiring  = active.filter(c => c.expires && new Date(c.expires) - now < 86400000);
    const issues    = active.filter(c => hasIssue(c));
    const sellVal   = selling.reduce((s, c) => s + (c.qty || 0) * ((c.unitPrice || 0) / 100), 0);

    document.getElementById('s-total').textContent   = active.length;
    document.getElementById('s-sell').textContent    = selling.length;
    document.getElementById('s-buy').textContent     = buying.length;
    document.getElementById('s-sellval').textContent = GtApi.formatCredits(sellVal);
    document.getElementById('s-exp').textContent     = expiring.length;
    document.getElementById('s-issues').textContent  = issues.length;
  }

  // ─── Filtering & rendering ─────────────────────────────────────────────────

  function hasIssue(c) {
    if (c.status !== 1) return false;
    const st = c.state || {};
    if (c.type === 1 && !st.hasMat)     return true; // selling but no stock
    if (c.type === 2 && !st.hasSpace)   return true; // buying but no space
    if (!st.hasCredits)                 return true; // partner can't pay
    return false;
  }

  function isExpiringSoon(c) {
    if (!c.expires) return false;
    return new Date(c.expires) - Date.now() < 86400000;
  }

  function getPartner(c) {
    if (c.company?.id === myCompanyId) return c.otherCompany;
    return c.company;
  }

  function vsMarket(unitPrice, matId) {
    const mkt = marketPrices[matId]; // already normalized (÷100)
    if (!mkt || mkt === 0) return null;
    return ((unitPrice / 100 - mkt) / mkt) * 100;
  }

  function applyFilters() {
    const fType     = document.getElementById('f-type').value;
    const fStatus   = document.getElementById('f-status').value;
    const fPartner  = document.getElementById('f-partner').value;
    const fMaterial = document.getElementById('f-material').value.toLowerCase().trim();

    let rows = allContracts.filter(c => {
      if (fType && String(c.type) !== fType) return false;

      if (fStatus === 'active'    && c.status !== 1)     return false;
      if (fStatus === 'pending'   && c.status !== 0)     return false;
      if (fStatus === 'done'      && c.status !== 2)     return false;
      if (fStatus === 'cancelled' && c.status !== 3)     return false;
      if (fStatus === 'expiring'  && (!isExpiringSoon(c) || c.status !== 1)) return false;
      if (fStatus === 'issues'    && !hasIssue(c))       return false;

      if (fPartner) {
        const partner = getPartner(c);
        if (!partner || partner.name !== fPartner) return false;
      }

      if (fMaterial) {
        const matName = gameData.getMaterialName(c.matId).toLowerCase();
        if (!matName.includes(fMaterial)) return false;
      }

      return true;
    });

    // Sort
    rows = sortRows(rows, sortCol, sortDir);
    renderTable(rows);
    document.getElementById('row-count').textContent =
      `Showing ${rows.length} of ${allContracts.length} contracts`;
  }

  function sortRows(rows, col, dir) {
    return [...rows].sort((a, b) => {
      let av, bv;
      switch (col) {
        case 'dir':      av = a.type; bv = b.type; break;
        case 'material': av = gameData.getMaterialName(a.matId); bv = gameData.getMaterialName(b.matId); break;
        case 'partner':  av = (getPartner(a)?.name || ''); bv = (getPartner(b)?.name || ''); break;
        case 'qty':      av = a.qty; bv = b.qty; break;
        case 'price':    av = a.unitPrice; bv = b.unitPrice; break;
        case 'value':    av = a.qty * a.unitPrice; bv = b.qty * b.unitPrice; break;
        case 'vsmarket': {
          const am = vsMarket(a.unitPrice, a.matId); const bm = vsMarket(b.unitPrice, b.matId);
          av = am ?? -Infinity; bv = bm ?? -Infinity; break;
        }
        case 'expiry':   av = a.expires ? new Date(a.expires).getTime() : Infinity; bv = b.expires ? new Date(b.expires).getTime() : Infinity; break;
        case 'status':   av = a.status; bv = b.status; break;
        default:         return 0;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return  1 * dir;
      return 0;
    });
  }

  function renderTable(rows) {
    const tbody = document.getElementById('contracts-tbody');

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="11"><div class="info-box" style="margin:12px">No contracts match your filters.</div></td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(c => {
      const partner    = getPartner(c);
      const matName    = gameData.getMaterialName(c.matId);
      const totalVal   = (c.qty || 0) * ((c.unitPrice || 0) / 100);
      const mktDiff    = vsMarket(c.unitPrice, c.matId);
      const expiring   = isExpiringSoon(c);
      const issue      = hasIssue(c);
      const st         = c.state || {};

      // Direction badge
      const dirBadge = c.type === 1
        ? `<span class="badge badge-sell">▶ SELL</span>`
        : `<span class="badge badge-buy">◀ BUY</span>`;

      // vs market
      let vsHtml = '<span class="text-muted">—</span>';
      if (mktDiff !== null) {
        const sign = mktDiff >= 0 ? '+' : '';
        const cls  = mktDiff > 2 ? 'above' : mktDiff < -2 ? 'below' : 'atpar';
        vsHtml = `<span class="vs-market ${cls}">${sign}${mktDiff.toFixed(1)}%</span>`;
      }

      // Status badge
      const statusBadge = `<span class="badge ${STATUS_BADGE[c.status] || 'badge-done'}">${STATUS_LABEL[c.status] || c.status}</span>`;

      // Expiry
      let expiryHtml;
      if (!c.expires) {
        expiryHtml = '<span class="text-muted">—</span>';
      } else {
        const timeStr = GtApi.timeUntil(c.expires);
        const style   = expiring && c.status === 1 ? 'color:var(--yellow);font-weight:700' : 'color:var(--text-dim)';
        expiryHtml = `<span style="${style}">${timeStr}</span>`;
      }

      // Fill progress
      let fillHtml = '<span class="text-muted">—</span>';
      if (c.fLimit !== null && c.fLimit !== undefined) {
        const today = c.fToday ?? 0;
        const limit = c.fLimit;
        const pct   = limit > 0 ? Math.min(100, Math.round((today / limit) * 100)) : 0;
        fillHtml = `
          <div class="fill-bar">
            <span class="mono" style="font-size:11px">${today}/${limit}</span>
            <div class="fb"><div class="fb-fill" style="width:${pct}%"></div></div>
          </div>`;
      }

      // Flags
      const flags = [];
      if (c.status === 1) {
        if (c.type === 1 && !st.hasMat)   flags.push(`<span class="flag-chip flag-nostock">NO STOCK</span>`);
        if (c.type === 2 && !st.hasSpace)  flags.push(`<span class="flag-chip flag-nospace">NO SPACE</span>`);
        if (!st.hasCredits)                flags.push(`<span class="flag-chip flag-nostock">NO CREDITS</span>`);
        if (expiring)                      flags.push(`<span class="flag-chip flag-expiring">⏰ EXPIRING</span>`);
        if (!flags.length)                 flags.push(`<span class="flag-chip flag-ok">OK</span>`);
      }

      const rowStyle = issue ? 'background:rgba(255,68,68,0.04)' : expiring && c.status === 1 ? 'background:rgba(255,202,40,0.03)' : '';

      return `
        <tr style="${rowStyle}">
          <td>${dirBadge}</td>
          <td>
            <strong>${matName}</strong>
            <span class="text-muted" style="font-size:11px;display:block">ID ${c.matId}</span>
          </td>
          <td>${partner?.name || '—'}</td>
          <td class="mono text-right">${GtApi.formatNum(c.qty)}</td>
          <td class="mono text-right">${GtApi.formatPrice(c.unitPrice)}</td>
          <td class="text-right">${vsHtml}</td>
          <td class="mono text-right">${GtApi.formatCredits(totalVal)}</td>
          <td>${fillHtml}</td>
          <td>${expiryHtml}</td>
          <td>${statusBadge}</td>
          <td><div class="flags">${flags.join('')}</div></td>
        </tr>
      `;
    }).join('');
  }

  // ─── Sort column headers ───────────────────────────────────────────────────

  document.querySelectorAll('#contracts-table th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortDir *= -1;
      } else {
        sortCol = col;
        sortDir = 1;
      }
      document.querySelectorAll('#contracts-table th').forEach(h => {
        h.classList.remove('sorted-asc', 'sorted-desc');
      });
      th.classList.add(sortDir === 1 ? 'sorted-asc' : 'sorted-desc');
      applyFilters();
    });
  });

  // ─── Filter events ─────────────────────────────────────────────────────────

  ['f-type', 'f-status', 'f-partner'].forEach(id => {
    document.getElementById(id).addEventListener('change', applyFilters);
  });
  document.getElementById('f-material').addEventListener('input', applyFilters);

  document.getElementById('f-reset').addEventListener('click', () => {
    document.getElementById('f-type').value     = '';
    document.getElementById('f-status').value   = '';
    document.getElementById('f-partner').value  = '';
    document.getElementById('f-material').value = '';
    applyFilters();
  });

  document.getElementById('refresh-btn').addEventListener('click', () => {
    api.invalidateCache('/public/company/contracts');
    api.invalidateCache('/public/exchange/mat-prices');
    loadData();
  });

  // ─── Error display ─────────────────────────────────────────────────────────

  function showError(msg) {
    const isAuth = msg.includes('AUTH_INVALID') || msg.includes('AUTH_INSUFFICIENT');
    document.getElementById('contracts-tbody').innerHTML = `
      <tr><td colspan="11">
        <div class="error-box" style="margin:16px">
          <div class="error-title">${isAuth ? '🔑 Auth Error' : '⚠ Error'}</div>
          <div>${msg.replace(/^[A-Z_]+: /, '')}</div>
          ${isAuth ? `<a href="index.html" style="color:var(--accent)">→ Update API key</a>` : ''}
        </div>
      </td></tr>`;
  }

  // ─── Init ──────────────────────────────────────────────────────────────────

  loadData();

  // Set default sort indicator
  document.querySelector('#contracts-table th[data-col="expiry"]')?.classList.add('sorted-asc');

  // Auto-refresh every 2 minutes
  setInterval(() => {
    if (!document.hidden) {
      api.invalidateCache('/public/company/contracts');
      loadData();
    }
  }, 2 * 60 * 1000);
})();
