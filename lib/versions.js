/**
 * Component: the version checker.
 *
 * Answers one question per installed plugin: "is there a newer published
 * version than the one I have?" — without pnpm, without touching the profile.
 *
 * Three sources, checked in this order:
 *   - registry (`^1.2.3`, `~1.2.3`, `1.2.3`, `latest`) → npm packument dist-tags
 *     and the version list
 *   - git (`github:o/r`, `git+https://…`) → the remote's HEAD commit
 *   - path (`link:…`) → the local checkout's own git remote/branch state
 *
 * Only the registry case can produce a version *upgrade*. The git and path
 * cases produce "a newer commit exists", which is a subscription concern, not
 * an upgrade concern — this module reports the fact and leaves the decision to
 * the caller.
 *
 * @module dsh-plugin-cloud/lib/versions
 */
import { execFile } from "node:child_process";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const GIT_TIMEOUT_MS = 15_000;
/** Concurrent registry reads. npm allows parallel packument GETs; this keeps the burst polite. */
const REGISTRY_CONCURRENCY = 6;

/** Run git, resolving null on any failure rather than throwing. */
function git(cwd, args) {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
			(error, stdout) => resolve(error ? null : String(stdout).trim()));
	});
}

/**
 * Parse a semver string into comparable parts.
 *
 * Pre-release and build metadata are kept because `1.3.0-beta` must sort below
 * `1.3.0`: a pre-release is *not* an upgrade over the release it precedes.
 *
 * @param {string} version - e.g. `1.2.3`, `1.2.3-beta.1`, `v1.2.3`.
 * @returns {{major:number,minor:number,patch:number,pre:string}|null} null when unparseable.
 */
export function parseSemver(version) {
	const m = String(version ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
	if (!m) return null;
	return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? "" };
}

/**
 * Compare two semver strings.
 *
 * @returns {number} negative when a<b, 0 when equal, positive when a>b.
 */
export function compareSemver(a, b) {
	const x = parseSemver(a);
	const y = parseSemver(b);
	if (x === null && y === null) return 0;
	if (x === null) return -1;
	if (y === null) return 1;
	for (const k of ["major", "minor", "patch"]) {
		if (x[k] !== y[k]) return x[k] - y[k];
	}
	// A release outranks any pre-release of the same triple.
	if (x.pre === y.pre) return 0;
	if (x.pre === "") return 1;
	if (y.pre === "") return -1;
	return x.pre < y.pre ? -1 : 1;
}

/**
 * Pick the highest published version that is not a pre-release.
 *
 * @param {string[]} versions - every published version.
 * @returns {string|null} the latest stable version, or null.
 */
export function latestStable(versions) {
	let best = null;
	for (const v of versions) {
		const parsed = parseSemver(v);
		if (parsed === null || parsed.pre !== "") continue;
		if (best === null || compareSemver(v, best) > 0) best = v;
	}
	return best;
}

/**
 * Read one package's packument.
 *
 * @param {string} name - package name.
 * @param {string} [registry] - registry root.
 * @returns {Promise<{latest:string|null, versions:string[], publishedAt:string|null}|null>} null on failure.
 */
export async function fetchPackument(name, registry) {
	const base = String(registry ?? "").trim().replace(/\/+$/, "") || DEFAULT_REGISTRY;
	const url = `${base}/${encodeURIComponent(name).replace(/^%40/, "@")}`;
	let res;
	try {
		res = await fetch(url, { headers: { accept: "application/json" } });
	} catch {
		return null;
	}
	if (!res.ok) return null;
	let json;
	try {
		json = await res.json();
	} catch {
		return null;
	}
	const versions = Object.keys(json?.versions ?? {});
	const tagged = json?.["dist-tags"]?.latest ?? null;
	// Prefer the registry's own `latest` tag; fall back to the highest stable
	// version so a package that only ever used `next` still reports something.
	const latest = tagged !== null && parseSemver(tagged) !== null ? tagged : latestStable(versions);
	return {
		latest,
		versions,
		publishedAt: latest !== null ? json?.time?.[latest] ?? null : null,
	};
}

/**
 * Read a package's packument through a bounded worker pool.
 *
 * @param {string[]} names - package names.
 * @param {string} [registry] - registry root.
 * @returns {Promise<Map<string, object|null>>} name → packument (or null).
 */
