/**
 * GT Companion — Base Optimizer
 *
 * Loads an existing base from the API, displays its current state, then
 * lets the user specify target products. Compares the current layout against
 * an ideal configuration (using the same ratio solver as the base planner)
 * and generates step-by-step recommendations: upgrade, scrap, build, re-order.
 */
(function () {
  if (!GtApi.getStoredKey()) { window.location.href = 'index.html'; return; }

  const api = new GtApi(GtApi.getStoredKey());

  let currentBase = null;      // PBaseDetailResponseModel
  let baseSlots = [];           // parsed slot data
  let targetMatIds = [];        // user-selected target material IDs
  let allPrices = {};           // matId → credits (not cents)

  // ═══════════════════════════════════════════════════════════════════════════
  // §1 — Rational arithmetic (same as base-planner)
  // ═══════════════════════════════════════════════════════════════════════════

  function gcd(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { [a, b] = [b, a % b]; } return a; }

  class Rat {
    constructor(n, d = 1n) {
      if (typeof n === 'number') n = BigInt(Math.round(n));
      if (typeof d === 'number') d = BigInt(Math.round(d));
      if (d < 0n) { n = -n; d = -d; }
      const g = gcd(n < 0n ? -n : n, d);
      this.n = n / g; this.d = d / g;
    }
    static from(v) { if (v instanceof Rat) return v; return new Rat(BigInt(Math.round(v))); }
    add(o) { o = Rat.from(o); return new Rat(this.n * o.d + o.n * this.d, this.d * o.d); }
    mul(o) { o = Rat.from(o); return new Rat(this.n * o.n, this.d * o.d); }
    div(o) { o = Rat.from(o); return new Rat(this.n * o.d, this.d * o.n); }
    toFloat() { return Number(this.n) / Number(this.d); }
    isZero() { return this.n === 0n; }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §2 — Load bases list
  // ═══════════════════════════════════════════════════════════════════════════

  async function loadBasesList() {
    try {
      await gameData.load();
      const bases = await api.getBases();
      const basesArr = Array.isArray(bases) ? bases : [];
      const select = document.getElementById('bo-base-select');

      if (!basesArr.length) {
        select.innerHTML = '<option value="">No bases found</option>';
        return;
      }

      select.innerHTML = '<option value="">— Select a base —</option>' +
        basesArr.map(b => `<option value="${b.id}">${b.name} (Planet #${b.planetId})</option>`).join('');
      document.getElementById('bo-load-btn').disabled = false;

      select.addEventListener('change', () => {
        document.getElementById('bo-load-btn').disabled = !select.value;
      });

      window._updateRateLimit(api);
    } catch (err) {
      showError('bo-load-error', err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §3 — Load base detail + render snapshot
  // ═══════════════════════════════════════════════════════════════════════════

  async function loadBase() {
    const baseId = document.getElementById('bo-base-select').value;
    if (!baseId) return;

    const btn = document.getElementById('bo-load-btn');
    btn.disabled = true;
    btn.textContent = 'Loading…';
    hideError('bo-load-error');

    try {
      currentBase = await api.getBase(parseInt(baseId));

      // Parse building slots
      baseSlots = (currentBase.buildingSlots || []).map(slot => {
        const b = slot.building;
        if (!b) return { slotId: slot.id, status: slot.status, empty: true };

        const gdBuilding = gameData.getBuilding(b.type);
        const recipeName = b.task?.rId
          ? getRecipeOutputName(b.task.rId)
          : null;
        const isHousing = gdBuilding?.workersHousing?.some(h => h > 0);
        const isHQ = b.type === 9;
        // Warehouse = no recipes, no housing, not HQ (building 14, but detect generically)
        const isWarehouse = !isHQ && !isHousing &&
          (!gdBuilding?.recipesIds || gdBuilding.recipesIds.length === 0);

        return {
          slotId: slot.id,
          status: slot.status,
          empty: false,
          buildingType: b.type,
          buildingName: gdBuilding?.name || `Building #${b.type}`,
          level: b.level,
          condition: b.cond,
          isHousing,
          isHQ,
          isWarehouse,
          gdBuilding,
          activeRecipeId: b.task?.rId || null,
          recipeName,
          workersNeeded: gdBuilding?.workersNeeded || [0,0,0,0]
        };
      });

      renderBaseSnapshot();

      // Show targets panel
      document.getElementById('bo-targets-panel').style.display = 'block';
      document.getElementById('bo-snapshot').classList.add('visible');
      document.getElementById('bo-placeholder').style.display = 'none';

      window._updateRateLimit(api);
    } catch (err) {
      showError('bo-load-error', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Load Base';
    }
  }

  function getRecipeOutputName(recipeId) {
    const recipe = gameData.recipes.find(r => r.id === recipeId);
    if (!recipe) return null;
    const outId = recipe.output?.id ?? recipe.output?.i;
    return outId !== undefined ? gameData.getMaterialName(outId) : null;
  }

  function getRecipeOutputId(recipeId) {
    const recipe = gameData.recipes.find(r => r.id === recipeId);
    if (!recipe) return null;
    return recipe.output?.id ?? recipe.output?.i ?? null;
  }

  function renderBaseSnapshot() {
    const wf = currentBase.workforce || {};
    const wh = currentBase.warehouse || {};
    const whUsed = (wh.mats || []).reduce((s, m) => s + (m.am || m.qty || 0), 0);
    const whPct = wh.cap > 0 ? Math.round((whUsed / wh.cap) * 100) : 0;

    const totalSlots = baseSlots.length;
    const usedSlots = baseSlots.filter(s => !s.empty).length;
    const emptySlots = baseSlots.filter(s => s.empty && s.status === 1).length;
    const debrisSlots = baseSlots.filter(s => s.status === 3).length;
    const prodSlots = baseSlots.filter(s => !s.empty && !s.isHousing && !s.isHQ && !s.isWarehouse);
    const housingSlots = baseSlots.filter(s => s.isHousing);
    const warehouseSlots = baseSlots.filter(s => s.isWarehouse);

    // Current products being made
    const currentProducts = new Set();
    for (const s of baseSlots) {
      if (s.activeRecipeId) {
        const outId = getRecipeOutputId(s.activeRecipeId);
        if (outId !== null) currentProducts.add(outId);
      }
    }

    document.getElementById('bo-base-name').textContent = currentBase.name;

    document.getElementById('bo-base-summary').innerHTML = `
      <div class="plan-stat-box">
        <div class="psb-label">Slots</div>
        <div class="psb-value">${usedSlots}/${totalSlots}</div>
        <div class="psb-sub">${emptySlots} empty${debrisSlots ? `, ${debrisSlots} debris` : ''}</div>
      </div>
      <div class="plan-stat-box">
        <div class="psb-label">Production</div>
        <div class="psb-value">${prodSlots.length}</div>
        <div class="psb-sub">${currentProducts.size} products</div>
      </div>
      <div class="plan-stat-box">
        <div class="psb-label">Housing</div>
        <div class="psb-value">${housingSlots.length}</div>
        <div class="psb-sub">${housingSlots.map(h => `Lv${h.level}`).join(', ') || '—'}</div>
      </div>
      <div class="plan-stat-box">
        <div class="psb-label">Warehouses</div>
        <div class="psb-value">${warehouseSlots.length}</div>
        <div class="psb-sub">${warehouseSlots.map(h => `Lv${h.level}`).join(', ') || '—'} (${GtApi.formatNum(wh.cap || 0)}t)</div>
      </div>
      <div class="plan-stat-box">
        <div class="psb-label">Storage</div>
        <div class="psb-value">${whPct}%</div>
        <div class="psb-sub">${GtApi.formatNum(whUsed)}/${GtApi.formatNum(wh.cap || 0)}t</div>
      </div>
    `;

    // Render slot grid
    document.getElementById('bo-slot-grid').innerHTML = baseSlots.map(s => {
      if (s.empty) {
        const label = s.status === 3 ? 'Debris' : s.status === 4 ? 'Premium (locked)' : 'Empty';
        return `<div class="slot-card slot-empty"><div class="slot-name">${label}</div><div class="slot-detail">Slot #${s.slotId}</div></div>`;
      }
      const cls = s.isHQ ? 'slot-hq' : s.isHousing ? 'slot-housing' : s.isWarehouse ? 'slot-warehouse' : 'slot-production';
      const condPct = Math.round((s.condition || 0) * 100);
      const condColor = condPct < 60 ? 'var(--red)' : condPct < 85 ? 'var(--yellow)' : 'var(--green)';
      return `
        <div class="slot-card ${cls}">
          <div class="slot-name">${s.buildingName} <span class="slot-level">Lv ${s.level}</span></div>
          <div class="slot-detail">Cond: <span style="color:${condColor}">${condPct}%</span></div>
          ${s.recipeName ? `<div class="slot-recipe">→ ${s.recipeName}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §4 — Target product selection
  // ═══════════════════════════════════════════════════════════════════════════

  function initProductSearch() {
    const input = document.getElementById('bo-product-search');
    const list  = document.getElementById('bo-autocomplete-list');

    input.addEventListener('input', () => {
      const q = input.value.trim();
      if (q.length < 1) { list.style.display = 'none'; return; }

      // Only show craftable materials (have a recipe with inputs)
      const results = gameData.searchMaterials(q)
        .filter(m => gameData.getRecipesForOutput(m.id).some(r => r.inputs?.length > 0))
        .slice(0, 10);
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
          const matId = parseInt(el.dataset.id);
          addTargetProduct(matId);
          input.value = '';
          list.style.display = 'none';
        });
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
        if (active) { addTargetProduct(parseInt(active.dataset.id)); input.value = ''; list.style.display = 'none'; }
      } else if (e.key === 'Escape') {
        list.style.display = 'none';
      }
    });
  }

  function addTargetProduct(matId) {
    if (targetMatIds.includes(matId)) return;
    targetMatIds.push(matId);
    renderTargetTags();
    document.getElementById('bo-optimize-btn').disabled = targetMatIds.length === 0;
  }

  function removeTargetProduct(matId) {
    targetMatIds = targetMatIds.filter(id => id !== matId);
    renderTargetTags();
    document.getElementById('bo-optimize-btn').disabled = targetMatIds.length === 0;
  }

  function renderTargetTags() {
    const container = document.getElementById('bo-target-tags');
    container.innerHTML = targetMatIds.map(matId => {
      const name = gameData.getMaterialName(matId);
      return `
        <div class="target-tag">
          <span>${name}</span>
          <span class="tag-remove" data-id="${matId}">&times;</span>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.tag-remove').forEach(el => {
      el.addEventListener('click', () => removeTargetProduct(parseInt(el.dataset.id)));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §5 — Recipe chain + ratio solver (shared logic from base-planner)
  // ═══════════════════════════════════════════════════════════════════════════

  function resolveChain(matId, topRecipe = null, depth = 0, visited = new Set(), result = []) {
    if (visited.has(matId)) return result;
    visited.add(matId);
    const recipe = depth === 0 && topRecipe ? topRecipe : gameData.getCraftingRecipe(matId);
    if (!recipe) return result;
    const building = gameData.getRecipeBuilding(recipe);
    const output = gameData.getRecipeOutput(recipe);
    const inputs = gameData.getRecipeInputs(recipe);
    result.push({ matId, recipe, building, inputs, outAmount: output?.amount || 1, timeMinutes: recipe.timeMinutes || 1, depth });
    for (const inp of inputs) resolveChain(inp.matId, null, depth + 1, visited, result);
    return result;
  }

  function solveRatios(targetMatId, chain, selfSet) {
    const nodeMap = new Map();
    for (const node of chain) {
      if (node.matId === targetMatId || selfSet.has(node.matId))
        nodeMap.set(node.matId, { ...node, runsPerDay: new Rat(0n) });
    }
    if (!nodeMap.has(targetMatId)) return nodeMap;
    const targetNode = nodeMap.get(targetMatId);
    targetNode.runsPerDay = new Rat(1n, BigInt(targetNode.outAmount));
    const sorted = [...nodeMap.values()].sort((a, b) => a.depth - b.depth);
    for (const node of sorted) {
      if (node.runsPerDay.isZero()) continue;
      for (const inp of node.inputs) {
        const childNode = nodeMap.get(inp.matId);
        if (!childNode) continue;
        const demand = node.runsPerDay.mul(new Rat(BigInt(inp.amount))).div(new Rat(BigInt(childNode.outAmount)));
        childNode.runsPerDay = childNode.runsPerDay.add(demand);
      }
    }
    return nodeMap;
  }

  function distributeToSlots(l1Equiv) {
    const totalNeeded = Math.ceil(l1Equiv);
    if (totalNeeded <= 0) return { slots: [1], totalLevel: 1 };
    if (totalNeeded === 1) return { slots: [1], totalLevel: 1 };
    const MAX_LEVEL = 30;
    const slotCount = Math.ceil(totalNeeded / MAX_LEVEL);
    const baseLevel = Math.floor(totalNeeded / slotCount);
    const remainder = totalNeeded - baseLevel * slotCount;
    const slots = [];
    for (let i = 0; i < slotCount; i++) slots.push(i < remainder ? baseLevel + 1 : baseLevel);
    return { slots, totalLevel: totalNeeded };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §5b — Upgrade cost helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /** Growth factor for upgrading TO currentLevel (wiki formula) */
  function upgradeGrowth(currentLevel) {
    if (currentLevel <= 0) return 1;
    if (currentLevel <= 8)
      return (0.1 * currentLevel) + Math.pow(1.07, currentLevel);
    return 0.7 + Math.pow(1.07, 7) +
      Math.pow(currentLevel - 6, 1.03) -
      0.95 * (currentLevel - 6);
  }

  /** Total growth cost to upgrade from fromLvl to toLvl (sum of each step) */
  function upgradeCostGrowth(fromLvl, toLvl) {
    let total = 0;
    for (let lvl = fromLvl + 1; lvl <= toLvl; lvl++) total += upgradeGrowth(lvl);
    return total;
  }

  /** Build cost growth for a brand-new building up to level */
  function buildCostGrowth(level) {
    let total = 1; // new build = growth 1
    for (let lvl = 2; lvl <= level; lvl++) total += upgradeGrowth(lvl);
    return total;
  }

  /**
   * Estimate credit cost of a growth factor using building construction materials.
   * cost = Σ( ceil(baseMat × growth) × matPrice )
   */
  function estimateCreditCost(building, growthFactor) {
    const mats = building?.constructionMaterials || [];
    let total = 0;
    for (const m of mats) {
      const baseAmt = m.am || m.a || 0;
      const qty = Math.ceil(baseAmt * growthFactor);
      const matId = m.id || m.i;
      const price = allPrices[matId] || (gameData.getMaterial(matId)?.cp || 0) / 100;
      total += qty * price;
    }
    return total;
  }

  /**
   * Calculate daily warehouse throughput weight for a set of production entries.
   * Returns { dailyInputWeight, dailyOutputWeight, dailyNetWeight, peakWeight }
   */
  function calcWarehouseThroughput(idealEntries, allChainNodes, selfSet) {
    let dailyInputWeight = 0;
    let dailyOutputWeight = 0;

    for (const entry of idealEntries) {
      const node = allChainNodes.find(n => n.matId === entry.matId);
      if (!node) continue;
      const runsPerDay = 1440 / node.timeMinutes;
      const totalLvl = entry.idealTotalLevel || 1;
      const dailyRuns = runsPerDay * totalLvl;

      // Output weight
      const outMat = gameData.getMaterial(entry.matId);
      const outWeight = (outMat?.weight || 1) * (node.outAmount || 1) * dailyRuns;
      dailyOutputWeight += outWeight;

      // Input weights (only for bought inputs, not self-produced)
      for (const inp of node.inputs) {
        if (selfSet.has(inp.matId)) continue; // produced on-base, flows internally
        const inpMat = gameData.getMaterial(inp.matId);
        const inpWeight = (inpMat?.weight || 1) * inp.amount * dailyRuns;
        dailyInputWeight += inpWeight;
      }
    }

    // Peak weight: inputs arrive in bulk (assume 1-day buffer) + outputs accumulate
    // until sold/shipped (assume 1-day buffer)
    const peakWeight = dailyInputWeight + dailyOutputWeight;
    return { dailyInputWeight, dailyOutputWeight, peakWeight };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §6 — Optimization engine
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build the ideal plan for target products, then compare against the
   * current base and generate recommendations.
   */
  function optimizeBase() {
    const totalSlots = baseSlots.length;
    const hqSlots = baseSlots.filter(s => s.isHQ).length;

    // For each target product, figure out what the base SHOULD look like.
    // We'll determine which materials are already being produced on-base
    // and only self-produce those + the targets.

    // Step 1: determine current production capabilities
    const currentProdByType = {}; // buildingType → { count, totalLevel, slots: [{level, recipeId}] }
    for (const s of baseSlots) {
      if (s.empty || s.isHousing || s.isHQ || s.isWarehouse) continue;
      const bt = s.buildingType;
      if (!currentProdByType[bt]) currentProdByType[bt] = { count: 0, totalLevel: 0, slots: [] };
      currentProdByType[bt].count++;
      currentProdByType[bt].totalLevel += s.level;
      currentProdByType[bt].slots.push({ level: s.level, recipeId: s.activeRecipeId, slotId: s.slotId });
    }

    // Step 2: resolve chains for all targets, self-produce everything producible
    const allChainNodes = [];
    const selfSet = new Set();

    for (const matId of targetMatIds) {
      const recipe = gameData.getCraftingRecipe(matId);
      if (!recipe) continue;
      const chain = resolveChain(matId, recipe);
      for (const node of chain) {
        if (!allChainNodes.find(n => n.matId === node.matId)) {
          allChainNodes.push(node);
        }
        // Auto self-produce if this building type already exists on base
        if (node.building && currentProdByType[node.building.id]) {
          selfSet.add(node.matId);
        }
      }
    }

    // Targets always self-produced
    for (const matId of targetMatIds) selfSet.add(matId);

    // Step 3: compute ideal ratios across all targets
    // We assume equal priority — each target gets output scaled to fill available throughput
    const idealBuildings = new Map(); // buildingType → { totalLevel needed, recipeId, matName, building }

    for (const matId of targetMatIds) {
      const chain = resolveChain(matId);
      const ratioMap = solveRatios(matId, chain, selfSet);

      // We don't know the exact target rate yet — we'll scale to fit available slots.
      // For now, collect the relative ratios per building type.
      for (const [mid, node] of ratioMap) {
        if (node.runsPerDay.isZero()) continue;
        const bt = node.building?.id;
        if (!bt) continue;
        const runsFloat = node.runsPerDay.toFloat();
        const runsPerL1 = 1440 / node.timeMinutes;
        const l1Equiv = runsFloat / runsPerL1;

        if (!idealBuildings.has(bt)) {
          idealBuildings.set(bt, {
            l1Equiv: 0, building: node.building, recipe: node.recipe,
            matId: mid, matName: gameData.getMaterialName(mid)
          });
        }
        const entry = idealBuildings.get(bt);
        entry.l1Equiv += l1Equiv;
      }
    }

    // Step 4: scale ideal ratios to fit available production slots
    const availProdSlots = totalSlots - hqSlots;
    // Count how many housing slots we'll need
    // First pass: figure out ideal buildings ignoring housing
    let idealSlotCount = 0;
    const idealEntries = [];

    for (const [bt, entry] of idealBuildings) {
      // Scale: we want all ratios to maintain their proportions
      // For now just use l1Equiv = 1 unit of target output
      const { slots, totalLevel } = distributeToSlots(entry.l1Equiv);
      idealEntries.push({
        buildingType: bt,
        buildingName: entry.building.name,
        building: entry.building,
        matId: entry.matId,
        matName: entry.matName,
        recipe: entry.recipe,
        idealSlots: slots,
        idealSlotCount: slots.length,
        idealTotalLevel: totalLevel,
        l1Equiv: entry.l1Equiv
      });
      idealSlotCount += slots.length;
    }

    // Compute ideal workers
    const idealWorkerTotals = [0, 0, 0, 0];
    for (const e of idealEntries) {
      const wn = e.building.workersNeeded || [0,0,0,0];
      for (let i = 0; i < 4; i++) {
        for (const lvl of e.idealSlots) idealWorkerTotals[i] += wn[i] * lvl;
      }
    }

    // Housing buildings needed
    const housingBuildings = gameData.buildings.filter(b => b.workersHousing?.some(h => h > 0));
    const idealHousing = [];
    let idealHousingSlots = 0;
    for (let tier = 0; tier < 4; tier++) {
      const needed = idealWorkerTotals[tier];
      if (needed <= 0) continue;
      const hb = housingBuildings.find(b => b.workersHousing[tier] > 0);
      if (!hb) continue;
      const capPerLvl = hb.workersHousing[tier];
      const levelsNeeded = Math.ceil(needed / capPerLvl);
      const { slots } = distributeToSlots(levelsNeeded);
      idealHousing.push({
        building: hb, buildingType: hb.id, buildingName: hb.name,
        tierIndex: tier, slots, slotCount: slots.length,
        workersHoused: slots.reduce((s, l) => s + l, 0) * capPerLvl,
        workersNeeded: needed
      });
      idealHousingSlots += slots.length;
    }

    // Step 5: generate recommendations by comparing current vs ideal
    const recommendations = [];
    const proposedSlots = []; // what the base should look like

    // Check production buildings: upgrade, build new, or scrap
    for (const ideal of idealEntries) {
      const current = currentProdByType[ideal.buildingType];

      if (!current) {
        // Need to build this building type (doesn't exist yet)
        for (const lvl of ideal.idealSlots) {
          const growth = buildCostGrowth(lvl);
          const cost = estimateCreditCost(ideal.building, growth);
          recommendations.push({
            type: 'build',
            title: `Build ${ideal.buildingName}`,
            detail: `Build to Lv ${lvl} for ${ideal.matName} production.`,
            building: ideal.buildingName,
            targetLevel: lvl,
            costCredits: cost, costGrowth: growth
          });
          proposedSlots.push({
            buildingName: ideal.buildingName, level: lvl, isHousing: false,
            isNew: true, recipe: ideal.matName, buildingType: ideal.buildingType
          });
        }
      } else {
        // Building type exists — check if levels need adjusting
        const currentSlots = current.slots.sort((a, b) => b.level - a.level);
        const idealLevels = [...ideal.idealSlots].sort((a, b) => b - a);

        // Match current slots to ideal slots
        const maxLen = Math.max(currentSlots.length, idealLevels.length);
        for (let i = 0; i < maxLen; i++) {
          const cur = currentSlots[i];
          const idealLvl = idealLevels[i];

          if (cur && idealLvl) {
            if (cur.level < idealLvl) {
              const growth = upgradeCostGrowth(cur.level, idealLvl);
              const cost = estimateCreditCost(ideal.building, growth);
              const outputGain = idealLvl - cur.level; // L1-equivalents gained
              recommendations.push({
                type: 'upgrade',
                title: `Upgrade ${ideal.buildingName} Lv ${cur.level} → Lv ${idealLvl}`,
                detail: `Slot #${cur.slotId}: +${outputGain} level${outputGain > 1 ? 's' : ''} output for ${ideal.matName}.`,
                building: ideal.buildingName,
                fromLevel: cur.level, targetLevel: idealLvl,
                costCredits: cost, costGrowth: growth,
                costPerLevel: cost / outputGain
              });
            }
            proposedSlots.push({
              buildingName: ideal.buildingName, level: Math.max(cur.level, idealLvl),
              isHousing: false, isNew: false, recipe: ideal.matName,
              buildingType: ideal.buildingType, wasUpgraded: cur.level < idealLvl
            });
          } else if (!cur && idealLvl) {
            const growth = buildCostGrowth(idealLvl);
            const cost = estimateCreditCost(ideal.building, growth);
            recommendations.push({
              type: 'build',
              title: `Build additional ${ideal.buildingName}`,
              detail: `Build to Lv ${idealLvl} for ${ideal.matName}.`,
              building: ideal.buildingName, targetLevel: idealLvl,
              costCredits: cost, costGrowth: growth
            });
            proposedSlots.push({
              buildingName: ideal.buildingName, level: idealLvl,
              isHousing: false, isNew: true, recipe: ideal.matName,
              buildingType: ideal.buildingType
            });
          } else if (cur && !idealLvl) {
            proposedSlots.push({
              buildingName: ideal.buildingName, level: cur.level,
              isHousing: false, isNew: false, recipe: ideal.matName || 'existing',
              buildingType: ideal.buildingType, isExtra: true
            });
          }
        }
      }
    }

    // Check for buildings on base that aren't in the ideal plan at all
    for (const s of baseSlots) {
      if (s.empty || s.isHQ || s.isHousing || s.isWarehouse) continue;
      const isInIdeal = idealEntries.some(e => e.buildingType === s.buildingType);
      if (!isInIdeal) {
        const outputName = s.recipeName || 'unknown';
        recommendations.push({
          type: 'scrap',
          title: `Consider scrapping ${s.buildingName} (Lv ${s.level})`,
          detail: `Slot #${s.slotId}: producing ${outputName}. Not needed for targets — scrap to free a slot.`,
          building: s.buildingName, level: s.level,
          costCredits: 0, costGrowth: 0
        });
        proposedSlots.push({
          buildingName: s.buildingName, level: s.level,
          isHousing: false, isNew: false, recipe: outputName,
          buildingType: s.buildingType, isScrapCandidate: true
        });
      }
    }

    // Housing recommendations
    const currentHousingByTier = {};
    for (const s of baseSlots) {
      if (!s.isHousing || !s.gdBuilding) continue;
      for (let t = 0; t < 4; t++) {
        if (s.gdBuilding.workersHousing[t] > 0) {
          if (!currentHousingByTier[t]) currentHousingByTier[t] = { slots: [], totalLevel: 0, building: s.gdBuilding };
          currentHousingByTier[t].slots.push(s);
          currentHousingByTier[t].totalLevel += s.level;
        }
      }
    }

    const tierNames = ['Workers', 'Technicians', 'Engineers', 'Scientists'];
    for (const ih of idealHousing) {
      const cur = currentHousingByTier[ih.tierIndex];
      const curTotalLvl = cur?.totalLevel || 0;
      const idealTotalLvl = ih.slots.reduce((s, l) => s + l, 0);

      if (curTotalLvl < idealTotalLvl) {
        const deficit = idealTotalLvl - curTotalLvl;
        const fromLvl = cur?.slots?.length ? Math.max(...cur.slots.map(s => s.level)) : 0;
        const growth = cur?.slots?.length
          ? upgradeCostGrowth(fromLvl, fromLvl + deficit)
          : buildCostGrowth(idealTotalLvl);
        const cost = estimateCreditCost(ih.building, growth);

        if (cur && cur.slots.length > 0) {
          recommendations.push({
            type: 'housing',
            title: `Upgrade ${ih.buildingName} (+${deficit} levels)`,
            detail: `Need ${idealTotalLvl} total levels for ${ih.workersNeeded.toLocaleString()} ${tierNames[ih.tierIndex]}. Currently at ${curTotalLvl}.`,
            costCredits: cost, costGrowth: growth
          });
        } else {
          for (const lvl of ih.slots) {
            const g = buildCostGrowth(lvl);
            const c = estimateCreditCost(ih.building, g);
            recommendations.push({
              type: 'housing',
              title: `Build ${ih.buildingName} (Lv ${lvl})`,
              detail: `Houses ${tierNames[ih.tierIndex]} — need ${ih.workersNeeded.toLocaleString()} total.`,
              costCredits: c, costGrowth: g
            });
          }
        }
      }

      for (const lvl of ih.slots) {
        proposedSlots.push({
          buildingName: ih.buildingName, level: lvl, isHousing: true,
          isNew: !cur, recipe: `${tierNames[ih.tierIndex]} housing`,
          buildingType: ih.buildingType
        });
      }
    }

    // ── Warehouse analysis ──────────────────────────────────────────────────
    const WH_CAP_PER_LEVEL = 1500; // 1500t per warehouse level
    const warehouseBuilding = gameData.buildings.find(b => b.id === 14);
    const currentWhSlots = baseSlots.filter(s => s.isWarehouse);
    const currentWhTotalLevel = currentWhSlots.reduce((s, w) => s + w.level, 0);
    const currentWhCapacity = currentBase.warehouse?.cap || (currentWhTotalLevel * WH_CAP_PER_LEVEL);

    // Calculate daily throughput weight
    const throughput = calcWarehouseThroughput(idealEntries, allChainNodes, selfSet);

    // We need enough capacity for at least ~1 day buffer of inputs + outputs
    // A safe margin is 2× daily peak to handle delivery timing
    const safeCapacity = Math.ceil(throughput.peakWeight * 2);
    const idealWhLevels = Math.max(1, Math.ceil(safeCapacity / WH_CAP_PER_LEVEL));
    const { slots: idealWhSlots } = distributeToSlots(idealWhLevels);
    let idealWhSlotsCount = idealWhSlots.length;

    // Warehouse recommendations
    if (currentWhTotalLevel < idealWhLevels && warehouseBuilding) {
      const deficit = idealWhLevels - currentWhTotalLevel;
      if (currentWhSlots.length > 0) {
        // Upgrade existing warehouses
        const topLvl = Math.max(...currentWhSlots.map(s => s.level));
        const growth = upgradeCostGrowth(topLvl, topLvl + deficit);
        const cost = estimateCreditCost(warehouseBuilding, growth);
        recommendations.push({
          type: 'warehouse',
          title: `Upgrade Warehouse (+${deficit} levels)`,
          detail: `Need ~${GtApi.formatNum(safeCapacity)}t capacity for daily throughput (${GtApi.formatNum(Math.round(throughput.peakWeight))}t/day). Currently ${GtApi.formatNum(currentWhCapacity)}t.`,
          costCredits: cost, costGrowth: growth
        });
      } else {
        // Build new warehouse
        for (const lvl of idealWhSlots) {
          const g = buildCostGrowth(lvl);
          const c = estimateCreditCost(warehouseBuilding, g);
          recommendations.push({
            type: 'warehouse',
            title: `Build Warehouse (Lv ${lvl})`,
            detail: `Need ~${GtApi.formatNum(safeCapacity)}t capacity. Daily throughput: ${GtApi.formatNum(Math.round(throughput.dailyInputWeight))}t in + ${GtApi.formatNum(Math.round(throughput.dailyOutputWeight))}t out.`,
            costCredits: c, costGrowth: g
          });
        }
      }
    } else if (currentWhTotalLevel > idealWhLevels + 5) {
      // Warehouse is much bigger than needed — note as potential savings
      const excess = currentWhTotalLevel - idealWhLevels;
      recommendations.push({
        type: 'info',
        title: `Warehouse over-provisioned by ~${excess} levels`,
        detail: `Current: ${GtApi.formatNum(currentWhCapacity)}t, needed: ~${GtApi.formatNum(safeCapacity)}t. Could downgrade to free a slot if tight on space.`,
        costCredits: 0, costGrowth: 0
      });
    }

    // Add current/ideal warehouses to proposed layout
    for (const lvl of idealWhSlots) {
      proposedSlots.push({
        buildingName: 'Warehouse', level: lvl, isWarehouse: true,
        isNew: currentWhSlots.length === 0,
        recipe: `${GtApi.formatNum(lvl * WH_CAP_PER_LEVEL)}t storage`,
        buildingType: 14
      });
    }

    // Add HQ to proposed
    for (const s of baseSlots) {
      if (s.isHQ) {
        proposedSlots.push({
          buildingName: s.buildingName, level: s.level, isHQ: true,
          isNew: false, recipe: 'Headquarters'
        });
      }
    }

    // Production order recommendations (no cost — just queue changes)
    const currentRecipes = new Set();
    for (const s of baseSlots) {
      if (s.activeRecipeId) currentRecipes.add(s.activeRecipeId);
    }
    for (const ideal of idealEntries) {
      if (ideal.recipe && !currentRecipes.has(ideal.recipe.id)) {
        recommendations.push({
          type: 'reorder',
          title: `Set production: ${ideal.matName}`,
          detail: `Add ${ideal.matName} recipe to ${ideal.buildingName} production queue.`,
          costCredits: 0, costGrowth: 0
        });
      }
    }

    // ── Cost-efficiency sort ────────────────────────────────────────────────
    // Primary: by priority class, secondary: by cost-efficiency (cheapest first)
    const order = { scrap: 0, reorder: 1, upgrade: 2, build: 3, housing: 4, warehouse: 5, info: 6 };
    recommendations.sort((a, b) => {
      const oa = order[a.type] ?? 7, ob = order[b.type] ?? 7;
      if (oa !== ob) return oa - ob;
      // Within same type, cheapest first (best ROI)
      return (a.costCredits || 0) - (b.costCredits || 0);
    });

    // Compute total upgrade cost across all recommendations
    const totalUpgradeCost = recommendations.reduce((s, r) => s + (r.costCredits || 0), 0);

    return {
      recommendations, proposedSlots, idealEntries, idealHousing,
      idealWorkerTotals, throughput, totalUpgradeCost,
      warehouseAnalysis: {
        currentCapacity: currentWhCapacity,
        idealCapacity: idealWhLevels * WH_CAP_PER_LEVEL,
        dailyInputWeight: throughput.dailyInputWeight,
        dailyOutputWeight: throughput.dailyOutputWeight,
        peakWeight: throughput.peakWeight
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §7 — Run optimization + render results
  // ═══════════════════════════════════════════════════════════════════════════

  async function runOptimization() {
    const btn = document.getElementById('bo-optimize-btn');
    btn.disabled = true;
    btn.textContent = 'Optimizing…';
    hideError('bo-opt-error');

    try {
      // Fetch prices
      const pricesRaw = await api.getMatPrices();
      const pricesArr = Array.isArray(pricesRaw) ? pricesRaw : (pricesRaw.prices || []);
      allPrices = {};
      for (const p of pricesArr) allPrices[p.matId] = p.currentPrice / 100;

      const result = optimizeBase();
      renderOptimizationResults(result);

      document.getElementById('bo-result-section').classList.add('visible');
      window._updateRateLimit(api);
    } catch (err) {
      showError('bo-opt-error', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Optimize Base';
    }
  }

  function renderOptimizationResults(result) {
    const { recommendations, proposedSlots, idealWorkerTotals,
            totalUpgradeCost, warehouseAnalysis } = result;

    // Current stats
    const curProdSlots = baseSlots.filter(s => !s.empty && !s.isHousing && !s.isHQ && !s.isWarehouse).length;
    const curHousingSlots = baseSlots.filter(s => s.isHousing).length;
    const curWhSlots = baseSlots.filter(s => s.isWarehouse).length;
    const curWorkerArr = currentBase.workforce?.workersCount || [0,0,0,0];
    const curWorkers = curWorkerArr.reduce((a, b) => a + b, 0);
    const burdenWeights = [1.0, 1.5, 2.5, 4.0];
    const curBurden = curWorkerArr.reduce((s, w, i) => s + w * burdenWeights[i], 0);

    // Proposed stats
    const propProdSlots = proposedSlots.filter(s => !s.isHousing && !s.isHQ && !s.isWarehouse).length;
    const propHousingSlots = proposedSlots.filter(s => s.isHousing).length;
    const propWhSlots = proposedSlots.filter(s => s.isWarehouse).length;
    const propWorkers = idealWorkerTotals.reduce((a, b) => a + b, 0);
    const propBurden = idealWorkerTotals.reduce((s, w, i) => s + w * burdenWeights[i], 0);
    const totalProposedSlots = proposedSlots.length;
    const totalBaseSlots = baseSlots.length;

    const newBuilds = recommendations.filter(r => r.type === 'build').length;
    const upgrades = recommendations.filter(r => r.type === 'upgrade').length;
    const scraps = recommendations.filter(r => r.type === 'scrap').length;

    const fmtCost = (v) => v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toFixed(0);

    // Comparison table
    document.getElementById('bo-comparison').innerHTML = `
      <div class="compare-row">
        <div class="cr-label">Production slots</div>
        <div class="cr-current">${curProdSlots}</div>
        <div class="cr-arrow">→</div>
        <div class="cr-proposed">${propProdSlots}</div>
      </div>
      <div class="compare-row">
        <div class="cr-label">Housing slots</div>
        <div class="cr-current">${curHousingSlots}</div>
        <div class="cr-arrow">→</div>
        <div class="cr-proposed">${propHousingSlots}</div>
      </div>
      <div class="compare-row">
        <div class="cr-label">Warehouse slots</div>
        <div class="cr-current">${curWhSlots}</div>
        <div class="cr-arrow">→</div>
        <div class="cr-proposed">${propWhSlots}</div>
      </div>
      <div class="compare-row">
        <div class="cr-label">Warehouse capacity</div>
        <div class="cr-current">${GtApi.formatNum(warehouseAnalysis.currentCapacity)}t</div>
        <div class="cr-arrow">→</div>
        <div class="cr-proposed">${GtApi.formatNum(warehouseAnalysis.idealCapacity)}t</div>
      </div>
      <div class="compare-row">
        <div class="cr-label">Daily throughput</div>
        <div class="cr-current" style="font-family:var(--font);color:var(--text-dim)">—</div>
        <div class="cr-arrow"></div>
        <div class="cr-proposed" style="font-family:var(--font)">${GtApi.formatNum(Math.round(warehouseAnalysis.dailyInputWeight))}t in / ${GtApi.formatNum(Math.round(warehouseAnalysis.dailyOutputWeight))}t out</div>
      </div>
      <div class="compare-row">
        <div class="cr-label">Total workers</div>
        <div class="cr-current">${curWorkers.toLocaleString()}</div>
        <div class="cr-arrow">→</div>
        <div class="cr-proposed">${propWorkers.toLocaleString()}</div>
      </div>
      <div class="compare-row">
        <div class="cr-label">Burden</div>
        <div class="cr-current">${curBurden.toLocaleString()}</div>
        <div class="cr-arrow">→</div>
        <div class="cr-proposed" style="color:${propBurden > 2000 ? 'var(--orange)' : 'var(--green)'}">${propBurden.toLocaleString()}</div>
      </div>
      <div class="compare-row">
        <div class="cr-label">Total slots used</div>
        <div class="cr-current">${baseSlots.filter(s => !s.empty).length}/${totalBaseSlots}</div>
        <div class="cr-arrow">→</div>
        <div class="cr-proposed" style="color:${totalProposedSlots > totalBaseSlots ? 'var(--red)' : 'var(--green)'}">${totalProposedSlots}/${totalBaseSlots}</div>
      </div>
      <div class="compare-row">
        <div class="cr-label">Changes</div>
        <div class="cr-current" style="font-family:var(--font);color:var(--text-dim)">current</div>
        <div class="cr-arrow">→</div>
        <div class="cr-proposed" style="font-family:var(--font)">${newBuilds} new, ${upgrades} upgrades, ${scraps} scrap</div>
      </div>
      <div class="compare-row" style="border-top:1px solid rgba(0,180,255,0.15);padding-top:8px;margin-top:4px">
        <div class="cr-label" style="font-weight:bold">Est. total cost</div>
        <div class="cr-current"></div>
        <div class="cr-arrow"></div>
        <div class="cr-proposed" style="color:var(--accent);font-weight:bold;font-size:15px">${fmtCost(totalUpgradeCost)} cr</div>
      </div>
    `;

    // Slot overflow warning
    if (totalProposedSlots > totalBaseSlots) {
      const overflowEl = document.createElement('div');
      overflowEl.style.cssText = 'color:var(--red);font-size:12px;padding:8px 12px;background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.2);border-radius:6px;margin-top:8px';
      overflowEl.textContent = `⚠ Proposed layout needs ${totalProposedSlots} slots but base only has ${totalBaseSlots}. Consider scrapping unused buildings or reducing target products.`;
      document.getElementById('bo-comparison').appendChild(overflowEl);
    }

    // Recommendations (with cost)
    document.getElementById('bo-rec-count').textContent = `${recommendations.length} recommendations`;
    const recList = document.getElementById('bo-rec-list');

    if (recommendations.length === 0) {
      recList.innerHTML = '<div style="color:var(--green);font-size:13px;padding:12px 0">✓ Base is already well-configured for target products!</div>';
    } else {
      recList.innerHTML = recommendations.map(r => {
        const cls = `rec-${r.type}`;
        const icon = { scrap: '🗑', build: '🏗', upgrade: '⬆', housing: '🏠', warehouse: '📦', reorder: '🔄', info: 'ℹ️' }[r.type] || '•';
        const costStr = r.costCredits ? `<span class="rec-cost">${fmtCost(r.costCredits)} cr</span>` : '';
        return `
          <div class="rec-card ${cls}">
            <div class="rec-title">${icon} ${r.title}${costStr}</div>
            <div class="rec-detail">${r.detail}</div>
          </div>
        `;
      }).join('');
    }

    // Proposed layout grid
    const propGrid = document.getElementById('bo-proposed-slots');
    propGrid.innerHTML = proposedSlots.map(s => {
      let cls = 'slot-production';
      if (s.isHousing) cls = 'slot-housing';
      if (s.isWarehouse) cls = 'slot-warehouse';
      if (s.isHQ) cls = 'slot-hq';

      let border = '';
      if (s.isNew) border = 'border: 1px solid var(--green);';
      if (s.isScrapCandidate) border = 'border: 1px dashed var(--red); opacity: 0.6;';
      if (s.wasUpgraded) border = 'border: 1px solid var(--yellow);';

      return `
        <div class="slot-card ${cls}" style="${border}">
          <div class="slot-name">${s.buildingName} <span class="slot-level">Lv ${s.level}</span></div>
          <div class="slot-recipe">→ ${s.recipe || ''}</div>
          ${s.isNew ? '<div style="font-size:9px;color:var(--green);margin-top:2px">NEW</div>' : ''}
          ${s.wasUpgraded ? '<div style="font-size:9px;color:var(--yellow);margin-top:2px">UPGRADE</div>' : ''}
          ${s.isScrapCandidate ? '<div style="font-size:9px;color:var(--red);margin-top:2px">SCRAP?</div>' : ''}
        </div>
      `;
    }).join('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §8 — Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  function showError(elId, msg) {
    const el = document.getElementById(elId);
    if (el) { el.textContent = msg.replace(/^[A-Z_]+: /, ''); el.style.display = 'block'; }
  }
  function hideError(elId) {
    const el = document.getElementById(elId);
    if (el) el.style.display = 'none';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §9 — Event wiring
  // ═══════════════════════════════════════════════════════════════════════════

  document.getElementById('bo-load-btn').addEventListener('click', loadBase);
  document.getElementById('bo-optimize-btn').addEventListener('click', runOptimization);

  // Init
  loadBasesList();
  initProductSearch();
})();
