var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.js
var main_exports = {};
__export(main_exports, {
  default: () => WikiDashboardPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian3 = require("obsidian");

// src/config.js
var VIEW_TYPE = "wiki-dashboard";
var TAU = Math.PI * 2;
var SUN_RINGS = { subject: [80, 160], kind: [164, 228], page: [232, 330] };
var MAP_RINGS = { moc: 150, concept: 300, source: 440 };
var DEFAULT_NODE_SIZE = 5.5;
var RECENT_WINDOW = 7 * 24 * 3600 * 1e3;
var NARROW_BREAKPOINT = 480;
var SUNBURST_REACH = { narrow: 260, wide: 290 };
var PULSE = {
  cell: 14,
  gap: 3,
  months: 12,
  monthsPerRow: 4,
  monthsPerRowNarrow: 2,
  blockGapX: 30,
  blockGapY: 34
};
var MAP_SCHEMA_PATH = "system/schema/map.json";
var COLORS_SCHEMA_PATH = "system/schema/colors.json";
var ASK_HISTORY_PATH = "system/ask-history.json";
var ASK_CONFIG_PATH = "system/schema/ask.json";
var DEFAULT_ASK_ENDPOINTS = [];
var LEGACY_ASK_KEY = "wlm-ask-history";
var ASK_HISTORY_CAP = 100;

// src/view.js
var import_obsidian2 = require("obsidian");

// src/color.js
var normalizeColor = (color) => {
  const probe = document.createElement("canvas").getContext("2d");
  probe.fillStyle = "#1e1e1e";
  probe.fillStyle = color;
  return probe.fillStyle;
};
var isLightColor = (color) => {
  const normalized = normalizeColor(color);
  const hex = normalized.startsWith("#") ? normalized : `#${(normalized.match(/\d+/g) ?? ["30", "30", "30"]).slice(0, 3).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`;
  const value = parseInt(hex.slice(1, 7), 16);
  const luminance = (0.299 * (value >> 16 & 255) + 0.587 * (value >> 8 & 255) + 0.114 * (value & 255)) / 255;
  return luminance > 0.5;
};
var mixWithWhite = (hex, amount) => {
  const value = parseInt(hex.slice(1), 16);
  const lifted = [16, 8, 0].map((shift) => {
    const channel = value >> shift & 255;
    return Math.round(channel + (255 - channel) * amount).toString(16).padStart(2, "0");
  });
  return `#${lifted.join("")}`;
};
var withAlpha = (color, alpha) => {
  const resolved = color.startsWith("#") && color.length === 7 ? color : normalizeColor(color);
  const channels = resolved.startsWith("#") ? [16, 8, 0].map((shift) => parseInt(resolved.slice(1), 16) >> shift & 255) : (resolved.match(/[\d.]+/g) ?? ["30", "30", "30"]).slice(0, 3);
  return `rgba(${channels.join(", ")}, ${alpha})`;
};

// src/theme.js
var PALETTES = {
  dark: {
    "1": "#ff6b9d",
    "2": "#ffa657",
    "3": "#e3c567",
    "4": "#3ddbb4",
    "5": "#4cc9f0",
    "6": "#a78bfa"
  },
  light: {
    "1": "#f43f85",
    "2": "#fd7314",
    "3": "#d19d0b",
    "4": "#0abf8c",
    "5": "#12a8ee",
    "6": "#7d55f6"
  }
};
var FALLBACK_ORDER = ["1", "5", "4", "6", "2", "3"];
var SHARED_TOKENS = {
  fallbackColor: "#8f9aa6",
  dangerColor: "#e93147"
};
var THEME_TOKENS = {
  dark: {
    label: "#c9cdd3",
    mutedLabel: "#9aa0a6",
    homeColor: "#e8e3d3",
    hoverStroke: "#ffffff",
    glowAlpha: 0.26,
    haloMix: 0,
    glossMix: 0.24,
    sliceBoost: 1,
    edgeBoost: 1
  },
  light: {
    label: "#2b303a",
    mutedLabel: "#6b7280",
    homeColor: "#d29a5c",
    hoverStroke: "#000000",
    glowAlpha: 0.22,
    haloMix: 0.5,
    glossMix: 0.18,
    sliceBoost: 1.15,
    edgeBoost: 1.4
  }
};
var themeTokens = (light) => ({
  ...SHARED_TOKENS,
  ...THEME_TOKENS[light ? "light" : "dark"]
});
var computeTheme = (container) => {
  const styles = getComputedStyle(document.body);
  const background = styles.getPropertyValue("--background-primary").trim() || "#1e1e1e";
  const light = isLightColor(background);
  const theme = {
    background,
    light,
    text: styles.getPropertyValue("--text-normal").trim() || "#dadada",
    font: styles.getPropertyValue("--font-interface").trim() || "sans-serif",
    ...themeTokens(light)
  };
  container?.style.setProperty("--wlm-danger", theme.dangerColor);
  return theme;
};

// src/utils.js
var easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
var reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
var newAskId = () => Math.random().toString(36).slice(2, 10);
var sanitizeAnswer = (markdown) => markdown.replace(/<\/?[a-z][^>]*>/gi, "").replace(/!\[[^\]]*\]\(\s*(?:https?:)?\/\/[^)]*\)/gi, "");

