import { isLightColor } from "./color.js";

export const PALETTES = {
	dark: {
		"1": "#ff6b9d",
		"2": "#ffa657",
		"3": "#e3c567",
		"4": "#3ddbb4",
		"5": "#4cc9f0",
		"6": "#a78bfa",
	},
	light: {
		"1": "#f43f85",
		"2": "#fd7314",
		"3": "#d19d0b",
		"4": "#0abf8c",
		"5": "#12a8ee",
		"6": "#7d55f6",
	},
};

export const FALLBACK_ORDER = ["1", "5", "4", "6", "2", "3"];

const SHARED_TOKENS = {
	fallbackColor: "#8f9aa6",
	dangerColor: "#e93147",
};

const THEME_TOKENS = {
	dark: {
		label: "#c9cdd3",
		mutedLabel: "#9aa0a6",
		homeColor: "#e8e3d3",
		hoverStroke: "#ffffff",
		glowAlpha: 0.26,
		haloMix: 0,
		glossMix: 0.24,
		sliceBoost: 1,
		edgeBoost: 1,
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
		edgeBoost: 1.4,
	},
};

export const themeTokens = (light) => ({
	...SHARED_TOKENS,
	...THEME_TOKENS[light ? "light" : "dark"],
});

export const computeTheme = (container) => {
	const styles = getComputedStyle(document.body);
	const background = styles.getPropertyValue("--background-primary").trim() || "#1e1e1e";
	const light = isLightColor(background);
	const theme = {
		background,
		light,
		text: styles.getPropertyValue("--text-normal").trim() || "#dadada",
		font: styles.getPropertyValue("--font-interface").trim() || "sans-serif",
		...themeTokens(light),
	};
	container?.style.setProperty("--wlm-danger", theme.dangerColor);
	return theme;
};