export async function fetchPackuments(names, registry) {
	const out = new Map();
	const queue = [...new Set(names)];
	const worker = async () => {
		for (;;) {
			const name = queue.shift();
			if (name === undefined) return;
			out.set(name, await fetchPackument(name, registry));
		}
	};
	await Promise.all(Array.from({ length: Math.min(REGISTRY_CONCURRENCY, queue.length) }, worker));
	return out;
}

/**
 * Decide whether an installed version can be upgraded to a published one.
 *
 * A caret/tilde/range spec is satisfied only up to its own bound, but "there is
 * a newer version published" is a plain version comparison — the user asked to
 * know about updates, not to respect the range the installer wrote.
 *
 * How many releases are skipped is a separate question; see {@link countBehind}.
 *
 * @param {string|null} installed - the version on disk.
 * @param {string|null} latest - the newest published version.
 * @returns {boolean} true when `latest` is newer than `installed`.
 */
export function updateStatus(installed, latest) {
	if (installed === null || installed === undefined || latest === null || latest === undefined) {
		return false;
	}
	return compareSemver(latest, installed) > 0;
}

/**
 * Count how many published stable versions sit between `installed` and `latest`.
 *
 * @param {string} installed - version on disk.
 * @param {string[]} versions - published versions.
 * @param {string|null} latest - newest published version.
 * @returns {number} number of newer stable releases.
 */
export function countBehind(installed, versions, latest) {
	if (latest === null || latest === undefined) return 0;
	return versions.filter((v) => {
		const parsed = parseSemver(v);
		if (parsed === null || parsed.pre !== "") return false;
		return compareSemver(v, installed) > 0 && compareSemver(v, latest) <= 0;
	}).length;
}

/**
 * Read a git working copy's divergence from its upstream.
 *
 * `rev-list --left-right --count HEAD...@{upstream}` yields "<ahead>\t<behind>".
 * No upstream means the checkout cannot tell us about remote progress, so the
 * result is `null` rather than "up to date" — the two are not the same claim.
 *
 * @param {string} dir - working copy.
 * @returns {Promise<{commit:string|null,ahead:number,behind:number,branch:string|null,remote:string|null}|null>}
 */
