/**
 * dsh-plugin-cloud — Host half.
 *
 * One plugin, five internal components:
 *
 *   lib/config.js      configuration + schema
 *   lib/collector.js   read the live profile into a portable snapshot
 *   lib/github.js      the private repository as cloud storage
 *   lib/store.js       local mirror + merged version index
 *   lib/autobackup.js  automatic snapshots (interval + on-change)
 *   lib/restorer.js    turn a snapshot back into an installed plugin set
 *   lib/versions.js    which installed plugins have a newer published version
 *   lib/subscriptions.js  move a local checkout onto its git remote
 *
 * Design boundary: this plugin never writes `package.json` or `cordis.patch.yml`.
 * Installing goes through `pluginManager.installBundle`, which owns the pnpm
 * path, the manifest lock, rollback and activation. Anything this plugin wrote
 * by hand would race that machinery.
 *
 * @module dsh-plugin-cloud
 */
import { join } from "node:path";
import { homedir } from "node:os";

import { load as loadConfig, save as saveConfig, normalize, cloudReady, DEFAULTS, FIELDS, configFile } from "./lib/config.js";
import { collect, classifySpec } from "./lib/collector.js";
import * as gh from "./lib/github.js";
import * as store from "./lib/store.js";
import { createScheduler, fingerprint } from "./lib/autobackup.js";
import { restore, summarizeReport } from "./lib/restorer.js";
import { checkUpdates, fetchPackument } from "./lib/versions.js";
import { planSubscription, BLOCKER_TEXT } from "./lib/subscriptions.js";
import { replaceDependency } from "./lib/manifest.js";
import { createJobRegistry, stepsFor, subscribeStepsFor } from "./lib/jobs.js";

export const name = "plugin-cloud";
export const inject = ["webServer"];
// No `Config` export: the Loader validates it through a Standard Schema
// (`Config['~standard'].validate`) which a profile-installed plugin cannot
// import. Settings therefore live in config.json (see lib/config.js).

const PREFIX = "/api/plugin-cloud";

/** The profile this Host is running. */
function profileInfo() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const profile = process.env.DSH_PROFILE ?? "desktop";
	const dir = process.env.DSH_PROFILE_DIR ?? join(home, "profiles", profile);
	return { home, profile, dir };
}

const writeJson = (res, status, body) => {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
};

/**
 * Collapse a plugin row plus its update info into one of the states the UI
 * paints. Keeping this server-side means the tab never has to re-derive the
 * precedence rules (disabled beats updatable, local beats unsupported, …).
 */
function pluginStatus(plugin, update) {
	if (plugin.installed === false) return "missing";
	if (plugin.enabled === false) return "disabled";
	if (update?.updateAvailable === true) return plugin.kind === "path" ? "behind-upstream" : "updatable";
	if (plugin.kind === "path" && update?.tracked === false) return "untracked";
	// A subscribed plugin whose remote could not be read is *unknown*, not
	// unsupported: the spec is fine, the network or the token is not. Saying
	// "unsupported" here would blame the plugin for a connectivity problem.
	if (update?.note === "remote-unreachable") return "unreachable";
	if (update?.note === "unsupported-spec") return "unsupported";
	return "current";
}

const readBody = (req, limit = 8 * 1024 * 1024) =>
	new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});

/**
 * Mount routes, scheduler and the change watcher.
 *
 * Settings live in a file that is re-read per operation, so saving takes
 * effect without a restart. The `config` object from the patch layer is only a
 * starting point for installs that predate the file.
 *
 * @param {import("cordis").Context} ctx
 * @param {object} rawConfig - the profile entry's `config` object.
 */
