export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

export const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

export const newAskId = () => Math.random().toString(36).slice(2, 10);

export const sanitizeAnswer = (markdown) =>
	markdown
		.replace(/<\/?[a-z][^>]*>/gi, "")
		.replace(/!\[[^\]]*\]\(\s*(?:https?:)?\/\/[^)]*\)/gi, "");
