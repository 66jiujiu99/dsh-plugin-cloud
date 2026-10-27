/**
 * Component: subscriptions.
 *
 * A plugin installed from a local checkout (`link:C:/…`) has no published
 * version and no upstream to check, so it can never report an update. The fix
 * is to move it onto its git remote: reinstall the same package from the
 * repository URL, so the profile depends on a commit-addressed source that
 * `git` can tell us about forever after.
 *
 * The switch is refused unless the checkout is clean and pushed — otherwise
 * the repository does not contain the code that is running right now, and
 * "subscribing" would silently downgrade the user's working tree.
 *
 * @module dsh-plugin-cloud/lib/subscriptions
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { githubSlug } from "./versions.js";

const GIT_TIMEOUT_MS = 15_000;

/** Run git, resolving null on any failure rather than throwing. */
function git(cwd, args) {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
			(error, stdout) => resolve(error ? null : String(stdout).trim()));
	});
}

/**
 * Inspect a local checkout to decide whether it can be subscribed.
 *
 * Every reason is a separate field so the UI can explain the exact blocker
 * instead of a generic "cannot subscribe".
 *
 * @param {string} dir - the checkout.
 * @returns {Promise<object>} readiness report.
 */
export async function inspectLocal(dir) {
	const report = {
		path: dir ?? null,
		isRepo: false,
		clean: null,
		remote: null,
		slug: null,
		branch: null,
		commit: null,
		short: null,
		upstream: null,
		ahead: 0,
		behind: 0,
		pushed: null,
		subscribable: false,
		blockedBy: [],
	};
	if (typeof dir !== "string" || dir === "" || !existsSync(dir)) {
		report.blockedBy.push("missing-path");
		return report;
	}
	if (!existsSync(join(dir, ".git"))) {
		report.blockedBy.push("not-a-git-repo");
		return report;
	}
	report.isRepo = true;

	const [commit, branch, remote, status, upstream, counts] = await Promise.all([
		git(dir, ["rev-parse", "HEAD"]),
		git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
		git(dir, ["remote", "get-url", "origin"]),
		git(dir, ["status", "--porcelain"]),
		git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
		git(dir, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
	]);
	report.commit = commit;
	report.short = commit === null ? null : commit.slice(0, 12);
	report.branch = branch;
	report.remote = remote;
	report.slug = githubSlug(remote);
	report.upstream = upstream;
	report.clean = status === null ? null : status.length === 0;
	if (counts !== null) {
		const [a, b] = counts.split(/\s+/).map(Number);
		report.ahead = Number.isFinite(a) ? a : 0;
		report.behind = Number.isFinite(b) ? b : 0;
	}
	// `git rev-list --count origin/<branch>..HEAD` answers "is my HEAD on the
	// remote?" even when no upstream is configured, which is the common case
	// for a checkout someone pushed by hand.
	if (commit !== null && branch !== null && remote !== null) {
		const onRemote = await git(dir, ["rev-list", "--count", `origin/${branch}..HEAD`]);
		report.pushed = onRemote === null ? null : Number(onRemote) === 0;
	}

	if (report.slug === null) report.blockedBy.push(remote === null ? "no-remote" : "not-github");
	if (report.clean === false) report.blockedBy.push("dirty");
	if (report.pushed === false) report.blockedBy.push("unpushed");
	if (commit === null) report.blockedBy.push("no-commit");
	report.subscribable = report.blockedBy.length === 0;
	return report;
}

/**
 * Build the install spec that subscribes a checkout to its own remote.
 *
 * The ref is pinned to the commit that is running now, not the branch: a
 * branch spec would resolve to whatever HEAD is at install time and make the
 * "exact version" promise of a snapshot a lie.
 *
 * @param {object} report - result of {@link inspectLocal}.
 * @returns {string|null} e.g. `github:owner/repo#<sha>`, or null when not subscribable.
 */
export function subscribeSpec(report) {
	if (!report?.subscribable || report.slug === null || report.commit === null) return null;
	return `github:${report.slug}#${report.commit}`;
}

/**
 * Read a package's own name from its manifest.
 *
 * @param {string} dir - the checkout.
 * @returns {Promise<string|null>} the declared name, or null.
 */
export async function packageNameOf(dir) {
	try {
		const raw = await readFile(join(dir, "package.json"), "utf8");
		const name = JSON.parse(raw)?.name;
		return typeof name === "string" && name !== "" ? name : null;
	} catch {
		return null;
	}
}

/**
 * Decide what converting one `link:` plugin to a subscription would involve.
 *
 * @param {object} options
 * @param {string} options.name - the dependency name in the profile manifest.
 * @param {string} options.path - the local checkout.
 * @returns {Promise<object>} the plan, with `spec` and `blockedBy`.
 */
export async function planSubscription({ name, path }) {
	const report = await inspectLocal(path);
	const declared = await packageNameOf(path);
	const spec = subscribeSpec(report);
	const blockedBy = [...report.blockedBy];
	// A dependency whose manifest name differs from its key cannot be reinstalled
	// by name — pnpm would create a second entry.
	if (declared !== null && declared !== name) blockedBy.push("name-mismatch");
	return {
		name,
		path: report.path,
		declaredName: declared,
		spec,
		ready: blockedBy.length === 0,
		blockedBy,
		report,
	};
}

/**
 * Explain a blocker code. The UI shows these; keeping them next to the check
 * that produces them is what stops the two drifting apart.
 */
export const BLOCKER_TEXT = {
	"missing-path": "本地目录不存在",
	"not-a-git-repo": "本地目录不是 git 仓库",
	"no-remote": "没有配置 origin 远程",
	"not-github": "远程不是 GitHub 仓库",
	dirty: "有未提交的改动",
	unpushed: "有提交还没推送",
	"no-commit": "仓库里还没有提交",
	"name-mismatch": "目录里的包名与依赖名不一致",
};