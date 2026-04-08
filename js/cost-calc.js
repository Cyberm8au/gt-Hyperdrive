/**
 * GT Companion — Production Cost Calculator Logic
 */
(function () {
  if (!GtApi.getStoredKey()) { window.location.href = 'index.html'; return; }

  const api = new GtApi(GtApi.getStoredKey());

  let selectedMatId = null;
  let selectedRecipe = null;
  let allPrices = {};       // matId → currentPrice
  let lastResult = null;    // { tree, rawTotals, totalCost }

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
  async function calcCost(matId, qty, depth = 0, visited = new Set(), rawTotals = {}) {
    if (depth > 10) return { cost: 0, tree: [] }; // guard against deep recursion

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
        tree: [{
          matId, matName, qty, unitPrice: price,
          totalCost, isRaw: true, depth, children: []
        }]
      };
    }

    // Guard circular references
    if (visited.has(matId)) {
      const price = allPrices[matId] ?? 0;
      return { cost: price * qty, tree: [{ matId, matName, qty, unitPrice: price, totalCost: price * qty, isRaw: true, depth, children: [] }] };
    }
    visited.add(matId);

    const output  = gameData.getRecipeOutput(recipe);
    const inputs  = gameData.getRecipeInputs(recipe);
    const outAmt  = output?.amount || 1;
    // How many recipe runs needed to produce `qty` units
    const runs    = qty / outAmt;

    let totalCost = 0;
    const children = [];

    for (const inp of inputs) {
      const neededQty = inp.amount * runs;
      const sub = await calcCost(inp.matId, neededQty, depth + 1, new Set(visited), rawTotals);
      totalCost += sub.cost;
      children.push(...sub.tree);
    }

    visited.delete(matId);

    return {
      cost: totalCost,
      tree: [{
        matId, matName, qty,
        unitPrice: totalCost / qty,
        totalCost, isRaw: false, depth, children
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
      ? GtApi.formatNum(Math.round(node.unitPrice)) + ' cr'
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
          <span class="price-label">${GtApi.formatNum(Math.round(e.unitPrice))} cr</span>
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
    document.getElementById('res-unitcost').textContent = GtApi.formatNum(Math.round(unitCost)) + ' cr';

    document.getElementById('res-breakeven').textContent = GtApi.formatNum(Math.round(unitCost)) + ' cr';
    document.getElementById('res-guild').textContent     = GtApi.formatNum(guildPrice) + ' cr';
    document.getElementById('res-guild-sub').innerHTML   = `at <span id="res-guild-pct">${guildPct}</span>% margin`;
    document.getElementById('res-market').textContent    = GtApi.formatNum(marketPrice) + ' cr';
    document.getElementById('res-market-sub').innerHTML  = `at <span id="res-market-pct">${marginPct}</span>% margin`;

    if (currentMkt !== null) {
      document.getElementById('res-current').textContent = GtApi.formatNum(currentMkt) + ' cr';
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
      for (const p of pricesArr) allPrices[p.matId] = p.currentPrice;

      // Compute cost tree
      const rawTotals = {};
      const { cost, tree } = await calcCost(selectedMatId, qty, 0, new Set(), rawTotals);

      lastResult = { tree, rawTotals, totalCost: cost };

      // Show results
      document.getElementById('result-placeholder').style.display = 'none';
      document.getElementById('result-section').classList.add('visible');

      renderPriceSummary(selectedMatId, qty, cost);
      renderTree(tree, document.getElementById('ingredient-tree'));
      renderRawSummary(rawTotals);
      window._updateRateLimit(api);
    } catch (err) {
      errEl.textContent = err.message.replace(/^[A-Z_]+: /, '');
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Calculate Cost';
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
