/**
 * GT Companion — Production Cost Calculator Logic
 */
(function () {
  if (!GtApi.getStoredKey()) { window.location.href = 'index.html'; return; }

  const api = new GtApi(GtApi.getStoredKey());

  let selectedMatId = null;
  let selectedRecipe = null;
  let allPrices = {};       // matId → currentPrice (normalised, credits)
  let lastResult = null;    // { tree, rawTotals, totalCost, consumTotals, timeMinutes, topBuilding }
  let empireProduced = null; // Set<matId> produced by user's own bases
  let companyTechnologies = null; // [{id,level}] from getCompany()

  // ─── Settings (persisted) ──────────────────────────────────────────────────
  // User-tunable values representing their company state. Auto-detection of
  // perk levels is not currently supported by the public API, so the user
  // enters them once and they're cached in localStorage.
  const SETTINGS_KEY = 'gt_costcalc_settings';
  const DEFAULT_SETTINGS = {
    workforceEffLvl: 0,        // Workforce Efficiency: -2% consumption per level
    adminOptLvl: 0,            // Administrative Optimization: -2.5% overhead mult per lvl
    efficientSupLvl: 0,        // Efficient Supervision: -5% overhead mult per lvl
    laxSupLvl: 0,              // Lax Supervision: -35% overhead mult per lvl
    strictSup: false,          // Strict Supervision keystone: +50% overhead mult
    guildAdminCenter: 0,       // Guild Admin Center flat % reduction (0-100)
    empireBurden: 2000,        // Total empire workforce burden (Σ workers × burden)
    prodSpeedBonusPct: 0,      // Aggregate production-speed bonus from tech + perks (%)
    includeOptionals: false,   // Factor optional consumables in cost
    includeConsumables: false  // Master toggle — off by default (see consumables-panel caveat)
  };
  const SETTINGS_VERSION = 2; // bump to migrate / reset misleading defaults
  let settings = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      // Migration: v2 disables consumables by default since per-recipe
      // attribution heavily inflates cost vs. how players actually budget.
      if (!settings.__v || settings.__v < 2) {
        settings.includeConsumables = false;
        settings.__v = SETTINGS_VERSION;
      }
    } else {
      settings.__v = SETTINGS_VERSION;
    }
  } catch (_) {}
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
  }

  /**
   * Compute current consumption multiplier from settings.
   * Returns { overheadMult, consumptionPerkMult, totalMult } where
   * totalMult is applied to base consumable rates.
   */
  function computeConsumptionMultiplier() {
    // Base overhead from burden
    const overheadRaw = Math.max(0, (settings.empireBurden - 2000) / 100000);
    // Multiplicative reductions stack additively as percent reductions
    let overheadReductionPct =
      settings.adminOptLvl * 2.5 +
      settings.efficientSupLvl * 5 +
      settings.laxSupLvl * 35;
    if (settings.strictSup) overheadReductionPct -= 50; // penalty
    const overheadAfterMult = overheadRaw * Math.max(0, 1 - overheadReductionPct / 100);
    const flatRed = Math.min(settings.guildAdminCenter / 100, overheadAfterMult / 2);
    const overheadFinal = Math.max(0, overheadAfterMult - flatRed);
    const overheadMult = 1 + overheadFinal;
    const consumptionPerkMult = Math.max(0, 1 - (settings.workforceEffLvl * 2) / 100);
    return {
      overheadMult,
      consumptionPerkMult,
      totalMult: overheadMult * consumptionPerkMult,
      overheadFinalPct: overheadFinal * 100
    };
  }

  // ─── Autocomplete ──────────────────────────────────────────────────────────

  async function initAutocomplete() {
    await gameData.load();

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
        el.addEventListener('click', () => selectMaterial(parseInt(el.dataset.id)));
      });
    });

    // Close on outside click
    document.addEventListener('click', e => {
      if (!e.target.closest('.autocomplete-wrap')) {
        list.style.display = 'none';
      }
    });

    // Keyboard nav
    input.addEventListener('keydown', e => {
      const items = list.querySelectorAll('.autocomplete-item');
      const sel   = list.querySelector('.autocomplete-item.selected');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = sel ? sel.nextElementSibling : items[0];
        if (next) { sel?.classList.remove('selected'); next.classList.add('selected'); }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = sel?.previousElementSibling;
        if (prev) { sel.classList.remove('selected'); prev.classList.add('selected'); }
      } else if (e.key === 'Enter') {
        const active = list.querySelector('.autocomplete-item.selected') || list.querySelector('.autocomplete-item');
        if (active) selectMaterial(parseInt(active.dataset.id));
      } else if (e.key === 'Escape') {
        list.style.display = 'none';
      }
    });
  }

  function selectMaterial(matId) {
    selectedMatId = matId;
    const mat = gameData.getMaterial(matId);
    if (!mat) return;

    const list = document.getElementById('autocomplete-list');
    document.getElementById('mat-search').value = mat.name;
    list.style.display = 'none';
    document.getElementById('selected-mat').textContent =
      `Tier ${mat.tier} · ${mat.description || ''}`.slice(0, 120);

    // Show recipe options if multiple exist
    const recipes = gameData.getRecipesForOutput(matId).filter(r => r.inputs?.length > 0);
    const recipeSection = document.getElementById('recipe-selector');
    const recipeOptions = document.getElementById('recipe-options');

    if (recipes.length > 1) {
      recipeSection.style.display = 'block';
      recipeOptions.innerHTML = recipes.map((r, i) => {
        const building = gameData.getRecipeBuilding(r);
        const output   = gameData.getRecipeOutput(r);
        const inputNames = (r.inputs || []).map(inp =>
          `${inp.a ?? inp.am}× ${gameData.getMaterialShortName(inp.id ?? inp.i)}`
        ).join(', ');
        return `
          <div class="recipe-option ${i === 0 ? 'selected' : ''}" data-idx="${i}">
            <div><strong>${building?.name || 'Building'}</strong> → ${output?.amount}× ${mat.name}</div>
            <div class="ro-building">${inputNames}</div>
          </div>
        `;
      }).join('');

      selectedRecipe = recipes[0];

      recipeOptions.querySelectorAll('.recipe-option').forEach(el => {
        el.addEventListener('click', () => {
          recipeOptions.querySelectorAll('.recipe-option').forEach(o => o.classList.remove('selected'));
          el.classList.add('selected');
          selectedRecipe = recipes[parseInt(el.dataset.idx)];
        });
      });
    } else {
      recipeSection.style.display = 'none';
      selectedRecipe = recipes[0] || null;
    }

    document.getElementById('calc-btn').disabled = false;
  }

  // ─── Cost calculation ──────────────────────────────────────────────────────

  /**
   * Recursively resolve ingredient costs.
   * Returns { cost, tree } where tree is an array of nodes for rendering.
   * rawTotals accumulates { matId → totalQty } for raw material summary.
   */
  async function calcCost(matId, qty, depth = 0, visited = new Set(), rawTotals = {}, consumTotals = {}, topRef = {}) {
    if (depth > 10) return { cost: 0, tree: [], timeMinutes: 0 }; // guard against deep recursion

    const recipe = selectedRecipe && depth === 0
      ? selectedRecipe
      : gameData.getCraftingRecipe(matId);

    const matName = gameData.getMaterialName(matId);

    // No crafting recipe → raw material, fetch market price
    if (!recipe) {
      const price = allPrices[matId] ?? 0;
      const totalCost = price * qty;

      // Accumulate for raw summary
      rawTotals[matId] = (rawTotals[matId] || 0) + qty;

      return {
        cost: totalCost,
        timeMinutes: 0,
        tree: [{
          matId, matName, qty, unitPrice: price,
          totalCost, isRaw: true, depth, children: []
        }]
      };
    }

    // Guard circular references
    if (visited.has(matId)) {
      const price = allPrices[matId] ?? 0;
      return { cost: price * qty, timeMinutes: 0, tree: [{ matId, matName, qty, unitPrice: price, totalCost: price * qty, isRaw: true, depth, children: [] }] };
    }
    visited.add(matId);

    const output  = gameData.getRecipeOutput(recipe);
    const inputs  = gameData.getRecipeInputs(recipe);
    const outAmt  = output?.amount || 1;
    const runs    = qty / outAmt;
    const building = gameData.getRecipeBuilding(recipe);
    // Production speed: global setting × per-recipe technology bonus
    // (technologies give +5% per level to buildings matching their specialization)
    let techBonus = 0;
    if (companyTechnologies && building?.specialization) {
      const tech = companyTechnologies.find(t => t.id === building.specialization);
      if (tech) techBonus = (tech.level || 0) * 0.05;
    }
    const speedMult = (1 + (settings.prodSpeedBonusPct || 0) / 100) * (1 + techBonus);
    const runMinutes = (recipe.timeMinutes || 0) / speedMult;
    const recipeTimeMinutes = runMinutes * runs;
    const recipeDurationDays = recipeTimeMinutes / 1440;

    let totalCost = 0;
    let subtreeTime = 0;
    const children = [];

    for (const inp of inputs) {
      const neededQty = inp.amount * runs;
      const sub = await calcCost(inp.matId, neededQty, depth + 1, new Set(visited), rawTotals, consumTotals, topRef);
      totalCost += sub.cost;
      subtreeTime += sub.timeMinutes || 0;
      children.push(...sub.tree);
    }

    // Consumable cost — essentials (and optionals if enabled) for the workers
    // required to man `building` for `recipeDurationDays`, scaled by the
    // current consumption multiplier from settings.
    let consumCost = 0;
    if (settings.includeConsumables && building?.workersNeeded && recipeDurationDays > 0) {
      const raw = gameData.getConsumablesForBuilding(
        building.workersNeeded,
        recipeDurationDays,
        settings.includeOptionals
      );
      const mult = computeConsumptionMultiplier().totalMult;
      for (const [midStr, baseQty] of Object.entries(raw)) {
        const mid = parseInt(midStr);
        const effectiveQty = baseQty * mult;
        const price = allPrices[mid] ?? 0;
        consumCost += effectiveQty * price;
        consumTotals[mid] = (consumTotals[mid] || 0) + effectiveQty;
      }
    }
    totalCost += consumCost;

    visited.delete(matId);

    if (depth === 0) {
      topRef.building = building;
      topRef.runs = runs;
      topRef.runMinutes = runMinutes;
      topRef.workersNeeded = building?.workersNeeded || null;
    }

    return {
      cost: totalCost,
      timeMinutes: recipeTimeMinutes + subtreeTime,
      tree: [{
        matId, matName, qty,
        unitPrice: totalCost / qty,
        totalCost, isRaw: false, depth, children,
        building: building?.name,
        runMinutes, runs,
        consumCost
      }]
    };
  }

  // ─── Render ingredient tree ────────────────────────────────────────────────

  function renderTree(nodes, container) {
    container.innerHTML = '';
    nodes.forEach(node => renderNode(node, container));
  }

  function renderNode(node, container, depth = 0) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-node';
    if (depth > 0) wrap.classList.add('tree-indent');

    const row = document.createElement('div');
    row.className = `tree-row ${node.isRaw ? 'is-raw' : 'is-crafted'}`;

    const icon = node.isRaw ? '⚙' : node.children?.length ? '▼' : '▶';
    const qtyFmt   = formatQty(node.qty);
    const priceFmt = node.isRaw
      ? GtApi.formatCredits(node.unitPrice)
      : `(derived)`;
    const totalFmt = GtApi.formatCredits(node.totalCost);

    row.innerHTML = `
      <div class="left">
        <span class="tree-icon">${icon}</span>
        <span class="mat-name">${node.matName}</span>
      </div>
      <div class="right">
        <span class="qty-label">${qtyFmt}</span>
        <span class="price-label">${priceFmt}</span>
        <span class="total-label">${totalFmt}</span>
      </div>
    `;

    wrap.appendChild(row);

    // Render children (collapsed by default for depth > 1)
    if (node.children?.length) {
      const childWrap = document.createElement('div');
      childWrap.className = 'tree-indent';
      if (depth >= 1) childWrap.style.display = 'none';

      node.children.forEach(child => renderNode(child, childWrap, depth + 1));
      wrap.appendChild(childWrap);

      // Toggle on click
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const hidden = childWrap.style.display === 'none';
        childWrap.style.display = hidden ? 'block' : 'none';
        row.querySelector('.tree-icon').textContent = hidden ? '▼' : '▶';
      });
    }

    container.appendChild(wrap);
  }

  function formatQty(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
    if (n >= 1000)    return (n / 1000).toFixed(2) + 'K';
    return Number(n.toFixed(4)).toString();
  }

  // ─── Render raw material summary ───────────────────────────────────────────

  function renderRawSummary(rawTotals) {
    const container = document.getElementById('raw-list');
    const section   = document.getElementById('raw-summary');

    const entries = Object.entries(rawTotals).map(([id, qty]) => ({
      matId: parseInt(id),
      matName: gameData.getMaterialName(parseInt(id)),
      qty,
      unitPrice: allPrices[parseInt(id)] ?? 0,
      totalCost: qty * (allPrices[parseInt(id)] ?? 0)
    })).sort((a, b) => b.totalCost - a.totalCost);

    if (!entries.length) { section.style.display = 'none'; return; }
    section.style.display = 'block';

    container.innerHTML = entries.map(e => `
      <div class="tree-row is-raw">
        <div class="left"><span class="mat-name">${e.matName}</span></div>
        <div class="right">
          <span class="qty-label">${formatQty(e.qty)}</span>
          <span class="price-label">${GtApi.formatCredits(e.unitPrice)}</span>
          <span class="total-label">${GtApi.formatCredits(e.totalCost)}</span>
        </div>
      </div>
    `).join('');
  }

  // ─── Render price summary ──────────────────────────────────────────────────

  function renderPriceSummary(matId, qty, totalCost) {
    const unitCost    = totalCost / qty;
    const marginPct   = parseInt(document.getElementById('margin-slider').value);
    const guildPct    = parseInt(document.getElementById('guild-slider').value);
    const marketPrice = Math.ceil(unitCost * (1 + marginPct / 100));
    const guildPrice  = Math.ceil(unitCost * (1 + guildPct / 100));
    const currentMkt  = allPrices[matId] ?? null;

    const matName = gameData.getMaterialName(matId);
    document.getElementById('res-matname').textContent = matName;
    document.getElementById('res-qty').textContent     = GtApi.formatNum(qty);
    document.getElementById('res-totalcost').textContent =
      GtApi.formatCredits(totalCost) + ` (${GtApi.formatCredits(unitCost)} ea)`;
    document.getElementById('res-unitcost').textContent = GtApi.formatCredits(unitCost);

    document.getElementById('res-breakeven').textContent = GtApi.formatCredits(unitCost);
    document.getElementById('res-guild').textContent     = GtApi.formatCredits(guildPrice);
    document.getElementById('res-guild-sub').innerHTML   = `at <span id="res-guild-pct">${guildPct}</span>% margin`;
    document.getElementById('res-market').textContent    = GtApi.formatCredits(marketPrice);
    document.getElementById('res-market-sub').innerHTML  = `at <span id="res-market-pct">${marginPct}</span>% margin`;

    if (currentMkt !== null) {
      document.getElementById('res-current').textContent = GtApi.formatCredits(currentMkt);
      const mktMargin = ((currentMkt - unitCost) / unitCost) * 100;
      const pill = document.getElementById('market-margin-pill');
      const desc = document.getElementById('market-margin-desc');
      pill.textContent = (mktMargin >= 0 ? '+' : '') + mktMargin.toFixed(1) + '%';
      pill.className = 'margin-pill ' + (mktMargin > 5 ? 'positive' : mktMargin < 0 ? 'negative' : 'neutral');
      desc.textContent = mktMargin < 0 ? '⚠ Market price is below your production cost!' : '';
      document.getElementById('margin-indicator').style.display = 'flex';
    } else {
      document.getElementById('res-current').textContent = 'No data';
      document.getElementById('margin-indicator').style.display = 'none';
    }
  }

  // ─── Render additional context panels ─────────────────────────────────────

  function formatMinutes(m) {
    if (!m || m < 0.01) return '—';
    if (m < 60) return m.toFixed(1) + 'm';
    const h = Math.floor(m / 60);
    const mm = Math.round(m % 60);
    if (h < 24) return `${h}h ${mm}m`;
    const d = Math.floor(h / 24);
    const hh = h % 24;
    return `${d}d ${hh}h`;
  }

  function renderThroughputAndBuilding(topRef, timeMinutes, qty) {
    const el = document.getElementById('throughput-panel');
    if (!el) return;
    if (!topRef.building) { el.style.display = 'none'; return; }
    el.style.display = 'block';

    const b = topRef.building;
    const workers = topRef.workersNeeded || [0,0,0,0];
    const tierLabels = ['Workers','Technicians','Engineers','Scientists'];
    const workerLines = workers.map((n, i) => n > 0
      ? `<div class="cost-row"><span class="cost-label">${tierLabels[i]}</span><span class="cost-value">${n.toLocaleString()}</span></div>`
      : ''
    ).join('');

    const topRunMinutes = topRef.runMinutes * topRef.runs;
    const unitsPerDay = topRef.runMinutes > 0
      ? (qty / topRunMinutes) * 1440
      : 0;

    document.getElementById('tp-building').textContent = b.name || '—';
    document.getElementById('tp-tier').textContent = 'Tier ' + (b.tier ?? '?');
    document.getElementById('tp-toptime').textContent = formatMinutes(topRunMinutes);
    document.getElementById('tp-totaltime').textContent = formatMinutes(timeMinutes);
    document.getElementById('tp-perday').textContent = unitsPerDay >= 1
      ? unitsPerDay.toFixed(0) + ' / day'
      : unitsPerDay > 0 ? unitsPerDay.toFixed(2) + ' / day' : '—';
    document.getElementById('tp-workers').innerHTML = workerLines || '<div style="color:var(--text-muted);font-size:11px">None</div>';
    const speed = settings.prodSpeedBonusPct;
    let techBonus = 0;
    if (companyTechnologies && b.specialization) {
      const tech = companyTechnologies.find(t => t.id === b.specialization);
      if (tech) techBonus = (tech.level || 0) * 5;
    }
    const parts = [];
    if (speed > 0) parts.push(`${speed}% from settings`);
    if (techBonus > 0) parts.push(`${techBonus}% from tech`);
    document.getElementById('tp-speednote').textContent = parts.length
      ? `(Includes ${parts.join(' + ')} production-speed bonus)`
      : '';
  }

  function renderConsumables(consumTotals, totalCost) {
    const section = document.getElementById('consumables-panel');
    if (!section) return;
    const entries = Object.entries(consumTotals).map(([id, qty]) => ({
      matId: parseInt(id),
      matName: gameData.getMaterialName(parseInt(id)),
      qty,
      unitPrice: allPrices[parseInt(id)] ?? 0,
      totalCost: qty * (allPrices[parseInt(id)] ?? 0)
    })).sort((a, b) => b.totalCost - a.totalCost);

    if (!settings.includeConsumables || !entries.length) { section.style.display = 'none'; return; }
    section.style.display = 'block';

    const consumSum = entries.reduce((s, e) => s + e.totalCost, 0);
    const pctOfTotal = totalCost > 0 ? (consumSum / totalCost) * 100 : 0;
    const mult = computeConsumptionMultiplier();

    document.getElementById('cp-total').textContent = GtApi.formatCredits(consumSum);
    document.getElementById('cp-pct').textContent = pctOfTotal.toFixed(1) + '%';
    document.getElementById('cp-overheadpct').textContent = mult.overheadFinalPct.toFixed(1) + '%';
    document.getElementById('cp-totalmult').textContent = '×' + mult.totalMult.toFixed(3);

    document.getElementById('cp-list').innerHTML = entries.map(e => `
      <div class="tree-row is-raw">
        <div class="left"><span class="mat-name">${e.matName}</span></div>
        <div class="right">
          <span class="qty-label">${formatQty(e.qty)}</span>
          <span class="price-label">${GtApi.formatCredits(e.unitPrice)}</span>
          <span class="total-label">${GtApi.formatCredits(e.totalCost)}</span>
        </div>
      </div>
    `).join('');
  }

  function renderSelfSufficiency(rawTotals, consumTotals) {
    const section = document.getElementById('selfsuf-panel');
    if (!section) return;
    if (!empireProduced) { section.style.display = 'none'; return; }

    const inputs = new Set([
      ...Object.keys(rawTotals).map(Number),
      ...Object.keys(consumTotals).map(Number)
    ]);
    if (!inputs.size) { section.style.display = 'none'; return; }
    section.style.display = 'block';

    const rows = [...inputs].map(mid => {
      const haveIt = empireProduced.has(mid);
      const qty = (rawTotals[mid] || 0) + (consumTotals[mid] || 0);
      return { mid, name: gameData.getMaterialName(mid), haveIt, qty };
    }).sort((a, b) => Number(b.haveIt) - Number(a.haveIt) || a.name.localeCompare(b.name));

    const produced = rows.filter(r => r.haveIt).length;
    document.getElementById('ss-ratio').textContent = `${produced} / ${rows.length}`;
    document.getElementById('ss-list').innerHTML = rows.map(r => `
      <div class="tree-row ${r.haveIt ? 'is-crafted' : 'is-raw'}" style="padding:4px 0">
        <div class="left">
          <span style="display:inline-block;width:18px;color:${r.haveIt ? 'var(--success,#2ecc71)' : 'var(--warn,#e67e22)'}">${r.haveIt ? '✓' : '✗'}</span>
          <span class="mat-name">${r.name}</span>
        </div>
        <div class="right">
          <span class="qty-label">${formatQty(r.qty)}</span>
          <span class="total-label" style="color:${r.haveIt ? 'var(--text-dim)' : 'var(--warn,#e67e22)'}">${r.haveIt ? 'produced' : 'must buy'}</span>
        </div>
      </div>
    `).join('');
  }

  function renderProfitScenarios(unitCost, matId, qty) {
    const section = document.getElementById('profit-panel');
    if (!section) return;
    const currentMkt = allPrices[matId];
    if (!currentMkt) { section.style.display = 'none'; return; }
    section.style.display = 'block';

    const guildPct = parseInt(document.getElementById('guild-slider').value);
    const marketPct = parseInt(document.getElementById('margin-slider').value);
    const scenarios = [
      { label: 'At Current Exchange', price: currentMkt },
      { label: `At Guild (+${guildPct}%)`, price: unitCost * (1 + guildPct / 100) },
      { label: `At Market (+${marketPct}%)`, price: unitCost * (1 + marketPct / 100) }
    ];

    document.getElementById('pr-list').innerHTML = scenarios.map(s => {
      const revenue = s.price * qty;
      const profit = (s.price - unitCost) * qty;
      const marginPct = unitCost > 0 ? ((s.price - unitCost) / unitCost) * 100 : 0;
      const cls = profit >= 0 ? 'positive' : 'negative';
      return `
        <div class="cost-row" style="padding:6px 0">
          <div class="cost-label">
            <div style="font-weight:600">${s.label}</div>
            <div style="font-size:10px;color:var(--text-muted)">${GtApi.formatCredits(s.price)} ea</div>
          </div>
          <div class="cost-value" style="text-align:right">
            <div class="text-mono">${GtApi.formatCredits(revenue)}</div>
            <div class="margin-pill ${cls}" style="font-size:10px">${profit >= 0 ? '+' : ''}${GtApi.formatCredits(profit)} (${marginPct.toFixed(1)}%)</div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ─── Main calculate action ─────────────────────────────────────────────────

  async function calculate() {
    if (!selectedMatId) return;

    const qty = Math.max(1, parseInt(document.getElementById('qty-input').value) || 1);
    const btn = document.getElementById('calc-btn');
    const errEl = document.getElementById('calc-error');

    btn.disabled = true;
    btn.textContent = 'Calculating…';
    errEl.style.display = 'none';

    try {
      // Fetch all market prices at once (5pts) for raw material costs
      const pricesRaw = await api.getMatPrices();
      const pricesArr = Array.isArray(pricesRaw) ? pricesRaw : (pricesRaw.prices || []);
      allPrices = {};
      for (const p of pricesArr) allPrices[p.matId] = p.currentPrice / 100; // API stores as integer cents

      // Kick off self-sufficiency + burden fetch (non-blocking)
      maybeFetchEmpireProduced().catch(() => {});
      autoLoadEmpireBurden().catch(() => {});
      // Perks must be awaited so the current calc uses them
      await autoLoadPerksFromCompany().catch(() => {});

      // Compute cost tree
      const rawTotals = {};
      const consumTotals = {};
      const topRef = {};
      const { cost, tree, timeMinutes } = await calcCost(
        selectedMatId, qty, 0, new Set(), rawTotals, consumTotals, topRef
      );

      lastResult = { tree, rawTotals, consumTotals, totalCost: cost, timeMinutes, topRef, qty };

      // Show results
      document.getElementById('result-placeholder').style.display = 'none';
      document.getElementById('result-section').classList.add('visible');

      renderPriceSummary(selectedMatId, qty, cost);
      renderTree(tree, document.getElementById('ingredient-tree'));
      renderRawSummary(rawTotals);
      renderThroughputAndBuilding(topRef, timeMinutes, qty);
      renderConsumables(consumTotals, cost);
      renderSelfSufficiency(rawTotals, consumTotals);
      renderProfitScenarios(cost / qty, selectedMatId, qty);
      window._updateRateLimit(api);
    } catch (err) {
      errEl.textContent = err.message.replace(/^[A-Z_]+: /, '');
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Calculate Cost';
    }
  }

  // ─── Auto-populate perk settings from /public/company ─────────────────────
  // CompanyPerkIdEnum mapping from swagger + observed per-level values
  const PERK_ENUM = {
    PRODUCTION_SPEED: 4,            // Workflow Optimization — +2%/lvl
    WORKFORCE_CONSUMPTION: 7,       // Workforce Efficiency — -2%/lvl
    OVERHEAD_REDUCTION: 8,          // Administrative Optimization — -2.5%/lvl
    STRICT_OVERSIGHT: 20,           // keystone +50% overhead, +25% speed
    LAX_OVERSIGHT: 21,              // -35%/lvl
    EFFICIENT_OVERSIGHT: 26         // -5%/lvl
  };

  let perksAutoLoaded = false;
  async function autoLoadPerksFromCompany() {
    if (perksAutoLoaded) return;
    try {
      const company = await api.getCompany();
      // Stash technologies for per-recipe speed bonus lookup
      if (Array.isArray(company?.technologies)) {
        companyTechnologies = company.technologies.map(t => ({
          id: typeof t.id === 'number' ? t.id : parseInt(t.id),
          level: t.level || 0
        }));
      }
      const perks = company?.perks;
      if (!Array.isArray(perks)) { perksAutoLoaded = true; return; }

      const byId = {};
      for (const p of perks) byId[p.id] = p.lvl || 0;

      settings.workforceEffLvl  = byId[PERK_ENUM.WORKFORCE_CONSUMPTION] || 0;
      settings.adminOptLvl      = byId[PERK_ENUM.OVERHEAD_REDUCTION] || 0;
      settings.efficientSupLvl  = byId[PERK_ENUM.EFFICIENT_OVERSIGHT] || 0;
      settings.laxSupLvl        = byId[PERK_ENUM.LAX_OVERSIGHT] || 0;
      settings.strictSup        = (byId[PERK_ENUM.STRICT_OVERSIGHT] || 0) > 0;
      // Workflow Optimization = +2% production speed per level (observed: max 5 → +10%)
      const speedLvl = byId[PERK_ENUM.PRODUCTION_SPEED] || 0;
      // Only overwrite if user hasn't customised (still at default 0)
      if (!settings.prodSpeedBonusPct) settings.prodSpeedBonusPct = speedLvl * 2;
      saveSettings();

      // Refresh settings panel inputs
      const sync = (id, val) => { const e = document.getElementById(id); if (e) { if (e.type === 'checkbox') e.checked = !!val; else e.value = val; } };
      sync('set-workforceEff', settings.workforceEffLvl);
      sync('set-adminOpt', settings.adminOptLvl);
      sync('set-efficientSup', settings.efficientSupLvl);
      sync('set-laxSup', settings.laxSupLvl);
      sync('set-strictSup', settings.strictSup);
      sync('set-prodSpeed', settings.prodSpeedBonusPct);

      const note = document.getElementById('perks-auto-note');
      if (note) {
        const count = perks.filter(p => p.lvl > 0).length;
        note.textContent = `✓ Auto-loaded ${count} perk${count === 1 ? '' : 's'} from your company`;
        note.style.color = 'var(--success, #2ecc71)';
      }
      perksAutoLoaded = true;
    } catch (_) {
      perksAutoLoaded = true;
    }
  }

  // ─── Auto-compute empire burden from base workforce ──────────────────────

  let burdenAutoLoaded = false;
  async function autoLoadEmpireBurden() {
    if (burdenAutoLoaded) return;
    try {
      const bases = await api.getBases();
      const basesArr = Array.isArray(bases) ? bases : (bases.bases || []);
      // Fetch each base in parallel
      const details = await Promise.all(
        basesArr.map(b => api.getBase(b.id).catch(() => null))
      );
      let burden = 0;
      for (const d of details) {
        const counts = d?.workforce?.workersCount;
        if (!Array.isArray(counts)) continue;
        burden += gameData.getBurdenForBuilding(counts);
      }
      if (burden > 0) {
        settings.empireBurden = Math.round(burden);
        saveSettings();
        const el = document.getElementById('set-empireBurden');
        if (el) el.value = settings.empireBurden;
        const note = document.getElementById('burden-auto-note');
        if (note) {
          note.textContent = `✓ Auto-computed burden: ${burden.toLocaleString()} from ${details.filter(Boolean).length} bases`;
          note.style.color = 'var(--success, #2ecc71)';
        }
      }
      burdenAutoLoaded = true;
    } catch (_) {
      burdenAutoLoaded = true;
    }
  }

  // ─── Empire self-sufficiency: what our own bases produce ──────────────────

  async function maybeFetchEmpireProduced() {
    if (empireProduced) return;
    try {
      const bases = await api.getBases();
      const basesArr = Array.isArray(bases) ? bases : (bases.bases || []);
      const set = new Set();
      for (const b of basesArr) {
        const orders = b.productionOrders || b.po || [];
        for (const o of orders) {
          const rId = o.rId || o.recipeId;
          if (!rId) continue;
          const recipe = gameData.recipes.find(r => r.id === rId);
          const outId = recipe?.output?.id ?? recipe?.output?.i;
          if (outId !== undefined) set.add(outId);
        }
      }
      empireProduced = set;
      if (lastResult) renderSelfSufficiency(lastResult.rawTotals, lastResult.consumTotals);
    } catch (_) {
      empireProduced = new Set(); // mark as attempted
    }
  }

  // ─── Live price updates when sliders change ────────────────────────────────

  function updatePricesOnly() {
    if (!lastResult || !selectedMatId) return;
    const qty = Math.max(1, parseInt(document.getElementById('qty-input').value) || 1);
    renderPriceSummary(selectedMatId, qty, lastResult.totalCost);
  }

  // ─── Expand/collapse all ───────────────────────────────────────────────────

  document.getElementById('expand-all-btn').addEventListener('click', function () {
    const tree = document.getElementById('ingredient-tree');
    const isExpanded = this.textContent === 'Collapse All';
    tree.querySelectorAll('.tree-indent').forEach(el => {
      el.style.display = isExpanded ? 'none' : 'block';
    });
    this.textContent = isExpanded ? 'Expand All' : 'Collapse All';
  });

  // ─── Event wiring ──────────────────────────────────────────────────────────

  document.getElementById('calc-btn').addEventListener('click', calculate);

  document.getElementById('margin-slider').addEventListener('input', function () {
    document.getElementById('margin-val').textContent = this.value + '%';
    updatePricesOnly();
  });

  document.getElementById('guild-slider').addEventListener('input', function () {
    document.getElementById('guild-val').textContent = this.value + '%';
    updatePricesOnly();
  });

  document.getElementById('qty-input').addEventListener('change', updatePricesOnly);

  // ─── Settings panel ────────────────────────────────────────────────────────

  function bindSetting(id, key, parser = v => v) {
    const el = document.getElementById(id);
    if (!el) return;
    // Populate
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else el.value = settings[key];
    el.addEventListener('change', () => {
      settings[key] = el.type === 'checkbox' ? el.checked : parser(el.value);
      saveSettings();
      // Re-run calc if we have a last result
      if (lastResult) calculate();
    });
  }

  bindSetting('set-workforceEff', 'workforceEffLvl', v => parseInt(v) || 0);
  bindSetting('set-adminOpt', 'adminOptLvl', v => parseInt(v) || 0);
  bindSetting('set-efficientSup', 'efficientSupLvl', v => parseInt(v) || 0);
  bindSetting('set-laxSup', 'laxSupLvl', v => parseInt(v) || 0);
  bindSetting('set-strictSup', 'strictSup');
  bindSetting('set-guildAdmin', 'guildAdminCenter', v => parseFloat(v) || 0);
  bindSetting('set-empireBurden', 'empireBurden', v => parseFloat(v) || 0);
  bindSetting('set-prodSpeed', 'prodSpeedBonusPct', v => parseFloat(v) || 0);
  bindSetting('set-includeOptionals', 'includeOptionals');
  bindSetting('set-includeConsumables', 'includeConsumables');

  const settingsToggle = document.getElementById('settings-toggle');
  const settingsBody = document.getElementById('settings-body');
  if (settingsToggle && settingsBody) {
    settingsToggle.addEventListener('click', () => {
      const hidden = settingsBody.style.display === 'none';
      settingsBody.style.display = hidden ? 'block' : 'none';
      settingsToggle.textContent = hidden ? '▾ Hide' : '▸ Show';
    });
  }

  document.getElementById('clear-btn').addEventListener('click', () => {
    selectedMatId = null;
    selectedRecipe = null;
    lastResult = null;
    document.getElementById('mat-search').value = '';
    document.getElementById('selected-mat').textContent = '';
    document.getElementById('recipe-selector').style.display = 'none';
    document.getElementById('calc-btn').disabled = true;
    document.getElementById('result-placeholder').style.display = 'block';
    document.getElementById('result-section').classList.remove('visible');
    document.getElementById('calc-error').style.display = 'none';
  });

  // ─── Init ──────────────────────────────────────────────────────────────────

  initAutocomplete().catch(err => {
    document.getElementById('calc-error').textContent =
      'Failed to load game data: ' + err.message;
    document.getElementById('calc-error').style.display = 'block';
  });
})();
