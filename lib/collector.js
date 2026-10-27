/**
 * Component: the collector.
 *
 * Reads a live profile and turns it into a portable snapshot. This is the only
 * module that knows where profile state lives; everything downstream works on
 * the snapshot shape.
 *
 * What a snapshot must contain, and why:
 *   - exact versions, not `^ranges` — a range re-resolves to whatever is newest
 *   - bundle order — later layers win, so order is behaviour
 *   - disabled rows — enablement is part of the environment
 *   - local plugin git identity — a link: dependency records a path, never code
 *
 * @module dsh-plugin-cloud/lib/collector
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const GIT_TIMEOUT_MS = 15_000;

/**
 * Collapse a package metadata field to a string.
 *
 * `description` is a string but `title` is a locale map; a snapshot is a
 * portable document and must not carry `[object Object]` in any field. This
 * keeps the shape stable no matter which form a package publishes.
 *
 * @param {unknown} value - string, locale map, or array.
 * @returns {string|null} plain text, or null when there is nothing to show.
 */
function plainText(value) {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string') return value === '' ? null : value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		const joined = value.map((item) => plainText(item)).filter(Boolean).join(' · ');
		return joined === '' ? null : joined;
	}
	if (typeof value === 'object') {
		const pick = value.zh ?? value.en ?? Object.values(value).find((v) => typeof v === 'string');
		return typeof pick === 'string' && pick !== '' ? pick : null;
	}
	return null;
}

/** Classify a dependency spec so restore can pick the right strategy. */
export function classifySpec(spec) {
	if (typeof spec !== "string") return "unknown";
	const v = spec.trim();
	if (v.startsWith("link:") || v.startsWith("file:")) return "path";
	if (/^(git|git\+|github:)/.test(v) || /^https?:\/\/[^/]*\.git/.test(v)) return "git";
	if (/\.(tgz|tar\.tar\.gz)$/.test(v)) return "tarball";
	return "registry";
}

/** Run git, resolving null on any failure rather than throwing. */
function git(cwd, args) {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
			(error, stdout) => resolve(error ? null : String(stdout).trim()));
	});
}

/** Turn a link:/file: spec into a filesystem path. */
export function localPathOf(spec) {
	const raw = String(spec).replace(/^(link|file):/, "");
	return /^\/[A-Za-z]:/.test(raw) ? raw.slice(1) : raw;
}

/** Parse the user patch layer for disabled row ids. */
function parseDisabled(patchRaw) {
	const out = [];
	if (!patchRaw) return out;
	// The profile patch is a flat YAML list; each block starts at `- `.
	for (const block of patchRaw.split(/^-\s+/m).slice(1)) {
		const id = block.match(/^id:\s*(\S+)/m);
		const disabled = block.match(/^disabled:\s*(true|false)/m);
		if (id && disabled && disabled[1] === "true") out.push(id[1]);
	}
	return out;
}

/** Read one local plugin's git identity. */
async function gitIdentity(name, spec) {
	const dir = localPathOf(spec);
	const entry = { path: dir, git: null };
	if (!existsSync(join(dir, ".git"))) return entry;
	const [commit, remote, branch, status] = await Promise.all([
		git(dir, ["rev-parse", "HEAD"]),
		git(dir, ["remote", "get-url", "origin"]),
		git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
		git(dir, ["status", "--porcelain"]),
	]);
	if (commit === null) return entry;
	entry.git = {
		commit,
		short: commit.slice(0, 12),
		remote: remote ?? null,
		branch: branch ?? null,
		dirty: status !== null ? status.length > 0 : null,
	};
	return entry;
}

/**
 * Build a snapshot of the given profile.
 *
 * @param {object} options
 * @param {object|null} options.manager - pluginManager, for installed versions.
 * @param {string} options.profileDir - absolute profile directory.
 * @param {string|null} options.profile - profile name.
 * @param {string} options.label - snapshot label.
 * @param {string} options.note - free-form note.
 * @returns {Promise<object>} snapshot document.
 */
export async function collect({ manager, profileDir, profile, label, note }) {
	const pkg = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
	const deps = pkg.dependencies ?? {};
	const bundleOrder = pkg.dsh?.profile?.bundles ?? [];

	let patchRaw = null;
	try {
		patchRaw = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
	} catch {
		/* a profile may legitimately have no user patch layer */
	}
	const disabledRows = parseDisabled(patchRaw);

	// The manager knows the real installed version and activation state; a
	// pack built from package.json alone can only see the requested range.
	let bundles = [];
	try {
		bundles = (await manager?.listBundles?.()) ?? [];
	} catch {
		bundles = [];
	}
	const byName = new Map(bundles.map((b) => [b.name, b]));

	const plugins = [];
	for (const [name, spec] of Object.entries(deps)) {
		const kind = classifySpec(spec);
		const info = byName.get(name);
		const row = {
			name,
			spec,
			kind,
			version: info?.version ?? null,
			enabled: info ? info.enabled === true : !disabledRows.includes(name),
			installed: info ? info.installed === true : true,
			official: info?.official === true,
			description: plainText(info?.description),
			// Management metadata, so the UI can group and label rows without
			// asking the manager again for every render. `meta.title` is a locale
			// map ({zh, en}); a snapshot must stay a portable document of plain
			// values, so it is split into two fields rather than stored as-is.
			availability: info?.availability ?? null,
			readOnlyReason: info?.readOnlyReason ?? null,
			titleZh: plainText(info?.meta?.title?.zh ?? info?.title?.zh ?? info?.title) || null,
			titleEn: plainText(info?.meta?.title?.en ?? info?.title?.en ?? info?.title) || null,
			subscribed: info?.subscribed ?? null,
		};
		if (kind === "path") Object.assign(row, await gitIdentity(name, spec));
		plugins.push(row);
	}

	return {
		schema: "dsh-plugin-cloud/1",
		label: String(label ?? "").slice(0, 120) || "snapshot",
		note: String(note ?? "").slice(0, 500),
		createdAt: new Date().toISOString(),
		source: {
			profile: profile ?? null,
			platform: process.platform,
			arch: process.arch,
			node: process.version,
			dshVersion: process.env.DSH_VERSION ?? null,
		},
		bundleOrder,
		disabledRows,
		plugins,
		summary: {
			total: plugins.length,
			registry: plugins.filter((p) => p.kind === "registry").length,
			local: plugins.filter((p) => p.kind === "path").length,
			withGit: plugins.filter((p) => p.git != null).length,
			disabled: plugins.filter((p) => p.enabled === false).length,
			dirty: plugins.filter((p) => p.git?.dirty === true).length,
		},
	};
}
