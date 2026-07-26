import { ItemView, MarkdownRenderer, debounce, setIcon } from "obsidian";
import { NARROW_BREAKPOINT, SUNBURST_REACH, TAU, VIEW_TYPE } from "./config.js";
import { mixWithWhite, withAlpha } from "./color.js";
import { computeTheme } from "./theme.js";
import { easeOutCubic, reducedMotionQuery } from "./utils.js";
import { buildModel } from "./model.js";
import { askMethods } from "./ask.js";
import { sunburstMethods } from "./sunburst.js";
import { pulseMethods } from "./pulse.js";

export class MapView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.transform = { scale: 1, offsetX: 0, offsetY: 0 };
		this.pointers = new Map();
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
		setIcon(searchToggle, "search");
		searchToggle.addEventListener("click", () => {
			const open = container.classList.toggle("wlm-search-open");
			setIcon(searchToggle, open ? "x" : "search");
			open ? this.searchEl.focus() : this.setFilter("");
		});
		this.searchEl = toolbar.createEl("input", {
			cls: "wlm-search",
			attr: { type: "search", placeholder: "Filter the map…" },
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
			{ value: "pulse", label: "Pulse" },
		].forEach((mode) => {
			const button = this.modesEl.createEl("button", { cls: "wlm-mode" });
			button.setText(mode.label);
			button.dataset.mode = mode.value;
			button.classList.toggle("active", this.mode === mode.value);
			button.addEventListener("click", () => this.setMode(mode.value));
		});
		const askButton = toolbar.createEl("button", { cls: "wlm-ask-open" });
		askButton.setText("✦ Ask");
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

		const rebuild = debounce(() => this.rebuild(), 800, true);
		this.registerEvent(this.app.metadataCache.on("resolved", rebuild));
		this.registerEvent(
			this.app.workspace.on("css-change", () => {
				this.cachedTheme = null;
				this.glowSprites = new Map();
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
		const pulseLayoutStale =
			this.mode === "pulse" && this.pulse && this.pulse.narrow !== narrowNow;
		pulseLayoutStale &&
			(this.buildPulse(),
			narrowNow ? this.pulseFlyNarrow() : this.flyToNodes(this.pulseBounds()));
		changed && !pulseLayoutStale && this.fitToView();
		this.requestDraw();
	}

	async rebuild() {
		const previous = new Map((this.model?.nodes ?? []).map((node) => [node.path, node]));
		const firstBuild = previous.size === 0;
		this.model = await buildModel(this.app, this.theme());
		const sameNodes =
			previous.size === this.model.nodes.length &&
			this.model.nodes.every((node) => previous.has(node.path));
		this.model.nodes.forEach((node) => {
			const old = previous.get(node.path);
			node.fromX = old?.renderX ?? 0;
			node.fromY = old?.renderY ?? 0;
			node.alphaState = old?.alphaState;
		});
		sameNodes || (this.introStart = performance.now());
		const focusNode =
			this.focusPath && this.model.nodes.find((node) => node.path === this.focusPath);
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
		[...this.modesEl.children].forEach((button) =>
			button.classList.toggle("active", button.dataset.mode === value)
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
			map: () => this.mapFitTargets(),
		};
		this.pulseLocked()
			? this.pulseFlyNarrow()
			: this.flyToNodes(flightTargets[value]());
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
				{ x: x + halfWidth, y },
			];
		});
		return [...this.model.nodes, ...labelPoints];
	}

	matchesQuery(node) {
		return (
			this.query === "" ||
			node.name.toLowerCase().includes(this.query) ||
			node.subjects.some((tag) => tag.toLowerCase().includes(this.query))
		);
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
			offsetY: height / 2 - centerY * scale,
		};
		const reducedMotion = reducedMotionQuery.matches;
		reducedMotion
			? ((this.transform = to), (this.flight = null))
			: (this.flight = {
					start: performance.now(),
					duration: 650,
					from: { ...this.transform },
					to,
			  });
		this.requestDraw();
	}

	stepFlight(now) {
		const progress = Math.min((now - this.flight.start) / this.flight.duration, 1);
		const eased = easeOutCubic(progress);
		const { from, to } = this.flight;
		this.transform = {
			scale: from.scale + (to.scale - from.scale) * eased,
			offsetX: from.offsetX + (to.offsetX - from.offsetX) * eased,
			offsetY: from.offsetY + (to.offsetY - from.offsetY) * eased,
		};
		progress >= 1 && (this.flight = null);
	}

	applyFocusLayout(node) {
		const { nodes, edges } = this.model;
		const neighborsOf = (path) =>
			edges
				.filter((edge) => edge.from === path || edge.to === path)
				.flatMap((edge) => [edge.from, edge.to])
				.filter((other) => other !== path);
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
			(member) =>
				member.path !== node.path && !ring1.has(member.path) && !ring2.has(member.path)
		);
		const place = (list, radius) =>
			list.forEach((member, index) => {
				const angle = -Math.PI / 2 + (index / Math.max(list.length, 1)) * TAU;
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
			const expanded =
				this.query === group.name ||
				group.facets.some((facet) => facet.name === this.query);
			expanded && groupEl.addClass("expanded");
			this.renderChip(groupEl, group, true);
			const facetsEl = groupEl.createEl("div", { cls: "wlm-chip-facets" });
			const panelEl = facetsEl.createEl("div", { cls: "wlm-chip-facets-panel" });
			group.facets.forEach((facet) => this.renderChip(panelEl, facet, false));
			expanded &&
				this.facetsRowEl &&
				group.facets.forEach((facet) => this.renderChip(this.facetsRowEl, facet, false));
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
		chip.addEventListener("click", () =>
			this.setFilter(this.query === tag.name ? "" : tag.name)
		);
	}

	fitToView() {
		const width = this.contentEl.clientWidth;
		const height = this.contentEl.clientHeight;
		const extent =
			this.model.subjects.reduce(
				(radius, subject) =>
					Math.max(radius, subject.outerRadius, subject.labelRadius ?? 0),
				this.model.nodes.reduce(
					(radius, node) => Math.max(radius, Math.hypot(node.x, node.y)),
					10
				)
			) + 70;
		const scale = (Math.min(width, height) / 2 - 24) / extent;
		this.transform = {
			scale: Math.max(scale, 0.05),
			offsetX: width / 2,
			offsetY: height / 2,
		};
	}

	toWorld(clientX, clientY) {
		const rect = this.canvasEl.getBoundingClientRect();
		const { scale, offsetX, offsetY } = this.transform;
		return {
			x: (clientX - rect.left - offsetX) / scale,
			y: (clientY - rect.top - offsetY) / scale,
		};
	}

	nodeAt(clientX, clientY) {
		const point = this.toWorld(clientX, clientY);
		const hitRadius = 14 / this.transform.scale;
		return (
			[...this.model.nodes]
				.reverse()
				.find(
					(node) =>
						Math.hypot((node.renderX ?? node.x) - point.x, (node.renderY ?? node.y) - point.y) <
						hitRadius + node.size
				) ?? null
		);
	}

	isolateTouch(element) {
		["touchstart", "touchmove", "touchend"].forEach((type) =>
			this.registerDomEvent(element, type, (event) => event.stopPropagation())
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
				startY: event.clientY,
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
					sliceChanged && ((this.sliceHoverStart = performance.now()), this.requestDraw());
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
					elapsed > 0 &&
						(this.panVelocityY =
							0.8 * (deltaY / elapsed) + 0.2 * (this.panVelocityY ?? 0));
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
			const moved = pointer
				? Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY)
				: 99;
			if (this.mode === "pulse") {
				const flick =
					this.pulseLocked() &&
					moved >= 6 &&
					!reducedMotionQuery.matches &&
					Math.abs(this.panVelocityY ?? 0) > 0.03;
				flick &&
					((this.pulseMomentum = {
						velocity: this.panVelocityY * 1.15,
						last: performance.now(),
					}),
					this.requestDraw());
				const cell = moved < 6 ? this.cellAt(event.clientX, event.clientY) : null;
				cell?.entry && this.openDay(cell);
				moved < 6 && !cell?.entry && this.closeDrawer();
				return;
			}
			if (this.mode === "sunburst") {
				const slice = moved < 6 ? this.sliceAt(event.clientX, event.clientY) : null;
				slice?.level === "page" && this.openNode(slice.node);
				slice &&
					slice.level !== "page" &&
					this.setFilter(this.query === slice.subject ? "" : slice.subject);
				moved < 6 && !slice && this.closeDrawer();
				return;
			}
			const node = moved < 6 ? this.nodeAt(event.clientX, event.clientY) : null;
			const tapTime = performance.now();
			const doubleTap =
				node && node.path === this.lastTapPath && tapTime - (this.lastTapAt ?? 0) < 350;
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
				this.zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.002));
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
			attr: { "aria-label": "Go back", title: "Go back" },
		});
		this.drawerHistoryBackButton.setText("←");
		this.drawerHistoryBackButton.style.display = "none";
		this.drawerHistoryBackButton.addEventListener("click", () => this.goBackDrawer());
		this.drawerBackButton = header.createEl("button", { cls: "wlm-drawer-back" });
		this.drawerBackButton.setText("✦ Ask");
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
		closeButton.setText("✕");
		closeButton.addEventListener("click", () => this.closeDrawer());
		this.drawerBodyEl = this.drawerEl.createEl("div", {
			cls: "wlm-drawer-body markdown-rendered",
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
			mapNode
				? this.showDrawer(mapNode)
				: target && this.app.workspace.openLinkText(target.path, "", false);
		});
		this.registerDomEvent(document, "keydown", (event) => {
			event.key === "Escape" &&
				(this.focusPath ? this.exitFocus() : this.closeDrawer());
		});
	}

	async showDrawer(node, { recordHistory = true, scrollTop = 0 } = {}) {
		if (recordHistory && this.drawerPath && this.drawerPath !== node.path) {
			this.drawerHistory.push({
				path: this.drawerPath,
				scrollTop: this.drawerBodyEl.scrollTop,
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
		await MarkdownRenderer.render(this.app, markdown, contentEl, node.path, this);
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
				scrollTop: previous.scrollTop,
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
		const citers = this.model.edges
			.filter((edge) => edge.to === node.path)
			.map((edge) => this.model.nodes.find((candidate) => candidate.path === edge.from))
			.filter(Boolean);
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
		this.drawQueued ||
			((this.drawQueued = true),
			requestAnimationFrame(() => {
				this.drawQueued = false;
				this.draw();
			}));
	}

	queueNextFrame(animating) {
		animating &&
			this.contentEl.isConnected &&
			this.contentEl.offsetParent !== null &&
			this.requestDraw();
	}

	theme() {
		this.cachedTheme = this.cachedTheme ?? computeTheme(this.contentEl);
		return this.cachedTheme;
	}

	glowSprite(color) {
		this.glowSprites = this.glowSprites ?? new Map();
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
		const drawerCoversCanvas =
			this.contentEl.classList.contains("wlm-narrow") &&
			this.drawerEl?.classList.contains("open");
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
			const sunburstAnimating =
				intro < 1 || this.flight || this.sliceHoverActive || !reducedMotion;
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

		const neighborhood = this.hovered
			? new Set([
					this.hovered.path,
					...edges
						.filter((edge) => edge.from === this.hovered.path || edge.to === this.hovered.path)
						.flatMap((edge) => [edge.from, edge.to]),
			  ])
			: null;
		const emphasis = (node) => {
			const searchFactor = this.matchesQuery(node) ? 1 : 0.12;
			const hoverFactor = neighborhood ? (neighborhood.has(node.path) ? 1 : 0.15) : 1;
			const focusFactor = this.focusPath
				? node.path === this.focusPath || this.focusRings.ring1.has(node.path)
					? 1
					: this.focusRings.ring2.has(node.path)
					? 0.55
					: 0.08
				: 1;
			return Math.min(searchFactor, hoverFactor, focusFactor);
		};

		nodes.forEach((node) => {
			const springX = (node.fromX ?? 0) + (node.x - (node.fromX ?? 0)) * grow;
			const springY = (node.fromY ?? 0) + (node.y - (node.fromY ?? 0)) * grow;
			const drift = reducedMotion ? 0 : 6 * grow;
			node.renderX = springX + Math.sin(now * 0.00035 + node.phase) * drift;
			node.renderY = springY + Math.cos(now * 0.00028 + node.phase * 1.7) * drift;
			const target = emphasis(node);
			const eased = (node.alphaState ?? target) + (target - (node.alphaState ?? target)) * 0.16;
			node.alphaState = reducedMotion ? target : eased;
			const hoverTarget = node === this.hovered ? 1 : 0;
			const hoverEased = (node.hoverState ?? 0) + (hoverTarget - (node.hoverState ?? 0)) * 0.18;
			node.hoverState = reducedMotion ? hoverTarget : hoverEased;
		});
		const settled = nodes.every(
			(node) =>
				Math.abs(node.alphaState - emphasis(node)) < 0.01 &&
				Math.abs(node.hoverState - (node === this.hovered ? 1 : 0)) < 0.01
		);

		subjects.forEach((subject) => {
			const labelAngle =
				subject.labelAngle ?? (subject.startAngle + subject.endAngle) / 2;
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

		const nodeIndex =
			this.model.nodeIndex ??
			(this.model.nodeIndex = new Map(nodes.map((node) => [node.path, node])));
		edges.forEach((edge) => {
			const from = nodeIndex.get(edge.from);
			const to = nodeIndex.get(edge.to);
			if (!from || !to) return;
			const strength = Math.min(from.alphaState, to.alphaState);
			const hoverEdge =
				this.hovered &&
				(edge.from === this.hovered.path || edge.to === this.hovered.path);
			const baseAlpha = hoverEdge ? 0.5 : edge.kind === "hierarchy" ? 0.3 : 0.14;
			const edgeColor = hoverEdge
				? this.hovered.home
					? theme.homeColor
					: this.hovered.color
				: to.color;
			context.beginPath();
			context.moveTo(from.renderX, from.renderY);
			const centerMidX = ((from.renderX + to.renderX) / 2) * 0.72;
			const centerMidY = ((from.renderY + to.renderY) / 2) * 0.72;
			const deltaX = to.renderX - from.renderX;
			const deltaY = to.renderY - from.renderY;
			const length = Math.hypot(deltaX, deltaY) || 1;
			const cross =
				(centerMidX - from.renderX) * deltaY - (centerMidY - from.renderY) * deltaX;
			const flat = Math.abs(cross) / length < 6;
			const side = from.phase > to.phase ? 1 : -1;
			const bow = length * 0.14 * side;
			const midX = flat
				? (from.renderX + to.renderX) / 2 + (-deltaY / length) * bow
				: centerMidX;
			const midY = flat
				? (from.renderY + to.renderY) / 2 + (deltaX / length) * bow
				: centerMidY;
			context.quadraticCurveTo(midX, midY, to.renderX, to.renderY);
			context.strokeStyle = withAlpha(
				edgeColor,
				Math.min(0.95, baseAlpha * strength * theme.edgeBoost)
			);
			context.lineWidth =
				(hoverEdge ? 1.7 : edge.kind === "hierarchy" ? 1.6 : 1) / scale ** 0.5;
			context.stroke();
		});

		nodes.forEach((node) => {
			const alpha = node.alphaState;
			const color = node.home ? theme.homeColor : node.color;
			const x = node.renderX;
			const y = node.renderY;
			const hoverBoost = node.hoverState ?? 0;
			const drawSize = node.size * (1 + 0.22 * hoverBoost);
			const pulse = reducedMotion ? 1 : 1 + 0.07 * Math.sin(now * 0.0005 + node.phase);
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
			node.recent &&
				alpha > 0.25 &&
				(context.beginPath(),
				context.arc(x, y, node.size + 3 / scale ** 0.5, 0, TAU),
				(context.strokeStyle = withAlpha(
					color,
					(0.4 + 0.2 * Math.sin(now * 0.002 + node.phase)) * alpha
				)),
				(context.lineWidth = 1.2 / scale ** 0.5),
				context.stroke());
			node.ring &&
				alpha > 0.25 &&
				(context.beginPath(),
				context.arc(x, y, node.size + 4 / scale ** 0.5, 0, TAU),
				(context.strokeStyle = withAlpha(color, 0.6 * alpha)),
				(context.lineWidth = 1.3 / scale ** 0.5),
				context.stroke());
			node.orphan &&
				alpha > 0.25 &&
				(context.setLineDash([3 / scale ** 0.5, 3 / scale ** 0.5]),
				context.beginPath(),
				context.arc(x, y, node.size + 5 / scale ** 0.5, 0, TAU),
				(context.strokeStyle = withAlpha(theme.dangerColor, 0.55 * alpha)),
				(context.lineWidth = 1.2 / scale ** 0.5),
				context.stroke(),
				context.setLineDash([]));
			const filtered = this.query !== "" && this.matchesQuery(node) && !node.home;
			filtered &&
				(context.beginPath(),
				context.arc(x, y, node.size + 3.5 / scale ** 0.5, 0, TAU),
				(context.lineWidth = 1.5 / scale ** 0.5),
				(context.strokeStyle = withAlpha(color, 0.9)),
				context.stroke());
			const isFocus = node === this.hovered;
			hoverBoost > 0.02 &&
				((context.globalAlpha = hoverBoost),
				(context.lineWidth = 2 / scale),
				(context.strokeStyle = theme.text),
				context.beginPath(),
				context.arc(x, y, drawSize, 0, TAU),
				context.stroke(),
				(context.globalAlpha = 1));

			const labelVisible =
				node.home || node.hub || scale > 0.55 || isFocus;
			if (!labelVisible || alpha < 0.3) return;
			const fontSize =
				node.home ? 16 : node.hub ? 13 : 10.5;
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
}

Object.assign(MapView.prototype, askMethods, sunburstMethods, pulseMethods);