export function apply(ctx, rawConfig) {
	const { profile, dir } = profileInfo();

	/** Live configuration; refreshed before every operation. */
	let cfgCache = { at: 0, cfg: normalize(rawConfig) };
	let cfgLoadError = null;
	async function cfgNow(force = false) {
		if (!force && Date.now() - cfgCache.at < 3000) return cfgCache.cfg;
		try {
			// A stale module generation after a hot reload can leave `load`
			// undefined; report it instead of silently serving defaults.
			if (typeof loadConfig !== "function") {
				cfgLoadError = `load is ${typeof loadConfig} (stale module?)`;
				return cfgCache.cfg;
			}
			const next = await loadConfig();
			cfgCache = { at: Date.now(), cfg: next };
			cfgLoadError = null;
		} catch (error) {
			cfgLoadError = String(error?.message ?? error).slice(0, 200);
			/* keep the last good configuration on a read failure */
		}
		return cfgCache.cfg;
	}
	// Sync view for the scheduler: it runs on timers and must not await a read
	// just to decide whether to start one.
	let cfgSync = cfgCache.cfg;
	void cfgNow().then((c) => { cfgSync = c; });

	/** Last registry check, reused when the tab re-renders with refresh=0. */
	let updateCache = null;
	/** Most recent plugin-set change, surfaced in the status payload. */
	let lastChange = null;
	/** Background upgrade jobs, polled by the UI for step-by-step progress. */
	const jobs = createJobRegistry();

	const manager = () => ctx.get("pluginManager", false) ?? null;

	/**
	 * Resolve the token through the credential service, per operation.
	 * Never cached: a rotated credential reaches the next request.
	 */
	async function token(ref) {
		const credentials = ctx.get("credentials", false);
		if (credentials === null || credentials === undefined) {
			throw Object.assign(new Error("凭证服务不可用"), { status: 503 });
		}
		const resolved = await credentials.resolve(String(ref || DEFAULTS.tokenRef));
		if (resolved === undefined || resolved.value === "") {
			throw Object.assign(new Error(`凭证 ${ref} 未配置`), { status: 412 });
		}
		return resolved.value;
	}

	/** Build a snapshot of this profile. */
	async function snapshot(label, note) {
		return collect({ manager: manager(), profileDir: dir, profile, label, note });
	}

	let lastPush = null;

	/** Persist a snapshot locally, and to GitHub when configured. */
	async function push(snap, reason, detail) {
		const cfg = await cfgNow();
		// Record *why* this version exists so the version list can say it.
		if (typeof detail === "string" && detail !== "") snap.reasonDetail = detail.slice(0, 120);
		await store.saveLocal(snap);
		if (!cloudReady(cfg)) {
			lastPush = { at: new Date().toISOString(), where: "local", reason, error: null };
			return;
		}
		try {
			const t = await token(cfg.tokenRef);
			const result = await gh.pushSnapshot(t, cfg.repo, snap, { keep: cfg.maxSnapshots, apiBase: cfg.apiBase });
			lastPush = { at: new Date().toISOString(), where: "cloud", reason, file: result.file, error: null };
		} catch (error) {
			lastPush = { at: new Date().toISOString(), where: "local", reason, error: String(error?.message ?? error).slice(0, 300) };
			throw error;
		}
	}

	const scheduler = createScheduler({
		getIntervalMs: () => Math.round(cfgSync.intervalHours * 3600_000),
		enabled: () => cfgSync.autoBackup === true,
		onChangeEnabled: () => cfgSync.autoPushOnChange === true,
		snapshot: () => snapshot("auto", "自动备份"),
		push,
		// The newest stored snapshot defines "what has already been pushed";
		// reading it from disk is what stops every reload from duplicating it.
		seed: async () => {
			const local = await store.listLocal();
			if (local.length === 0) return null;
			const newest = await store.loadLocal(local[0].file);
			return newest ? fingerprint(newest) : null;
		},
		onEvent: (event) => { try { ctx.emit?.("plugin-cloud/auto", event); } catch { /* no listener */ } },
	});

	// Arm the scheduler only after the real configuration is read: otherwise
	// the first reschedule() sees the default interval and the timer runs on
	// the wrong cadence until the next tick.
	ctx.effect(() => {
		let stop = null;
		let released = false;
		void cfgNow(true).then((c) => {
			cfgSync = c;
			// The effect may already have been disposed (fast reload, bundle
			// disable); never leave a timer running behind after that.
			if (released) { scheduler.stop(); return; }
			stop = scheduler.start();
		});
		return () => {
			released = true;
			if (stop) stop();
			else scheduler.stop();
		};
	}, "plugin-cloud/auto-backup");

	// On-change trigger: the manager emits this for every completed install,
	// removal and enablement change — including the ones this plugin performs
	// itself, so an upgrade or subscription is captured exactly like a manual
	// edit. The fingerprint inside the scheduler keeps a no-op change from
	// producing a duplicate snapshot.
	//
	// The payload's `reason` is the *category* the manager used ("plugin" or
	// "bundle"), not the action; the action is inferred by diffing the plugin
	// set against the last snapshot, so the stored note says what really moved.
	ctx.effect(() => {
		const on = ctx.on?.("plugin-manager/changed", (event) => {
			void cfgNow(true).then((c) => {
				cfgSync = c;
				const category = String(event?.reason ?? "");
				lastChange = { category, at: new Date().toISOString() };
				scheduler.notifyChange(category || "change");
			});
		});
		return typeof on === "function" ? on : () => {};
	}, "plugin-cloud/change-watch");

	/**
	 * Run one upgrade job to completion, reporting each step as it starts.
	 *
	 * The step boundaries are the real boundaries of the work: the registry
	 * lookup, the manifest edit, the pnpm run. Reporting them is what makes the
	 * UI honest — when it says "执行 pnpm 安装" pnpm is genuinely running, and a
	 * job that stalls on one step shows exactly which step stalled.
	 *
	 * A cancelled job stops between steps and never mid-install: interrupting a
	 * pnpm run would risk leaving the manifest without the dependency entry.
	 *
	 * @param {object} options
	 * @param {string} options.jobId - job to advance.
	 * @param {string[]} options.names - plugins being upgraded.
	 * @param {object} options.manager - pluginManager.
	 * @param {string} options.dir - profile directory.
	 */
	async function runUpgradeJob({ jobId, names, manager, dir }) {
		const results = [];
		let restartRequired = false;

		for (const [index, name] of names.entries()) {
			const row = { name, ok: false, error: null, errorCode: null, from: null, to: null, spec: null };
			const advance = (stepIndex, phase) => jobs.advance(jobId, { index, stepIndex, phase });

			if (jobs.isCancelled(jobId)) {
				row.errorCode = "cancelled";
				row.error = "cancelled";
				results.push(row);
				jobs.pushResult(jobId, row);
				break;
			}

			try {
				advance(0, "resolving");
				// Self-upgrade would replace the code running this request.
				if (name === "dsh-plugin-cloud") throw new Error("self-upgrade-blocked");
				const packument = await fetchPackument(name, cfg.registry);
				row.to = packument?.latest ?? null;
				row.spec = row.to === null ? null : `${name}@${row.to}`;
				// Rebuild this plugin's step labels now that the version is known:
				// "解析 x 的目标版本（0.3.39）" beats a generic label.
				jobs.advance(jobId, { index, stepIndex: 0, phase: "resolving" });
				if (row.to === null) throw new Error("registry-unreachable");

				advance(1, "preparing");
				const installed = await (manager.listBundles?.() ?? []);
				row.from = installed.find((b) => b.name === name)?.version ?? null;
				if (row.from === row.to) {
					row.ok = true;
					row.unchanged = true;
					// Nothing was installed, so nothing needs a restart.
					row.application = "not-needed";
					results.push(row);
					jobs.pushResult(jobId, row);
					continue;
				}

				// saveExact writes `1.2.0`, not `^1.2.0`: a snapshot made after this
				// must resolve to this same version elsewhere.
				advance(3, "installing");
				const outcome = await replaceDependency({
					manager,
					dir,
					name,
					spec: `${name}@${row.to}`,
					installOptions: { saveExact: true },
				});

				advance(4, "verifying");
				row.ok = outcome.ok === true;
				row.via = outcome.via ?? null;
				row.application = outcome.application ?? null;
				if (!row.ok) {
					row.errorCode = outcome.errorCode ?? "operation-error";
					row.error = outcome.error ?? row.errorCode;
					row.restored = outcome.restored ?? null;
				} else {
					const applied = row.application === "applied";
					if (!applied) restartRequired = true;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				row.errorCode = message;
				row.error = message;
			}
			results.push(row);
			jobs.pushResult(jobId, row);
		}

		// Upgrading changes the installed set: take a snapshot of the result so
		// the change is captured even if the change event lands later.
		void scheduler.force("upgrade").catch(() => {});
		jobs.finish(jobId, {
			results,
			restartRequired,
			ok: results.every((r) => r.ok),
		});
	}

	/**
	 * Run one subscribe job to completion, reporting each step as it starts.
	 *
	 * The step boundaries are the real boundaries of the work: inspect the
	 * checkout, derive the pinned spec, install. Reporting them is what makes
	 * the panel honest — when it says "执行 pnpm 安装", pnpm is running, and a
	 * subscribe that stalls shows exactly which step stalled instead of a
	 * spinner that means nothing.
	 *
	 * A blocked checkout is reported as a blocker list rather than a generic
	 * error, so the UI can say "有未提交的改动" instead of "订阅失败".
	 *
	 * @param {object} options
	 * @param {string} options.jobId - job to advance.
	 * @param {string[]} options.names - plugins being subscribed.
	 * @param {object} options.manager - pluginManager.
	 * @param {string} options.dir - profile directory.
	 */
	async function runSubscribeJob({ jobId, names, manager, dir }) {
		const results = [];
		let restartRequired = false;

		if (jobs.isCancelled(jobId)) {
			jobs.finish(jobId, { results, restartRequired: false, ok: false, cancelled: true });
			return;
		}

		// The inventory is read once: the loop only needs each plugin's kind and
		// path, and re-collecting per plugin would re-read the whole profile.
		let byName = new Map();
		try {
			const snap = await snapshot("inventory", "插件清单");
			byName = new Map(snap.plugins.map((p) => [p.name, p]));
		} catch {
			// A failed inventory is not fatal: the per-plugin lookup below reports
			// `unknown-plugin`, which is the same conclusion with a usable code.
		}

		for (const [index, name] of names.entries()) {
			const row = { name, ok: false, error: null, errorCode: null, spec: null };
			const advance = (stepIndex, phase) => jobs.advance(jobId, { index, stepIndex, phase });

			if (jobs.isCancelled(jobId)) {
				row.errorCode = "cancelled";
				row.error = "cancelled";
				results.push(row);
				jobs.pushResult(jobId, row);
				break;
			}

			try {
				advance(0, "inspecting");
				if (name === "dsh-plugin-cloud") throw new Error("self-subscribe-blocked");
				const plugin = byName.get(name);
				if (plugin === undefined) throw new Error("unknown-plugin");
				if (plugin.kind !== "path") throw new Error("not-a-local-plugin");

				advance(1, "planning");
				const plan = await planSubscription({ name, path: plugin.path ?? plugin.git?.path ?? null });
				row.spec = plan.spec;
				if (!plan.ready) {
					const blocker = new Error(`subscribe-blocked:${plan.blockedBy.join(",")}`);
					blocker.codes = plan.blockedBy;
					throw blocker;
				}

				// A git spec is exact by construction: it names a commit, so
				// saveExact adds nothing but costs a lock.
				advance(3, "installing");
				const outcome = await replaceDependency({
					manager,
					dir,
					name,
					spec: plan.spec,
					installOptions: { saveExact: true },
				});

				advance(4, "verifying");
				row.ok = outcome.ok === true;
				row.via = outcome.via ?? null;
				row.application = outcome.application ?? null;
				if (!row.ok) {
					row.errorCode = outcome.errorCode ?? "operation-error";
					row.error = outcome.error ?? row.errorCode;
					row.restored = outcome.restored ?? null;
				} else if (row.application !== "applied") {
					restartRequired = true;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				row.errorCode = message;
				row.error = message;
				if (Array.isArray(error?.codes)) row.blockedBy = error.codes;
			}
			results.push(row);
			jobs.pushResult(jobId, row);
		}

		void scheduler.force("subscribe").catch(() => {});
		jobs.finish(jobId, {
			results,
			restartRequired,
			ok: results.every((r) => r.ok),
		});
	}

	ctx.inject(["webServer"], (scope) => {
		scope.effect(() => scope.webServer.register({
			kind: "prefix",
			path: PREFIX,
			handler: async (req, res) => {
				const url = new URL(req.url ?? "/", "http://localhost");
				const route = url.pathname.replace(/\/+$/, "").slice(PREFIX.length);
				const cfg = await cfgNow(route === "/config" || route === "/token");
				try {
					// ---- status -------------------------------------------------
					if (req.method === "GET" && (route === "/status" || route === "")) {
						const local = await store.readLocalIndex();
						let remote = { versions: [] };
						let cloud = { ready: cloudReady(cfg), repo: cfg.repo, reachable: false, error: null, isPrivate: null };
						let tokenInfo = { configured: false, source: null, ref: cfg.tokenRef };
						try {
							const credentials = ctx.get("credentials", false);
							if (credentials) {
								const info = await credentials.describe(cfg.tokenRef);
								tokenInfo = { configured: info.configured === true, source: info.source ?? null, ref: cfg.tokenRef };
							}
						} catch {
							/* describe failure is not fatal: the status page still renders */
						}
						if (cloud.ready && tokenInfo.configured) {
							try {
								const t = await token(cfg.tokenRef);
								const info = await gh.verifyRepo(t, cfg.repo);
								cloud.reachable = true;
								cloud.isPrivate = info.private;
								remote = await gh.readIndex(t, cfg.repo);
							} catch (error) {
								cloud.error = String(error?.message ?? error).slice(0, 300);
							}
						}
						writeJson(res, 200, {
							config: { ...cfg },
							configPath: configFile(),
							configLoadError: cfgLoadError,
							cloud,
							token: tokenInfo,
							versionCount: store.mergeIndexes(local.versions, remote.versions).length,
							auto: scheduler.status(),
							lastPush,
							lastChange,
							profile,
						});
						return;
					}

					// ---- versions -----------------------------------------------
					if (req.method === "GET" && route === "/versions") {
						const local = await store.readLocalIndex();
						let remote = { versions: [] };
						let error = null;
						if (cloudReady(cfg)) {
							try {
								remote = await gh.readIndex(await token(cfg.tokenRef), cfg.repo);
							} catch (e) {
								error = String(e?.message ?? e).slice(0, 300);
							}
						}
						writeJson(res, 200, {
							versions: store.mergeIndexes(local.versions, remote.versions),
							cloudError: error,
						});
						return;
					}

					// ---- preview -------------------------------------------------
					if (req.method === "GET" && route === "/preview") {
						const snap = await snapshot("preview", "");
						writeJson(res, 200, { snapshot: snap, fingerprint: fingerprint(snap) });
						return;
					}

					// ---- backup now ----------------------------------------------
					if (req.method === "POST" && route === "/backup") {
						const body = JSON.parse((await readBody(req)) || "{}");
						const snap = await snapshot(body.label || "manual", body.note || "");
						await push(snap, "manual");
						writeJson(res, 200, { snapshot: snap, lastPush });
						return;
					}

					// ---- read one version ----------------------------------------
					if (req.method === "GET" && route.startsWith("/version/")) {
						const file = decodeURIComponent(route.slice("/version/".length));
						const safe = file.replace(/[\\/]/g, "").replace(/\.\./g, "");
						let snap = await store.loadLocal(safe);
						let from = "local";
						if (!snap && cloudReady(cfg)) {
							const remote = await gh.readFile(await token(cfg.tokenRef), cfg.repo, `snapshots/${safe}`);
							if (remote) { snap = JSON.parse(remote.content); from = "cloud"; }
						}
						if (!snap) { writeJson(res, 404, { error: "not-found" }); return; }
						writeJson(res, 200, { snapshot: snap, from });
						return;
					}

					// ---- restore -------------------------------------------------
					if (req.method === "POST" && route === "/restore") {
						const body = JSON.parse((await readBody(req)) || "{}");
						const safe = String(body.file ?? "").replace(/[\\/]/g, "").replace(/\.\./g, "");
						let snap = body.snapshot ?? (safe ? await store.loadLocal(safe) : null);
						if (!snap && safe && cloudReady(cfg)) {
							const remote = await gh.readFile(await token(cfg.tokenRef), cfg.repo, `snapshots/${safe}`);
							if (remote) snap = JSON.parse(remote.content);
						}
						if (!snap) { writeJson(res, 404, { error: "not-found" }); return; }
						const dryRun = body.confirm !== true;
						const rows = await restore({ manager: manager(), snapshot: snap, dryRun, profileDir: dir, profile });
						writeJson(res, 200, { dryRun, report: rows, summary: summarizeReport(rows) });
						return;
					}

					// ---- delete a version ----------------------------------------
					if (req.method === "POST" && route === "/delete") {
						const body = JSON.parse((await readBody(req)) || "{}");
						const safe = String(body.file ?? "").replace(/[\\/]/g, "").replace(/\.\./g, "");
						if (!safe) { writeJson(res, 400, { error: "invalid-name" }); return; }
						const localResult = await store.deleteLocal(safe);
						let cloudResult = { deleted: false };
						if (cloudReady(cfg) && body.cloud !== false) {
							try {
								cloudResult = await gh.deleteSnapshot(await token(cfg.tokenRef), cfg.repo, safe);
							} catch (e) {
								cloudResult = { deleted: false, error: String(e?.message ?? e).slice(0, 200) };
							}
						}
						writeJson(res, 200, { local: localResult, cloud: cloudResult });
						return;
					}

					// ---- verify the repository -----------------------------------
					if (req.method === "POST" && route === "/verify") {
						const body = JSON.parse((await readBody(req)) || "{}");
						const repo = String(body.repo ?? cfg.repo);
						if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
							writeJson(res, 400, { error: "invalid-repo" });
							return;
						}
						const t = await token(cfg.tokenRef);
						const info = await gh.verifyRepo(t, repo);
						writeJson(res, 200, { repo: info });
						return;
					}

					// ---- persist configuration ---------------------------------------
					// Settings live in config.json, re-read before every operation,
					// so a save takes effect immediately: the scheduler re-arms its
					// timer from the live value on the next tick, and the next cloud
					// call already sees the new repo/tokenRef.
					if (req.method === "POST" && route === "/config") {
						const body = JSON.parse((await readBody(req)) || "{}");
						const patch = {};
						// FIELDS is the single source of truth for what may be saved;
						// restating the list here is how it drifts from the schema.
						for (const key of Object.keys(FIELDS)) {
							if (body[key] !== undefined) patch[key] = body[key];
						}
						if (Object.keys(patch).length === 0) { writeJson(res, 400, { error: "没有可保存的字段" }); return; }
						try {
							const result = await saveConfig(patch);
							// Invalidate the read cache so the very next request —
							// which may arrive inside the freshness window — sees the
							// value just written rather than the pre-save snapshot.
							cfgCache = { at: 0, cfg: result.config };
							cfgSync = result.config;
							// A settings change does not change the plugin set, so it
							// must not force a snapshot; only re-arm the timer.
							scheduler.reschedule();
							if (result.rejected.length > 0) {
								writeJson(res, 400, { error: `字段被拒绝: ${result.rejected.join(", ")}`, config: result.config });
								return;
							}
							writeJson(res, 200, { saved: true, config: result.config, path: result.path });
						} catch (error) {
							writeJson(res, 500, { error: String(error?.message ?? error).slice(0, 300) });
						}
						return;
					}

					// ---- store the GitHub token --------------------------------------
					// The token goes to the credential service under `tokenRef` and is
					// never written to the profile patch, a snapshot, or a log.
					if (req.method === "POST" && route === "/token") {
						const body = JSON.parse((await readBody(req)) || "{}");
						const value = String(body.value ?? "");
						if (!value) { writeJson(res, 400, { error: "令牌为空" }); return; }
						const credentials = ctx.get("credentials", false);
						if (credentials === null || credentials === undefined) {
							writeJson(res, 503, { error: "凭证服务不可用" });
							return;
						}
						// Honor a tokenRef supplied with this request: the config
						// above may name a new reference that is not live until the
						// next launch, and a token saved in the same action must land
						// under the name the user just chose.
						const ref = String(body.ref ?? cfg.tokenRef).trim() || cfg.tokenRef;
						try {
							await credentials.set(ref, value);
							writeJson(res, 200, { stored: true, ref });
						} catch (error) {
							writeJson(res, 400, { error: String(error?.message ?? error).slice(0, 300) });
						}
						return;
					}

					// ---- describe the token (never returns the value) ----------------
					if (req.method === "GET" && route === "/token") {
						const credentials = ctx.get("credentials", false);
						if (credentials === null || credentials === undefined) {
							writeJson(res, 503, { error: "凭证服务不可用" });
							return;
						}
						try {
							const info = await credentials.describe(cfg.tokenRef);
							writeJson(res, 200, { ref: cfg.tokenRef, configured: info.configured === true, source: info.source ?? null, writable: info.writable === true });
						} catch (error) {
							writeJson(res, 400, { error: String(error?.message ?? error).slice(0, 300) });
						}
						return;
					}

					// ---- installed plugins + available updates -----------------------
					// One call the management tab can drive its whole table from. The
					// snapshot is the inventory; `updates` is joined onto it by name.
					if (req.method === "GET" && route === "/plugins") {
						const snap = await snapshot("inventory", "插件清单");
						const wantCached = url.searchParams.get("refresh") === "0";
						let updates = null;
						let updateError = null;
						let cached = false;
						// A stale marker is only meaningful if there is something to be
						// stale: with no cache yet, honouring `refresh=0` would report
						// every plugin as up to date, which is a lie, not a cache hit.
						if (wantCached && updateCache !== null) {
							updates = updateCache;
							cached = true;
						} else {
							try {
								updates = await checkUpdates(snap.plugins, { registry: cfg.registry });
								updateCache = updates;
							} catch (error) {
								updateError = String(error?.message ?? error).slice(0, 300);
								updates = new Map();
							}
						}
						const rows = snap.plugins.map((p) => {
							const u = updates.get(p.name) ?? null;
							return {
								...p,
								update: u,
								status: pluginStatus(p, u),
							};
						});
						// Subscriptions: what each link: plugin would become.
						const plans = [];
						for (const p of snap.plugins) {
							if (p.kind !== "path") continue;
							const plan = await planSubscription({ name: p.name, path: p.path ?? p.git?.path ?? null });
							plans.push({
								name: p.name,
								spec: plan.spec,
								ready: plan.ready,
								blockedBy: plan.blockedBy,
								blockedText: plan.blockedBy.map((c) => BLOCKER_TEXT[c] ?? c),
								slug: plan.report.slug,
								branch: plan.report.branch,
								commit: plan.report.short,
								ahead: plan.report.ahead,
								behind: plan.report.behind,
							});
						}
						writeJson(res, 200, {
							plugins: rows,
							subscriptions: plans,
							summary: {
								...snap.summary,
								updatable: rows.filter((r) => r.update?.updateAvailable === true).length,
								subscribable: plans.filter((p) => p.ready).length,
							},
							// The user's own plugin (this one) is never offered for self-upgrade.
							selfName: "dsh-plugin-cloud",
							updateError,
							generatedAt: new Date().toISOString(),
							cached,
						});
						return;
					}

					// ---- force a fresh registry check ------------------------------
					if (req.method === "POST" && route === "/updates") {
						const snap = await snapshot("inventory", "插件清单");
						const updates = await checkUpdates(snap.plugins, { registry: cfg.registry });
						updateCache = updates;
						writeJson(res, 200, {
							ok: true,
							updates: Object.fromEntries(updates),
							generatedAt: new Date().toISOString(),
						});
						return;
					}

					// ---- upgrade one or more plugins (as a job) ----------------------
					// Installs go through pluginManager, which owns pnpm, the manifest
					// lock and rollback. installBundle never rejects: a refusal comes
					// back folded into `result.error.code`, so success has to be read
					// from the result rather than from a thrown exception.
					//
					// The work runs in the background and the response carries a job
					// id: an upgrade takes tens of seconds, and a synchronous response
					// leaves the UI with nothing to show but a spinner. The UI polls
					// `/job` for the current step, so "正在执行 pnpm 安装" is a claim
					// about what is happening right now, not a decorative animation.
					if (req.method === "POST" && route === "/upgrade") {
						const manager = ctx.get("pluginManager", false);
						if (manager === null || manager === undefined) {
							writeJson(res, 503, { error: "manager-unavailable" });
							return;
						}
						const running = jobs.running();
						if (running !== null) {
							// Two concurrent pnpm runs against one profile would race on
							// the lockfile and the manifest. Hand back the running job so
							// the UI adopts it instead of starting a second one.
							writeJson(res, 409, { error: "job-running", job: running });
							return;
						}
						const body = JSON.parse((await readBody(req)) || "{}");
						const targets = Array.isArray(body.names) ? body.names : body.name ? [body.name] : [];
						if (targets.length === 0) { writeJson(res, 400, { error: "no-upgrade-targets" }); return; }
						const names = targets.map(String);
						// Labels are built before any work starts, so the UI can render
						// the whole step list from the first poll rather than discovering
						// steps as it goes.
						const stepSets = names.map((n) => stepsFor(n, null));
						const job = jobs.create({ names, stepSets });
						// Start after the response is written: the id must reach the
						// UI before the first step can possibly finish.
						res.once("finish", () => {
							void runUpgradeJob({ jobId: job.id, names, manager, dir }).catch((error) => {
								jobs.fail(job.id, error instanceof Error ? error.message : String(error));
							});
						});
						writeJson(res, 202, { ok: true, job });
						return;
					}

					// ---- poll a job --------------------------------------------------
					if (req.method === "GET" && route === "/job") {
						const id = url.searchParams.get("id") ?? "";
						jobs.sweep();
						const job = jobs.get(id);
						if (job === null) { writeJson(res, 404, { error: "job-not-found" }); return; }
						writeJson(res, 200, { job });
						return;
					}

					// ---- cancel a running job ----------------------------------------
					if (req.method === "POST" && route === "/cancel") {
						const body = JSON.parse((await readBody(req)) || "{}");
						const id = typeof body.id === "string" ? body.id : "";
						const running = jobs.running();
						if (running === null) { writeJson(res, 409, { error: "no-running-job" }); return; }
						const target = id === "" ? running.id : id;
						const ok = jobs.cancel(target);
						writeJson(res, ok ? 200 : 409, { ok, job: jobs.get(target) });
						return;
					}

					// ---- subscribe a local checkout to its git remote (as a job) ------
					// Same manifest seam as an upgrade: the dependency is already in
					// package.json, so the manager's `already-installed` guard fires
					// and the refusal arrives folded into the result, not as a throw.
					//
					// It runs as a job for the same reason upgrades do: inspecting a
					// checkout runs several git commands and the install runs pnpm, so a
					// synchronous response leaves the panel spinning with nothing to
					// show. Subscribing was the last synchronous action here, and the
					// first thing a user asked about it was "it just spins".
					if (req.method === "POST" && route === "/subscribe") {
						const manager = ctx.get("pluginManager", false);
						if (manager === null || manager === undefined) {
							writeJson(res, 503, { error: "manager-unavailable" });
							return;
						}
						const running = jobs.running();
						if (running !== null) {
							writeJson(res, 409, { error: "job-running", job: running });
							return;
						}
						const body = JSON.parse((await readBody(req)) || "{}");
						const names = Array.isArray(body.names) ? body.names : body.name ? [body.name] : [];
						if (names.length === 0) { writeJson(res, 400, { error: "no-subscribe-targets" }); return; }
						const targets = names.map(String);
						const stepSets = targets.map((n) => subscribeStepsFor(n));
						const job = jobs.create({ names: targets, stepSets });
						res.once("finish", () => {
							void runSubscribeJob({ jobId: job.id, names: targets, manager, dir }).catch((error) => {
								jobs.fail(job.id, error instanceof Error ? error.message : String(error));
							});
						});
						writeJson(res, 202, { ok: true, job });
						return;
					}

					writeJson(res, 404, { error: "not-found", route });
				} catch (error) {
					writeJson(res, error?.status ?? 500, { error: String(error?.message ?? error).slice(0, 400) });
				}
			},
		}), "plugin-cloud/routes");
	});
}

export { classifySpec, fingerprint };