export async function gitDivergence(dir) {
	if (!dir) return null;
	const [commit, branch, remote, upstream, counts] = await Promise.all([
		git(dir, ["rev-parse", "HEAD"]),
		git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
		git(dir, ["remote", "get-url", "origin"]),
		git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
		git(dir, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
	]);
	if (commit === null) return null;
	let ahead = 0;
	let behind = 0;
	if (counts !== null) {
		const [a, b] = counts.split(/\s+/).map(Number);
		ahead = Number.isFinite(a) ? a : 0;
		behind = Number.isFinite(b) ? b : 0;
	}
	return { commit, branch: branch ?? null, remote: remote ?? null, upstream: upstream ?? null, ahead, behind };
}

/**
 * Resolve a remote ref to a commit without cloning.
 *
 * `git ls-remote` is the only git command that answers "what is on the server?"
 * with no working copy, which is exactly the question a `github:owner/repo#sha`
 * dependency raises: the profile pins a commit, and the only update it can have
 * is "the branch has moved on past that commit".
 *
 * @param {string} slug - `owner/repo`.
 * @param {string} [ref] - branch or ref name; defaults to `HEAD`.
 * @returns {Promise<string|null>} full sha, or null when it cannot be read.
 */
export async function remoteCommit(slug, ref = "HEAD") {
	if (typeof slug !== "string" || slug === "") return null;
	const url = `https://github.com/${slug}.git`;
	const out = await git(process.cwd(), ["ls-remote", url, ref]);
	if (out === null) return null;
	// Output is "<sha>\t<ref>"; take the first line's sha.
	const first = out.split("\n").find((line) => line.trim() !== "");
	if (first === undefined) return null;
	const sha = first.split(/\s+/)[0];
	return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * Check a `github:owner/repo#<sha>` dependency for a newer upstream commit.
 *
 * The pinned sha is compared against the remote branch tip. A dependency that
 * pins an older commit is behind — not "unsupported". Treating it as
 * unsupported made every successfully-subscribed plugin permanently
 * uncheckable, which is the opposite of what subscribing is for.
 *
 * @param {object} plugin - collector row with `spec` and optionally `git`.
 * @param {object} [options]
 * @param {string} [options.branch] - branch to compare against (default `main`).
 * @returns {Promise<object>} update info.
 */
export async function checkGitDependency(plugin, options = {}) {
	const spec = String(plugin?.spec ?? "");
	const slug = plugin?.git?.slug ?? githubSlug(spec) ?? null;
	const pinned = /#([0-9a-f]{7,40})/i.exec(spec)?.[1] ?? null;
	const branch = options.branch ?? plugin?.git?.branch ?? "main";

	const base = {
		source: "git",
		installed: plugin?.version ?? null,
		// `latest` keeps its registry meaning: the published version string. A git
		// dependency has no such thing — its "newest" is a commit — so this stays
		// null and the commit goes in `latestCommit`. Putting a 40-character sha
		// here made the UI render it in the "最新" column under a version number,
		// which is not a version and cannot be compared with one.
		latest: null,
		latestCommit: null,
		publishedAt: null,
		slug,
		pinned,
		branch,
		updateAvailable: false,
		behind: 0,
	};
	if (slug === null) return { ...base, note: "unsupported-spec" };

	const tip = await remoteCommit(slug, branch);
	if (tip === null) {
		// The remote could not be read (offline, private repo without a token).
		// Say so instead of claiming "up to date": an unreadable remote is not
		// evidence of freshness.
		return { ...base, note: "remote-unreachable" };
	}
	base.latestCommit = tip;
	if (pinned === null) {
		// No pinned commit: it tracks the branch, so there is nothing to compare.
		return { ...base, tracking: "branch" };
	}
	const same = tip.toLowerCase().startsWith(pinned.toLowerCase()) || pinned.toLowerCase().startsWith(tip.toLowerCase());
	return {
		...base,
		updateAvailable: !same,
		note: same ? null : "upstream-ahead",
	};
}

/**
 * Check every plugin in a plugin list for available updates.
 *
 * @param {object[]} plugins - rows from the collector (`name`, `kind`, `version`, `spec`, `git`).
 * @param {object} [options]
 * @param {string} [options.registry] - registry root.
 * @returns {Promise<Map<string, object>>} name → update info.
 */
export async function checkUpdates(plugins, options = {}) {
	const registryNames = plugins
		.filter((p) => p.kind === "registry" && typeof p.name === "string")
		.map((p) => p.name);
	const packuments = await fetchPackuments(registryNames, options.registry);

	const out = new Map();
	for (const p of plugins) {
		if (p.kind === "registry") {
			const packument = packuments.get(p.name) ?? null;
			const latest = packument?.latest ?? null;
			const canUpdate = updateStatus(p.version, latest);
			out.set(p.name, {
				source: "registry",
				installed: p.version ?? null,
				latest,
				publishedAt: packument?.publishedAt ?? null,
				updateAvailable: canUpdate,
				behind: canUpdate
					? countBehind(p.version, packument?.versions ?? [], latest)
					: 0,
			});
			continue;
		}
		if (p.kind === "path") {
			const div = await gitDivergence(p.git?.path ?? p.path ?? null);
			out.set(p.name, {
				source: "path",
				installed: p.version ?? null,
				latest: null,
				publishedAt: null,
				// A local checkout is "behind" when its upstream has commits it lacks.
				updateAvailable: div !== null && div.behind > 0,
				behind: div?.behind ?? 0,
				ahead: div?.ahead ?? 0,
				remote: div?.remote ?? p.git?.remote ?? null,
				branch: div?.branch ?? p.git?.branch ?? null,
				upstream: div?.upstream ?? null,
				tracked: div?.upstream !== null && div?.upstream !== undefined,
			});
			continue;
		}
		if (p.kind === "git") {
			out.set(p.name, await checkGitDependency(p, options));
			continue;
		}
		out.set(p.name, {
			source: p.kind ?? "unknown",
			installed: p.version ?? null,
			latest: null,
			updateAvailable: false,
			behind: 0,
			note: "unsupported-spec",
		});
	}
	return out;
}

/**
 * Turn a git URL into an `owner/repo` pair.
 *
 * @param {string|null} url - e.g. `git@github.com:o/r.git`, `https://github.com/o/r.git`.
 * @returns {string|null} `owner/repo`, or null when the URL is not a GitHub repository.
 */
export function githubSlug(url) {
	if (typeof url !== "string") return null;
	const m = url.trim().match(/^(?:git@github\.com:|https?:\/\/github\.com\/|git:\/\/github\.com\/|github:)([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:#.*)?$/);
	return m ? `${m[1]}/${m[2]}` : null;
}
