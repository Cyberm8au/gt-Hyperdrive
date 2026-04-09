/**
 * GT Companion — Base Production Planner
 *
 * Phase 1 MVP: Given a target material, resolve the recipe chain, let the
 * user tick which intermediates to self-produce, then compute the optimal
 * ratio of buildings needed to sustain a target daily output with minimal
 * excess materials.
 *
 * Algorithm (rational-ratio approach):
 *   1. Walk the recipe DAG from target downwards, collecting only
 *      self-produced nodes.
 *   2. For each self-produced material, note which building produces it,
 *      the recipe inputs/outputs per run, and run time.
 *   3. Express required runs/day for each building as a function of the
 *      target output rate, using exact rational arithmetic (BigInt) to
 *      avoid floating-point ratio drift.
 *   4. Scale all rational runs/day to integers (LCM of denominators) to
 *      find the minimum zero-excess integer ratio of buildings.
 *   5. Then scale that integer ratio to achieve the desired target
 *      output rate, rounding up where needed (which may introduce small
 *      excess on intermediates).
 *   6. Report: building counts, total workers, construction cost,
 *      slot usage, production orders, buy-list, excess.
 */
(function () {
  if (!GtApi.getStoredKey()) { window.location.href = 'index.html'; return; }

  const api = new GtApi(GtApi.getStoredKey());

  let selectedMatId = null;
  let selectedRecipe = null;
  let allPrices = {};        // matId → price in credits (not cents)
  let chainNodes = [];       // flat list of { matId, recipe, building, depth, parentMatId }
  let selfProduceSet = new Set(); // matIds the user wants to self-produce

  // ═══════════════════════════════════════════════════════════════════════════
  // §1 — Rational number helper (BigInt-based, exact arithmetic)
  // ═══════════════════════════════════════════════════════════════════════════

  function gcd(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { [a, b] = [b, a % b]; } return a; }
  function lcm(a, b) { return (a / gcd(a, b)) * b; }

  class Rat {
    constructor(n, d = 1n) {
      if (typeof n === 'number') n = BigInt(Math.round(n));
      if (typeof d === 'number') d = BigInt(Math.round(d));
      if (d < 0n) { n = -n; d = -d; }
      const g = gcd(n < 0n ? -n : n, d);
      this.n = n / g;
      this.d = d / g;
    }
    static from(v) { if (v instanceof Rat) return v; return new Rat(BigInt(Math.round(v))); }
    add(o) { o = Rat.from(o); return new Rat(this.n * o.d + o.n * this.d, this.d * o.d); }
    sub(o) { o = Rat.from(o); return new Rat(this.n * o.d - o.n * this.d, this.d * o.d); }
    mul(o) { o = Rat.from(o); return new Rat(this.n * o.n, this.d * o.d); }
    div(o) { o = Rat.from(o); return new Rat(this.n * o.d, this.d * o.n); }
    toFloat() { return Number(this.n) / Number(this.d); }
    ceil() { if (this.d === 1n) return Number(this.n); const f = this.n / this.d; return this.n > 0n && this.n % this.d !== 0n ? Number(f) + 1 : Number(f); }
    isZero() { return this.n === 0n; }
    toString() { return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`; }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §2 — Recipe chain resolver
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Walk the recipe DAG from `matId` and build a flat list of all craftable
   * intermediates with their recipes/buildings, down to raw materials.
   * Returns array of { matId, matName, recipe, building, inputs, outAmount, depth }.
   * Each matId appears at most once (deduped). Raw materials (no recipe) are NOT
   * included — they go into the buy-list.
   */
  function resolveChain(matId, topRecipe = null, depth = 0, visited = new Set(), result = []) {
    if (visited.has(matId)) return result;
    visited.add(matId);

    const recipe = depth === 0 && topRecipe ? topRecipe : gameData.getCraftingRecipe(matId);
    if (!recipe) return result; // raw material — skip

    const building = gameData.getRecipeBuilding(recipe);
    const output   = gameData.getRecipeOutput(recipe);
    const inputs   = gameData.getRecipeInputs(recipe);

    result.push({
      matId,
      matName: gameData.getMaterialName(matId),
      recipe,
      building,
      inputs,
      outAmount: output?.amount || 1,
      timeMinutes: recipe.timeMinutes || 1,
      depth
    });

    for (const inp of inputs) {
      resolveChain(inp.matId, null, depth + 1, visited, result);
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §3 — Zero-excess ratio solver
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Given the chain nodes and the selfProduceSet, compute the exact rational
   * number of runs per day each self-produced building needs, relative to
   * producing exactly 1 unit/day of the target.
   *
   * Then find the LCM scaling so all runs/day are integers (the "zero-excess
   * base ratio"), and finally scale to the requested target rate.
   *
   * Returns Map<matId, { runsPerDay: Rat, building, recipe, inputs, outAmount, ... }>
   */
  function solveRatios(targetMatId, chain, selfSet) {
    // Build a map of matId → chain node (only self-produced)
    const nodeMap = new Map();
    for (const node of chain) {
      if (node.matId === targetMatId || selfSet.has(node.matId)) {
        nodeMap.set(node.matId, { ...node, runsPerDay: new Rat(0n) });
      }
    }

    if (!nodeMap.has(targetMatId)) return nodeMap;

    // Start: to produce 1 unit/day of target, we need 1/outAmount runs/day
    // of the target building.
    const targetNode = nodeMap.get(targetMatId);
    targetNode.runsPerDay = new Rat(1n, BigInt(targetNode.outAmount));

    // BFS: propagate demand downward through the chain
    // Process in depth order (parents before children)
    const sorted = [...nodeMap.values()].sort((a, b) => a.depth - b.depth);

    for (const node of sorted) {
      if (node.runsPerDay.isZero()) continue;

      for (const inp of node.inputs) {
        const childNode = nodeMap.get(inp.matId);
        if (!childNode) continue; // this input is bought, not self-produced

        // This node needs `inp.amount * runsPerDay` units/day of the input.
        // The child building produces `childNode.outAmount` units per run.
        // So child needs += (inp.amount * node.runsPerDay) / childNode.outAmount runs/day
        const demand = node.runsPerDay
          .mul(new Rat(BigInt(inp.amount)))
          .div(new Rat(BigInt(childNode.outAmount)));
        childNode.runsPerDay = childNode.runsPerDay.add(demand);
      }
    }

    return nodeMap;
  }

  /**
   * Scale rational runs/day to a target daily output and compute building
   * slots with levels. A level-N building does N× output per run in the
   * same time (wiki: "level-N building uses N× inputs, produces N× outputs,
   * same time"). So instead of 53 level-1 buildings, you might need 5 slots
   * at levels ~10-11.
   *
   * Strategy: for each building type, compute the "effective level-1
   * equivalents" needed, then distribute across the minimum number of
   * building slots, spreading levels as evenly as possible.
   *
   * Returns array of plan entries with `slots` array instead of flat count.
   */
  function computePlan(targetMatId, ratioMap, targetRate, prodSlots) {
    const plan = [];

    const scale = Rat.from(targetRate);

    for (const [matId, node] of ratioMap) {
      if (node.runsPerDay.isZero()) continue;

      const runsPerDayNeeded = node.runsPerDay.mul(scale);
      const runsPerDayFloat  = runsPerDayNeeded.toFloat();

      // Each level-1 building does 1440/timeMinutes runs/day
      const runsPerL1PerDay = 1440 / node.timeMinutes;

      // "Level-1 equivalents" needed (a level-N building = N level-1 equivalents)
      const l1EquivNeeded = runsPerDayFloat / runsPerL1PerDay;

      // Distribute across building slots using levels.
      // We want the fewest slots possible → each slot at max useful level.
      // Spread evenly: if we need 53 L1-equiv, that's 6 slots at levels
      // [9,9,9,9,9,8] since 6×9=54 ≥ 53.
      const { slots, totalLevel } = distributeToSlots(l1EquivNeeded);
      const slotCount = slots.length;

      // Actual throughput: totalLevel × L1 throughput
      const runsPerDayActual = totalLevel * runsPerL1PerDay;
      const outputPerDay = runsPerDayActual * node.outAmount;
      const neededPerDay = runsPerDayFloat * node.outAmount;
      const excessPerDay = outputPerDay - neededPerDay;

      // Workers: each building slot uses the same workers regardless of level
      const wn = node.building?.workersNeeded || [0,0,0,0];
      const totalWorkers = wn.map(w => w * slotCount);

      plan.push({
        matId,
        matName: node.matName,
        building: node.building,
        buildingName: node.building?.name || '?',
        slotCount,
        slots,           // array of levels, e.g. [9, 9, 8]
        totalLevel,      // sum of all slot levels (= effective L1 equivalents)
        l1EquivNeeded,
        runsPerDayNeeded: runsPerDayFloat,
        runsPerDayActual,
        outputPerDay,
        neededPerDay,
        excessPerDay: Math.max(0, excessPerDay),
        workersNeeded: totalWorkers,
        recipe: node.recipe,
        inputs: node.inputs,
        outAmount: node.outAmount,
        timeMinutes: node.timeMinutes
      });
    }

    return plan;
  }

  /**
   * Given a fractional number of "level-1 equivalents" needed, distribute
   * across the minimum number of building slots with levels spread evenly.
   * Returns { slots: number[], totalLevel: number }.
   *
   * Example: 53 L1-equiv → 6 slots at [9,9,9,9,9,8] (total 53... but we
   * need to round up to cover demand, so [9,9,9,9,9,9] = 54).
   */
  function distributeToSlots(l1Equiv) {
    const totalNeeded = Math.ceil(l1Equiv); // round up to cover demand
    if (totalNeeded <= 0) return { slots: [1], totalLevel: 1 };
    if (totalNeeded === 1) return { slots: [1], totalLevel: 1 };

    // Find the optimal slot count: minimize slots while keeping max level
    // reasonable. We want the fewest slots, so each slot is at a higher level.
    // Max practical building level is ~30 (wiki says 200 but cost explodes).
    // We'll cap at 30 for planning purposes.
    const MAX_LEVEL = 30;

    // Minimum slots = ceil(totalNeeded / MAX_LEVEL)
    let slotCount = Math.ceil(totalNeeded / MAX_LEVEL);

    // Distribute evenly: base level + remainder get +1
    const baseLevel = Math.floor(totalNeeded / slotCount);
    const remainder = totalNeeded - baseLevel * slotCount;

    const slots = [];
    for (let i = 0; i < slotCount; i++) {
      slots.push(i < remainder ? baseLevel + 1 : baseLevel);
    }

    return { slots, totalLevel: totalNeeded };
  }

  /**
   * Compute the buy-list: materials that are NOT self-produced but are
   * consumed by self-produced buildings, scaled to the plan's actual runs/day.
   * Returns array of { matId, matName, qtyPerDay, unitPrice, costPerDay }
   */
  function computeBuyList(plan, selfSet, targetMatId) {
    const buys = {}; // matId → qty/day

    for (const entry of plan) {
      for (const inp of entry.inputs) {
        if (inp.matId === targetMatId || selfSet.has(inp.matId)) continue;
        // This input is bought
        const qtyPerDay = inp.amount * entry.runsPerDayActual;
        buys[inp.matId] = (buys[inp.matId] || 0) + qtyPerDay;
      }
    }

    return Object.entries(buys).map(([id, qty]) => {
      const matId = parseInt(id);
      const price = allPrices[matId] ?? 0;
      return {
        matId,
        matName: gameData.getMaterialName(matId),
        qtyPerDay: qty,
        unitPrice: price,
        costPerDay: qty * price
      };
    }).sort((a, b) => b.costPerDay - a.costPerDay);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §4 — Construction cost estimator
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Wiki upgrade cost growth factor for building at currentLevel → next level.
   * Levels 1-8:  Growth = (0.1 × currentLevel) + (1.07 ^ currentLevel)
   * Levels 9+:   Growth = 0.7 + (1.07^7) + ((currentLevel − 6) ^ 1.03) − (0.95 × (currentLevel − 6))
   * New build:   Growth = 1
   */
  function upgradeGrowth(currentLevel) {
    if (currentLevel === 0) return 1; // new build
    if (currentLevel <= 8) return (0.1 * currentLevel) + Math.pow(1.07, currentLevel);
    return 0.7 + Math.pow(1.07, 7) + Math.pow(currentLevel - 6, 1.03) - (0.95 * (currentLevel - 6));
  }

  /**
   * Estimate total build cost for a building with given slots and levels.
   * Cost to reach level N from scratch = sum of upgradeGrowth(0) + upgradeGrowth(1) + ... + upgradeGrowth(N-1)
   * applied to each base construction material.
   * Returns { totalCredits, materials: [{ matId, matName, qty }] }
   */
  function estimateBuildCost(building, slots) {
    const mats = building?.constructionMaterials || [];
    let totalCredits = 0;
    const materialTotals = {}; // matId → total qty

    // For each slot, sum growth factors from level 0 to target level
    for (const level of slots) {
      let growthSum = 0;
      for (let l = 0; l < level; l++) {
        growthSum += upgradeGrowth(l);
      }

      for (const cm of mats) {
        const matId = cm.id ?? cm.i;
        const baseQty = cm.a ?? cm.am ?? 0;
        const qty = Math.ceil(baseQty * growthSum);
        materialTotals[matId] = (materialTotals[matId] || 0) + qty;
      }
    }

    const materials = [];
    for (const [id, qty] of Object.entries(materialTotals)) {
      const matId = parseInt(id);
      const price = allPrices[matId] ?? 0;
      totalCredits += qty * price;
      materials.push({
        matId,
        matName: gameData.getMaterialName(matId),
        qty
      });
    }

    return { totalCredits, materials };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §5 — Autocomplete (reused pattern from cost-calc)
  // ═══════════════════════════════════════════════════════════════════════════

  async function initAutocomplete() {
    await gameData.load();

    const input = document.getElementById('bp-mat-search');
    const list  = document.getElementById('bp-autocomplete-list');

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

    document.addEventListener('click', e => {
      if (!e.target.closest('.autocomplete-wrap')) list.style.display = 'none';
    });

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

    document.getElementById('bp-mat-search').value = mat.name;
    document.getElementById('bp-autocomplete-list').style.display = 'none';
    document.getElementById('bp-selected-mat').textContent =
      `Tier ${mat.tier} · ${mat.description || ''}`.slice(0, 120);

    // Show recipe options if multiple exist
    const recipes = gameData.getRecipesForOutput(matId).filter(r => r.inputs?.length > 0);
    const recipeSection = document.getElementById('bp-recipe-selector');
    const recipeOptions = document.getElementById('bp-recipe-options');

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
          buildChainUI();
        });
      });
    } else {
      recipeSection.style.display = 'none';
      selectedRecipe = recipes[0] || null;
    }

    document.getElementById('bp-calc-btn').disabled = !selectedRecipe;
    if (selectedRecipe) buildChainUI();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §6 — Chain tickbox UI
  // ═══════════════════════════════════════════════════════════════════════════

  function buildChainUI() {
    if (!selectedMatId || !selectedRecipe) return;

    chainNodes = resolveChain(selectedMatId, selectedRecipe);
    // Auto-select: by default self-produce everything except raw materials
    selfProduceSet = new Set(chainNodes.filter(n => n.matId !== selectedMatId).map(n => n.matId));

    renderChainTree();

    const panel = document.getElementById('bp-chain-panel');
    panel.style.display = 'block';
  }

  function renderChainTree() {
    const container = document.getElementById('bp-chain-tree');
    container.innerHTML = '';

    for (const node of chainNodes) {
      const isTarget = node.matId === selectedMatId;
      const isSelf   = isTarget || selfProduceSet.has(node.matId);
      const indent   = node.depth * 20;

      const div = document.createElement('div');
      div.className = 'chain-node';
      div.style.paddingLeft = indent + 'px';

      if (isTarget) {
        div.innerHTML = `
          <span class="mat-tier-badge">T${gameData.getMaterialTier(node.matId)}</span>
          <strong>${node.matName}</strong>
          <span class="building-tag">(${node.building?.name || '?'})</span>
          <span class="chain-self">TARGET</span>
        `;
      } else {
        const id = `bp-chain-${node.matId}`;
        div.innerHTML = `
          <label>
            <input type="checkbox" id="${id}" ${isSelf ? 'checked' : ''}>
            <span class="mat-tier-badge">T${gameData.getMaterialTier(node.matId)}</span>
            ${node.matName}
          </label>
          <span class="building-tag">(${node.building?.name || '?'})</span>
          ${isSelf
            ? '<span class="chain-self">self-produce</span>'
            : '<span class="chain-buy">buy</span>'}
        `;

        const cb = div.querySelector('input');
        cb.addEventListener('change', () => {
          if (cb.checked) selfProduceSet.add(node.matId);
          else selfProduceSet.delete(node.matId);
          renderChainTree(); // re-render to update labels
        });
      }

      container.appendChild(div);
    }
  }

  // Wire select all / select none
  document.getElementById('bp-select-all').addEventListener('click', () => {
    selfProduceSet = new Set(chainNodes.filter(n => n.matId !== selectedMatId).map(n => n.matId));
    renderChainTree();
  });
  document.getElementById('bp-select-none').addEventListener('click', () => {
    selfProduceSet.clear();
    renderChainTree();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // §7 — Generate plan (main action)
  // ═══════════════════════════════════════════════════════════════════════════

  async function generatePlan() {
    if (!selectedMatId || !selectedRecipe) return;

    const targetRate    = Math.max(1, parseInt(document.getElementById('bp-target-rate').value) || 100);
    const maxSlots      = parseInt(document.getElementById('bp-max-slots').value) || 25;
    const reservedSlots = parseInt(document.getElementById('bp-reserved-slots').value) || 3;
    const prodSlots     = maxSlots - reservedSlots;

    const btn   = document.getElementById('bp-calc-btn');
    const errEl = document.getElementById('bp-error');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    errEl.style.display = 'none';

    try {
      // Fetch market prices
      const pricesRaw = await api.getMatPrices();
      const pricesArr = Array.isArray(pricesRaw) ? pricesRaw : (pricesRaw.prices || []);
      allPrices = {};
      for (const p of pricesArr) allPrices[p.matId] = p.currentPrice / 100;

      // Solve ratios
      const ratioMap = solveRatios(selectedMatId, chainNodes, selfProduceSet);
      const plan = computePlan(selectedMatId, ratioMap, targetRate, prodSlots);
      const buyList = computeBuyList(plan, selfProduceSet, selectedMatId);

      // Check slot feasibility
      const totalSlots = plan.reduce((s, e) => s + e.slotCount, 0);
      const slotWarning = totalSlots > prodSlots
        ? `⚠ Plan requires ${totalSlots} building slots but only ${prodSlots} production slots available (${maxSlots} − ${reservedSlots} reserved). Consider reducing target rate or buying more intermediates.`
        : null;

      // Render
      renderPlanResults(plan, buyList, targetRate, totalSlots, prodSlots, slotWarning);

      document.getElementById('bp-placeholder').style.display = 'none';
      document.getElementById('bp-result-section').classList.add('visible');
      window._updateRateLimit(api);

    } catch (err) {
      errEl.textContent = err.message.replace(/^[A-Z_]+: /, '');
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate Plan';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §8 — Render results
  // ═══════════════════════════════════════════════════════════════════════════

  function renderPlanResults(plan, buyList, targetRate, totalSlots, prodSlots, slotWarning) {
    const matName = gameData.getMaterialName(selectedMatId);
    document.getElementById('bp-res-name').textContent = `${matName} @ ${targetRate}/day`;

    // Worker totals
    const workerTotals = [0, 0, 0, 0];
    for (const entry of plan) {
      for (let i = 0; i < 4; i++) workerTotals[i] += entry.workersNeeded[i];
    }
    const totalWorkers = workerTotals.reduce((a, b) => a + b, 0);

    // Burden
    const burdenWeights = [1.0, 1.5, 2.5, 4.0];
    const burden = workerTotals.reduce((s, w, i) => s + w * burdenWeights[i], 0);

    // Total build cost (using slots with levels)
    let totalBuildCost = 0;
    for (const entry of plan) {
      const cost = estimateBuildCost(entry.building, entry.slots);
      totalBuildCost += cost.totalCredits;
    }

    // Daily buy cost
    const dailyBuyCost = buyList.reduce((s, b) => s + b.costPerDay, 0);

    // Daily revenue (target output × market price)
    const targetPrice = allPrices[selectedMatId] ?? 0;
    const dailyRevenue = targetRate * targetPrice;
    const dailyProfit = dailyRevenue - dailyBuyCost;

    // Summary grid
    const summaryGrid = document.getElementById('bp-summary-grid');
    const slotsColor = totalSlots > prodSlots ? 'var(--red)' : 'var(--green)';
    summaryGrid.innerHTML = `
      <div class="plan-stat-box">
        <div class="psb-label">Building Slots</div>
        <div class="psb-value" style="color:${slotsColor}">${totalSlots}</div>
        <div class="psb-sub">of ${prodSlots} prod slots</div>
      </div>
      <div class="plan-stat-box">
        <div class="psb-label">Workers</div>
        <div class="psb-value">${totalWorkers.toLocaleString()}</div>
        <div class="psb-sub">burden: ${burden.toLocaleString()}</div>
      </div>
      <div class="plan-stat-box">
        <div class="psb-label">Build Cost</div>
        <div class="psb-value" style="color:var(--gold)">${GtApi.formatCredits(totalBuildCost)}</div>
        <div class="psb-sub">construction materials</div>
      </div>
      <div class="plan-stat-box">
        <div class="psb-label">Daily Input Cost</div>
        <div class="psb-value">${GtApi.formatCredits(dailyBuyCost)}</div>
        <div class="psb-sub">materials to buy</div>
      </div>
      <div class="plan-stat-box">
        <div class="psb-label">Daily Revenue</div>
        <div class="psb-value" style="color:var(--green)">${GtApi.formatCredits(dailyRevenue)}</div>
        <div class="psb-sub">at market price</div>
      </div>
      <div class="plan-stat-box">
        <div class="psb-label">Daily Profit</div>
        <div class="psb-value" style="color:${dailyProfit >= 0 ? 'var(--green)' : 'var(--red)'}">${dailyProfit >= 0 ? '+' : ''}${GtApi.formatCredits(dailyProfit)}</div>
        <div class="psb-sub">revenue − input cost</div>
      </div>
    `;

    if (slotWarning) {
      summaryGrid.insertAdjacentHTML('afterend',
        `<div class="error-box" style="margin-top:12px">${slotWarning}</div>`
      );
    }

    // Building list
    const buildingList = document.getElementById('bp-building-list');
    buildingList.innerHTML = plan.map(entry => {
      const cost = estimateBuildCost(entry.building, entry.slots);
      const wStr = entry.workersNeeded.map((w, i) => w > 0 ? `${w}${['W','T','E','S'][i]}` : '').filter(Boolean).join(' ');

      // Format slot levels: if all same → "3 slots @ Lv 9", else list them
      const allSame = entry.slots.every(l => l === entry.slots[0]);
      let levelStr;
      if (entry.slotCount === 1) {
        levelStr = `1 slot @ Lv ${entry.slots[0]}`;
      } else if (allSame) {
        levelStr = `${entry.slotCount} slots @ Lv ${entry.slots[0]}`;
      } else {
        levelStr = `${entry.slotCount} slots (Lv ${entry.slots.join(', ')})`;
      }

      return `
        <div class="plan-building-row">
          <div>
            <div class="bld-name">${entry.buildingName}</div>
            <div style="font-size:10px;color:var(--text-muted)">→ ${entry.matName} (${entry.outAmount}/run, ${entry.timeMinutes}min)</div>
            <div style="font-size:10px;color:var(--accent-dim)">${levelStr}</div>
          </div>
          <div class="bld-count">${entry.slotCount} slots</div>
          <div class="bld-workers">${wStr || '—'}</div>
          <div class="bld-cost">${GtApi.formatCredits(cost.totalCredits)}</div>
        </div>
      `;
    }).join('');

    // Worker summary
    const tierLabels = ['Workers', 'Technicians', 'Engineers', 'Scientists'];
    document.getElementById('bp-worker-summary').innerHTML = workerTotals.map((w, i) =>
      w > 0 ? `<div class="worker-summary-row"><span class="ws-tier">${tierLabels[i]}</span><span class="ws-count">${w.toLocaleString()}</span></div>` : ''
    ).join('');
    document.getElementById('bp-burden-info').textContent =
      `Total burden: ${burden.toLocaleString()} (threshold: 2,000 — ${burden > 2000 ? 'overhead applies!' : 'below threshold'})`;

    // Production orders
    const poList = document.getElementById('bp-po-list');
    poList.innerHTML = plan.map(entry => {
      const inputStr = entry.inputs.map(inp =>
        `${inp.amount}× ${gameData.getMaterialShortName(inp.matId)}`
      ).join(', ');
      const allSame = entry.slots.every(l => l === entry.slots[0]);
      const slotDesc = entry.slotCount === 1
        ? `1 slot @ Lv ${entry.slots[0]}`
        : allSame
          ? `${entry.slotCount} slots @ Lv ${entry.slots[0]}`
          : `${entry.slotCount} slots (Lv ${entry.slots.join(', ')})`;
      const runsPerSlot = (1440 / entry.timeMinutes).toFixed(1);
      return `
        <div class="po-card">
          <div class="po-title">${entry.buildingName} — ${slotDesc}</div>
          <div class="po-detail">
            Recipe: ${inputStr} → ${entry.outAmount}× ${entry.matName}<br>
            Runs/slot/day: ${runsPerSlot} &nbsp;|&nbsp;
            Effective output/day: ${entry.outputPerDay.toFixed(1)} units
            (Lv scales ×inputs and ×outputs)
            ${entry.excessPerDay > 0.01 ? `<br><span style="color:var(--orange)">Excess: +${entry.excessPerDay.toFixed(1)}/day</span>` : ''}
          </div>
        </div>
      `;
    }).join('');

    // Buy list
    const buyListEl = document.getElementById('bp-buy-list');
    if (buyList.length === 0) {
      buyListEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">No external inputs needed — fully self-sufficient!</div>';
    } else {
      buyListEl.innerHTML = buyList.map(b => `
        <div class="tree-row is-raw" style="padding:4px 0">
          <div class="left"><span class="mat-name">${b.matName}</span></div>
          <div class="right">
            <span class="qty-label">${formatQty(b.qtyPerDay)}/day</span>
            <span class="price-label">${GtApi.formatCredits(b.unitPrice)} ea</span>
            <span class="total-label">${GtApi.formatCredits(b.costPerDay)}/day</span>
          </div>
        </div>
      `).join('');
    }

    // Excess materials
    const excessEntries = plan.filter(e => e.excessPerDay > 0.01);
    const excessPanel = document.getElementById('bp-excess-panel');
    if (excessEntries.length === 0) {
      excessPanel.style.display = 'none';
    } else {
      excessPanel.style.display = 'block';
      document.getElementById('bp-excess-list').innerHTML = excessEntries.map(e => {
        const price = allPrices[e.matId] ?? 0;
        return `
          <div class="tree-row is-crafted" style="padding:4px 0">
            <div class="left"><span class="mat-name">${e.matName}</span></div>
            <div class="right">
              <span class="qty-label">+${formatQty(e.excessPerDay)}/day</span>
              <span class="price-label">${GtApi.formatCredits(price)} ea</span>
              <span class="total-label">${GtApi.formatCredits(e.excessPerDay * price)}/day</span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  function formatQty(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
    if (n >= 1000)    return (n / 1000).toFixed(2) + 'K';
    return Number(n.toFixed(2)).toString();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §9 — Copy plan to clipboard
  // ═══════════════════════════════════════════════════════════════════════════

  function copyPlan() {
    if (!selectedMatId) return;

    const matName = gameData.getMaterialName(selectedMatId);
    const targetRate = parseInt(document.getElementById('bp-target-rate').value) || 100;

    // Reconstruct plan data for text output
    const ratioMap = solveRatios(selectedMatId, chainNodes, selfProduceSet);
    const plan = computePlan(selectedMatId, ratioMap, targetRate);
    const buyList = computeBuyList(plan, selfProduceSet, selectedMatId);

    const workerTotals = [0, 0, 0, 0];
    for (const entry of plan) {
      for (let i = 0; i < 4; i++) workerTotals[i] += entry.workersNeeded[i];
    }

    const tierLabels = ['W', 'T', 'E', 'S'];
    const workerStr = workerTotals.map((w, i) => w > 0 ? `${w}${tierLabels[i]}` : '').filter(Boolean).join(' + ');
    const totalSlots = plan.reduce((s, e) => s + e.slotCount, 0);

    let text = `# Base Plan: ${matName} @ ${targetRate}/day\n\n`;
    text += `## Buildings (${totalSlots} slots)\n`;
    for (const entry of plan) {
      const allSame = entry.slots.every(l => l === entry.slots[0]);
      const lvlStr = entry.slotCount === 1
        ? `Lv ${entry.slots[0]}`
        : allSame
          ? `${entry.slotCount}× Lv ${entry.slots[0]}`
          : `Lv ${entry.slots.join(', ')}`;
      text += `- ${entry.slotCount}× ${entry.buildingName} (${lvlStr}) → ${entry.matName}\n`;
    }
    text += `\n## Workers: ${workerStr}\n`;
    if (buyList.length > 0) {
      text += `\n## Daily Inputs (buy)\n`;
      for (const b of buyList) {
        text += `- ${formatQty(b.qtyPerDay)}/day ${b.matName}\n`;
      }
    }
    text += `\n_Generated by GT Companion Base Planner_\n`;

    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('bp-copy-btn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => btn.textContent = '📋 Copy Plan', 2000);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §10 — Event wiring
  // ═══════════════════════════════════════════════════════════════════════════

  document.getElementById('bp-calc-btn').addEventListener('click', generatePlan);
  document.getElementById('bp-copy-btn').addEventListener('click', copyPlan);

  document.getElementById('bp-clear-btn').addEventListener('click', () => {
    selectedMatId = null;
    selectedRecipe = null;
    chainNodes = [];
    selfProduceSet.clear();
    document.getElementById('bp-mat-search').value = '';
    document.getElementById('bp-selected-mat').textContent = '';
    document.getElementById('bp-recipe-selector').style.display = 'none';
    document.getElementById('bp-chain-panel').style.display = 'none';
    document.getElementById('bp-calc-btn').disabled = true;
    document.getElementById('bp-placeholder').style.display = 'block';
    document.getElementById('bp-result-section').classList.remove('visible');
    document.getElementById('bp-error').style.display = 'none';
  });

  // ─── Init ──────────────────────────────────────────────────────────────────

  initAutocomplete().catch(err => {
    document.getElementById('bp-error').textContent =
      'Failed to load game data: ' + err.message;
    document.getElementById('bp-error').style.display = 'block';
  });
})();
