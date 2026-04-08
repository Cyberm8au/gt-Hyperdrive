/**
 * GT Companion — Market Analysis Logic
 */
(function () {
  if (!GtApi.getStoredKey()) { window.location.href = 'index.html'; return; }

  const api = new GtApi(GtApi.getStoredKey());
  let priceChart = null;
  let volumeChart = null;
  let selectedMatId = null;
  let myContracts = [];
  let myCompanyId = null;

  const CHART_DEFAULTS = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
    scales: {
      x: { grid: { color: 'rgba(30,45,80,0.8)' }, ticks: { color: '#7a8eb5', maxTicksLimit: 10, font: { size: 10 } } },
      y: { grid: { color: 'rgba(30,45,80,0.8)' }, ticks: { color: '#7a8eb5', font: { size: 10 } } }
    }
  };

  // ─── Autocomplete ──────────────────────────────────────────────────────────

  async function initAutocomplete() {
    await gameData.load();

    // Also load contracts + company ID in background for comparison
    api.getCompany().then(c => {
      myCompanyId = c.id;
      window._setNavCompany(c.name);
    }).catch(() => {});
    api.getContracts().then(c => { myContracts = c; }).catch(() => {});

    const input = document.getElementById('mat-search');
    const list  = document.getElementById('autocomplete-list');

    input.addEventListener('input', () => {
      const q = input.value.trim();
      if (q.length < 1) { list.style.display = 'none'; return; }
      const results = gameData.searchMaterials(q).slice(0, 12);
      if (!results.length) { list.style.display = 'none'; return; }

      list.innerHTML = results.map(m => `
        <div class="autocomplete-item" data-id="${m.id}">
          <span>${m.name}</span>
          <span class="mat-tier">Tier ${m.tier}</span>
        </div>
      `).join('');
      list.style.display = 'block';

      list.querySelectorAll('.autocomplete-item').forEach(el => {
        el.addEventListener('click', () => {
          selectedMatId = parseInt(el.dataset.id);
          input.value = gameData.getMaterialName(selectedMatId);
          list.style.display = 'none';
          document.getElementById('fetch-btn').disabled = false;
        });
      });
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !document.getElementById('fetch-btn').disabled) {
        fetchMarket();
      }
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('.autocomplete-wrap')) list.style.display = 'none';
    });
  }

  // ─── Fetch and render ──────────────────────────────────────────────────────

  async function fetchMarket() {
    if (!selectedMatId) return;

    const btn   = document.getElementById('fetch-btn');
    const errEl = document.getElementById('fetch-error');
    btn.disabled = true;
    btn.textContent = 'Loading…';
    errEl.style.display = 'none';

    try {
      const data = await api.getMatDetails(selectedMatId);
      render(data);
      window._updateRateLimit(api);
    } catch (err) {
      errEl.textContent = err.message.replace(/^[A-Z_]+: /, '');
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Fetch Market Data';
    }
  }

  function render(data) {
    const matName = gameData.getMaterialName(data.matId);

    // Show results pane
    document.getElementById('placeholder-card').style.display = 'none';
    document.getElementById('results-col').classList.add('visible');
    document.getElementById('quick-stats').style.display = 'block';

    // ── Quick stats ──
    document.getElementById('qs-matname').textContent  = matName;
    document.getElementById('qs-current').textContent  = GtApi.formatNum(data.currentPrice) + ' cr';
    document.getElementById('qs-avg').textContent      = GtApi.formatNum(Math.round(data.avgPrice)) + ' cr';
    document.getElementById('qs-qty').textContent      = GtApi.formatNum(data.totalQtyAvailable);
    document.getElementById('qs-vol').textContent      = GtApi.formatNum(Math.round(data.avgQtySoldDaily));
    document.getElementById('qs-orders').textContent   = (data.orders || []).length;

    // Trend: compare current to 7-day avg
    const history = (data.priceHistory || []).slice().reverse(); // oldest first
    const recent7 = history.slice(-7);
    const avg7    = recent7.length ? recent7.reduce((s, d) => s + d.avgPrice, 0) / recent7.length : data.avgPrice;
    const trendPct = avg7 > 0 ? ((data.currentPrice - avg7) / avg7) * 100 : 0;
    const trendCls = trendPct > 1 ? 'trend-up' : trendPct < -1 ? 'trend-down' : 'trend-flat';
    const trendIcon = trendPct > 1 ? '↑' : trendPct < -1 ? '↓' : '→';
    document.getElementById('qs-trend').innerHTML =
      `<span class="trend-pill ${trendCls}">${trendIcon} ${trendPct >= 0 ? '+' : ''}${trendPct.toFixed(1)}% vs 7-day avg</span>`;

    // ── Price chart ──
    renderPriceChart(history, data.currentPrice);

    // ── Volume chart ──
    renderVolumeChart(history);

    // ── Price range label ──
    if (history.length) {
      const prices = history.map(h => h.avgPrice);
      const lo = Math.min(...prices), hi = Math.max(...prices);
      document.getElementById('price-range').textContent =
        `Range: ${GtApi.formatNum(lo)} – ${GtApi.formatNum(hi)} cr`;
    }

    // ── Order book ──
    renderOrderBook(data.orders || []);

    // ── Your contracts for this material ──
    renderYourContracts(data.matId);
  }

  function renderPriceChart(history, currentPrice) {
    const labels = history.map(h => {
      const d = new Date(h.date);
      return `${d.getMonth()+1}/${d.getDate()}`;
    });
    const prices = history.map(h => h.avgPrice);

    if (priceChart) priceChart.destroy();

    const ctx = document.getElementById('price-chart').getContext('2d');
    priceChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Avg Price',
            data: prices,
            borderColor: '#00c8ff',
            backgroundColor: 'rgba(0,200,255,0.08)',
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            pointRadius: 2,
            pointHoverRadius: 5,
          },
          {
            label: 'Current',
            data: Array(labels.length).fill(currentPrice),
            borderColor: 'rgba(240,165,0,0.4)',
            borderWidth: 1,
            borderDash: [4, 4],
            pointRadius: 0,
            fill: false,
          }
        ]
      },
      options: {
        ...CHART_DEFAULTS,
        plugins: {
          ...CHART_DEFAULTS.plugins,
          tooltip: {
            mode: 'index', intersect: false,
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${GtApi.formatNum(Math.round(ctx.raw))} cr`
            }
          }
        },
        scales: {
          ...CHART_DEFAULTS.scales,
          y: {
            ...CHART_DEFAULTS.scales.y,
            ticks: {
              ...CHART_DEFAULTS.scales.y.ticks,
              callback: v => GtApi.formatNum(Math.round(v))
            }
          }
        }
      }
    });
  }

  function renderVolumeChart(history) {
    const labels  = history.map(h => { const d = new Date(h.date); return `${d.getMonth()+1}/${d.getDate()}`; });
    const volumes = history.map(h => h.qtySold || 0);

    if (volumeChart) volumeChart.destroy();

    const ctx = document.getElementById('volume-chart').getContext('2d');
    volumeChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Qty Sold',
          data: volumes,
          backgroundColor: 'rgba(0,200,255,0.25)',
          borderColor: 'rgba(0,200,255,0.5)',
          borderWidth: 1,
          borderRadius: 2,
        }]
      },
      options: {
        ...CHART_DEFAULTS,
        plugins: {
          ...CHART_DEFAULTS.plugins,
          tooltip: { callbacks: { label: ctx => `Volume: ${GtApi.formatNum(ctx.raw)}` } }
        },
        scales: {
          ...CHART_DEFAULTS.scales,
          y: {
            ...CHART_DEFAULTS.scales.y,
            ticks: {
              ...CHART_DEFAULTS.scales.y.ticks,
              callback: v => v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : v
            }
          }
        }
      }
    });
  }

  function renderOrderBook(orders) {
    const tbody = document.getElementById('orders-tbody');

    if (!orders.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-muted text-center" style="padding:16px">No open orders.</td></tr>`;
      return;
    }

    // Sort by price ascending
    const sorted = [...orders].sort((a, b) => a.unitPrice - b.unitPrice);
    const lowest = sorted[0]?.unitPrice;

    tbody.innerHTML = sorted.map((o, i) => {
      const isMe    = o.cId === myCompanyId;
      const totalVal = (o.qty || 0) * (o.unitPrice || 0);
      const pctAbove = lowest > 0 ? ((o.unitPrice - lowest) / lowest * 100) : 0;

      return `
        <tr class="${isMe ? 'your-order' : ''}">
          <td class="text-muted mono">${i + 1}</td>
          <td>${isMe ? '⭐ ' : ''}${o.cName || o.cId}</td>
          <td class="mono text-right">
            ${GtApi.formatNum(o.unitPrice)} cr
            ${i > 0 ? `<span class="text-muted" style="font-size:10px">+${pctAbove.toFixed(1)}%</span>` : '<span class="badge badge-active" style="font-size:10px;padding:1px 5px;margin-left:4px">BEST</span>'}
          </td>
          <td class="mono text-right">${GtApi.formatNum(o.qty)}</td>
          <td class="mono text-right">${GtApi.formatCredits(totalVal)}</td>
        </tr>
      `;
    }).join('');
  }

  function renderYourContracts(matId) {
    const card = document.getElementById('your-contracts-card');
    const list = document.getElementById('your-contracts-list');

    const relevant = myContracts.filter(c => c.matId === matId && c.status === 1);
    if (!relevant.length) { card.style.display = 'none'; return; }

    card.style.display = 'block';
    list.innerHTML = relevant.map(c => {
      const dir   = c.type === 1 ? '▶ SELL' : '◀ BUY';
      const badge = c.type === 1 ? 'badge-sell' : 'badge-buy';
      const partner = c.company?.id !== myCompanyId ? c.company?.name : c.otherCompany?.name;
      return `
        <div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span class="badge ${badge}" style="font-size:10px">${dir}</span>
            <span class="mono text-gold">${GtApi.formatNum(c.unitPrice)} cr</span>
          </div>
          <div style="color:var(--text-dim);margin-top:4px">${partner} · ${GtApi.formatNum(c.qty)} units · expires ${GtApi.timeUntil(c.expires)}</div>
        </div>
      `;
    }).join('');
    if (relevant.length) list.lastElementChild.style.borderBottom = 'none';
  }

  // ─── Events ────────────────────────────────────────────────────────────────

  document.getElementById('fetch-btn').addEventListener('click', fetchMarket);

  initAutocomplete().catch(() => {});
})();
