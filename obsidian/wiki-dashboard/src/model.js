import {
	COLORS_SCHEMA_PATH,
	DEFAULT_NODE_SIZE,
	MAP_RINGS,
	MAP_SCHEMA_PATH,
	RECENT_WINDOW,
	TAU,
} from "./config.js";
import { FALLBACK_ORDER, PALETTES } from "./theme.js";

const loadPalette = async (app, slots, fallbackColor) => {
	const parsed = await app.vault.adapter
		.read(COLORS_SCHEMA_PATH)
		.then((raw) => JSON.parse(raw))
		.catch(() => ({}));
	return Object.fromEntries(
		Object.entries(parsed).map(([tag, slot]) => [tag, slots[slot] ?? fallbackColor])
	);
};

const loadMapSchema = (app) =>
	app.vault.adapter
		.read(MAP_SCHEMA_PATH)
		.then((raw) => JSON.parse(raw))
		.catch(() => ({}));

const inferRoot = (files) => {
	const counts = files
		.map((file) => file.path.split("/")[0])
		.reduce((tally, segment) => tally.set(segment, (tally.get(segment) ?? 0) + 1), new Map());
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
};

export const buildModel = async (app, theme) => {
	const slots = PALETTES[theme.light ? "light" : "dark"];
	const [palette, schema] = await Promise.all([
		loadPalette(app, slots, theme.fallbackColor),
		loadMapSchema(app),
	]);
	const allFiles = app.vault.getMarkdownFiles();
	const root = schema.root ?? inferRoot(allFiles);
	const excluded = new Set(schema.exclude ?? []);
	const files = allFiles
		.filter((file) => file.path.startsWith(`${root}/`))
		.filter((file) => !excluded.has(file.basename));
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
		return undated.length > 26 ? `${undated.slice(0, 25)}…` : undated;
	};

	const phaseOf = (path) =>
		([...path].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7) % 628) / 100;

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
		const fromFields = activityFields
			.map((field) => dayOf(frontmatter[field]))
			.filter(Boolean);
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
			activityDays: activityDaysOf(file),
		};
	});
	const byPath = new Map(nodes.map((node) => [node.path, node]));

	const resolved = app.metadataCache.resolvedLinks;
	const edges = nodes.flatMap((node) =>
		Object.keys(resolved[node.path] ?? {})
			.filter((target) => byPath.has(target) && target !== node.path)
			.map((target) => ({
				from: node.path,
				to: target,
				kind: byPath.get(target).hub || byPath.get(target).home ? "hierarchy" : "citation",
			}))
	);

	const homeNode = homePath && byPath.get(homePath);
	const isPage = (node) => !node.hub && !node.home;
	const subjectNames = [
		...new Set(
			nodes
				.filter((node) => node.hub && !node.home)
				.map((node) => node.name)
				.concat(nodes.filter(isPage).map((node) => node.subjects[0]).filter(Boolean))
		),
	]
		.filter((name) => name !== homeNode?.name)
		.sort();

	const membersOf = (subjectName) =>
		nodes.filter((node) => isPage(node) && node.subjects[0] === subjectName);

	const weights = subjectNames.map((name) => membersOf(name).length + 3);
	const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
	const gap = 0.05 * TAU / Math.max(subjectNames.length, 1);

	let cursor = -Math.PI / 2;
	const subjects = subjectNames.map((name, index) => {
		const span = (weights[index] / totalWeight) * (TAU - gap * subjectNames.length);
		const sector = {
			name,
			color: palette[name] ?? slots[FALLBACK_ORDER[index % FALLBACK_ORDER.length]],
			startAngle: cursor,
			endAngle: cursor + span,
			innerRadius: MAP_RINGS.moc - 40,
			outerRadius: MAP_RINGS.source + 40,
		};
		cursor += span + gap;
		return sector;
	});
	const sectorByName = new Map(subjects.map((sector) => [sector.name, sector]));

	const degree = new Map();
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

	nodes
		.filter((node) => node.hub && !node.home)
		.forEach((node) => {
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
			(members.length * minArc) / Math.max(span, 0.1)
		);
		members.forEach((node, index) => {
			const step = span / Math.max(members.length - 1, 1);
			const angle =
				members.length === 1
					? (sector.startAngle + sector.endAngle) / 2
					: sector.startAngle + padding + step * index;
			const wobble = (index % 3) * 36;
			node.x = Math.cos(angle) * (radius + wobble);
			node.y = Math.sin(angle) * (radius + wobble);
		});
	});

	nodes
		.filter((node) => node.outer)
		.forEach((node, index) => {
			const citers = edges
				.filter((edge) => edge.to === node.path)
				.map((edge) => byPath.get(edge.from))
				.filter((citer) => citer && !citer.home && citer.x !== undefined);
			const sector = sectorByName.get(node.subjects[0]);
			const fallbackAngle = sector
				? (sector.startAngle + sector.endAngle) / 2
				: (index / Math.max(nodes.length, 1)) * TAU;
			const direction = citers.reduce(
				(sum, citer) => {
					const length = Math.hypot(citer.x, citer.y) || 1;
					return { x: sum.x + citer.x / length, y: sum.y + citer.y / length };
				},
				{ x: 0, y: 0 }
			);
			const angle =
				Math.hypot(direction.x, direction.y) > 0.01
					? Math.atan2(direction.y, direction.x)
					: fallbackAngle;
			const wobble = (index % 3) * 32;
			node.x = Math.cos(angle) * (MAP_RINGS.source + wobble);
			node.y = Math.sin(angle) * (MAP_RINGS.source + wobble);
		});

	nodes
		.filter((node) => node.x === undefined)
		.forEach((node, index) => {
			const angle = (index / 8) * TAU;
			node.x = Math.cos(angle) * (MAP_RINGS.source + 90);
			node.y = Math.sin(angle) * (MAP_RINGS.source + 90);
		});

	nodes
		.filter((node) => node.orphan)
		.forEach((node, index) => {
			const sector = sectorByName.get(node.subjects[0]);
			const nudge = index % 2 === 0 ? 0.14 : -0.14;
			const angle = sector
				? (sector.startAngle + sector.endAngle) / 2 + nudge
				: node.phase;
			node.x = Math.cos(angle) * (MAP_RINGS.source + 120);
			node.y = Math.sin(angle) * (MAP_RINGS.source + 120);
		});

	const movable = (node) => !node.hub && !node.home;
	const labelHalfWidth = (node) =>
		Math.max(node.size + 10, node.name.length * (node.hub || node.home ? 5.5 : 4.3));
	const boxHalfHeight = (node) => node.size + 16;
	const boxCenterY = (node) => node.y + 9;
	Array.from({ length: 80 }).forEach(() => {
		nodes.forEach((first, index) => {
			nodes.slice(index + 1).forEach((second) => {
				const deltaX = second.x - first.x;
				const deltaY = boxCenterY(second) - boxCenterY(first);
				const overlapX =
					labelHalfWidth(first) + labelHalfWidth(second) - Math.abs(deltaX);
				const overlapY =
					boxHalfHeight(first) + boxHalfHeight(second) - Math.abs(deltaY);
				if (overlapX <= 0 || overlapY <= 0) return;
				const alongX = overlapX < overlapY;
				const fallback = first.phase > second.phase ? -1 : 1;
				const direction = alongX
					? Math.sign(deltaX) || fallback
					: Math.sign(deltaY) || fallback;
				const push = (alongX ? overlapX : overlapY) * 0.6 + 1;
				const firstWeight = movable(first) ? (movable(second) ? 0.5 : 1) : 0;
				const secondWeight = movable(second) ? 1 - firstWeight : 0;
				alongX
					? ((first.x -= direction * push * firstWeight),
					  (second.x += direction * push * secondWeight))
					: ((first.y -= direction * push * firstWeight),
					  (second.y += direction * push * secondWeight));
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
			maxY: Math.max(bounds.maxY, boxCenterY(node) + boxHalfHeight(node)),
		}),
		{ minX: 0, maxX: 0, minY: 0, maxY: 0 }
	);

	subjects.forEach((sector) => {
		const reach = nodes
			.filter(
				(node) =>
					node.subjects[0] === sector.name ||
					(node.hub && node.name === sector.name)
			)
			.reduce((max, node) => Math.max(max, Math.hypot(node.x, node.y)), sector.outerRadius);
		const mid = (sector.startAngle + sector.endAngle) / 2;
		const sectorHalfWidth = sector.name.length * 5.2;
		const clearsAt = (angle, radius) =>
			nodes.every(
				(node) =>
					Math.abs(Math.cos(angle) * radius - node.x) >
						sectorHalfWidth + labelHalfWidth(node) ||
					Math.abs(Math.sin(angle) * radius - boxCenterY(node)) >
						14 + boxHalfHeight(node)
			);
		const halfSpan = (sector.endAngle - sector.startAngle) / 2;
		const maxOffset = Math.min(halfSpan + 0.2, 0.65);
		const angleOffsets = [0]
			.concat([...Array(6).keys()].flatMap((i) => [(i + 1) * 0.11, -(i + 1) * 0.11]))
			.filter((offset) => Math.abs(offset) <= maxOffset);
		const overhang = (x, y) =>
			Math.max(0, x + sectorHalfWidth - nodeBounds.maxX) +
			Math.max(0, nodeBounds.minX - (x - sectorHalfWidth)) +
			Math.max(0, y + 14 - nodeBounds.maxY) +
			Math.max(0, nodeBounds.minY - (y - 14));
		const placement = [...Array(24).keys()]
			.flatMap((step) =>
				angleOffsets.map((offset) => ({
					radius: reach + 50 + step * 22,
					angle: mid + offset,
				}))
			)
			.filter((candidate) => clearsAt(candidate.angle, candidate.radius))
			.map((candidate) => {
				const x = Math.cos(candidate.angle) * candidate.radius;
				const y = Math.sin(candidate.angle) * candidate.radius;
				return { ...candidate, score: overhang(x, y) * 2 + (candidate.radius - reach) * 0.3 };
			})
			.sort((first, second) => first.score - second.score)[0];
		sector.labelRadius = placement?.radius ?? reach + 70;
		sector.labelAngle = placement?.angle ?? mid;
	});

	const facetNames = [
		...new Set(nodes.flatMap((node) => node.subjects.slice(1))),
	].filter((name) => !sectorByName.has(name));
	const countable = nodes.filter(isPage);
	const countOf = (name) => countable.filter((node) => node.subjects.includes(name)).length;
	const dominantSubject = (name) => {
		const primaries = countable
			.filter((node) => node.subjects.includes(name))
			.map((node) => node.subjects[0]);
		return [...new Set(primaries)].sort(
			(first, second) =>
				primaries.filter((p) => p === second).length -
				primaries.filter((p) => p === first).length
		)[0];
	};
	const tagGroups = subjects.map((sector) => ({
		name: sector.name,
		color: sector.color,
		count: countOf(sector.name),
		facets: facetNames
			.sort()
			.filter((name) => dominantSubject(name) === sector.name)
			.map((name) => ({ name, color: sector.color, count: countOf(name) })),
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
		synthesisSave: schema.synthesisSave ?? null,
	};
};
