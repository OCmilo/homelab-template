export const normalizeColor = (color) => {
	const probe = document.createElement("canvas").getContext("2d");
	probe.fillStyle = "#1e1e1e";
	probe.fillStyle = color;
	return probe.fillStyle;
};

export const isLightColor = (color) => {
	const normalized = normalizeColor(color);
	const hex = normalized.startsWith("#")
		? normalized
		: `#${(normalized.match(/\d+/g) ?? ["30", "30", "30"])
				.slice(0, 3)
				.map((channel) => Number(channel).toString(16).padStart(2, "0"))
				.join("")}`;
	const value = parseInt(hex.slice(1, 7), 16);
	const luminance =
		(0.299 * ((value >> 16) & 255) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255)) / 255;
	return luminance > 0.5;
};

export const mixWithWhite = (hex, amount) => {
	const value = parseInt(hex.slice(1), 16);
	const lifted = [16, 8, 0].map((shift) => {
		const channel = (value >> shift) & 255;
		return Math.round(channel + (255 - channel) * amount)
			.toString(16)
			.padStart(2, "0");
	});
	return `#${lifted.join("")}`;
};

export const withAlpha = (color, alpha) => {
	const resolved =
		color.startsWith("#") && color.length === 7 ? color : normalizeColor(color);
	const channels = resolved.startsWith("#")
		? [16, 8, 0].map((shift) => (parseInt(resolved.slice(1), 16) >> shift) & 255)
		: (resolved.match(/[\d.]+/g) ?? ["30", "30", "30"]).slice(0, 3);
	return `rgba(${channels.join(", ")}, ${alpha})`;
};
