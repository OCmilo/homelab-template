import { SUN_RINGS, TAU } from "./config.js";
import { mixWithWhite, withAlpha } from "./color.js";
import { easeOutCubic } from "./utils.js";

const circularDistance = (left, right) =>
	Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));

const layoutSubjectLabels = (labels, baseRadius, laneGap, fontSize) => {
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

export const sunburstMethods = {
	buildSunburst() {
		const pages = this.model.nodes.filter((node) => !node.hub && !node.home);
		const groups = this.model.subjects
			.map((sector) => ({
				name: sector.name,
				color: sector.color,
				pages: pages.filter((page) => page.subjects[0] === sector.name),
			}))
			.filter((group) => group.pages.length > 0);
		const total = groups.reduce((sum, group) => sum + group.pages.length, 0);
		const gap = 0.035;
		const slices = [];
		const dividers = [];
		let cursor = -Math.PI / 2;
		groups.forEach((group) => {
			const span = (group.pages.length / total) * (TAU - gap * groups.length);
			slices.push({
				level: "subject",
				name: group.name,
				color: group.color,
				count: group.pages.length,
				start: cursor,
				end: cursor + span,
				subject: group.name,
			});
			const kinds = this.model.pageKinds
				.map((kind) => ({ kind, pages: group.pages.filter((page) => page.kind === kind) }))
				.filter((entry) => entry.pages.length > 0);
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
					subject: group.name,
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
						stripe: stripeIndex++ % 2,
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
		return (
			this.sunburst.slices.find((slice) => {
				const [inner, outer] = rings[slice.level];
				const within = radius >= inner && radius <= outer;
				const relative = (((angle - slice.start) % TAU) + TAU) % TAU;
				return within && relative < slice.end - slice.start;
			}) ?? null
		);
	},

	drawSunburst(context, theme, now, grow, reducedMotion, scale) {
		this.sunburst ?? this.buildSunburst();
		const { slices, total, dividers } = this.sunburst;
		const rings = SUN_RINGS;
		const hoverElapsed = (now - (this.sliceHoverStart ?? 0)) / 220;
		const hoverEase = reducedMotion ? 1 : easeOutCubic(Math.min(hoverElapsed, 1));
		this.sliceHoverActive = hoverElapsed < 1 && !reducedMotion;

		const sliceMatches = (slice) =>
			this.query === "" ||
			(slice.node
				? this.matchesQuery(slice.node)
				: slice.subject.toLowerCase().includes(this.query) ||
				  slice.name.toLowerCase().includes(this.query));
		const related =
			this.hoveredSlice &&
			((slice) =>
				slice === this.hoveredSlice ||
				(this.hoveredSlice.level !== "page" && slice.subject === this.hoveredSlice.subject));

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
			const breathe =
				slice.node && !reducedMotion
					? Math.sin(now * 0.0012 + slice.node.phase) * 2.5 * local
					: 0;
			const outer = inner + (baseOuter - inner) * petal * local + lift + breathe;
			const levelAlpha =
				slice.level === "subject" ? 0.88 : slice.level === "kind" ? 0.5 : 0.62 + slice.stripe * 0.16;
			const matchFactor = sliceMatches(slice) ? 1 : 0.12;
			const hoverFactor = related ? (related(slice) ? 1 : 0.45) : 1;
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
			hovered &&
				((context.lineWidth = 1.5 / scale),
				(context.strokeStyle = withAlpha(theme.hoverStroke, 0.5 * hoverEase)),
				context.stroke());
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
		const subjectLabels = slices
			.filter((slice) => slice.level === "subject")
			.map((slice) => {
				const characters = [...slice.name];
				const widths = characters.map((char) => context.measureText(char).width);
				return {
					slice,
					mid: (slice.start + slice.end) / 2,
					characters,
					widths,
					width: widths.reduce((sum, width) => sum + width, 0),
				};
			});
		layoutSubjectLabels(
			subjectLabels,
			rings.page[1] + 20,
			subjectFontSize + 8,
			subjectFontSize
		)
			.filter((label) => !label.hidden)
			.forEach(({ slice, mid, characters, widths, width, radius: finalRadius }) => {
				const radius = finalRadius * grow;
				if (grow < 0.72 || radius <= 0) return;
				context.font = `600 ${subjectFontSize}px ${theme.font}`;
				context.textAlign = "center";
				context.textBaseline = "middle";
				const reveal = Math.min((grow - 0.72) / 0.28, 1);
				context.fillStyle = withAlpha(slice.color, 0.85 * reveal);
				const normalized = ((mid % TAU) + TAU) % TAU;
				const flip = normalized > Math.PI / 4 && normalized < (3 * Math.PI) / 4;
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
		slices
			.filter((slice) => slice.level === "kind" && slice.end - slice.start > 0.07)
			.forEach((slice) => {
				const mid = (slice.start + slice.end) / 2;
				const radius = ((rings.kind[0] + rings.kind[1]) / 2) * grow;
				const label = `${slice.name} · ${slice.count}`;
				context.font = `600 ${10.5 / Math.sqrt(scale)}px ${theme.font}`;
				const tangentialFits =
					(slice.end - slice.start) * radius > context.measureText(label).width + 12;
				context.save();
				context.translate(Math.cos(mid) * radius, Math.sin(mid) * radius);
				context.textAlign = "center";
				context.textBaseline = "middle";
				context.fillStyle = withAlpha(theme.label, 0.9);
				if (tangentialFits) {
					const normalized = ((mid % TAU) + TAU) % TAU;
					const upsideDown =
						normalized > Math.PI / 4 && normalized < (3 * Math.PI) / 4;
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
		const subtitle = focus
			? focus.level === "page"
				? focus.node.subjects.map((tag) => `#${tag}`).join("  ")
				: `${focus.count} pages`
			: `${total} pages`;
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
	},
};