// src/model.js
var loadPalette = async (app, slots, fallbackColor) => {
  const parsed = await app.vault.adapter.read(COLORS_SCHEMA_PATH).then((raw) => JSON.parse(raw)).catch(() => ({}));
  return Object.fromEntries(
    Object.entries(parsed).map(([tag, slot]) => [tag, slots[slot] ?? fallbackColor])
  );
};
var loadMapSchema = (app) => app.vault.adapter.read(MAP_SCHEMA_PATH).then((raw) => JSON.parse(raw)).catch(() => ({}));
var inferRoot = (files) => {
  const counts = files.map((file) => file.path.split("/")[0]).reduce((tally, segment) => tally.set(segment, (tally.get(segment) ?? 0) + 1), /* @__PURE__ */ new Map());
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
};
var buildModel = async (app, theme) => {
  const slots = PALETTES[theme.light ? "light" : "dark"];
  const [palette, schema] = await Promise.all([
    loadPalette(app, slots, theme.fallbackColor),
    loadMapSchema(app)
  ]);
  const allFiles = app.vault.getMarkdownFiles();
  const root = schema.root ?? inferRoot(allFiles);
  const excluded = new Set(schema.exclude ?? []);
  const files = allFiles.filter((file) => file.path.startsWith(`${root}/`)).filter((file) => !excluded.has(file.basename));
  const folderInfo = (path) => schema.folders?.[path.split("/")[1]] ?? {};
  const homePath = schema.home?.path;
  const subjectsOf = (file) => {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const raw = frontmatter.tags ?? [];
    const tags = Array.isArray(raw) ? raw : [raw];
    return [...new Set(tags.map((tag) => String(tag).split("/")[0].trim()))];
  };
  const labelOf = (basename) => {
    const undated = basename.replace(/^\d{4}-\d{2}-\d{2}-/, "");
    return undated.length > 26 ? `${undated.slice(0, 25)}\u2026` : undated;
  };
  const phaseOf = (path) => [...path].reduce((hash, char) => hash * 31 + char.charCodeAt(0) | 0, 7) % 628 / 100;
  const localDay = (ms) => {
    const date = new Date(ms);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate()
    ).padStart(2, "0")}`;
  };
  const dayOf = (value) => {
    const text = String(value ?? "");
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
  };
  const activityFields = schema.pulse?.dateFields ?? [];
  const activityDaysOf = (file) => {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const fromFields = activityFields.map((field) => dayOf(frontmatter[field])).filter(Boolean);
    const fromStat = [file.stat?.ctime, file.stat?.mtime].filter(Boolean).map(localDay);
    return [...new Set(activityFields.length > 0 ? fromFields : fromStat)];
  };
  const nowMs = Date.now();
  const nodes = files.map((file) => {
    const info = folderInfo(file.path);
    return {
      path: file.path,
      name: labelOf(file.basename),
      fullName: file.basename,
      kind: file.path.split("/")[1],
      hub: !!info.hub,
      home: file.path === homePath,
      outer: !!info.outer,
      muted: !!info.muted,
      ring: !!info.ring,
      baseSize: info.size ?? DEFAULT_NODE_SIZE,
      subjects: subjectsOf(file),
      phase: phaseOf(file.path),
      recent: nowMs - (file.stat?.mtime ?? 0) < RECENT_WINDOW,
      activityDays: activityDaysOf(file)
    };
  });
  const byPath = new Map(nodes.map((node) => [node.path, node]));
  const resolved = app.metadataCache.resolvedLinks;
  const edges = nodes.flatMap(
    (node) => Object.keys(resolved[node.path] ?? {}).filter((target) => byPath.has(target) && target !== node.path).map((target) => ({
      from: node.path,
      to: target,
      kind: byPath.get(target).hub || byPath.get(target).home ? "hierarchy" : "citation"
    }))
  );
  const homeNode = homePath && byPath.get(homePath);
  const isPage = (node) => !node.hub && !node.home;
  const subjectNames = [
    ...new Set(
      nodes.filter((node) => node.hub && !node.home).map((node) => node.name).concat(nodes.filter(isPage).map((node) => node.subjects[0]).filter(Boolean))
    )
  ].filter((name) => name !== homeNode?.name).sort();
  const membersOf = (subjectName) => nodes.filter((node) => isPage(node) && node.subjects[0] === subjectName);
  const weights = subjectNames.map((name) => membersOf(name).length + 3);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const gap = 0.05 * TAU / Math.max(subjectNames.length, 1);
  let cursor = -Math.PI / 2;
  const subjects = subjectNames.map((name, index) => {
    const span = weights[index] / totalWeight * (TAU - gap * subjectNames.length);
    const sector = {
      name,
      color: palette[name] ?? slots[FALLBACK_ORDER[index % FALLBACK_ORDER.length]],
      startAngle: cursor,
      endAngle: cursor + span,
      innerRadius: MAP_RINGS.moc - 40,
      outerRadius: MAP_RINGS.source + 40
    };
    cursor += span + gap;
    return sector;
  });
  const sectorByName = new Map(subjects.map((sector) => [sector.name, sector]));
  const degree = /* @__PURE__ */ new Map();
  edges.forEach((edge) => {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  });
  nodes.forEach((node) => {
    node.color = sectorByName.get(node.subjects[0])?.color ?? theme.fallbackColor;
    node.degree = degree.get(node.path) ?? 0;
    node.orphan = node.degree === 0 && isPage(node);
    const growth = Math.min(1.9, 0.85 + 0.22 * Math.sqrt(node.degree));
    node.size = node.home ? schema.home?.size ?? node.baseSize : node.baseSize * growth;
  });
  homeNode && Object.assign(homeNode, { x: 0, y: 0, color: theme.homeColor });
  nodes.filter((node) => node.hub && !node.home).forEach((node) => {
    const sector = sectorByName.get(node.name) ?? sectorByName.get(node.subjects[0]);
    const angle = sector ? (sector.startAngle + sector.endAngle) / 2 : 0;
    node.x = Math.cos(angle) * MAP_RINGS.moc;
    node.y = Math.sin(angle) * MAP_RINGS.moc;
    sector && (node.color = sector.color);
  });
  subjects.forEach((sector) => {
    const members = membersOf(sector.name).filter((node) => !node.outer);
    const padding = (sector.endAngle - sector.startAngle) * 0.12;
    const span = sector.endAngle - sector.startAngle - padding * 2;
    const minArc = 96;
    const radius = Math.max(
      MAP_RINGS.concept,
      members.length * minArc / Math.max(span, 0.1)
    );
    members.forEach((node, index) => {
      const step = span / Math.max(members.length - 1, 1);
      const angle = members.length === 1 ? (sector.startAngle + sector.endAngle) / 2 : sector.startAngle + padding + step * index;
      const wobble = index % 3 * 36;
      node.x = Math.cos(angle) * (radius + wobble);
      node.y = Math.sin(angle) * (radius + wobble);
    });
  });
  nodes.filter((node) => node.outer).forEach((node, index) => {
    const citers = edges.filter((edge) => edge.to === node.path).map((edge) => byPath.get(edge.from)).filter((citer) => citer && !citer.home && citer.x !== void 0);
    const sector = sectorByName.get(node.subjects[0]);
    const fallbackAngle = sector ? (sector.startAngle + sector.endAngle) / 2 : index / Math.max(nodes.length, 1) * TAU;
    const direction = citers.reduce(
      (sum, citer) => {
        const length = Math.hypot(citer.x, citer.y) || 1;
        return { x: sum.x + citer.x / length, y: sum.y + citer.y / length };
      },
      { x: 0, y: 0 }
    );
    const angle = Math.hypot(direction.x, direction.y) > 0.01 ? Math.atan2(direction.y, direction.x) : fallbackAngle;
    const wobble = index % 3 * 32;
    node.x = Math.cos(angle) * (MAP_RINGS.source + wobble);
    node.y = Math.sin(angle) * (MAP_RINGS.source + wobble);
  });
  nodes.filter((node) => node.x === void 0).forEach((node, index) => {
    const angle = index / 8 * TAU;
    node.x = Math.cos(angle) * (MAP_RINGS.source + 90);
    node.y = Math.sin(angle) * (MAP_RINGS.source + 90);
  });
  nodes.filter((node) => node.orphan).forEach((node, index) => {
    const sector = sectorByName.get(node.subjects[0]);
    const nudge = index % 2 === 0 ? 0.14 : -0.14;
    const angle = sector ? (sector.startAngle + sector.endAngle) / 2 + nudge : node.phase;
    node.x = Math.cos(angle) * (MAP_RINGS.source + 120);
    node.y = Math.sin(angle) * (MAP_RINGS.source + 120);
  });
  const movable = (node) => !node.hub && !node.home;
  const labelHalfWidth = (node) => Math.max(node.size + 10, node.name.length * (node.hub || node.home ? 5.5 : 4.3));
  const boxHalfHeight = (node) => node.size + 16;
  const boxCenterY = (node) => node.y + 9;
  Array.from({ length: 80 }).forEach(() => {
    nodes.forEach((first, index) => {
      nodes.slice(index + 1).forEach((second) => {
        const deltaX = second.x - first.x;
        const deltaY = boxCenterY(second) - boxCenterY(first);
        const overlapX = labelHalfWidth(first) + labelHalfWidth(second) - Math.abs(deltaX);
        const overlapY = boxHalfHeight(first) + boxHalfHeight(second) - Math.abs(deltaY);
        if (overlapX <= 0 || overlapY <= 0) return;
        const alongX = overlapX < overlapY;
        const fallback = first.phase > second.phase ? -1 : 1;
        const direction = alongX ? Math.sign(deltaX) || fallback : Math.sign(deltaY) || fallback;
        const push = (alongX ? overlapX : overlapY) * 0.6 + 1;
        const firstWeight = movable(first) ? movable(second) ? 0.5 : 1 : 0;
        const secondWeight = movable(second) ? 1 - firstWeight : 0;
        alongX ? (first.x -= direction * push * firstWeight, second.x += direction * push * secondWeight) : (first.y -= direction * push * firstWeight, second.y += direction * push * secondWeight);
      });
    });
  });
  nodes.forEach((node) => {
    node.baseX = node.x;
    node.baseY = node.y;
  });
  const nodeBounds = nodes.reduce(
    (bounds, node) => ({
      minX: Math.min(bounds.minX, node.x - labelHalfWidth(node)),
      maxX: Math.max(bounds.maxX, node.x + labelHalfWidth(node)),
      minY: Math.min(bounds.minY, boxCenterY(node) - boxHalfHeight(node)),
      maxY: Math.max(bounds.maxY, boxCenterY(node) + boxHalfHeight(node))
    }),
    { minX: 0, maxX: 0, minY: 0, maxY: 0 }
  );
  subjects.forEach((sector) => {
    const reach = nodes.filter(
      (node) => node.subjects[0] === sector.name || node.hub && node.name === sector.name
    ).reduce((max, node) => Math.max(max, Math.hypot(node.x, node.y)), sector.outerRadius);
    const mid = (sector.startAngle + sector.endAngle) / 2;
    const sectorHalfWidth = sector.name.length * 5.2;
    const clearsAt = (angle, radius) => nodes.every(
      (node) => Math.abs(Math.cos(angle) * radius - node.x) > sectorHalfWidth + labelHalfWidth(node) || Math.abs(Math.sin(angle) * radius - boxCenterY(node)) > 14 + boxHalfHeight(node)
    );
    const halfSpan = (sector.endAngle - sector.startAngle) / 2;
    const maxOffset = Math.min(halfSpan + 0.2, 0.65);
    const angleOffsets = [0].concat([...Array(6).keys()].flatMap((i) => [(i + 1) * 0.11, -(i + 1) * 0.11])).filter((offset) => Math.abs(offset) <= maxOffset);
    const overhang = (x, y) => Math.max(0, x + sectorHalfWidth - nodeBounds.maxX) + Math.max(0, nodeBounds.minX - (x - sectorHalfWidth)) + Math.max(0, y + 14 - nodeBounds.maxY) + Math.max(0, nodeBounds.minY - (y - 14));
    const placement = [...Array(24).keys()].flatMap(
      (step) => angleOffsets.map((offset) => ({
        radius: reach + 50 + step * 22,
        angle: mid + offset
      }))
    ).filter((candidate) => clearsAt(candidate.angle, candidate.radius)).map((candidate) => {
      const x = Math.cos(candidate.angle) * candidate.radius;
      const y = Math.sin(candidate.angle) * candidate.radius;
      return { ...candidate, score: overhang(x, y) * 2 + (candidate.radius - reach) * 0.3 };
    }).sort((first, second) => first.score - second.score)[0];
    sector.labelRadius = placement?.radius ?? reach + 70;
    sector.labelAngle = placement?.angle ?? mid;
  });
  const facetNames = [
    ...new Set(nodes.flatMap((node) => node.subjects.slice(1)))
  ].filter((name) => !sectorByName.has(name));
  const countable = nodes.filter(isPage);
  const countOf = (name) => countable.filter((node) => node.subjects.includes(name)).length;
  const dominantSubject = (name) => {
    const primaries = countable.filter((node) => node.subjects.includes(name)).map((node) => node.subjects[0]);
    return [...new Set(primaries)].sort(
      (first, second) => primaries.filter((p) => p === second).length - primaries.filter((p) => p === first).length
    )[0];
  };
  const tagGroups = subjects.map((sector) => ({
    name: sector.name,
    color: sector.color,
    count: countOf(sector.name),
    facets: facetNames.sort().filter((name) => dominantSubject(name) === sector.name).map((name) => ({ name, color: sector.color, count: countOf(name) }))
  }));
  const pageKinds = Object.keys(schema.folders ?? {}).filter(
    (folder) => !schema.folders[folder].hub
  );
  const inferredKinds = [...new Set(nodes.filter(isPage).map((node) => node.kind))].sort();
  return {
    nodes,
    edges,
    subjects,
    tagGroups,
    root,
    pageKinds: pageKinds.length > 0 ? pageKinds : inferredKinds,
    synthesisSave: schema.synthesisSave ?? null
  };
};

// src/ask.js
var import_obsidian = require("obsidian");
var askMethods = {
  askConfig() {
    this.askConfigPromise = this.askConfigPromise ?? this.app.vault.adapter.read(ASK_CONFIG_PATH).then((raw) => JSON.parse(raw)).catch(() => ({}));
    return this.askConfigPromise;
  },
  async openAsk() {
    this.resetDrawerHistory();
    this.askThread = this.askThread ?? [];
    this.askHistory = await this.loadAskHistory();
    this.askConversationId = this.askHistory.some(
      (entry) => entry.id === this.askConversationId
    ) ? this.askConversationId : null;
    this.askMode = true;
    this.cameFromAsk = false;
    this.drawerPath = null;
    this.drawerBackButton.style.display = "none";
    this.drawerOpenButton.style.display = "none";
    this.drawerTitleEl.setText("Ask the Wiki");
    await this.renderAsk();
    this.contentEl.scrollLeft = 0;
    this.contentEl.scrollTop = 0;
    window.setTimeout(() => this.drawerEl.addClass("open"), 20);
  },
  async loadAskHistory() {
    const parse = (raw2) => {
      try {
        const value = JSON.parse(raw2);
        return Array.isArray(value) ? value : null;
      } catch {
        return null;
      }
    };
    const ensureIds = (entries) => {
      entries.forEach((entry) => entry.id = entry.id ?? newAskId());
      return entries;
    };
    const raw = await this.app.vault.adapter.read(ASK_HISTORY_PATH).catch(() => null);
    const fromVault = raw ? parse(raw) : null;
    raw && !fromVault && await this.app.vault.adapter.write(`${ASK_HISTORY_PATH.replace(".json", "")}.corrupt-${Date.now()}.json`, raw).catch(() => {
    });
    if (fromVault) return ensureIds(fromVault);
    const legacy = ensureIds(parse(window.localStorage.getItem(LEGACY_ASK_KEY) ?? "") ?? []);
    this.askHistory = legacy;
    const persisted = legacy.length === 0 || await this.persistAskHistory();
    persisted && window.localStorage.removeItem(LEGACY_ASK_KEY);
    return legacy;
  },
  async persistAskHistory() {
    this.askHistory.length > ASK_HISTORY_CAP && (this.askHistory.length = ASK_HISTORY_CAP);
    return this.app.vault.adapter.write(ASK_HISTORY_PATH, JSON.stringify(this.askHistory)).then(() => true).catch(() => false);
  },
  async renderAsk() {
    this.askThread = this.askThread ?? [];
    const body = this.drawerBodyEl;
    body.empty();
    const form = body.createEl("form", { cls: "wlm-ask-form" });
    this.askInputEl = form.createEl("input", {
      cls: "wlm-ask-input",
      attr: { type: "text", placeholder: "Ask anything in the wiki\u2026", enterkeyhint: "send" }
    });
    const send = form.createEl("button", { cls: "wlm-ask-send", attr: { type: "submit" } });
    send.setText("Ask");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submitAsk();
    });
    this.askStatusEl = body.createEl("div", { cls: "wlm-ask-status" });
    this.askBusy && this.askStatusEl.setText(this.askStatusText ?? "Searching the wiki\u2026");
    const thread = body.createEl("div", { cls: "wlm-ask-thread" });
    await this.askThread.reduce(
      (chain, turn) => chain.then(() => this.renderTurn(thread, turn)),
      Promise.resolve()
    );
    this.askThread.length > 0 && !this.askBusy && this.renderAskActions(body);
    this.renderAskRecent(body);
    this.askBusy || this.askInputEl.focus({ preventScroll: true });
  },
  renderAskRecent(body) {
    const others = (this.askHistory ?? []).filter(
      (entry) => entry.id !== this.askConversationId && entry.turns?.length > 0
    );
    if (others.length === 0) return;
    const section = body.createEl("div", { cls: "wlm-ask-recent" });
    const title = section.createEl("div", { cls: "wlm-backlinks-title" });
    title.setText("Recent");
    others.slice(0, 5).forEach((entry) => {
      const item = section.createEl("a", { cls: "wlm-backlink" });
      item.setText(entry.turns[0].question);
      item.addEventListener("click", () => this.resumeConversation(entry));
    });
    if (others.length <= 5) return;
    const all = section.createEl("a", { cls: "wlm-backlink wlm-ask-all" });
    all.setText(`All conversations (${others.length}) \u2192`);
    all.addEventListener("click", () => this.renderAskHistoryScreen());
  },
  resumeConversation(entry) {
    this.askThread = entry.turns;
    this.askConversationId = entry.id;
    this.renderAsk();
  },
  renderAskHistoryScreen() {
    const body = this.drawerBodyEl;
    body.empty();
    const back = body.createEl("a", { cls: "wlm-backlink wlm-ask-all" });
    back.setText("\u2190 Back to Ask");
    back.addEventListener("click", () => this.renderAsk());
    const title = body.createEl("div", { cls: "wlm-backlinks-title wlm-ask-screen-title" });
    title.setText("Conversations");
    const list = body.createEl("div", { cls: "wlm-ask-conversations" });
    this.askHistory.filter((entry) => entry.turns?.length > 0).forEach((entry) => {
      const row = list.createEl("div", { cls: "wlm-ask-conversation" });
      const main = row.createEl("a", { cls: "wlm-ask-conversation-main" });
      const question = main.createEl("div", { cls: "wlm-ask-conversation-question" });
      question.setText(entry.turns[0].question);
      const meta = main.createEl("div", { cls: "wlm-ask-conversation-meta" });
      const turnCount = `${entry.turns.length} turn${entry.turns.length === 1 ? "" : "s"}`;
      const saved = entry.turns.some((turn) => turn.savedPath) ? " \xB7 saved \u2713" : "";
      meta.setText(
        [entry.updatedAt?.slice(0, 10), turnCount].filter(Boolean).join(" \xB7 ") + saved
      );
      main.addEventListener("click", () => this.resumeConversation(entry));
      if (this.askBusy) return;
      const remove = row.createEl("button", { cls: "wlm-ask-conversation-delete" });
      remove.setText("\u2715");
      remove.addEventListener("click", async () => {
        this.askHistory.splice(this.askHistory.indexOf(entry), 1);
        entry.id === this.askConversationId && (this.askThread = [], this.askConversationId = null);
        await this.persistAskHistory();
        this.renderAskHistoryScreen();
      });
    });
  },
  async renderTurn(container, turn) {
    const questionEl = container.createEl("div", { cls: "wlm-ask-question" });
    questionEl.setText(turn.question);
    const answerEl = container.createEl("div", { cls: "wlm-ask-answer markdown-rendered" });
    await import_obsidian.MarkdownRenderer.render(this.app, turn.answer, answerEl, "", this);
    const cited = this.citedNodes(turn.answer);
    if (cited.length === 0) return;
    const chips = container.createEl("div", { cls: "wlm-ask-cited" });
    cited.forEach((node) => {
      const chip = chips.createEl("button", { cls: "wlm-chip" });
      chip.setText(node.name);
      chip.style.setProperty("--chip-color", node.color);
      chip.addEventListener("click", () => this.showDrawer(node));
    });
  },
  renderAskActions(body) {
    const actions = body.createEl("div", { cls: "wlm-ask-actions" });
    const latest = this.askThread[this.askThread.length - 1];
    const save = actions.createEl("button", { cls: "wlm-ask-save" });
    save.setText(latest.savedPath ? "Saved \u2713" : "Save as synthesis page");
    (latest.failed || !this.model.synthesisSave) && (save.style.display = "none");
    latest.savedPath || save.addEventListener("click", () => this.saveSynthesis(latest, save));
    if (latest.failed) {
      const retry = actions.createEl("button", { cls: "wlm-ask-save" });
      retry.setText("Retry question");
      retry.addEventListener("click", () => this.retryAskTurn(latest));
    }
    const missing = this.missingCoverage(latest.answer);
    if (missing && !latest.failed) {
      const queue = actions.createEl("button", { cls: "wlm-ask-new wlm-gap-queue" });
      queue.setText(latest.gapPath ? "Gap queued \u2713" : "Queue missing coverage");
      latest.gapPath || queue.addEventListener("click", () => this.queueResearchGap(latest, queue));
    }
    const reset = actions.createEl("button", { cls: "wlm-ask-new" });
    reset.setText("New conversation");
    reset.addEventListener("click", () => {
      this.askThread = [];
      this.askConversationId = null;
      this.renderAsk();
    });
  },
  async retryAskTurn(turn) {
    const question = turn.question;
    const turnIndex = this.askThread.indexOf(turn);
    if (turnIndex === -1) return;
    this.askThread.splice(turnIndex, 1);
    const existing = this.askHistory.findIndex(
      (entry) => entry.id === this.askConversationId
    );
    if (existing !== -1) {
      this.askThread.length ? this.askHistory[existing].turns = this.askThread : this.askHistory.splice(existing, 1);
      await this.persistAskHistory();
    }
    this.submitAsk(question);
  },
  citedNodes(answer) {
    const wikilink = new RegExp(`\\[\\[(${this.model.root}/[^\\]|#]+)`, "g");
    const paths = [...answer.matchAll(wikilink)].map((match) => `${match[1].trim()}.md`);
    return [...new Set(paths)].map((path) => this.model.nodes.find((node) => node.path === path)).filter(Boolean);
  },
  async submitAsk(forcedQuestion = "") {
    const question = forcedQuestion || this.askInputEl.value.trim();
    if (!question || this.askBusy) return;
    this.askBusy = true;
    const targetThread = this.askThread;
    const targetId = this.askConversationId;
    const startedAt = Date.now();
    this.askTicker = window.setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1e3);
      this.askStatusText = `Searching the wiki\u2026 ${seconds}s`;
      this.askStatusEl?.setText(this.askStatusText);
    }, 1e3);
    this.renderAsk();
    try {
      const answer = sanitizeAnswer(await this.runAsk(question, targetThread));
      targetThread.push({ question, answer });
      await this.adoptAnswer(targetThread, targetId);
    } catch (error) {
      targetThread.push({
        question,
        answer: `**Could not reach the wiki server.** ${error.message ?? error}`,
        failed: true
      });
      await this.adoptAnswer(targetThread, targetId);
    }
    window.clearInterval(this.askTicker);
    this.askTicker = null;
    if (this.disposed) return;
    this.askBusy = false;
    this.askStatusText = "";
    this.askMode && this.renderAsk();
  },
  adoptAnswer(targetThread, targetId) {
    const existing = this.askHistory.findIndex((entry) => entry.id === targetId);
    existing !== -1 && this.askHistory.splice(existing, 1);
    const entryId = targetId ?? newAskId();
    this.askHistory.unshift({
      id: entryId,
      turns: targetThread,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    targetThread === this.askThread && (this.askConversationId = entryId);
    return this.persistAskHistory();
  },
  async runAsk(question, targetThread) {
    const config = await this.askConfig();
    const thread = targetThread.filter((turn) => !turn.failed).map((turn) => ({ question: turn.question, answer: turn.answer }));
    const post = await this.askRequest(config, "/ask", {
      question,
      thread
    });
    const deadline = Date.now() + 10 * 60 * 1e3;
    let consecutiveFailures = 0;
    while (Date.now() < deadline && !this.disposed) {
      await new Promise((resolve) => window.setTimeout(resolve, 2e3));
      const job = await this.askRequest(config, `/ask/${post.id}`).catch(() => null);
      consecutiveFailures = job ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures >= 8) throw new Error("lost contact with the server");
      if (job?.status === "done") return job.answer;
      if (job?.status === "error") throw new Error(job.error || "the run failed");
    }
    throw new Error(this.disposed ? "view closed" : "timed out after 10 minutes");
  },
  async askRequest(config, route, payload) {
    const endpoints = config?.endpoints ?? DEFAULT_ASK_ENDPOINTS;
    const token = config?.token ?? "";
    let lastError = new Error("no ask endpoints reachable");
    for (const base of endpoints) {
      try {
        const response = await (0, import_obsidian.requestUrl)({
          url: `${base}${route}`,
          method: payload ? "POST" : "GET",
          contentType: "application/json",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: payload ? JSON.stringify(payload) : void 0,
          throw: false
        });
        if (response.status >= 400) {
          const error = new Error(response.json?.error || `request failed (${response.status})`);
          error.code = response.json?.code;
          throw error;
        }
        return response.json;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  },
  missingCoverage(answer) {
    return answer?.match(/^Not in the wiki:\s*(.+)$/im)?.[1]?.trim() ?? "";
  },
  async queueResearchGap(turn, button) {
    const missing = this.missingCoverage(turn.answer);
    if (!missing) return;
    const config = await this.askConfig();
    const target = config.researchGaps;
    if (!target?.folder) return button.setText("Research queue not configured");
    const slugged = turn.question.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    const base = slugged || `gap-${Date.now()}`;
    let slug = base;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(`${target.folder}/${slug}.md`)) {
      slug = `${base}-${suffix++}`;
    }
    const path = `${target.folder}/${slug}.md`;
    const content = [
      "---",
      `type: ${target.type ?? "research-gap"}`,
      "status: wanted",
      `created: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`,
      `question: "${turn.question.replace(/"/g, "'")}"`,
      "---",
      `# ${turn.question}`,
      "",
      "## Missing coverage",
      "",
      missing,
      "",
      "## Candidate sources",
      "",
      "Add links or source titles here. Nothing is researched automatically.",
      "",
      "## Personal notes",
      "",
      "Add what you already know, what a useful answer should cover, or why this matters.",
      ""
    ].join("\n");
    try {
      await this.app.vault.createFolder(target.folder).catch(() => {
      });
      await this.app.vault.create(path, content);
      turn.gapPath = path;
      await this.persistAskHistory();
      button.setText("Gap queued \u2713");
    } catch {
      button.setText("Queue failed \u2014 retry");
    }
  },
  async openOps(forceCosts = false) {
    this.resetDrawerHistory();
    this.askMode = false;
    this.cameFromAsk = false;
    this.drawerPath = null;
    this.drawerBackButton.style.display = "none";
    this.drawerOpenButton.style.display = "none";
    this.drawerTitleEl.setText("Wiki operations");
    this.drawerBodyEl.empty();
    const loading = this.drawerBodyEl.createEl("div", { cls: "wlm-ask-status" });
    loading.setText("Loading usage and OpenAI spend\u2026");
    this.drawerEl.addClass("open");
    try {
      const config = await this.askConfig();
      this.opsConfig = config;
      const summary = await this.askRequest(
        config,
        forceCosts ? "/ops?refresh=1" : "/ops"
      );
      this.renderOps(summary);
    } catch (error) {
      loading.setText(`Operations server unavailable: ${error.message ?? error}`);
    }
  },
  renderOps(summary) {
    const body = this.drawerBodyEl;
    body.empty();
    const hero = body.createEl("section", { cls: "wlm-ops-hero" });
    const amount = hero.createEl("div", { cls: "wlm-ops-amount" });
    amount.setText(
      summary.credit ? `$${summary.credit.balanceUsd.toFixed(2)} credit remaining` : "Credit balance not recorded"
    );
    const state = hero.createEl("div", { cls: "wlm-ops-state" });
    const cost = summary.openaiCost ?? { status: "not-configured" };
    const hasPlatformSpend = ["ok", "stale"].includes(cost.status) && Number.isFinite(cost.spendUsd);
    const checked = cost.checkedAt?.slice(0, 10);
    state.setText(hasPlatformSpend ? `$${cost.spendUsd.toFixed(2)} OpenAI ${cost.scope} spend since ${cost.periodStart}${checked ? ` \xB7 ${cost.status === "stale" ? "cached" : "checked"} ${checked}` : ""}` : cost.message ?? "OpenAI Costs API is not configured");
    this.renderCreditEditor(hero, summary);
    if (summary.credit?.checkedAt) {
      hero.createEl("div", {
        cls: "wlm-ops-state",
        text: `Balance updated ${summary.credit.checkedAt.slice(0, 10)}`
      });
    }
    if (summary.credit?.lastTopUpUsd) {
      hero.createEl("div", {
        cls: "wlm-ops-state",
        text: `Last top-up +$${summary.credit.lastTopUpUsd.toFixed(2)} on ${summary.credit.lastTopUpAt.slice(0, 10)}`
      });
    }
    const metrics = body.createEl("div", { cls: "wlm-ops-metrics" });
    const difference = hasPlatformSpend ? cost.spendUsd - summary.spentUsd : null;
    const money = (value) => `$${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
    [
      [hasPlatformSpend ? `$${cost.spendUsd.toFixed(2)}` : "\u2014", "OpenAI month spend"],
      [`$${summary.spentUsd.toFixed(2)}`, "tracked wiki estimate"],
      [
        difference === null ? "\u2014" : `$${Math.abs(difference).toFixed(2)}`,
        difference !== null && difference < 0 ? "estimate above API" : "API/local difference"
      ],
      [`$${summary.cacheSavedUsd.toFixed(2)}`, "estimated cache saving"],
      [summary.runs, "recorded wiki runs"],
      [summary.activeAskJobs, "Ask running"]
    ].forEach(([value, label]) => {
      const card = metrics.createEl("div", { cls: "wlm-ops-metric" });
      card.createEl("strong", { text: String(value) });
      card.createEl("span", { text: label });
    });
    if (hasPlatformSpend && cost.services) {
      this.renderOpsSection(body, "OpenAI spend by service", [
        { label: "Wiki agents and Ask", meta: money(cost.services.wikiAgent ?? 0) },
        { label: "Karakeep AI tagging", meta: money(cost.services.karakeep ?? 0) },
        { label: "Wiki podcast transcription", meta: money(cost.services.wikiTranscription ?? 0) },
        { label: "Other OpenAI usage", meta: money(cost.services.other ?? 0) }
      ]);
      body.createEl("div", {
        cls: "wlm-ops-attribution",
        text: "Service attribution currently uses model line items: GPT-5 \u2192 wiki, GPT-4o mini \u2192 Karakeep, transcription \u2192 podcast intake."
      });
    }
    this.renderOpsSection(body, "Cost by workflow", Object.entries(summary.byKind).map(([kind, row]) => ({
      label: kind.replaceAll("-", " "),
      meta: `${row.runs} run${row.runs === 1 ? "" : "s"} \xB7 $${row.costUsd.toFixed(2)}`
    })));
    const pending = summary.pending;
    this.renderOpsSection(body, "Pending", [
      { label: "Inbox notes", meta: String(pending.inbox) },
      { label: "Raw sources not ingested", meta: String(pending.rawSources) },
      { label: "Research gaps", meta: String(pending.researchGaps) }
    ]);
    const gapFolder = this.opsConfig?.researchGaps?.folder;
    const gapFiles = gapFolder ? this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${gapFolder}/`)) : [];
    if (gapFiles.length) {
      const section = body.createEl("section", { cls: "wlm-ops-section" });
      section.createEl("div", { cls: "wlm-backlinks-title", text: "Research queue" });
      gapFiles.forEach((file) => {
        const link = section.createEl("a", { cls: "wlm-backlink" });
        link.setText(file.basename);
        link.addEventListener("click", () => this.app.workspace.openLinkText(file.path, "", false));
      });
    }
    if (summary.recentFailures.length) {
      this.renderOpsSection(body, "Needs attention", summary.recentFailures.map((event) => ({
        label: event.kind.replaceAll("-", " "),
        meta: `${event.timestamp.slice(0, 10)} \xB7 ${event.status}`,
        detail: event.error,
        actionText: event.kind === "ask" ? "Open Ask" : "Retry",
        action: event.kind === "ask" ? () => this.openFailedAsk() : (button) => this.retryWorkflow(event.kind, button)
      })));
    }
    const foot = body.createEl("div", { cls: "wlm-ops-foot" });
    foot.setText(
      "OpenAI spend comes from the organization Costs API when an Admin key is configured. Credit balance remains manual. Workflow figures are local wiki-only estimates from Codex token totals."
    );
    const refresh = body.createEl("button", { cls: "wlm-ask-new" });
    refresh.setText("Refresh OpenAI spend");
    refresh.addEventListener("click", () => this.openOps(true));
  },
  renderCreditEditor(hero, summary) {
    const actions = hero.createEl("div", { cls: "wlm-credit-actions" });
    const addToggle = actions.createEl("button", {
      cls: "wlm-credit-toggle mod-cta",
      attr: { type: "button" },
      text: "Add credits"
    });
    const setToggle = actions.createEl("button", {
      cls: "wlm-credit-toggle",
      attr: { type: "button" },
      text: "Set exact balance"
    });
    const addForm = hero.createEl("form", { cls: "wlm-credit-form" });
    addForm.style.display = "none";
    const amountLabel = addForm.createEl("label", { text: "Credits added ($)" });
    const amount = amountLabel.createEl("input", {
      attr: { type: "number", min: "0.01", step: "0.01", required: "true", placeholder: "5.00" }
    });
    const add = addForm.createEl("button", { attr: { type: "submit" }, text: "Add to remaining balance" });
    const setForm = hero.createEl("form", { cls: "wlm-credit-form" });
    setForm.style.display = "none";
    const balanceLabel = setForm.createEl("label", { text: "Exact remaining balance ($)" });
    const balance = balanceLabel.createEl("input", {
      attr: { type: "number", min: "0", step: "0.01", required: "true" }
    });
    balance.value = String(summary.credit?.balanceUsd ?? "");
    const save = setForm.createEl("button", { attr: { type: "submit" }, text: "Save exact balance" });
    addToggle.addEventListener("click", () => {
      setForm.style.display = "none";
      addForm.style.display = addForm.style.display === "none" ? "grid" : "none";
    });
    setToggle.addEventListener("click", () => {
      addForm.style.display = "none";
      setForm.style.display = setForm.style.display === "none" ? "grid" : "none";
    });
    addForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      add.disabled = true;
      add.setText("Adding\u2026");
      try {
        const updated = await this.askRequest(
          this.opsConfig,
          "/ops/credit/add",
          { amountUsd: Number(amount.value) }
        );
        this.renderOps(updated);
      } catch (error) {
        add.disabled = false;
        add.setText(error.message ?? "Add failed");
      }
    });
    setForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      save.setText("Saving\u2026");
      try {
        const updated = await this.askRequest(
          this.opsConfig,
          "/ops/credit",
          { balanceUsd: Number(balance.value) }
        );
        this.renderOps(updated);
      } catch (error) {
        save.disabled = false;
        save.setText(error.message ?? "Save failed");
      }
    });
    hero.createEl("div", {
      cls: "wlm-credit-help",
      text: "Display only: adding or correcting credits never pauses jobs."
    });
  },
  renderOpsSection(body, title, rows) {
    const section = body.createEl("section", { cls: "wlm-ops-section" });
    section.createEl("div", { cls: "wlm-backlinks-title", text: title });
    rows.forEach((row) => {
      const item = section.createEl("div", { cls: "wlm-ops-row" });
      const copy = item.createEl("div", { cls: "wlm-ops-row-copy" });
      copy.createEl("span", { text: row.label });
      row.detail && copy.createEl("small", { text: row.detail });
      const side = item.createEl("div", { cls: "wlm-ops-row-side" });
      side.createEl("span", { text: row.meta });
      if (row.action) {
        const action = side.createEl("button", { cls: "wlm-ops-retry" });
        action.setText(row.actionText);
        action.addEventListener("click", () => row.action(action));
      }
    });
  },
  async retryWorkflow(kind, button) {
    button.disabled = true;
    button.setText("Starting\u2026");
    try {
      const config = await this.askConfig();
      await this.askRequest(config, "/ops/retry", { kind });
      button.setText("Retry started");
    } catch {
      button.disabled = false;
      button.setText("Retry failed");
    }
  },
  async openFailedAsk() {
    await this.openAsk();
    const failed = this.askHistory.find(
      (entry) => entry.turns?.some((turn) => turn.failed)
    );
    failed && this.resumeConversation(failed);
  },
  async saveSynthesis(turn, button) {
    const target = this.model.synthesisSave;
    if (!target) return;
    const cited = this.citedNodes(turn.answer);
    const subjectCounts = cited.flatMap((node) => node.subjects[0] ? [node.subjects[0]] : []).reduce((counts, subject) => counts.set(subject, (counts.get(subject) ?? 0) + 1), /* @__PURE__ */ new Map());
    const primary = [...subjectCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? this.model.subjects[0]?.name;
    const slugged = turn.question.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    const baseSlug = slugged || `ask-${(/* @__PURE__ */ new Date()).toISOString().replace(/\D/g, "").slice(0, 14)}`;
    const taken = (candidate) => this.app.vault.getAbstractFileByPath(`${target.folder}/${candidate}.md`);
    let slug = baseSlug;
    let suffix = 2;
    while (taken(slug)) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }
    const content = [
      "---",
      `type: ${target.type}`,
      ...primary ? [`tags: [${primary}]`] : [],
      `created: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`,
      "status: edited",
      `question: "${turn.question.replace(/"/g, "'")}"`,
      "---",
      `# ${turn.question}`,
      "",
      turn.answer,
      ""
    ].join("\n");
    const path = `${target.folder}/${slug}.md`;
    try {
      await this.app.vault.createFolder(target.folder).catch(() => {
      });
      await this.app.vault.create(path, content);
      turn.savedPath = path;
      await this.persistAskHistory();
      button.setText("Saved \u2713");
    } catch {
      button.setText("Save failed \u2014 retry");
    }
  }
};

