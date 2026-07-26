import { NARROW_BREAKPOINT, PULSE } from "./config.js";
import { withAlpha } from "./color.js";
import { easeOutCubic, reducedMotionQuery } from "./utils.js";

const dayStep = PULSE.cell + PULSE.gap;
const blockWidth = 6 * dayStep - PULSE.gap;
const blockHeight = 7 * dayStep - PULSE.gap;
const rowStride = blockHeight + PULSE.blockGapY;
const columnStride = blockWidth + PULSE.blockGapX;
const mondayIndex = (date) => (date.getDay() + 6) % 7;
const localKey = (date) =>
	`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
		date.getDate()
	).padStart(2, "0")}`;

export const pulseMethods = {
	buildPulse() {
		const days = new Map();
		this.model.nodes
			.filter((node) => !node.hub && !node.home)
			.forEach((node) =>
				(node.activityDays ?? []).forEach((day) => {
					const entry = days.get(day) ?? { nodes: [] };
					entry.nodes.push(node);
					days.set(day, entry);
				})
			);

		const today = new Date();
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
				blockX: originX + (offset % monthsPerRow) * columnStride,
				blockY: originY + Math.floor(offset / monthsPerRow) * rowStride,
			};
		});

		const cells = months.flatMap((month) => {
			const daysInMonth = new Date(
				month.monthStart.getFullYear(),
				month.monthStart.getMonth() + 1,
				0
			).getDate();
			const firstWeekday = mondayIndex(month.monthStart);
			return [...Array(daysInMonth).keys()]
				.map((dayIndex) => {
					const date = new Date(
						month.monthStart.getFullYear(),
						month.monthStart.getMonth(),
						dayIndex + 1
					);
					const weekIndex = Math.floor((dayIndex + firstWeekday) / 7);
					return date > end
						? null
						: {
								date,
								key: localKey(date),
								order: month.order,
								x: month.blockX + weekIndex * dayStep,
								y: month.blockY + mondayIndex(date) * dayStep,
								entry: days.get(localKey(date)) ?? null,
						  };
				})
				.filter(Boolean);
		});

		const monthLabels = months.map((month) => ({
			x: month.blockX,
			y: month.blockY - 13,
			text: month.monthStart.toLocaleDateString(undefined, {
				month: "short",
				...(month.order === 0 || month.monthStart.getMonth() === 0
					? { year: "numeric" }
					: {}),
			}),
		}));
		const weekdayName = (row) =>
			cells.find((cell) => mondayIndex(cell.date) === row).date.toLocaleDateString(
				undefined,
				{ weekday: "short" }
			);
		const weekdayLabels = [...Array(rows).keys()].flatMap((blockRow) =>
			[0, 2, 4].flatMap((row) => {
				const y = originY + blockRow * rowStride + row * dayStep + PULSE.cell / 2;
				const text = weekdayName(row);
				return [
					{ x: originX - 10, y, text, align: "right" },
					{ x: originX + width + 10, y, text, align: "left" },
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
			summary: `${touched.size} pages added · ${active.length} days`,
		};
		this.pulseCacheStore = null;
	},

	pulseBounds() {
		const { originX, originY, width, height } = this.pulse;
		return [
			{ x: originX - 44, y: originY - 54 },
			{ x: originX + width + 44, y: originY + height + 16 },
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
		return minOffset > maxOffset
			? (minOffset + maxOffset) / 2
			: Math.min(Math.max(offsetY, minOffset), maxOffset);
	},

	pulseFlyNarrow() {
		const { width } = this.pulse;
		const viewWidth = this.contentEl.clientWidth;
		const scale = (viewWidth - 12) / (width + 104);
		const to = {
			scale,
			offsetX: viewWidth / 2,
			offsetY: this.pulseClampY(-Infinity, scale),
		};
		reducedMotionQuery.matches
			? ((this.transform = to), (this.flight = null))
			: (this.flight = {
					start: performance.now(),
					duration: 650,
					from: { ...this.transform },
					to,
			  });
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
		(clamped !== proposed || Math.abs(momentum.velocity) < 0.01) &&
			(this.pulseMomentum = null);
	},

	cellAt(clientX, clientY) {
		if (!this.pulse) return null;
		const point = this.toWorld(clientX, clientY);
		return (
			this.pulse.cells.find(
				(cell) =>
					point.x >= cell.x &&
					point.x <= cell.x + PULSE.cell &&
					point.y >= cell.y &&
					point.y <= cell.y + PULSE.cell
			) ?? null
		);
	},

	cellColor(cell) {
		const tally = cell.entry.nodes.reduce(
			(counts, node) => counts.set(node.color, (counts.get(node.color) ?? 0) + 1),
			new Map()
		);
		return [...tally.entries()].sort((first, second) => second[1] - first[1])[0][0];
	},

	paintPulseGrid(context, theme, grow, reducedMotion, scale, includeHover) {
		const { cells, monthLabels, weekdayLabels, maxCount } = this.pulse;
		const highlight = (cell) =>
			this.query === "" || cell.entry?.nodes.some((node) => this.matchesQuery(node));

		cells.forEach((cell) => {
			const local = reducedMotion
				? 1
				: easeOutCubic(
						Math.min(Math.max((grow * 1.6 - cell.order / PULSE.months) / 0.6, 0), 1)
				  );
			const hovered = includeHover && cell === this.hoveredCell;
			const intensity = cell.entry
				? 0.3 + 0.7 * (cell.entry.nodes.length / maxCount)
				: 0;
			const color = cell.entry ? this.cellColor(cell) : theme.label;
			const alpha = (cell.entry ? intensity : 0.08) * local * (highlight(cell) ? 1 : 0.15);
			context.beginPath();
			context.roundRect(cell.x, cell.y, PULSE.cell, PULSE.cell, 3);
			context.fillStyle = withAlpha(color, alpha);
			context.fill();
			hovered &&
				((context.lineWidth = 1.4 / scale ** 0.5),
				(context.strokeStyle = withAlpha(theme.hoverStroke, 0.8)),
				context.stroke());
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
			hovered &&
				(context.beginPath(),
				context.roundRect(hovered.x, hovered.y, PULSE.cell, PULSE.cell, 3),
				(context.lineWidth = 1.4 / scale ** 0.5),
				(context.strokeStyle = withAlpha(theme.hoverStroke, 0.8)),
				context.stroke());
		}
		cached || this.paintPulseGrid(context, theme, grow, reducedMotion, scale, true);

		const focus = this.hoveredCell;
		const caption = focus
			? `${focus.date.toLocaleDateString(undefined, {
					day: "numeric",
					month: "short",
					year: "numeric",
			  })} · ${focus.entry?.nodes.length ?? 0} pages added`
			: this.pulse.summary;
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
			cell.date.toLocaleDateString(undefined, {
				weekday: "long",
				day: "numeric",
				month: "long",
				year: "numeric",
			})
		);
		this.drawerBodyEl.empty();
		const list = this.drawerBodyEl.createEl("div", { cls: "wlm-day-list" });
		[...cell.entry.nodes]
			.sort(
				(first, second) =>
					first.kind.localeCompare(second.kind) || first.name.localeCompare(second.name)
			)
			.forEach((node) => {
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
	},
};
