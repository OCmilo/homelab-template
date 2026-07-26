import { MarkdownRenderer, requestUrl } from "obsidian";
import {
	ASK_CONFIG_PATH,
	ASK_HISTORY_CAP,
	ASK_HISTORY_PATH,
	DEFAULT_ASK_ENDPOINTS,
	LEGACY_ASK_KEY,
} from "./config.js";
import { newAskId, sanitizeAnswer } from "./utils.js";

export const askMethods = {
	askConfig() {
		this.askConfigPromise =
			this.askConfigPromise ??
			this.app.vault.adapter
				.read(ASK_CONFIG_PATH)
				.then((raw) => JSON.parse(raw))
				.catch(() => ({}));
		return this.askConfigPromise;
	},

	async openAsk() {
		this.resetDrawerHistory();
		this.askThread = this.askThread ?? [];
		this.askHistory = await this.loadAskHistory();
		this.askConversationId = this.askHistory.some(
			(entry) => entry.id === this.askConversationId
		)
			? this.askConversationId
			: null;
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
		const parse = (raw) => {
			try {
				const value = JSON.parse(raw);
				return Array.isArray(value) ? value : null;
			} catch {
				return null;
			}
		};
		const ensureIds = (entries) => {
			entries.forEach((entry) => (entry.id = entry.id ?? newAskId()));
			return entries;
		};
		const raw = await this.app.vault.adapter.read(ASK_HISTORY_PATH).catch(() => null);
		const fromVault = raw ? parse(raw) : null;
		raw &&
			!fromVault &&
			(await this.app.vault.adapter
				.write(`${ASK_HISTORY_PATH.replace(".json", "")}.corrupt-${Date.now()}.json`, raw)
				.catch(() => {}));
		if (fromVault) return ensureIds(fromVault);
		const legacy = ensureIds(parse(window.localStorage.getItem(LEGACY_ASK_KEY) ?? "") ?? []);
		this.askHistory = legacy;
		const persisted = legacy.length === 0 || (await this.persistAskHistory());
		persisted && window.localStorage.removeItem(LEGACY_ASK_KEY);
		return legacy;
	},

	async persistAskHistory() {
		this.askHistory.length > ASK_HISTORY_CAP && (this.askHistory.length = ASK_HISTORY_CAP);
		return this.app.vault.adapter
			.write(ASK_HISTORY_PATH, JSON.stringify(this.askHistory))
			.then(() => true)
			.catch(() => false);
	},

	async renderAsk() {
		this.askThread = this.askThread ?? [];
		const body = this.drawerBodyEl;
		body.empty();
		const form = body.createEl("form", { cls: "wlm-ask-form" });
		this.askInputEl = form.createEl("input", {
			cls: "wlm-ask-input",
			attr: { type: "text", placeholder: "Ask anything in the wiki…", enterkeyhint: "send" },
		});
		const send = form.createEl("button", { cls: "wlm-ask-send", attr: { type: "submit" } });
		send.setText("Ask");
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			this.submitAsk();
		});
		this.askStatusEl = body.createEl("div", { cls: "wlm-ask-status" });
		this.askBusy && this.askStatusEl.setText(this.askStatusText ?? "Searching the wiki…");
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
		all.setText(`All conversations (${others.length}) →`);
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
		back.setText("← Back to Ask");
		back.addEventListener("click", () => this.renderAsk());
		const title = body.createEl("div", { cls: "wlm-backlinks-title wlm-ask-screen-title" });
		title.setText("Conversations");
		const list = body.createEl("div", { cls: "wlm-ask-conversations" });
		this.askHistory
			.filter((entry) => entry.turns?.length > 0)
			.forEach((entry) => {
				const row = list.createEl("div", { cls: "wlm-ask-conversation" });
				const main = row.createEl("a", { cls: "wlm-ask-conversation-main" });
				const question = main.createEl("div", { cls: "wlm-ask-conversation-question" });
				question.setText(entry.turns[0].question);
				const meta = main.createEl("div", { cls: "wlm-ask-conversation-meta" });
				const turnCount = `${entry.turns.length} turn${entry.turns.length === 1 ? "" : "s"}`;
				const saved = entry.turns.some((turn) => turn.savedPath) ? " · saved ✓" : "";
				meta.setText(
					[entry.updatedAt?.slice(0, 10), turnCount].filter(Boolean).join(" · ") + saved
				);
				main.addEventListener("click", () => this.resumeConversation(entry));
				if (this.askBusy) return;
				const remove = row.createEl("button", { cls: "wlm-ask-conversation-delete" });
				remove.setText("✕");
				remove.addEventListener("click", async () => {
					this.askHistory.splice(this.askHistory.indexOf(entry), 1);
					entry.id === this.askConversationId &&
						((this.askThread = []), (this.askConversationId = null));
					await this.persistAskHistory();
					this.renderAskHistoryScreen();
				});
			});
	},

	async renderTurn(container, turn) {
		const questionEl = container.createEl("div", { cls: "wlm-ask-question" });
		questionEl.setText(turn.question);
		const answerEl = container.createEl("div", { cls: "wlm-ask-answer markdown-rendered" });
		await MarkdownRenderer.render(this.app, turn.answer, answerEl, "", this);
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
		save.setText(latest.savedPath ? "Saved ✓" : "Save as synthesis page");
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
			queue.setText(latest.gapPath ? "Gap queued ✓" : "Queue missing coverage");
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
			this.askThread.length
				? (this.askHistory[existing].turns = this.askThread)
				: this.askHistory.splice(existing, 1);
			await this.persistAskHistory();
		}
		this.submitAsk(question);
	},

	citedNodes(answer) {
		const wikilink = new RegExp(`\\[\\[(${this.model.root}/[^\\]|#]+)`, "g");
		const paths = [...answer.matchAll(wikilink)].map((match) => `${match[1].trim()}.md`);
		return [...new Set(paths)]
			.map((path) => this.model.nodes.find((node) => node.path === path))
			.filter(Boolean);
	},

	async submitAsk(forcedQuestion = "") {
		const question = forcedQuestion || this.askInputEl.value.trim();
		if (!question || this.askBusy) return;
		this.askBusy = true;
		const targetThread = this.askThread;
		const targetId = this.askConversationId;
		const startedAt = Date.now();
		this.askTicker = window.setInterval(() => {
			const seconds = Math.round((Date.now() - startedAt) / 1000);
			this.askStatusText = `Searching the wiki… ${seconds}s`;
			this.askStatusEl?.setText(this.askStatusText);
		}, 1000);
		this.renderAsk();
		try {
			const answer = sanitizeAnswer(await this.runAsk(question, targetThread));
			targetThread.push({ question, answer });
			await this.adoptAnswer(targetThread, targetId);
		} catch (error) {
			targetThread.push({
				question,
				answer: `**Could not reach the wiki server.** ${error.message ?? error}`,
				failed: true,
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
			updatedAt: new Date().toISOString(),
		});
		targetThread === this.askThread && (this.askConversationId = entryId);
		return this.persistAskHistory();
	},

	async runAsk(question, targetThread) {
		const config = await this.askConfig();
		const endpoints = config.endpoints ?? DEFAULT_ASK_ENDPOINTS;
		const thread = targetThread
			.filter((turn) => !turn.failed)
			.map((turn) => ({ question: turn.question, answer: turn.answer }));
		const post = await this.askRequest(endpoints, "/ask", {
			question,
			thread,
		});
		const deadline = Date.now() + 10 * 60 * 1000;
		let consecutiveFailures = 0;
		while (Date.now() < deadline && !this.disposed) {
			await new Promise((resolve) => window.setTimeout(resolve, 2000));
			const job = await this.askRequest(endpoints, `/ask/${post.id}`).catch(() => null);
			consecutiveFailures = job ? 0 : consecutiveFailures + 1;
			if (consecutiveFailures >= 8) throw new Error("lost contact with the server");
			if (job?.status === "done") return job.answer;
			if (job?.status === "error") throw new Error(job.error || "the run failed");
		}
		throw new Error(this.disposed ? "view closed" : "timed out after 10 minutes");
	},

	async askRequest(endpoints, route, payload) {
		let lastError = new Error("no ask endpoints reachable");
		for (const base of endpoints) {
			try {
				const response = await requestUrl({
					url: `${base}${route}`,
					method: payload ? "POST" : "GET",
					contentType: "application/json",
					body: payload ? JSON.stringify(payload) : undefined,
					throw: false,
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
		const slugged = turn.question
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60);
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
			`created: ${new Date().toISOString().slice(0, 10)}`,
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
			"",
		].join("\n");
		try {
			await this.app.vault.createFolder(target.folder).catch(() => {});
			await this.app.vault.create(path, content);
			turn.gapPath = path;
			await this.persistAskHistory();
			button.setText("Gap queued ✓");
		} catch {
			button.setText("Queue failed — retry");
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
		loading.setText("Loading usage and OpenAI spend…");
		this.drawerEl.addClass("open");
		try {
			const config = await this.askConfig();
			this.opsConfig = config;
			const summary = await this.askRequest(
				config.endpoints ?? DEFAULT_ASK_ENDPOINTS,
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
			summary.credit
				? `$${summary.credit.balanceUsd.toFixed(2)} credit remaining`
				: "Credit balance not recorded"
		);
		const state = hero.createEl("div", { cls: "wlm-ops-state" });
		const cost = summary.openaiCost ?? { status: "not-configured" };
		const hasPlatformSpend = ["ok", "stale"].includes(cost.status) && Number.isFinite(cost.spendUsd);
		const checked = cost.checkedAt?.slice(0, 10);
		state.setText(hasPlatformSpend
			? `$${cost.spendUsd.toFixed(2)} OpenAI ${cost.scope} spend since ${cost.periodStart}${checked ? ` · ${cost.status === "stale" ? "cached" : "checked"} ${checked}` : ""}`
			: cost.message ?? "OpenAI Costs API is not configured");
		this.renderCreditEditor(hero, summary);
		if (summary.credit?.checkedAt) {
			hero.createEl("div", {
				cls: "wlm-ops-state",
				text: `Balance updated ${summary.credit.checkedAt.slice(0, 10)}`,
			});
		}
		if (summary.credit?.lastTopUpUsd) {
			hero.createEl("div", {
				cls: "wlm-ops-state",
				text: `Last top-up +$${summary.credit.lastTopUpUsd.toFixed(2)} on ${summary.credit.lastTopUpAt.slice(0, 10)}`,
			});
		}

		const metrics = body.createEl("div", { cls: "wlm-ops-metrics" });
		const difference = hasPlatformSpend ? cost.spendUsd - summary.spentUsd : null;
		const money = (value) => `$${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
		[
			[hasPlatformSpend ? `$${cost.spendUsd.toFixed(2)}` : "—", "OpenAI month spend"],
			[`$${summary.spentUsd.toFixed(2)}`, "tracked wiki estimate"],
			[difference === null ? "—" : `$${Math.abs(difference).toFixed(2)}`,
				difference !== null && difference < 0 ? "estimate above API" : "API/local difference"],
			[`$${summary.cacheSavedUsd.toFixed(2)}`, "estimated cache saving"],
			[summary.runs, "recorded wiki runs"],
			[summary.activeAskJobs, "Ask running"],
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
				{ label: "Other OpenAI usage", meta: money(cost.services.other ?? 0) },
			]);
			body.createEl("div", {
				cls: "wlm-ops-attribution",
				text: "Service attribution currently uses model line items: GPT-5 → wiki, GPT-4o mini → Karakeep, transcription → podcast intake.",
			});
		}

		this.renderOpsSection(body, "Cost by workflow", Object.entries(summary.byKind).map(([kind, row]) => ({
			label: kind.replaceAll("-", " "),
			meta: `${row.runs} run${row.runs === 1 ? "" : "s"} · $${row.costUsd.toFixed(2)}`,
		})));

		const pending = summary.pending;
		this.renderOpsSection(body, "Pending", [
			{ label: "Inbox notes", meta: String(pending.inbox) },
			{ label: "Raw sources not ingested", meta: String(pending.rawSources) },
			{ label: "Research gaps", meta: String(pending.researchGaps) },
		]);

		const gapFolder = this.opsConfig?.researchGaps?.folder;
		const gapFiles = gapFolder
			? this.app.vault
					.getMarkdownFiles()
					.filter((file) => file.path.startsWith(`${gapFolder}/`))
			: [];
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
				meta: `${event.timestamp.slice(0, 10)} · ${event.status}`,
				detail: event.error,
				actionText: event.kind === "ask" ? "Open Ask" : "Retry",
				action: event.kind === "ask"
					? () => this.openFailedAsk()
					: (button) => this.retryWorkflow(event.kind, button),
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
			text: "Add credits",
		});
		const setToggle = actions.createEl("button", {
			cls: "wlm-credit-toggle",
			attr: { type: "button" },
			text: "Set exact balance",
		});
		const addForm = hero.createEl("form", { cls: "wlm-credit-form" });
		addForm.style.display = "none";
		const amountLabel = addForm.createEl("label", { text: "Credits added ($)" });
		const amount = amountLabel.createEl("input", {
			attr: { type: "number", min: "0.01", step: "0.01", required: "true", placeholder: "5.00" },
		});
		const add = addForm.createEl("button", { attr: { type: "submit" }, text: "Add to remaining balance" });
		const setForm = hero.createEl("form", { cls: "wlm-credit-form" });
		setForm.style.display = "none";
		const balanceLabel = setForm.createEl("label", { text: "Exact remaining balance ($)" });
		const balance = balanceLabel.createEl("input", {
			attr: { type: "number", min: "0", step: "0.01", required: "true" },
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
			add.setText("Adding…");
			try {
				const updated = await this.askRequest(
					this.opsConfig.endpoints ?? DEFAULT_ASK_ENDPOINTS,
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
			save.setText("Saving…");
			try {
				const updated = await this.askRequest(
					this.opsConfig.endpoints ?? DEFAULT_ASK_ENDPOINTS,
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
			text: "Display only: adding or correcting credits never pauses jobs.",
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
		button.setText("Starting…");
		try {
			const config = await this.askConfig();
			await this.askRequest(config.endpoints ?? DEFAULT_ASK_ENDPOINTS, "/ops/retry", { kind });
			button.setText("Retry started");
		} catch {
			button.disabled = false;
			button.setText("Retry failed");
		}
	},

	async openFailedAsk() {
		await this.openAsk();
		const failed = this.askHistory.find((entry) =>
			entry.turns?.some((turn) => turn.failed)
		);
		failed && this.resumeConversation(failed);
	},

	async saveSynthesis(turn, button) {
		const target = this.model.synthesisSave;
		if (!target) return;
		const cited = this.citedNodes(turn.answer);
		const subjectCounts = cited
			.flatMap((node) => (node.subjects[0] ? [node.subjects[0]] : []))
			.reduce((counts, subject) => counts.set(subject, (counts.get(subject) ?? 0) + 1), new Map());
		const primary =
			[...subjectCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
			this.model.subjects[0]?.name;
		const slugged = turn.question
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60);
		const baseSlug =
			slugged || `ask-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
		const taken = (candidate) =>
			this.app.vault.getAbstractFileByPath(`${target.folder}/${candidate}.md`);
		let slug = baseSlug;
		let suffix = 2;
		while (taken(slug)) {
			slug = `${baseSlug}-${suffix}`;
			suffix += 1;
		}
		const content = [
			"---",
			`type: ${target.type}`,
			...(primary ? [`tags: [${primary}]`] : []),
			`created: ${new Date().toISOString().slice(0, 10)}`,
			"status: edited",
			`question: "${turn.question.replace(/"/g, "'")}"`,
			"---",
			`# ${turn.question}`,
			"",
			turn.answer,
			"",
		].join("\n");
		const path = `${target.folder}/${slug}.md`;
		try {
			await this.app.vault.createFolder(target.folder).catch(() => {});
			await this.app.vault.create(path, content);
			turn.savedPath = path;
			await this.persistAskHistory();
			button.setText("Saved ✓");
		} catch {
			button.setText("Save failed — retry");
		}
	},
};
