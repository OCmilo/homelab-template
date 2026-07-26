import { Plugin } from "obsidian";
import { VIEW_TYPE } from "./config.js";
import { MapView } from "./view.js";

typeof window !== "undefined" && (window.__WLM_VIEW = MapView);

export default class WikiDashboardPlugin extends Plugin {
	async onload() {
		this.registerView(VIEW_TYPE, (leaf) => new MapView(leaf, this));
		this.addRibbonIcon("radar", "Open Wiki Dashboard", () => this.activateView());
		this.addCommand({
			id: "open-map",
			name: "Open map",
			callback: () => this.activateView(),
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
}