// src/sunburst.js
var circularDistance = (left, right) => Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));
var layoutSubjectLabels = (labels, baseRadius, laneGap, fontSize) => {
  const placed = [];
  return labels.map((label) => {
    for (let lane = 0; lane < 2; lane += 1) {
      const radius = baseRadius + lane * laneGap;
      const collides = placed.some((other) => {
        const radialOverlap = Math.abs(radius - other.radius) < fontSize + 6;
        const arcDistance = circularDistance(label.mid, other.mid) * Math.min(radius, other.radius);
        const requiredArc = (label.width + other.width) / 2 + 12;
        return radialOverlap && arcDistance < requiredArc;
      });
      if (!collides) {
        const result = { ...label, radius };
        placed.push(result);
        return result;
      }
    }
    return { ...label, hidden: true };
  });
};
var sunburstMethods = {
  buildSunburst() {
    const pages = this.model.nodes.filter((node) => !node.hub && !node.home);
    const groups = this.model.subjects.map((sector) => ({
      name: sector.name,
      color: sector.color,
      pages: pages.filter((page) => page.subjects[0] === sector.name)
    })).filter((group) => group.pages.length > 0);
    const total = groups.reduce((sum, group) => sum + group.pages.length, 0);
    const gap = 0.035;
    const slices = [];
    const dividers = [];
    let cursor = -Math.PI / 2;
    groups.forEach((group) => {
      const span = group.pages.length / total * (TAU - gap * groups.length);
      slices.push({
        level: "subject",
        name: group.name,
        color: group.color,
        count: group.pages.length,
        start: cursor,
        end: cursor + span,
        subject: group.name
      });
      const kinds = this.model.pageKinds.map((kind) => ({ kind, pages: group.pages.filter((page) => page.kind === kind) })).filter((entry) => entry.pages.length > 0);
      let kindCursor = cursor;
      let stripeIndex = 0;
      kinds.forEach((entry, kindIndex) => {
        const kindSpan = span * (entry.pages.length / group.pages.length);
        slices.push({
          level: "kind",
          name: entry.kind,
          color: group.color,
          count: entry.pages.length,
          start: kindCursor,
          end: kindCursor + kindSpan,
          subject: group.name
        });
        kindIndex > 0 && dividers.push(kindCursor);
        const pageSpan = kindSpan / entry.pages.length;
        entry.pages.forEach((page, index) => {
          slices.push({
            level: "page",
            name: page.name,
            color: group.color,
            node: page,
            start: kindCursor + pageSpan * index,
            end: kindCursor + pageSpan * (index + 1),
            subject: group.name,
            stripe: stripeIndex++ % 2
          });
        });
        kindCursor += kindSpan;
      });
      cursor += span + gap;
    });
    const maxDegree = Math.max(...pages.map((page) => page.degree ?? 0), 1);
    this.sunburst = { slices, total, dividers, maxDegree };
  },
  sliceAt(clientX, clientY) {
    if (!this.sunburst) return null;
    const point = this.toWorld(clientX, clientY);
    const radius = Math.hypot(point.x, point.y);
    const rings = SUN_RINGS;
    const angle = Math.atan2(point.y, point.x);
    return this.sunburst.slices.find((slice) => {
      const [inner, outer] = rings[slice.level];
      const within = radius >= inner && radius <= outer;
      const relative = ((angle - slice.start) % TAU + TAU) % TAU;
      return within && relative < slice.end - slice.start;
    }) ?? null;
  },
  drawSunburst(context, theme, now, grow, reducedMotion, scale) {
    this.sunburst ?? this.buildSunburst();
    const { slices, total, dividers } = this.sunburst;
    const rings = SUN_RINGS;
    const hoverElapsed = (now - (this.sliceHoverStart ?? 0)) / 220;
    const hoverEase = reducedMotion ? 1 : easeOutCubic(Math.min(hoverElapsed, 1));
    this.sliceHoverActive = hoverElapsed < 1 && !reducedMotion;
    const sliceMatches = (slice) => this.query === "" || (slice.node ? this.matchesQuery(slice.node) : slice.subject.toLowerCase().includes(this.query) || slice.name.toLowerCase().includes(this.query));
    const related = this.hoveredSlice && ((slice) => slice === this.hoveredSlice || this.hoveredSlice.level !== "page" && slice.subject === this.hoveredSlice.subject);
    const maxDegree = this.sunburst.maxDegree ?? 1;
    slices.forEach((slice) => {
      const [inner, baseOuter] = rings[slice.level];
      const levelStart = slice.level === "subject" ? 0 : slice.level === "kind" ? 0.22 : 0.42;
      const local = easeOutCubic(
        Math.min(Math.max((grow - levelStart) / (1 - levelStart), 0), 1)
      );
      const hovered = slice === this.hoveredSlice;
      const lift = hovered ? 8 * hoverEase : 0;
      const petal = slice.node ? 0.4 + 0.6 * ((slice.node.degree ?? 0) / maxDegree) : 1;
      const breathe = slice.node && !reducedMotion ? Math.sin(now * 12e-4 + slice.node.phase) * 2.5 * local : 0;
      const outer = inner + (baseOuter - inner) * petal * local + lift + breathe;
      const levelAlpha = slice.level === "subject" ? 0.88 : slice.level === "kind" ? 0.5 : 0.62 + slice.stripe * 0.16;
      const matchFactor = sliceMatches(slice) ? 1 : 0.12;
      const hoverFactor = related ? related(slice) ? 1 : 0.45 : 1;
      context.beginPath();
      context.arc(0, 0, outer, slice.start, slice.end);
      context.arc(0, 0, inner * grow, slice.end, slice.start, true);
      context.closePath();
      const sliceAlpha = Math.min(0.96, levelAlpha * matchFactor * hoverFactor * theme.sliceBoost);
      context.fillStyle = this.sunGloss(
        context,
        inner * grow,
        outer,
        slice.color,
        sliceAlpha,
        theme.glossMix
      );
      context.fill();
      hovered && (context.lineWidth = 1.5 / scale, context.strokeStyle = withAlpha(theme.hoverStroke, 0.5 * hoverEase), context.stroke());
    });
    context.strokeStyle = theme.background;
    context.lineWidth = 2.5;
    dividers.forEach((angle) => {
      context.beginPath();
      context.moveTo(Math.cos(angle) * rings.kind[0] * grow, Math.sin(angle) * rings.kind[0] * grow);
      context.lineTo(Math.cos(angle) * (rings.page[1] * grow + 2), Math.sin(angle) * (rings.page[1] * grow + 2));
      context.stroke();
    });
    const subjectFontSize = 15 / Math.sqrt(scale);
    context.font = `600 ${subjectFontSize}px ${theme.font}`;
    const subjectLabels = slices.filter((slice) => slice.level === "subject").map((slice) => {
      const characters = [...slice.name];
      const widths = characters.map((char) => context.measureText(char).width);
      return {
        slice,
        mid: (slice.start + slice.end) / 2,
        characters,
        widths,
        width: widths.reduce((sum, width) => sum + width, 0)
      };
    });
    layoutSubjectLabels(
      subjectLabels,
      rings.page[1] + 20,
      subjectFontSize + 8,
      subjectFontSize
    ).filter((label) => !label.hidden).forEach(({ slice, mid, characters, widths, width, radius: finalRadius }) => {
      const radius = finalRadius * grow;
      if (grow < 0.72 || radius <= 0) return;
      context.font = `600 ${subjectFontSize}px ${theme.font}`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      const reveal = Math.min((grow - 0.72) / 0.28, 1);
      context.fillStyle = withAlpha(slice.color, 0.85 * reveal);
      const normalized = (mid % TAU + TAU) % TAU;
      const flip = normalized > Math.PI / 4 && normalized < 3 * Math.PI / 4;
      const totalAngle = width / radius;
      let angle = mid + (flip ? 1 : -1) * (totalAngle / 2);
      characters.forEach((char, index) => {
        const halfAngle = widths[index] / 2 / radius;
        angle += (flip ? -1 : 1) * halfAngle;
        context.save();
        context.translate(Math.cos(angle) * radius, Math.sin(angle) * radius);
        context.rotate(angle + (flip ? -Math.PI / 2 : Math.PI / 2));
        context.fillText(char, 0, 0);
        context.restore();
        angle += (flip ? -1 : 1) * halfAngle;
      });
    });
    slices.filter((slice) => slice.level === "kind" && slice.end - slice.start > 0.07).forEach((slice) => {
      const mid = (slice.start + slice.end) / 2;
      const radius = (rings.kind[0] + rings.kind[1]) / 2 * grow;
      const label = `${slice.name} \xB7 ${slice.count}`;
      context.font = `600 ${10.5 / Math.sqrt(scale)}px ${theme.font}`;
      const tangentialFits = (slice.end - slice.start) * radius > context.measureText(label).width + 12;
      context.save();
      context.translate(Math.cos(mid) * radius, Math.sin(mid) * radius);
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = withAlpha(theme.label, 0.9);
      if (tangentialFits) {
        const normalized = (mid % TAU + TAU) % TAU;
        const upsideDown = normalized > Math.PI / 4 && normalized < 3 * Math.PI / 4;
        context.rotate(mid + (upsideDown ? -Math.PI / 2 : Math.PI / 2));
        context.fillText(label, 0, 0);
        context.restore();
        return;
      }
      context.font = `600 ${9 / Math.sqrt(scale)}px ${theme.font}`;
      context.rotate(Math.cos(mid) < 0 ? mid + Math.PI : mid);
      context.fillText(slice.name, 0, 0);
      context.restore();
    });
    const focus = this.hoveredSlice;
    context.textAlign = "center";
    context.fillStyle = withAlpha(theme.label, 0.95);
    context.font = `600 ${16 / Math.sqrt(scale)}px ${theme.font}`;
    context.textBaseline = "alphabetic";
    context.fillText(focus ? focus.name : "Wiki", 0, focus ? -4 : -6);
    context.font = `400 ${11 / Math.sqrt(scale)}px ${theme.font}`;
    context.fillStyle = withAlpha(theme.mutedLabel, 0.9);
    const subtitle = focus ? focus.level === "page" ? focus.node.subjects.map((tag) => `#${tag}`).join("  ") : `${focus.count} pages` : `${total} pages`;
    context.fillText(subtitle, 0, 16);
  },
  sunGloss(context, inner, outer, color, alpha, mixAmount) {
    const gradient = context.createRadialGradient(
      0,
      0,
      Math.max(inner, 1),
      0,
      0,
      Math.max(outer, inner + 1)
    );
    gradient.addColorStop(0, withAlpha(mixWithWhite(color, mixAmount), alpha));
    gradient.addColorStop(1, withAlpha(color, alpha));
    return gradient;
  }
};

