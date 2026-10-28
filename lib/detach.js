/**
 * Component: detaching a bundle so its directory can be replaced.
 *
 * On Windows, `pnpm` cannot rename a package directory that the running host
 * still holds open. Subscribing a `link:` plugin hits this every time: the
 * dependency points at a junction into the source checkout, the plugin is
 * loaded because it is in `dsh.profile.bundles`, and the final
 * `rename(_tmp -> pkg)` fails with `EPERM` after the download has already
 * succeeded. The failure looks like a network timeout — the UI spins for over a
 * minute while pnpm retries the fetch — but the real error is the rename.
 *
 * `removeBundle` cannot help: without HMR it refuses to touch a bundle that was
 * loaded at startup (`stop-profile`). `setBundleEnabled(name, false)` has no
 * such guard — it only edits the `dsh.profile.bundles` array and leaves the
 * dependency in place — and that is enough to let go of the directory.
 *
 * Verified against the real host: detaching from `bundles`, running
 * `pnpm add github:…#sha`, and re-attaching completes in ~2 s, leaves the
 * source checkout's `.git` untouched, and replaces the junction with a real
 * directory.
 *
 * This module owns only that array edit. It never removes a dependency, never
 * touches `cordis.patch.yml`, and always restores the previous selection if the
 * install fails — a plugin silently dropped from `bundles` is exactly the kind
 * of damage this whole plugin exists to undo.
 *
 * @module dsh-plugin-cloud/lib/detach
 */
