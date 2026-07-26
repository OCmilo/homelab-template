export const VIEW_TYPE = "wiki-dashboard";
export const TAU = Math.PI * 2;

export const SUN_RINGS = { subject: [80, 160], kind: [164, 228], page: [232, 330] };
export const MAP_RINGS = { moc: 150, concept: 300, source: 440 };
export const DEFAULT_NODE_SIZE = 5.5;
export const RECENT_WINDOW = 7 * 24 * 3600 * 1000;

export const NARROW_BREAKPOINT = 480;
export const SUNBURST_REACH = { narrow: 260, wide: 290 };
export const PULSE = {
	cell: 14,
	gap: 3,
	months: 12,
	monthsPerRow: 4,
	monthsPerRowNarrow: 2,
	blockGapX: 30,
	blockGapY: 34,
};

export const MAP_SCHEMA_PATH = "system/schema/map.json";
export const COLORS_SCHEMA_PATH = "system/schema/colors.json";
export const ASK_HISTORY_PATH = "system/ask-history.json";
export const ASK_CONFIG_PATH = "system/schema/ask.json";
export const DEFAULT_ASK_ENDPOINTS = [];
export const LEGACY_ASK_KEY = "wlm-ask-history";
export const ASK_HISTORY_CAP = 100;