// src/pulse.js
var dayStep = PULSE.cell + PULSE.gap;
var blockWidth = 6 * dayStep - PULSE.gap;
var blockHeight = 7 * dayStep - PULSE.gap;
var rowStride = blockHeight + PULSE.blockGapY;
var columnStride = blockWidth + PULSE.blockGapX;
var mondayIndex = (date) => (date.getDay() + 6) % 7;
var localKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
  date.getDate()
).padStart(2, "0")}`;
var pulseMethods = {
  buildPulse() {
    const days = /* @__PURE__ */ new Map();
    this.model.nodes.filter((node) => !node.hub && !node.home).forEach(
      (node) => (node.activityDays ?? []).forEach((day) => {
        const entry = days.get(day) ?? { nodes: [] };
        entry.nodes.push(node);
        days.set(day, entry);
      })
    );
    const today = /* @__PURE__ */ new Date();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const narrow = this.contentEl.clientWidth < NARROW_BREAKPOINT;
    const monthsPerRow = narrow ? PULSE.monthsPerRowNarrow : PULSE.monthsPerRow;
    const rows = Math.ceil(PULSE.months / monthsPerRow);
    const width = monthsPerRow * columnStride - PULSE.blockGapX;
    const height = rows * rowStride - PULSE.blockGapY;
    const originX = -width / 2;
    const originY = -height / 2;
    const months = [...Array(PULSE.months).keys()].map((offset) => {
      const monthStart = new Date(
        end.getFullYear(),
        end.getMonth() - (PULSE.months - 1) + offset,
        1
      );
      return {
        monthStart,
        order: offset,
        blockX: originX + offset % monthsPerRow * columnStride,
        blockY: originY + Math.floor(offset / monthsPerRow) * rowStride
      };
    });
    const cells = months.flatMap((month) => {
      const daysInMonth = new Date(
        month.monthStart.getFullYear(),
        month.monthStart.getMonth() + 1,
        0
      ).getDate();
      const firstWeekday = mondayIndex(month.monthStart);
      return [...Array(daysInMonth).keys()].map((dayIndex) => {
        const date = new Date(
          month.monthStart.getFullYear(),
          month.monthStart.getMonth(),
          dayIndex + 1
        );
        const weekIndex = Math.floor((dayIndex + firstWeekday) / 7);
        return date > end ? null : {
          date,
          key: localKey(date),
          order: month.order,
          x: month.blockX + weekIndex * dayStep,
          y: month.blockY + mondayIndex(date) * dayStep,
          entry: days.get(localKey(date)) ?? null
        };
      }).filter(Boolean);
    });
    const monthLabels = months.map((month) => ({
      x: month.blockX,
      y: month.blockY - 13,
      text: month.monthStart.toLocaleDateString(void 0, {
        month: "short",
        ...month.order === 0 || month.monthStart.getMonth() === 0 ? { year: "numeric" } : {}
      })
    }));
    const weekdayName = (row) => cells.find((cell) => mondayIndex(cell.date) === row).date.toLocaleDateString(
      void 0,
      { weekday: "short" }
    );
    const weekdayLabels = [...Array(rows).keys()].flatMap(
      (blockRow) => [0, 2, 4].flatMap((row) => {
        const y = originY + blockRow * rowStride + row * dayStep + PULSE.cell / 2;
        const text = weekdayName(row);
        return [
          { x: originX - 10, y, text, align: "right" },
          { x: originX + width + 10, y, text, align: "left" }
        ];
      })
    );
    const active = cells.filter((cell) => cell.entry);
    const maxCount = active.reduce((max, cell) => Math.max(max, cell.entry.nodes.length), 1);
    const touched = new Set(active.flatMap((cell) => cell.entry.nodes.map((node) => node.path)));
    this.pulse = {
      cells,
      monthLabels,
      weekdayLabels,
      maxCount,
      originX,
      originY,
      width,
      height,
      narrow,
      summary: `${touched.size} pages added \xB7 ${active.length} days`
    };
    this.pulseCacheStore = null;
  },
  pulseBounds() {
    const { originX, originY, width, height } = this.pulse;
    return [
      { x: originX - 44, y: originY - 54 },
      { x: originX + width + 44, y: originY + height + 16 }
    ];
  },
  pulseLocked() {
    return this.mode === "pulse" && !!this.pulse?.narrow;
  },
  pulseTopPad() {
    const bar = this.topbarEl?.getBoundingClientRect();
    const canvas = this.canvasEl.getBoundingClientRect();
    return bar ? Math.max(bar.bottom - canvas.top, 0) + 26 : 110;
  },
  pulseClampY(offsetY, scale = this.transform.scale) {
    const { originY, height } = this.pulse;
    const viewHeight = this.contentEl.clientHeight;
    const maxOffset = this.pulseTopPad() - (originY - 64) * scale;
    const minOffset = viewHeight - 96 - (originY + height + 20) * scale;
    return minOffset > maxOffset ? (minOffset + maxOffset) / 2 : Math.min(Math.max(offsetY, minOffset), maxOffset);
  },
  pulseFlyNarrow() {
    const { width } = this.pulse;
    const viewWidth = this.contentEl.clientWidth;
    const scale = (viewWidth - 12) / (width + 104);
    const to = {
      scale,
      offsetX: viewWidth / 2,
      offsetY: this.pulseClampY(-Infinity, scale)
    };
    reducedMotionQuery.matches ? (this.transform = to, this.flight = null) : this.flight = {
      start: performance.now(),
      duration: 650,
      from: { ...this.transform },
      to
    };
    this.requestDraw();
  },
  stepPulseMomentum(now) {
    const momentum = this.pulseMomentum;
    if (!momentum) return;
    const elapsed = Math.min(now - momentum.last, 50);
    momentum.last = now;
    const proposed = this.transform.offsetY + momentum.velocity * elapsed;
    const clamped = this.pulseClampY(proposed);
    this.transform.offsetY = clamped;
    momentum.velocity *= Math.exp(-elapsed / 500);
    (clamped !== proposed || Math.abs(momentum.velocity) < 0.01) && (this.pulseMomentum = null);
  },
  cellAt(clientX, clientY) {
    if (!this.pulse) return null;
    const point = this.toWorld(clientX, clientY);
    return this.pulse.cells.find(
      (cell) => point.x >= cell.x && point.x <= cell.x + PULSE.cell && point.y >= cell.y && point.y <= cell.y + PULSE.cell
    ) ?? null;
  },
  cellColor(cell) {
    const tally = cell.entry.nodes.reduce(
      (counts, node) => counts.set(node.color, (counts.get(node.color) ?? 0) + 1),
      /* @__PURE__ */ new Map()
    );
    return [...tally.entries()].sort((first, second) => second[1] - first[1])[0][0];
  },
  paintPulseGrid(context, theme, grow, reducedMotion, scale, includeHover) {
    const { cells, monthLabels, weekdayLabels, maxCount } = this.pulse;
    const highlight = (cell) => this.query === "" || cell.entry?.nodes.some((node) => this.matchesQuery(node));
    cells.forEach((cell) => {
      const local = reducedMotion ? 1 : easeOutCubic(
        Math.min(Math.max((grow * 1.6 - cell.order / PULSE.months) / 0.6, 0), 1)
      );
      const hovered = includeHover && cell === this.hoveredCell;
      const intensity = cell.entry ? 0.3 + 0.7 * (cell.entry.nodes.length / maxCount) : 0;
      const color = cell.entry ? this.cellColor(cell) : theme.label;
      const alpha = (cell.entry ? intensity : 0.08) * local * (highlight(cell) ? 1 : 0.15);
      context.beginPath();
      context.roundRect(cell.x, cell.y, PULSE.cell, PULSE.cell, 3);
      context.fillStyle = withAlpha(color, alpha);
      context.fill();
      hovered && (context.lineWidth = 1.4 / scale ** 0.5, context.strokeStyle = withAlpha(theme.hoverStroke, 0.8), context.stroke());
    });
    context.textBaseline = "middle";
    context.font = `600 ${10.5 / Math.sqrt(scale)}px ${theme.font}`;
    context.fillStyle = withAlpha(theme.mutedLabel, 0.9 * grow);
    context.textAlign = "left";
    monthLabels.forEach((label) => context.fillText(label.text, label.x, label.y));
    context.font = `400 ${9.5 / Math.sqrt(scale)}px ${theme.font}`;
    weekdayLabels.forEach((label) => {
      context.textAlign = label.align;
      context.fillText(label.text, label.x, label.y);
    });
  },
  pulseGridCache(theme) {
    const { originX, originY, width, height, narrow } = this.pulse;
    const density = Math.min(
      (window.devicePixelRatio || 1) * this.transform.scale,
      3
    );
    const key = [theme.light, this.query, narrow, density.toFixed(2)].join("|");
    if (this.pulseCacheStore?.key === key) return this.pulseCacheStore;
    const margin = { left: 64, right: 64, top: 32, bottom: 12 };
    const worldX = originX - margin.left;
    const worldY = originY - margin.top;
    const worldW = width + margin.left + margin.right;
    const worldH = height + margin.top + margin.bottom;
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(worldW * density);
    canvas.height = Math.ceil(worldH * density);
    const cacheContext = canvas.getContext("2d");
    cacheContext.scale(density, density);
    cacheContext.translate(-worldX, -worldY);
    this.paintPulseGrid(cacheContext, theme, 1, true, this.transform.scale, false);
    this.pulseCacheStore = { key, canvas, worldX, worldY, worldW, worldH };
    return this.pulseCacheStore;
  },
  drawPulse(context, theme, grow, reducedMotion, scale) {
    this.pulse ?? this.buildPulse();
    const cached = this.pulseLocked() && grow >= 1;
    if (cached) {
      const cache = this.pulseGridCache(theme);
      context.drawImage(cache.canvas, cache.worldX, cache.worldY, cache.worldW, cache.worldH);
      const hovered = this.hoveredCell;
      hovered && (context.beginPath(), context.roundRect(hovered.x, hovered.y, PULSE.cell, PULSE.cell, 3), context.lineWidth = 1.4 / scale ** 0.5, context.strokeStyle = withAlpha(theme.hoverStroke, 0.8), context.stroke());
    }
    cached || this.paintPulseGrid(context, theme, grow, reducedMotion, scale, true);
    const focus = this.hoveredCell;
    const caption = focus ? `${focus.date.toLocaleDateString(void 0, {
      day: "numeric",
      month: "short",
      year: "numeric"
    })} \xB7 ${focus.entry?.nodes.length ?? 0} pages added` : this.pulse.summary;
    const ratio = window.devicePixelRatio || 1;
    context.save();
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const captionX = this.canvasEl.width / ratio / 2;
    const captionY = this.pulseTopPad();
    context.textAlign = "center";
    context.font = `600 13px ${theme.font}`;
    const captionHalf = context.measureText(caption).width / 2 + 12;
    context.beginPath();
    context.roundRect(captionX - captionHalf, captionY - 12, captionHalf * 2, 24, 12);
    context.fillStyle = withAlpha(theme.background, 0.82 * grow);
    context.fill();
    context.fillStyle = withAlpha(theme.label, 0.95 * grow);
    context.fillText(caption, captionX, captionY);
    context.restore();
  },
  openDay(cell) {
    this.resetDrawerHistory();
    this.askMode = false;
    this.cameFromAsk = false;
    this.drawerBackButton.style.display = "none";
    this.drawerPath = null;
    this.drawerOpenButton.style.display = "none";
    this.drawerTitleEl.setText(
      cell.date.toLocaleDateString(void 0, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric"
      })
    );
    this.drawerBodyEl.empty();
    const list = this.drawerBodyEl.createEl("div", { cls: "wlm-day-list" });
    [...cell.entry.nodes].sort(
      (first, second) => first.kind.localeCompare(second.kind) || first.name.localeCompare(second.name)
    ).forEach((node) => {
      const item = list.createEl("button", { cls: "wlm-day-item" });
      const dot = item.createEl("span", { cls: "wlm-day-dot" });
      dot.style.setProperty(
        "--chip-color",
        node.home ? this.theme().homeColor : node.color
      );
      const label = item.createEl("span", { cls: "wlm-day-name" });
      label.setText(node.fullName ?? node.name);
      const kind = item.createEl("span", { cls: "wlm-day-kind" });
      kind.setText(node.kind);
      item.addEventListener("click", () => this.showDrawer(node));
    });
    this.drawerEl.addClass("open");
    this.drawerBodyEl.scrollTop = 0;
  }
};

// src/view.js
var MapView = class extends import_obsidian2.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.transform = { scale: 1, offsetX: 0, offsetY: 0 };
    this.pointers = /* @__PURE__ */ new Map();
    this.hovered = null;
    this.hoveredSlice = null;
    this.mode = "map";
    this.query = "";
    this.introStart = 0;
    this.model = { nodes: [], edges: [], subjects: [] };
  }
  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "Wiki Dashboard";
  }
  getIcon() {
    return "radar";
  }
  async onOpen() {
    const container = this.contentEl;
    container.empty();
    container.addClass("wlm-container");
    const topbar = container.createEl("div", { cls: "wlm-topbar" });
    this.topbarEl = topbar;
    this.isolateTouch(topbar);
    const toolbar = topbar.createEl("div", { cls: "wlm-toolbar" });
    const searchToggle = toolbar.createEl("button", { cls: "wlm-search-toggle" });
    (0, import_obsidian2.setIcon)(searchToggle, "search");
    searchToggle.addEventListener("click", () => {
      const open = container.classList.toggle("wlm-search-open");
      (0, import_obsidian2.setIcon)(searchToggle, open ? "x" : "search");
      open ? this.searchEl.focus() : this.setFilter("");
    });
    this.searchEl = toolbar.createEl("input", {
      cls: "wlm-search",
      attr: { type: "search", placeholder: "Filter the map\u2026" }
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.toLowerCase().trim();
      this.renderChips();
      this.flyToQuery();
      this.requestDraw();
    });
    this.modesEl = toolbar.createEl("div", { cls: "wlm-modes" });
    [
      { value: "map", label: "Map" },
      { value: "sunburst", label: "Sunburst" },
      { value: "pulse", label: "Pulse" }
    ].forEach((mode) => {
      const button = this.modesEl.createEl("button", { cls: "wlm-mode" });
      button.setText(mode.label);
      button.dataset.mode = mode.value;
      button.classList.toggle("active", this.mode === mode.value);
      button.addEventListener("click", () => this.setMode(mode.value));
    });
    const askButton = toolbar.createEl("button", { cls: "wlm-ask-open" });
    askButton.setText("\u2726 Ask");
    askButton.addEventListener("click", () => this.openAsk());
    const opsButton = toolbar.createEl("button", { cls: "wlm-ops-open" });
    opsButton.setText("$ Ops");
    opsButton.addEventListener("click", () => this.openOps());
    this.chipsEl = topbar.createEl("div", { cls: "wlm-chips" });
    this.facetsRowEl = topbar.createEl("div", { cls: "wlm-chips wlm-facet-row" });
    this.isolateTouch(this.chipsEl);
    this.isolateTouch(this.facetsRowEl);
    this.canvasEl = container.createEl("canvas", { cls: "wlm-canvas" });
    this.bindPointerEvents();
    this.buildDrawer(container);
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);
    this.registerDomEvent(window, "resize", () => this.handleResize());
    const rebuild = (0, import_obsidian2.debounce)(() => this.rebuild(), 800, true);
    this.registerEvent(this.app.metadataCache.on("resolved", rebuild));
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        this.cachedTheme = null;
        this.glowSprites = /* @__PURE__ */ new Map();
        this.rebuild();
      })
    );
    await this.rebuild();
  }
  async onClose() {
    this.disposed = true;
    this.askTicker && window.clearInterval(this.askTicker);
    this.resizeObserver?.disconnect();
  }
  handleResize() {
    const ratio = window.devicePixelRatio || 1;
    const width = this.contentEl.clientWidth;
    const height = this.contentEl.clientHeight;
    const narrowNow = width < NARROW_BREAKPOINT;
    this.contentEl.classList.toggle("wlm-narrow", narrowNow);
    const changed = this.canvasEl.width !== Math.round(width * ratio);
    this.canvasEl.width = Math.round(width * ratio);
    this.canvasEl.height = Math.round(height * ratio);
    const pulseLayoutStale = this.mode === "pulse" && this.pulse && this.pulse.narrow !== narrowNow;
    pulseLayoutStale && (this.buildPulse(), narrowNow ? this.pulseFlyNarrow() : this.flyToNodes(this.pulseBounds()));
    changed && !pulseLayoutStale && this.fitToView();
    this.requestDraw();
  }
  async rebuild() {
    const previous = new Map((this.model?.nodes ?? []).map((node) => [node.path, node]));
    const firstBuild = previous.size === 0;
    this.model = await buildModel(this.app, this.theme());
    const sameNodes = previous.size === this.model.nodes.length && this.model.nodes.every((node) => previous.has(node.path));
    this.model.nodes.forEach((node) => {
      const old = previous.get(node.path);
      node.fromX = old?.renderX ?? 0;
      node.fromY = old?.renderY ?? 0;
      node.alphaState = old?.alphaState;
    });
    sameNodes || (this.introStart = performance.now());
    const focusNode = this.focusPath && this.model.nodes.find((node) => node.path === this.focusPath);
    this.focusPath = focusNode ? this.focusPath : null;
    this.focusRings = focusNode ? this.focusRings : null;
    focusNode && this.applyFocusLayout(focusNode);
    this.renderChips();
    this.mode === "sunburst" && this.buildSunburst();
    this.mode === "pulse" && this.buildPulse();
    firstBuild && this.fitToView();
    this.requestDraw();
  }
  setFilter(value) {
    this.query = value;
    this.searchEl.value = value;
    this.renderChips();
    this.flyToQuery();
    this.requestDraw();
  }
  setMode(value) {
    this.mode = value;
    [...this.modesEl.children].forEach(
      (button) => button.classList.toggle("active", button.dataset.mode === value)
    );
    this.hovered = null;
    this.hoveredSlice = null;
    this.hoveredCell = null;
    this.introStart = performance.now();
    value === "sunburst" && this.buildSunburst();
    value === "pulse" && this.buildPulse();
    const narrow = this.contentEl.clientWidth < NARROW_BREAKPOINT;
    const reach = narrow ? SUNBURST_REACH.narrow : SUNBURST_REACH.wide;
    const flightTargets = {
      sunburst: () => [{ x: -reach, y: -reach + 5 }, { x: reach, y: reach }],
      pulse: () => this.pulseBounds(),
      map: () => this.mapFitTargets()
    };
    this.pulseLocked() ? this.pulseFlyNarrow() : this.flyToNodes(flightTargets[value]());
    this.requestDraw();
  }
  mapFitTargets() {
    const labelPoints = this.model.subjects.flatMap((subject) => {
      const angle = subject.labelAngle ?? (subject.startAngle + subject.endAngle) / 2;
      const radius = subject.labelRadius ?? subject.outerRadius + 70;
      const halfWidth = subject.name.length * 5.2;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      return [
        { x: x - halfWidth, y },
        { x: x + halfWidth, y }
      ];
    });
    return [...this.model.nodes, ...labelPoints];
  }
  matchesQuery(node) {
    return this.query === "" || node.name.toLowerCase().includes(this.query) || node.subjects.some((tag) => tag.toLowerCase().includes(this.query));
  }
  flyToQuery() {
    if (this.mode !== "map") return;
    const matched = this.model.nodes.filter((node) => this.matchesQuery(node));
    const targets = this.query === "" ? this.mapFitTargets() : matched;
    targets.length && this.flyToNodes(targets);
  }
  flyToNodes(targets) {
    if (targets.length === 0) return;
    const width = this.contentEl.clientWidth;
    const height = this.contentEl.clientHeight;
    const xs = targets.map((node) => node.x);
    const ys = targets.map((node) => node.y);
    const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const extentX = Math.max((Math.max(...xs) - Math.min(...xs)) / 2, 60) + 90;
    const extentY = Math.max((Math.max(...ys) - Math.min(...ys)) / 2, 60) + 90;
    const fit = Math.min((width / 2 - 32) / extentX, (height / 2 - 32) / extentY);
    const scale = Math.min(Math.max(fit, 0.05), 1.7);
    const to = {
      scale,
      offsetX: width / 2 - centerX * scale,
      offsetY: height / 2 - centerY * scale
    };
    const reducedMotion = reducedMotionQuery.matches;
    reducedMotion ? (this.transform = to, this.flight = null) : this.flight = {
      start: performance.now(),
      duration: 650,
      from: { ...this.transform },
      to
    };
    this.requestDraw();
  }
  stepFlight(now) {
    const progress = Math.min((now - this.flight.start) / this.flight.duration, 1);
    const eased = easeOutCubic(progress);
    const { from, to } = this.flight;
    this.transform = {
      scale: from.scale + (to.scale - from.scale) * eased,
      offsetX: from.offsetX + (to.offsetX - from.offsetX) * eased,
      offsetY: from.offsetY + (to.offsetY - from.offsetY) * eased
    };
    progress >= 1 && (this.flight = null);
  }
  applyFocusLayout(node) {
    const { nodes, edges } = this.model;
    const neighborsOf = (path) => edges.filter((edge) => edge.from === path || edge.to === path).flatMap((edge) => [edge.from, edge.to]).filter((other) => other !== path);
    const ring1 = new Set(neighborsOf(node.path));
    const ring2 = new Set(
      [...ring1].flatMap(neighborsOf).filter((path) => path !== node.path && !ring1.has(path))
    );
    this.focusPath = node.path;
    this.focusRings = { ring1, ring2 };
    nodes.forEach((member) => {
      member.fromX = member.renderX ?? member.x;
      member.fromY = member.renderY ?? member.y;
    });
    const inRing = (set) => nodes.filter((member) => set.has(member.path));
    const rest = nodes.filter(
      (member) => member.path !== node.path && !ring1.has(member.path) && !ring2.has(member.path)
    );
    const place = (list, radius) => list.forEach((member, index) => {
      const angle = -Math.PI / 2 + index / Math.max(list.length, 1) * TAU;
      member.x = Math.cos(angle) * radius;
      member.y = Math.sin(angle) * radius;
    });
    node.x = 0;
    node.y = 0;
    place(inRing(ring1), 180);
    place(inRing(ring2), 340);
    place(rest, 560);
    return [node, ...inRing(ring1), ...inRing(ring2)];
  }
  enterFocus(node) {
    this.closeDrawer();
    const flightTargets = this.applyFocusLayout(node);
    this.introStart = performance.now();
    this.flyToNodes(flightTargets);
  }
  exitFocus() {
    this.focusPath = null;
    this.focusRings = null;
    this.model.nodes.forEach((member) => {
      member.fromX = member.renderX ?? member.x;
      member.fromY = member.renderY ?? member.y;
      member.x = member.baseX;
      member.y = member.baseY;
    });
    this.introStart = performance.now();
    this.flyToNodes(this.model.nodes);
  }
  renderChips() {
    this.chipsEl.empty();
    this.facetsRowEl?.empty();
    this.model.tagGroups.forEach((group) => {
      const groupEl = this.chipsEl.createEl("div", { cls: "wlm-chip-group" });
      const expanded = this.query === group.name || group.facets.some((facet) => facet.name === this.query);
      expanded && groupEl.addClass("expanded");
      this.renderChip(groupEl, group, true);
      const facetsEl = groupEl.createEl("div", { cls: "wlm-chip-facets" });
      const panelEl = facetsEl.createEl("div", { cls: "wlm-chip-facets-panel" });
      group.facets.forEach((facet) => this.renderChip(panelEl, facet, false));
      expanded && this.facetsRowEl && group.facets.forEach((facet) => this.renderChip(this.facetsRowEl, facet, false));
    });
  }
  renderChip(parent, tag, isSubject) {
    const chip = parent.createEl("button", { cls: "wlm-chip" });
    isSubject && chip.addClass("wlm-chip-subject");
    chip.setText(`#${tag.name}`);
    const badge = chip.createEl("span", { cls: "wlm-chip-count" });
    badge.setText(String(tag.count));
    chip.style.setProperty("--chip-color", tag.color);
    chip.classList.toggle("active", this.query === tag.name);
    chip.addEventListener(
      "click",
      () => this.setFilter(this.query === tag.name ? "" : tag.name)
    );
  }
  fitToView() {
    const width = this.contentEl.clientWidth;
    const height = this.contentEl.clientHeight;
    const extent = this.model.subjects.reduce(
      (radius, subject) => Math.max(radius, subject.outerRadius, subject.labelRadius ?? 0),
      this.model.nodes.reduce(
        (radius, node) => Math.max(radius, Math.hypot(node.x, node.y)),
        10
      )
    ) + 70;
    const scale = (Math.min(width, height) / 2 - 24) / extent;
    this.transform = {
      scale: Math.max(scale, 0.05),
      offsetX: width / 2,
      offsetY: height / 2
    };
  }
  toWorld(clientX, clientY) {
    const rect = this.canvasEl.getBoundingClientRect();
    const { scale, offsetX, offsetY } = this.transform;
    return {
      x: (clientX - rect.left - offsetX) / scale,
      y: (clientY - rect.top - offsetY) / scale
    };
  }
  nodeAt(clientX, clientY) {
    const point = this.toWorld(clientX, clientY);
    const hitRadius = 14 / this.transform.scale;
    return [...this.model.nodes].reverse().find(
      (node) => Math.hypot((node.renderX ?? node.x) - point.x, (node.renderY ?? node.y) - point.y) < hitRadius + node.size
    ) ?? null;
  }
  isolateTouch(element) {
    ["touchstart", "touchmove", "touchend"].forEach(
      (type) => this.registerDomEvent(element, type, (event) => event.stopPropagation())
    );
  }
  bindPointerEvents() {
    const canvas = this.canvasEl;
    canvas.style.touchAction = "none";
    this.isolateTouch(canvas);
    canvas.addEventListener("pointerdown", (event) => {
      this.flight = null;
      this.pulseMomentum = null;
      this.panVelocityY = 0;
      this.panSampleAt = null;
      canvas.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY
      });
    });
    canvas.addEventListener("pointermove", (event) => {
      const pointer = this.pointers.get(event.pointerId);
      if (!pointer) {
        if (this.mode === "pulse") {
          const cell = this.cellAt(event.clientX, event.clientY);
          const cellChanged = cell !== this.hoveredCell;
          this.hoveredCell = cell;
          canvas.style.cursor = cell?.entry ? "pointer" : "default";
          cellChanged && this.requestDraw();
          return;
        }
        if (this.mode === "sunburst") {
          const slice = this.sliceAt(event.clientX, event.clientY);
          const sliceChanged = slice !== this.hoveredSlice;
          this.hoveredSlice = slice;
          canvas.style.cursor = slice ? "pointer" : "default";
          sliceChanged && (this.sliceHoverStart = performance.now(), this.requestDraw());
          return;
        }
        const node = this.nodeAt(event.clientX, event.clientY);
        const changed = node !== this.hovered;
        this.hovered = node;
        canvas.style.cursor = node ? "pointer" : "default";
        changed && this.requestDraw();
        return;
      }
      const previous = { x: pointer.x, y: pointer.y };
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      const pointerList = [...this.pointers.values()];
      if (pointerList.length === 1) {
        const locked = this.pulseLocked();
        const deltaY = pointer.y - previous.y;
        locked || (this.transform.offsetX += pointer.x - previous.x);
        this.transform.offsetY += deltaY;
        if (locked) {
          this.transform.offsetY = this.pulseClampY(this.transform.offsetY);
          const sampleNow = performance.now();
          const elapsed = sampleNow - (this.panSampleAt ?? sampleNow);
          elapsed > 0 && (this.panVelocityY = 0.8 * (deltaY / elapsed) + 0.2 * (this.panVelocityY ?? 0));
          this.panSampleAt = sampleNow;
        }
        this.requestDraw();
        return;
      }
      const [first, second] = pointerList;
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const previousDistance = this.pinchDistance ?? distance;
      this.pinchDistance = distance;
      const midX = (first.x + second.x) / 2;
      const midY = (first.y + second.y) / 2;
      this.zoomAt(midX, midY, distance / previousDistance);
    });
    const releasePointer = (event) => {
      const pointer = this.pointers.get(event.pointerId);
      this.pointers.delete(event.pointerId);
      this.pinchDistance = null;
      const moved = pointer ? Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) : 99;
      if (this.mode === "pulse") {
        const flick = this.pulseLocked() && moved >= 6 && !reducedMotionQuery.matches && Math.abs(this.panVelocityY ?? 0) > 0.03;
        flick && (this.pulseMomentum = {
          velocity: this.panVelocityY * 1.15,
          last: performance.now()
        }, this.requestDraw());
        const cell = moved < 6 ? this.cellAt(event.clientX, event.clientY) : null;
        cell?.entry && this.openDay(cell);
        moved < 6 && !cell?.entry && this.closeDrawer();
        return;
      }
      if (this.mode === "sunburst") {
        const slice = moved < 6 ? this.sliceAt(event.clientX, event.clientY) : null;
        slice?.level === "page" && this.openNode(slice.node);
        slice && slice.level !== "page" && this.setFilter(this.query === slice.subject ? "" : slice.subject);
        moved < 6 && !slice && this.closeDrawer();
        return;
      }
      const node = moved < 6 ? this.nodeAt(event.clientX, event.clientY) : null;
      const tapTime = performance.now();
      const doubleTap = node && node.path === this.lastTapPath && tapTime - (this.lastTapAt ?? 0) < 350;
      this.lastTapPath = node?.path ?? null;
      this.lastTapAt = tapTime;
      if (doubleTap) {
        this.focusPath === node.path ? this.exitFocus() : this.enterFocus(node);
        return;
      }
      node && this.openNode(node);
      moved < 6 && !node && this.closeDrawer();
    };
    canvas.addEventListener("pointerup", releasePointer);
    canvas.addEventListener("pointercancel", (event) => {
      this.pointers.delete(event.pointerId);
      this.pinchDistance = null;
    });
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 2e-3));
      },
      { passive: false }
    );
  }
  zoomAt(clientX, clientY, factor) {
    if (this.pulseLocked()) return;
    this.flight = null;
    const rect = this.canvasEl.getBoundingClientRect();
    const pivotX = clientX - rect.left;
    const pivotY = clientY - rect.top;
    const nextScale = Math.min(Math.max(this.transform.scale * factor, 0.05), 8);
    const applied = nextScale / this.transform.scale;
    this.transform.offsetX = pivotX - (pivotX - this.transform.offsetX) * applied;
    this.transform.offsetY = pivotY - (pivotY - this.transform.offsetY) * applied;
    this.transform.scale = nextScale;
    this.requestDraw();
  }
  buildDrawer(container) {
    this.drawerEl = container.createEl("aside", { cls: "wlm-drawer" });
    this.isolateTouch(this.drawerEl);
    const header = this.drawerEl.createEl("header", { cls: "wlm-drawer-header" });
    this.drawerHistory = [];
    this.drawerHistoryBackButton = header.createEl("button", {
      cls: "wlm-drawer-history-back",
      attr: { "aria-label": "Go back", title: "Go back" }
    });
    this.drawerHistoryBackButton.setText("\u2190");
    this.drawerHistoryBackButton.style.display = "none";
    this.drawerHistoryBackButton.addEventListener("click", () => this.goBackDrawer());
    this.drawerBackButton = header.createEl("button", { cls: "wlm-drawer-back" });
    this.drawerBackButton.setText("\u2726 Ask");
    this.drawerBackButton.style.display = "none";
    this.drawerBackButton.addEventListener("click", () => this.openAsk());
    this.drawerTitleEl = header.createEl("span", { cls: "wlm-drawer-title" });
    this.drawerOpenButton = header.createEl("button", { cls: "wlm-drawer-open" });
    this.drawerOpenButton.setText("Open note");
    this.drawerOpenButton.addEventListener("click", () => {
      this.drawerPath && this.app.workspace.openLinkText(this.drawerPath, "", false);
      this.closeDrawer();
    });
    const closeButton = header.createEl("button", { cls: "wlm-drawer-close" });
    closeButton.setText("\u2715");
    closeButton.addEventListener("click", () => this.closeDrawer());
    this.drawerBodyEl = this.drawerEl.createEl("div", {
      cls: "wlm-drawer-body markdown-rendered"
    });
    this.drawerBodyEl.addEventListener("click", (event) => {
      const link = event.target.closest("a.internal-link");
      if (!link) return;
      event.preventDefault();
      const target = this.app.metadataCache.getFirstLinkpathDest(
        link.getAttribute("data-href") ?? link.getAttribute("href") ?? "",
        this.drawerPath ?? ""
      );
      const mapNode = target && this.model.nodes.find((node) => node.path === target.path);
      mapNode ? this.showDrawer(mapNode) : target && this.app.workspace.openLinkText(target.path, "", false);
    });
    this.registerDomEvent(document, "keydown", (event) => {
      event.key === "Escape" && (this.focusPath ? this.exitFocus() : this.closeDrawer());
    });
  }
  async showDrawer(node, { recordHistory = true, scrollTop = 0 } = {}) {
    if (recordHistory && this.drawerPath && this.drawerPath !== node.path) {
      this.drawerHistory.push({
        path: this.drawerPath,
        scrollTop: this.drawerBodyEl.scrollTop
      });
    }
    this.updateDrawerHistoryButton();
    this.cameFromAsk = this.cameFromAsk || this.askMode;
    this.askMode = false;
    this.drawerBackButton.style.display = this.cameFromAsk ? "" : "none";
    this.drawerPath = node.path;
    this.drawerOpenButton.style.display = "";
    this.drawerTitleEl.setText(node.fullName ?? node.name);
    this.drawerBodyEl.empty();
    const tagsEl = this.drawerBodyEl.createEl("div", { cls: "wlm-drawer-tags" });
    node.subjects.forEach((tag) => {
      const chip = tagsEl.createEl("button", { cls: "wlm-chip" });
      chip.setText(`#${tag}`);
      chip.style.setProperty("--chip-color", node.color);
      chip.addEventListener("click", () => this.setFilter(tag));
    });
    const contentEl = this.drawerBodyEl.createEl("div", { cls: "wlm-drawer-content" });
    const file = this.app.vault.getAbstractFileByPath(node.path);
    const raw = file ? await this.app.vault.cachedRead(file) : "";
    const markdown = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
    await import_obsidian2.MarkdownRenderer.render(this.app, markdown, contentEl, node.path, this);
    this.renderBacklinks(node);
    this.drawerEl.addClass("open");
    this.drawerBodyEl.scrollTop = scrollTop;
  }
  updateDrawerHistoryButton() {
    this.drawerHistoryBackButton.style.display = this.drawerHistory.length > 0 ? "" : "none";
  }
  async goBackDrawer() {
    while (this.drawerHistory.length > 0) {
      const previous = this.drawerHistory.pop();
      const node = this.model.nodes.find((candidate) => candidate.path === previous.path);
      if (!node) continue;
      this.updateDrawerHistoryButton();
      await this.showDrawer(node, {
        recordHistory: false,
        scrollTop: previous.scrollTop
      });
      return;
    }
    this.updateDrawerHistoryButton();
  }
  resetDrawerHistory() {
    this.drawerHistory = [];
    this.updateDrawerHistoryButton();
  }
  renderBacklinks(node) {
    const citers = this.model.edges.filter((edge) => edge.to === node.path).map((edge) => this.model.nodes.find((candidate) => candidate.path === edge.from)).filter(Boolean);
    if (citers.length === 0) return;
    const section = this.drawerBodyEl.createEl("div", { cls: "wlm-backlinks" });
    const title = section.createEl("div", { cls: "wlm-backlinks-title" });
    title.setText("Linked from");
    citers.forEach((citer) => {
      const link = section.createEl("a", { cls: "wlm-backlink" });
      link.setText(citer.fullName ?? citer.name);
      link.addEventListener("click", () => this.showDrawer(citer));
    });
  }
  closeDrawer() {
    this.drawerEl?.removeClass("open");
    this.drawerPath = null;
    this.askMode = false;
    this.cameFromAsk = false;
    this.resetDrawerHistory();
    this.requestDraw();
  }
  openNode(node) {
    const now = performance.now();
    const debounced = now - (this.lastOpenAt ?? 0) < 400;
    this.lastOpenAt = now;
    debounced || this.showDrawer(node);
  }
  requestDraw() {
    this.drawQueued || (this.drawQueued = true, requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    }));
  }
  queueNextFrame(animating) {
    animating && this.contentEl.isConnected && this.contentEl.offsetParent !== null && this.requestDraw();
  }
  theme() {
    this.cachedTheme = this.cachedTheme ?? computeTheme(this.contentEl);
    return this.cachedTheme;
  }
  glowSprite(color) {
    this.glowSprites = this.glowSprites ?? /* @__PURE__ */ new Map();
    const theme = this.theme();
    const key = `${color}|${theme.light}`;
    const cached = this.glowSprites.get(key);
    if (cached) return cached;
    const halo = mixWithWhite(color, theme.haloMix);
    const sprite = document.createElement("canvas");
    sprite.width = 128;
    sprite.height = 128;
    const spriteContext = sprite.getContext("2d");
    const gradient = spriteContext.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, withAlpha(halo, 1));
    gradient.addColorStop(0.45, withAlpha(halo, 0.35));
    gradient.addColorStop(1, withAlpha(halo, 0));
    spriteContext.fillStyle = gradient;
    spriteContext.fillRect(0, 0, 128, 128);
    this.glowSprites.set(key, sprite);
    return sprite;
  }
  draw() {
    const drawerCoversCanvas = this.contentEl.classList.contains("wlm-narrow") && this.drawerEl?.classList.contains("open");
    if (drawerCoversCanvas) return;
    const canvas = this.canvasEl;
    const context = canvas.getContext("2d");
    const ratio = window.devicePixelRatio || 1;
    const theme = this.theme();
    const { nodes, edges, subjects } = this.model;
    const reducedMotion = reducedMotionQuery.matches;
    const now = performance.now();
    this.flight && this.stepFlight(now);
    const { scale, offsetX, offsetY } = this.transform;
    const introElapsed = (now - this.introStart) / 900;
    const intro = reducedMotion ? 1 : Math.min(introElapsed, 1);
    const grow = easeOutCubic(intro);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = theme.background;
    context.fillRect(0, 0, canvas.width / ratio, canvas.height / ratio);
    context.translate(offsetX, offsetY);
    context.scale(scale, scale);
    if (this.mode === "sunburst") {
      this.drawSunburst(context, theme, now, grow, reducedMotion, scale);
      context.setTransform(1, 0, 0, 1, 0, 0);
      const sunburstAnimating = intro < 1 || this.flight || this.sliceHoverActive || !reducedMotion;
      this.queueNextFrame(sunburstAnimating);
      return;
    }
    if (this.mode === "pulse") {
      this.stepPulseMomentum(now);
      this.drawPulse(context, theme, grow, reducedMotion, scale);
      context.setTransform(1, 0, 0, 1, 0, 0);
      this.queueNextFrame(intro < 1 || !!this.flight || !!this.pulseMomentum);
      return;
    }
    const neighborhood = this.hovered ? /* @__PURE__ */ new Set([
      this.hovered.path,
      ...edges.filter((edge) => edge.from === this.hovered.path || edge.to === this.hovered.path).flatMap((edge) => [edge.from, edge.to])
    ]) : null;
    const emphasis = (node) => {
      const searchFactor = this.matchesQuery(node) ? 1 : 0.12;
      const hoverFactor = neighborhood ? neighborhood.has(node.path) ? 1 : 0.15 : 1;
      const focusFactor = this.focusPath ? node.path === this.focusPath || this.focusRings.ring1.has(node.path) ? 1 : this.focusRings.ring2.has(node.path) ? 0.55 : 0.08 : 1;
      return Math.min(searchFactor, hoverFactor, focusFactor);
    };
    nodes.forEach((node) => {
      const springX = (node.fromX ?? 0) + (node.x - (node.fromX ?? 0)) * grow;
      const springY = (node.fromY ?? 0) + (node.y - (node.fromY ?? 0)) * grow;
      const drift = reducedMotion ? 0 : 6 * grow;
      node.renderX = springX + Math.sin(now * 35e-5 + node.phase) * drift;
      node.renderY = springY + Math.cos(now * 28e-5 + node.phase * 1.7) * drift;
      const target = emphasis(node);
      const eased = (node.alphaState ?? target) + (target - (node.alphaState ?? target)) * 0.16;
      node.alphaState = reducedMotion ? target : eased;
      const hoverTarget = node === this.hovered ? 1 : 0;
      const hoverEased = (node.hoverState ?? 0) + (hoverTarget - (node.hoverState ?? 0)) * 0.18;
      node.hoverState = reducedMotion ? hoverTarget : hoverEased;
    });
    const settled = nodes.every(
      (node) => Math.abs(node.alphaState - emphasis(node)) < 0.01 && Math.abs(node.hoverState - (node === this.hovered ? 1 : 0)) < 0.01
    );
    subjects.forEach((subject) => {
      const labelAngle = subject.labelAngle ?? (subject.startAngle + subject.endAngle) / 2;
      const labelRadius = subject.labelRadius ?? subject.outerRadius + 70;
      context.save();
      context.translate(
        Math.cos(labelAngle) * labelRadius,
        Math.sin(labelAngle) * labelRadius
      );
      context.fillStyle = withAlpha(subject.color, 0.75 * grow);
      context.font = `600 ${15 / Math.sqrt(scale)}px ${theme.font}`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(subject.name, 0, 0);
      context.restore();
    });
    const nodeIndex = this.model.nodeIndex ?? (this.model.nodeIndex = new Map(nodes.map((node) => [node.path, node])));
    edges.forEach((edge) => {
      const from = nodeIndex.get(edge.from);
      const to = nodeIndex.get(edge.to);
      if (!from || !to) return;
      const strength = Math.min(from.alphaState, to.alphaState);
      const hoverEdge = this.hovered && (edge.from === this.hovered.path || edge.to === this.hovered.path);
      const baseAlpha = hoverEdge ? 0.5 : edge.kind === "hierarchy" ? 0.3 : 0.14;
      const edgeColor = hoverEdge ? this.hovered.home ? theme.homeColor : this.hovered.color : to.color;
      context.beginPath();
      context.moveTo(from.renderX, from.renderY);
      const centerMidX = (from.renderX + to.renderX) / 2 * 0.72;
      const centerMidY = (from.renderY + to.renderY) / 2 * 0.72;
      const deltaX = to.renderX - from.renderX;
      const deltaY = to.renderY - from.renderY;
      const length = Math.hypot(deltaX, deltaY) || 1;
      const cross = (centerMidX - from.renderX) * deltaY - (centerMidY - from.renderY) * deltaX;
      const flat = Math.abs(cross) / length < 6;
      const side = from.phase > to.phase ? 1 : -1;
      const bow = length * 0.14 * side;
      const midX = flat ? (from.renderX + to.renderX) / 2 + -deltaY / length * bow : centerMidX;
      const midY = flat ? (from.renderY + to.renderY) / 2 + deltaX / length * bow : centerMidY;
      context.quadraticCurveTo(midX, midY, to.renderX, to.renderY);
      context.strokeStyle = withAlpha(
        edgeColor,
        Math.min(0.95, baseAlpha * strength * theme.edgeBoost)
      );
      context.lineWidth = (hoverEdge ? 1.7 : edge.kind === "hierarchy" ? 1.6 : 1) / scale ** 0.5;
      context.stroke();
    });
    nodes.forEach((node) => {
      const alpha = node.alphaState;
      const color = node.home ? theme.homeColor : node.color;
      const x = node.renderX;
      const y = node.renderY;
      const hoverBoost = node.hoverState ?? 0;
      const drawSize = node.size * (1 + 0.22 * hoverBoost);
      const pulse = reducedMotion ? 1 : 1 + 0.07 * Math.sin(now * 5e-4 + node.phase);
      const glowRadius = drawSize * 3.8 * pulse * (1 + 0.25 * hoverBoost);
      context.globalAlpha = Math.min(1, theme.glowAlpha * alpha * (1 + 0.8 * hoverBoost));
      context.drawImage(
        this.glowSprite(color),
        x - glowRadius,
        y - glowRadius,
        glowRadius * 2,
        glowRadius * 2
      );
      context.globalAlpha = 1;
      context.beginPath();
      context.arc(x, y, drawSize, 0, TAU);
      context.fillStyle = withAlpha(color, Math.min(0.95, 0.55 + 0.45 * alpha));
      context.fill();
      node.recent && alpha > 0.25 && (context.beginPath(), context.arc(x, y, node.size + 3 / scale ** 0.5, 0, TAU), context.strokeStyle = withAlpha(
        color,
        (0.4 + 0.2 * Math.sin(now * 2e-3 + node.phase)) * alpha
      ), context.lineWidth = 1.2 / scale ** 0.5, context.stroke());
      node.ring && alpha > 0.25 && (context.beginPath(), context.arc(x, y, node.size + 4 / scale ** 0.5, 0, TAU), context.strokeStyle = withAlpha(color, 0.6 * alpha), context.lineWidth = 1.3 / scale ** 0.5, context.stroke());
      node.orphan && alpha > 0.25 && (context.setLineDash([3 / scale ** 0.5, 3 / scale ** 0.5]), context.beginPath(), context.arc(x, y, node.size + 5 / scale ** 0.5, 0, TAU), context.strokeStyle = withAlpha(theme.dangerColor, 0.55 * alpha), context.lineWidth = 1.2 / scale ** 0.5, context.stroke(), context.setLineDash([]));
      const filtered = this.query !== "" && this.matchesQuery(node) && !node.home;
      filtered && (context.beginPath(), context.arc(x, y, node.size + 3.5 / scale ** 0.5, 0, TAU), context.lineWidth = 1.5 / scale ** 0.5, context.strokeStyle = withAlpha(color, 0.9), context.stroke());
      const isFocus = node === this.hovered;
      hoverBoost > 0.02 && (context.globalAlpha = hoverBoost, context.lineWidth = 2 / scale, context.strokeStyle = theme.text, context.beginPath(), context.arc(x, y, drawSize, 0, TAU), context.stroke(), context.globalAlpha = 1);
      const labelVisible = node.home || node.hub || scale > 0.55 || isFocus;
      if (!labelVisible || alpha < 0.3) return;
      const fontSize = node.home ? 16 : node.hub ? 13 : 10.5;
      const hub = node.home || node.hub;
      context.font = `${hub ? 600 : 400} ${fontSize / Math.sqrt(scale)}px ${theme.font}`;
      context.textAlign = "center";
      context.textBaseline = "top";
      context.fillStyle = withAlpha(
        node.muted ? theme.mutedLabel : theme.label,
        0.25 + 0.75 * alpha
      );
      context.fillText(node.name, x, y + drawSize + 5 / scale);
      const showTags = isFocus && node.subjects.length > 0;
      if (!showTags) return;
      context.font = `italic ${10 / Math.sqrt(scale)}px ${theme.font}`;
      context.fillStyle = withAlpha(theme.mutedLabel, 0.9);
      context.fillText(
        node.subjects.map((tag) => `#${tag}`).join("  "),
        x,
        y + drawSize + (5 + fontSize + 6) / scale ** 0.5
      );
    });
    context.setTransform(1, 0, 0, 1, 0, 0);
    this.queueNextFrame(intro < 1 || !reducedMotion || !settled || this.flight);
  }
};
Object.assign(MapView.prototype, askMethods, sunburstMethods, pulseMethods);

// src/main.js
typeof window !== "undefined" && (window.__WLM_VIEW = MapView);
var WikiDashboardPlugin = class extends import_obsidian3.Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new MapView(leaf, this));
    this.addRibbonIcon("radar", "Open Wiki Dashboard", () => this.activateView());
    this.addCommand({
      id: "open-map",
      name: "Open map",
      callback: () => this.activateView()
    });
    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.getLeavesOfType(VIEW_TYPE).length === 0 && this.activateView();
    });
  }
  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
};