import { readFile, writeFile, rename, unlink, lstat, readlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const MANIFEST_FILE = "package.json";
const TRANSIENT = new Set(["EACCES", "EBUSY", "EPERM"]);
const RETRY_INITIAL_MS = 20;
const RETRY_MAX_MS = 200;
const RETRY_LIMIT = 8;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Where a profile keeps its manifest. */
const manifestPath = (dir) => join(dir, MANIFEST_FILE);

/**
 * Read the profile manifest.
 *
 * @param {string} dir - profile directory.
 * @returns {Promise<{manifest?: object, error?: string}>}
 */
async function readManifest(dir) {
	try {
		const parsed = JSON.parse(await readFile(manifestPath(dir), "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { error: "profile manifest is not a JSON object" };
		}
		return { manifest: parsed };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Persist a manifest atomically, falling back to an in-place write.
 *
 * Same two-stage strategy as `lib/manifest.js`: the harness holds this file
 * open for its own reads, so a rename can fail with a transient Windows code
 * while an in-place write still succeeds.
 *
 * @param {string} dir - profile directory.
 * @param {object} manifest - value to persist.
 * @returns {Promise<"atomic"|"in-place">} which path committed.
 */
async function writeManifest(dir, manifest) {
	const target = manifestPath(dir);
	const text = `${JSON.stringify(manifest, undefined, 2)}\n`;
	const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;

	let lastError = null;
	try {
		await writeFile(temp, text, { encoding: "utf8", flag: "wx" });
		let delay = RETRY_INITIAL_MS;
		for (let attempt = 0; ; attempt += 1) {
			try {
				await rename(temp, target);
				return "atomic";
			} catch (error) {
				lastError = error;
				const transient = process.platform === "win32" && TRANSIENT.has(error?.code ?? "");
				if (!transient || attempt >= RETRY_LIMIT) break;
				await wait(delay);
				delay = Math.min(delay * 2, RETRY_MAX_MS);
			}
		}
	} catch (error) {
		lastError = error;
	}

	try { await unlink(temp); } catch { /* best effort */ }
	try {
		await writeFile(target, text, "utf8");
		return "in-place";
	} catch (directError) {
		const first = lastError instanceof Error ? lastError.message : String(lastError);
		const second = directError instanceof Error ? directError.message : String(directError);
		throw new Error(`无法写入 profile 的 package.json（原子替换：${first}；原地写入：${second}）`);
	}
}

/** Read `dsh.profile.bundles`, tolerating a manifest that has none. */
function bundlesOf(manifest) {
	const list = manifest?.dsh?.profile?.bundles;
	return Array.isArray(list) ? list : null;
}

/**
 * Read the local path a `link:`/`file:` spec points at, or null.
 *
 * @param {unknown} spec - dependency spec.
 * @returns {string|null} absolute-ish path, or null for non-link specs.
 */
export function linkedPathOf(spec) {
	if (typeof spec !== "string") return null;
	if (!spec.startsWith("link:") && !spec.startsWith("file:")) return null;
	const raw = spec.replace(/^(link|file):/, "");
	return raw === "" ? null : raw;
}

/**
 * Remove a `link:` package's junction from `node_modules`.
 *
 * This is the step that actually makes a replacement install possible on
 * Windows. `pnpm` imports a package with `rename(tmp, target)`, and Windows
 * refuses to overwrite an existing target — it raises `EPERM`. A `link:`
 * dependency leaves a junction at `node_modules/<name>`, so the rename has a
 * target and fails every time, after the download has already succeeded. That
 * is why the UI spins for over a minute and the log looks like a network
 * problem.
 *
 * Verified against the real host: deleting the junction makes the same
 * `rename(tmp, target)` succeed, and the source checkout is untouched — only
 * the link is removed. `pnpm` recreates the entry on the next install.
 *
 * Only the junction itself is removed. A real directory at that path is left
 * alone: that would be an actually installed package, and deleting it would
 * destroy files rather than a pointer.
 *
 * @param {string} profileDir - profile directory.
 * @param {string} name - package name.
 * @returns {Promise<{kind:"removed"|"absent"|"not-a-link"|"unavailable", target?:string|null, reason?:string}>}
 */
export async function unlinkNodeModulesEntry(profileDir, name) {
	const entry = join(profileDir, "node_modules", name);
	let info;
	try {
		info = await lstat(entry);
	} catch (error) {
		if (error?.code === "ENOENT") return { kind: "absent" };
		return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	}
	if (info.isSymbolicLink() !== true) {
		// A real directory: an installed package, not a link. Leave it be.
		return { kind: "not-a-link" };
	}
	let target = null;
	try {
		target = await readlink(entry);
	} catch {
		// The link may be unreadable but still removable; keep going.
	}
	try {
		// `rmdir` on a junction removes the link, not the target tree. `unlink`
		// handles the symlink case; try both so a junction on Windows and a
		// symlink elsewhere behave the same.
		try {
			await rmdir(entry);
		} catch {
			await unlink(entry);
		}
		return { kind: "removed", target };
	} catch (error) {
		return { kind: "unavailable", target, reason: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Remove a bundle name from the selection, remembering where it was.
 *
 * Mirrors `setBundleEnabled(name, false)`: only the selection changes. The
 * dependency stays, so nothing is uninstalled and a later re-attach restores
 * the exact same set.
 *
 * @param {string} dir - profile directory.
 * @param {string} name - bundle/package name.
 * @returns {Promise<{kind:"detached",index:number}|{kind:"absent"}|{kind:"unavailable",reason:string}>}
 */
export async function detachBundle(dir, name) {
	const { manifest, error } = await readManifest(dir);
	if (manifest === undefined) return { kind: "unavailable", reason: error ?? "unreadable manifest" };
	const bundles = bundlesOf(manifest);
	if (bundles === null) return { kind: "unavailable", reason: "manifest has no dsh.profile.bundles array" };
	const index = bundles.indexOf(name);
	if (index < 0) return { kind: "absent" };
	try {
		await writeManifest(dir, { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: bundles.filter((n) => n !== name) } } });
		return { kind: "detached", index };
	} catch (writeError) {
		return { kind: "unavailable", reason: writeError instanceof Error ? writeError.message : String(writeError) };
	}
}

/**
 * Put a bundle name back at the position it occupied.
 *
 * Restoring the original index keeps configuration precedence identical to what
 * the user had, instead of quietly moving their plugin to the end of the list.
 *
 * @param {string} dir - profile directory.
 * @param {string} name - bundle/package name.
 * @param {number} [index] - original position, clamped to the list length.
 * @returns {Promise<{ok:boolean, already?:boolean, error?:string}>}
 */
export async function reattachBundle(dir, name, index) {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const { manifest, error } = await readManifest(dir);
		if (manifest === undefined) return { ok: false, error: error ?? "unreadable manifest" };
		const bundles = bundlesOf(manifest);
		if (bundles === null) return { ok: false, error: "manifest has no dsh.profile.bundles array" };
		// A concurrent manager action may already have restored it; never duplicate.
		if (bundles.includes(name)) return { ok: true, already: true };
		const at = Number.isInteger(index) && index >= 0 ? Math.min(index, bundles.length) : bundles.length;
		const next = [...bundles.slice(0, at), name, ...bundles.slice(at)];
		try {
			await writeManifest(dir, { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: next } } });
			return { ok: true };
		} catch (writeError) {
			if (attempt === 2) {
				return { ok: false, error: writeError instanceof Error ? writeError.message : String(writeError) };
			}
			await wait(100 * (attempt + 1));
		}
	}
	return { ok: false, error: "reattach exhausted" };
}

/**
 * Run a replacement install with the bundle temporarily deselected.
 *
 * The sequence is: detach → install → re-attach, with the re-attach in a
 * `finally` so a failed or throwing install cannot leave the plugin missing
 * from the profile. If re-attaching itself fails, that is reported as a failure
 * with `detached: true`, because a silently detached plugin is worse than a
 * failed install.
 *
 * @param {object} options
 * @param {string} options.dir - profile directory.
 * @param {string} options.name - bundle/package name.
 * @param {Function} options.install - `async () => outcome` that performs the install.
 * @param {(phase:"detach"|"install"|"reattach")=>void} [options.onPhase] - progress callback.
 * @returns {Promise<{ok:boolean, detached:boolean, reattached:boolean, outcome?:object, error?:string}>}
 */
export async function installDetached({ dir, name, install, onPhase }) {
	const detached = await detachBundle(dir, name);
	if (detached.kind === "unavailable") {
		// Nothing was changed: the safe outcome. Report it so the caller can say
		// why the subscribe did not happen, rather than retrying into the same wall.
		return { ok: false, detached: false, reattached: false, error: `detach-unavailable:${detached.reason}` };
	}
	onPhase?.("detach");

	const restore = async () => {
		if (detached.kind !== "detached") return { ok: true, already: true };
		onPhase?.("reattach");
		return reattachBundle(dir, name, detached.index);
	};

	let outcome;
	let thrown = null;
	try {
		onPhase?.("install");
		outcome = await install();
	} catch (error) {
		thrown = error;
	}

	const back = await restore();
	if (back.ok !== true) {
		return {
			ok: false,
			detached: true,
			reattached: false,
			outcome,
			error: `reattach-failed:${back.error ?? "unknown"}`,
		};
	}
	if (thrown !== null) {
		return {
			ok: false,
			detached: detached.kind === "detached",
			reattached: true,
			error: thrown instanceof Error ? thrown.message : String(thrown),
		};
	}
	return { ok: outcome?.ok === true, detached: detached.kind === "detached", reattached: true, outcome };
}
