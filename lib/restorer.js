/**
 * Component: the restorer.
 *
 * Turns a snapshot back into an installed plugin set. Two strategies:
 *
 *   registry plugins → pluginManager.installBundle(`name@exactVersion`)
 *   local plugins    → a git clone + checkout command the user runs
 *
 * The manager owns the pnpm path, the manifest lock, failure rollback and the
 * activation lifecycle, so this module never touches package.json itself.
 *
 * @module dsh-plugin-cloud/lib/restorer
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { unlinkNodeModulesEntry } from "./detach.js";

/** Statuses that mean the desired end state already holds. */
const BENIGN = new Set(["already-installed"]);

/**
 * Perform (or plan) a restore.
 *
 * @param {object} options
 * @param {object|null} options.manager - pluginManager service.
 * @param {object} options.snapshot - snapshot document.
 * @param {boolean} options.dryRun - plan only, write nothing.
 * @param {string} options.profileDir - target profile directory.
 * @param {string} options.profile - target profile name.
 * @param {(update:{index:number,stepId:string,phase:string})=>void} [options.onStep] - progress callback.
 * @returns {Promise<object[]>} per-plugin report rows.
 */
export async function restore({ manager, snapshot, dryRun, profileDir, profile, onStep }) {
	const rows = [];
	const targetBundles = Array.isArray(snapshot.bundleOrder) ? snapshot.bundleOrder : [];
	const plugins = snapshot.plugins ?? [];
	// Progress must never break the work, so the callback is contained.
	const step = (index, stepId, phase) => {
		try { onStep?.({ index, stepId, phase }); } catch { /* ignore */ }
	};

	for (const [index, entry] of plugins.entries()) {
		const row = { name: entry.name, kind: entry.kind, action: null, status: "pending", detail: null };
		step(index, "resolve", "resolving");

		// --- git dependency: restored from its own spec, never from a registry ---
		//
		// A `github:owner/repo#sha` or `git+https://…#sha` dependency is not on
		// npm. Falling through to the registry branch below asked pnpm for
		// `name@version`, which has no published version, so every restore of a
		// subscribed plugin failed with `ERR_PNPM_FETCH_404` — and subscribing is
		// what this plugin encourages. The spec already names an exact commit, so
		// it is installed verbatim.
		if (entry.kind === "git") {
			if (!entry.spec || typeof entry.spec !== "string") {
				row.action = "skip";
				row.status = "unresolved";
				row.detail = "快照里没有记录安装地址，无法自动恢复";
				rows.push(row);
				continue;
			}
			row.action = "install-git";
			row.detail = entry.spec;
			if (dryRun) {
				row.status = "planned";
				rows.push(row);
				continue;
			}
			if (manager === null || manager === undefined) {
				row.status = "failed";
				row.detail = "pluginManager 不可用";
				rows.push(row);
				continue;
			}
			try {
				// `link:` entries in node_modules make the replacement install fail
				// with EPERM on Windows (pnpm cannot rename over an existing target),
				// so drop that link first. A no-op when there is nothing to unlink.
				step(index, "prepare", "preparing");
				const unlinked = await unlinkNodeModulesEntry(profileDir, entry.name);
				step(index, "install", "installing");
				const result = await manager.installBundle(entry.spec, { saveExact: true });
				const code = result?.error?.code;
				const app = result?.application;
				if (code && BENIGN.has(code)) row.status = "already";
				else if (app === "applied") row.status = "installed";
				else if (app === "restart-required") row.status = "installed-restart";
				else if (app === "failed") row.status = "failed";
				else row.status = String(app ?? "unknown");
				if (result?.error) {
					row.detail = `${entry.spec} — ${result.error.code}${result.error.diagnostic ? `: ${result.error.diagnostic}` : ""}`;
				}
				if (unlinked.kind === "removed") row.detail = `${row.detail}（已移除旧的 link 链接）`;
			} catch (error) {
				row.status = "failed";
				row.detail = `${entry.spec} — ${String(error?.message ?? error).slice(0, 200)}`;
			}
			rows.push(row);
			continue;
		}

		// --- local plugin: restored by git identity, never by an old path ---
		if (entry.kind === "path") {
			if (!entry.git?.remote || !entry.git?.commit) {
				row.action = "skip";
				row.status = "unresolved";
				row.detail = "本地插件没有 git remote/commit，无法自动恢复";
				rows.push(row);
				continue;
			}
			row.action = "clone";
			if (dryRun) {
				row.status = "planned";
				row.detail = `${entry.git.remote} @ ${entry.git.short}`;
			} else {
				row.status = "manual";
				row.detail =
					`git clone ${entry.git.remote} <目录> && git -C <目录> checkout ${entry.git.commit}` +
					` && dsh plugin --profile ${profile ?? "desktop"} add <目录>`;
			}
			rows.push(row);
			continue;
		}

		// --- registry plugin: exact version through the official manager ---
		const spec = entry.version ? `${entry.name}@${entry.version}` : entry.name;
		row.action = "install";
		row.detail = spec;
		if (dryRun) {
			row.status = "planned";
			rows.push(row);
			continue;
		}
		if (manager === null || manager === undefined) {
			row.status = "failed";
			row.detail = "pluginManager 不可用";
			rows.push(row);
			continue;
		}
		try {
			step(index, "install", "installing");
			const result = await manager.installBundle(spec);
			const code = result?.error?.code;
			const app = result?.application;
			if (code && BENIGN.has(code)) row.status = "already";
			else if (app === "applied") row.status = "installed";
			else if (app === "restart-required") row.status = "installed-restart";
			else if (app === "failed") row.status = "failed";
			else row.status = String(app ?? "unknown");
			if (result?.error) {
				row.detail = `${spec} — ${result.error.code}${result.error.diagnostic ? `: ${result.error.diagnostic}` : ""}`;
			}
		} catch (error) {
			row.status = "failed";
			row.detail = `${spec} — ${String(error?.message ?? error).slice(0, 200)}`;
		}
		rows.push(row);
	}

	// Bundle order and enablement are reported, not written: replacing the
	// bundle list while the Host is running is the one change that can make the
	// next boot fail entirely. The report gives the exact target state.
	rows.push({
		action: "bundle-order",
		status: dryRun ? "planned" : "manual",
		detail: `期望顺序: ${targetBundles.join(" → ")}`,
	});

	for (const disabled of snapshot.disabledRows ?? []) {
		rows.push({
			action: "disable",
			name: disabled,
			status: dryRun ? "planned" : "manual",
			detail: "需要在 cordis.patch.yml 中停用该行（可让 agent 按报告执行）",
		});
	}

	// Report local plugins that would collide with a directory already present.
	for (const row of rows) {
		if (row.status === "manual" && row.action === "clone") {
			const entry = (snapshot.plugins ?? []).find((p) => p.name === row.name);
			if (entry?.path && existsSync(entry.path)) {
				row.detail += "（该路径已存在，确认是否复用）";
			}
		}
	}

	return rows;
}

/** Human summary of a restore report. */
export function summarizeReport(rows) {
	const count = (s) => rows.filter((r) => r.status === s).length;
	return {
		total: rows.length,
		installed: count("installed") + count("already"),
		planned: count("planned"),
		manual: count("manual"),
		failed: count("failed"),
		unresolved: count("unresolved"),
	};
}
