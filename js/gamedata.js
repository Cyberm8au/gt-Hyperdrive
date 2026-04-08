/**
 * GT Companion - Game Data Resolver
 * Loads gamedata.json (public endpoint, no auth needed) and provides
 * helpers for resolving material names, recipes, and buildings.
 */

const GAMEDATA_URL = 'https://api.g2.galactictycoons.com/gamedata.json';
const GAMEDATA_CACHE_KEY = 'gt_gamedata';
const GAMEDATA_CACHE_TTL = 60 * 60 * 1000; // 1 hour

class GameData {
  constructor() {
    this.materials = [];
    this.recipes = [];
    this.buildings = [];
    this.workers = [];
    this.systems = [];
    this._matMap = {};       // matId → material
    this._recipeByOutput = {}; // matId → first recipe that produces it
    this._buildingMap = {};  // buildingId → building
    this._loaded = false;
  }

  /** Load game data (from cache or network) */
  async load() {
    if (this._loaded) return;

    // Try cache
    try {
      const raw = localStorage.getItem(GAMEDATA_CACHE_KEY);
      if (raw) {
        const { data, timestamp } = JSON.parse(raw);
        if (Date.now() - timestamp < GAMEDATA_CACHE_TTL) {
          this._ingest(data);
          return;
        }
      }
    } catch (_) {}

    // Fetch fresh
    const response = await fetch(GAMEDATA_URL);
    if (!response.ok) throw new Error('Failed to load game data from GT API');
    const data = await response.json();

    // Cache it
    try {
      localStorage.setItem(GAMEDATA_CACHE_KEY, JSON.stringify({
        data,
        timestamp: Date.now()
      }));
    } catch (_) {}

    this._ingest(data);
  }

  _ingest(data) {
    this.materials = data.materials || [];
    this.recipes = data.recipes || [];
    this.buildings = data.buildings || [];
    this.workers = data.workers || [];
    this.systems = data.systems || [];

    // Build lookup maps
    for (const mat of this.materials) {
      this._matMap[mat.id] = mat;
    }
    for (const building of this.buildings) {
      this._buildingMap[building.id] = building;
    }

    // Map recipes by output material ID
    // A material may have multiple recipes (different buildings). We keep all.
    this._recipeByOutput = {};
    for (const recipe of this.recipes) {
      const outId = recipe.output?.id ?? recipe.output?.i;
      if (outId === undefined) continue;
      if (!this._recipeByOutput[outId]) {
        this._recipeByOutput[outId] = [];
      }
      this._recipeByOutput[outId].push(recipe);
    }

    this._loaded = true;
  }

  // ─── Material helpers ─────────────────────────────────────────────────────

  getMaterial(matId) {
    return this._matMap[matId] || null;
  }

  getMaterialName(matId) {
    return this._matMap[matId]?.name ?? `Material #${matId}`;
  }

  getMaterialShortName(matId) {
    return this._matMap[matId]?.sName ?? this.getMaterialName(matId);
  }

  getMaterialTier(matId) {
    return this._matMap[matId]?.tier ?? 0;
  }

  getMaterialType(matId) {
    return this._matMap[matId]?.type ?? 0;
  }

  /** Return all materials sorted by name */
  getAllMaterials() {
    return [...this.materials].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Search materials by name (case-insensitive) */
  searchMaterials(query) {
    const q = query.toLowerCase();
    return this.materials.filter(m =>
      m.name.toLowerCase().includes(q) || m.sName.toLowerCase().includes(q)
    ).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ─── Recipe helpers ───────────────────────────────────────────────────────

  /**
   * Get all recipes that produce a given material.
   * Returns [] if the material is a raw extraction output or has no recipe.
   */
  getRecipesForOutput(matId) {
    return this._recipeByOutput[matId] || [];
  }

  /**
   * Get the "best" recipe for a material (first one found, prefers the
   * one with the most inputs as a proxy for being a crafted item).
   * Returns null if this is a raw material (no recipe, or empty inputs).
   */
  getCraftingRecipe(matId) {
    const recipes = this.getRecipesForOutput(matId);
    // Filter to recipes with actual inputs (not raw extraction)
    const crafting = recipes.filter(r => r.inputs && r.inputs.length > 0);
    if (crafting.length === 0) return null;
    // Prefer recipe with most inputs (typically the most refined)
    return crafting.sort((a, b) => b.inputs.length - a.inputs.length)[0];
  }

  /**
   * Get normalized inputs for a recipe.
   * Returns array of { matId, amount } per run.
   */
  getRecipeInputs(recipe) {
    if (!recipe?.inputs) return [];
    return recipe.inputs.map(inp => ({
      matId: inp.id ?? inp.i,
      amount: inp.a ?? inp.am ?? 1
    }));
  }

  /**
   * Get normalized output for a recipe.
   * Returns { matId, amount } per run.
   */
  getRecipeOutput(recipe) {
    if (!recipe?.output) return null;
    return {
      matId: recipe.output.id ?? recipe.output.i,
      amount: recipe.output.a ?? recipe.output.am ?? 1
    };
  }

  /** Get the building that produces a recipe */
  getRecipeBuilding(recipe) {
    if (!recipe?.producedIn) return null;
    return this._buildingMap[recipe.producedIn] || null;
  }

  // ─── Building helpers ─────────────────────────────────────────────────────

  getBuilding(buildingId) {
    return this._buildingMap[buildingId] || null;
  }

  getBuildingName(buildingId) {
    return this._buildingMap[buildingId]?.name ?? `Building #${buildingId}`;
  }

  // ─── Worker helpers ───────────────────────────────────────────────────────

  getWorkerTierName(tier) {
    const names = ['', 'Tier 1', 'Tier 2', 'Tier 3', 'Tier 4'];
    return names[tier] || `Tier ${tier}`;
  }

  // ─── Planet helpers ───────────────────────────────────────────────────────

  getPlanet(planetId) {
    for (const system of this.systems) {
      const planet = system.planets?.find(p => p.id === planetId);
      if (planet) return { ...planet, systemName: system.name };
    }
    return null;
  }

  getPlanetName(planetId) {
    const p = this.getPlanet(planetId);
    if (!p) return `Planet #${planetId}`;
    return p.name || `${p.systemName} ${p.id}`;
  }
}

// Singleton
window.gameData = new GameData();
window.GameData = GameData;
