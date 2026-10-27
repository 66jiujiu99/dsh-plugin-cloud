/**
 * Component: the manifest seam.
 *
 * `pluginManager.installBundle` refuses any spec whose package name is already
 * in the profile's `dependencies`, with `already-installed`. That guard reads
 * `package.json`, not the disk, so it fires even when the whole point of the
 * call is to replace that very version — which is exactly what an upgrade is.
 *
 * The way through is to drop just the manifest entry and install again: pnpm
 * overwrites an existing dependency happily, and the manager's own bookkeeping
 * still finds the package because the entry comes back the moment pnpm writes
 * it. The bundle is never *deselected*, so the plugin stays mounted and loading
 * for the whole upgrade instead of vanishing for the length of two pnpm runs.
 *
 * Windows makes that edit harder than it looks, and an end-to-end run proved it:
 * DSH holds the profile manifest open for its own reads, so replacing the file
 * fails intermittently with `EPERM`/`EBUSY`/`EACCES`. A dropped entry that
 * never comes back deletes a plugin from the profile while its files are still
 * on disk — strictly worse than a failed upgrade. So the write is retried with
 * a real async backoff, then falls back to writing in place, and only then
 * reports failure.
 *
 * This module owns that one edit and nothing else. It never reorders bundles,
 * never touches `cordis.patch.yml`, never rewrites a version it was not asked
 * to rewrite: the manager still owns installation, locking, rollback and
 * activation.
 *
 * @module dsh-plugin-cloud/lib/manifest
 */
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Where a profile keeps its manifest. */
const MANIFEST_FILE = "package.json";

/** Windows reports these when another handle is briefly holding the target. */
const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const RETRY_INITIAL_MS = 20;
const RETRY_MAX_MS = 200;
const RETRY_LIMIT = 8;

/** Promise that settles after `ms`, without blocking the event loop. */
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The real filesystem, behind a name.
 *
 * A real handle *does* reproduce the failure this code exists for: Node's
 * `open(path, 'r')` does not take `FILE_SHARE_DELETE`, so holding one makes the
 * atomic `rename` fail with `EPERM` on Windows, exactly as DSH's own reads make
 * it fail in the field. What a real handle cannot reproduce is the *timing* —
 * how many attempts fail, whether the backoff grows, whether the in-place
 * fallback gets reached. Those are the branches that decide whether a plugin
 * disappears from the profile, so they need to be driven deliberately rather
 * than hit by chance. Tests inject a fake `io`/`sleep`/`isTransient` here for
 * that; production callers pass none of them and get the real thing.
 */
const REAL_IO = Object.freeze({ readFile, writeFile, rename, unlink });

/**
 * Whether Windows reported temporary interference with an atomic replacement.
 *
 * @param {unknown} error - the failing write/rename error.
 * @returns {boolean} true when retrying may succeed.
 */
function isTransient(error) {
	if (process.platform !== "win32") return false;
	return TRANSIENT_RENAME_CODES.has(error?.code ?? "");
}

/**
 * The retry policy in force for one call.
 *
 * Outside Windows a rename never reports the transient codes, so the retry
 * branch is dead code there — correct in production, untestable on CI. Tests
 * inject `isTransient` to force the branch; production always uses the platform
 * rule.
 *
 * @param {object} options - caller options.
 * @returns {(error: unknown) => boolean}
 */
const transientOf = (options) => options.isTransient ?? isTransient;

/**
 * Read a profile manifest, or explain why it could not be read.
 *
 * @param {string} dir - profile directory.
 * @param {object} [options] - test seam: `{io}`.
 * @returns {Promise<{manifest?: object, error?: string}>}
 */
async function readManifest(dir, options = {}) {
	const io = options.io ?? REAL_IO;
	try {
		const raw = await io.readFile(join(dir, MANIFEST_FILE), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { error: "profile manifest is not a JSON object" };
		}
		return { manifest: parsed };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Persist a manifest: 2-space JSON with a trailing newline, as the harness writes it.
 *
 * First an atomic replace — random-suffix sibling written with `wx`, then
 * renamed over the target, retried over a bounded backoff for the transient
 * Windows codes. If that still cannot commit, fall back to writing the target
 * in place: an older `package.json` on disk is recoverable, a manifest missing
 * a dependency is not, and the in-place path frequently succeeds exactly where
 * the rename is blocked (a reader holds the file, but the entry itself is not
 * being replaced). On total failure the temp file is removed so no orphan is
 * left behind.
 *
 * @param {string} dir - profile directory.
 * @param {object} manifest - value to persist.
 * @param {object} [options] - test seam: `{io, sleep}`.
 * @returns {Promise<{via:"atomic"|"in-place"}>} which path committed.
 * @throws {Error} when neither path could write the file.
 */
async function writeManifest(dir, manifest, options = {}) {
	const io = options.io ?? REAL_IO;
	const sleep = options.sleep ?? wait;
	const transient = transientOf(options);
	const target = join(dir, MANIFEST_FILE);
	const text = `${JSON.stringify(manifest, undefined, 2)}\n`;
	const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;

	let lastError = null;
	try {
		await io.writeFile(temp, text, { encoding: "utf8", flag: "wx" });
		let delay = RETRY_INITIAL_MS;
		for (let attempt = 0; ; attempt += 1) {
			try {
				await io.rename(temp, target);
				return { via: "atomic" };
			} catch (error) {
				lastError = error;
				if (!transient(error) || attempt >= RETRY_LIMIT) break;
				await sleep(delay);
				delay = Math.min(delay * 2, RETRY_MAX_MS);
			}
		}
	} catch (error) {
		lastError = error;
	}

	// The atomic path is spent. Drop the sibling, then try to commit in place.
	try { await io.unlink(temp); } catch { /* best effort */ }
	const renameFailure = lastError instanceof Error ? lastError.message : String(lastError);
	try {
		await io.writeFile(target, text, "utf8");
		return { via: "in-place" };
	} catch (directError) {
		const direct = directError instanceof Error ? directError.message : String(directError);
		throw new Error(`无法写入 profile 的 package.json（原子替换：${renameFailure}；原地写入：${direct}）`);
	}
}

/**
 * Remove one dependency entry, leaving everything else untouched.
 *
 * @param {string} dir - profile directory.
 * @param {string} name - dependency key to drop.
 * @param {object} [options] - test seam, forwarded to {@link writeManifest}: `{io, sleep, isTransient}`.
 * @returns {Promise<{kind:"dropped",spec:string,via:string}|{kind:"absent"}|{kind:"unavailable",reason:string}>}
 *   `dropped` carries the spec that was removed so the caller can restore it.
 */
export async function dropDependency(dir, name, options = {}) {
	const { manifest, error } = await readManifest(dir, options);
	if (manifest === undefined) return { kind: "unavailable", reason: error ?? "unreadable manifest" };
	const deps = manifest.dependencies;
	if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
		return { kind: "unavailable", reason: "manifest has no dependencies object" };
	}
	if (!Object.hasOwn(deps, name)) return { kind: "absent" };
	const spec = deps[name];
	delete deps[name];
	try {
		const written = await writeManifest(dir, manifest, options);
		return { kind: "dropped", spec, via: written.via };
	} catch (writeError) {
		return { kind: "unavailable", reason: writeError instanceof Error ? writeError.message : String(writeError) };
	}
}

/**
 * Put a dropped entry back.
 *
 * Used when a replacement install failed: the manifest must not be left without
 * a dependency the profile still has on disk, because the next read would
 * consider the package gone. This is the single most important write in the
 * plugin, so it gets its own retry budget on top of {@link writeManifest}.
 *
 * @param {string} dir - profile directory.
 * @param {string} name - dependency key.
 * @param {string} spec - the exact spec that was dropped.
 * @param {object} [options] - test seam, forwarded to {@link writeManifest}.
 * @returns {Promise<{ok:boolean, via?:string, already?:boolean, error?:string}>}
 */
export async function restoreDependency(dir, name, spec, options = {}) {
	const sleep = options.sleep ?? wait;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const { manifest, error } = await readManifest(dir, options);
		if (manifest === undefined) return { ok: false, error: error ?? "unreadable manifest" };
		if (manifest.dependencies === null || typeof manifest.dependencies !== "object") {
			return { ok: false, error: "manifest has no dependencies object" };
		}
		// A successful install already wrote a (newer) entry; never clobber it.
		if (Object.hasOwn(manifest.dependencies, name)) return { ok: true, already: true };
		manifest.dependencies[name] = spec;
		try {
			const written = await writeManifest(dir, manifest, options);
			return { ok: true, via: written.via };
		} catch (writeError) {
			if (attempt === 2) {
				return { ok: false, error: writeError instanceof Error ? writeError.message : String(writeError) };
			}
			await sleep(100 * (attempt + 1));
		}
	}
	return { ok: false, error: "restore exhausted" };
}

/**
 * Install a replacement for a package that is already in the manifest.
 *
 * One sequence, used by both upgrade and subscribe so the two cannot drift:
 * drop the entry, install the new spec exactly, and restore the entry if the
 * install did not land. A manager that does not enforce the guard (no HMR in
 * the composition) simply succeeds on the first attempt; the drop path only
 * runs on `already-installed`.
 *
 * `installBundle` never rejects for a refusal — it folds the failure into
 * `result.error.code` and only throws for a lock or disposal fault — so success
 * has to be read from the result. Treating a folded failure as success would
 * tell the user an upgrade happened when pnpm refused it.
 *
 * @param {object} options
 * @param {object} options.manager - pluginManager service.
 * @param {string} options.dir - profile directory.
 * @param {string} options.name - dependency key.
 * @param {string} options.spec - install spec, e.g. `pkg@1.2.3`.
 * @param {object} options.installOptions - forwarded to installBundle (saveExact).
 * @param {object} [options.io] - test seam, forwarded to the manifest writers.
 * @param {object} [options.sleep] - test seam, forwarded to the manifest writers.
 * @param {object} [options.isTransient] - test seam, forwarded to the manifest writers.
 * @returns {Promise<object>} `{ok, via, application?, errorCode?, error?, restored?, previousSpec?}`
 */
export async function replaceDependency({ manager, dir, name, spec, installOptions = {}, ...seam }) {
	let result;
	let thrown;
	try {
		result = await manager.installBundle(spec, installOptions);
	} catch (error) {
		thrown = error;
	}

	/** Read a manager failure code off a result or a throw. */
	const codeOf = (value) => {
		if (value === null || typeof value !== "object") return undefined;
		if (typeof value.code === "string") return value.code;
		if (value.error?.code !== undefined) return String(value.error.code);
		return undefined;
	};
	/** Any failure folded into a result, code or not. */
	const foldedFailure = (value) => {
		const code = codeOf(value);
		if (code !== undefined) return code;
		if (value?.application === "failed") return "operation-error";
		return undefined;
	};

	const code = codeOf(result) ?? codeOf(thrown);

	// Only the "already in the manifest" refusal is recoverable here. Anything
	// else (network, invalid spec, build approval) is the caller's to report.
	if (code !== "already-installed") {
		if (thrown !== undefined) {
			return {
				ok: false,
				via: "direct",
				errorCode: codeOf(thrown) ?? "operation-error",
				error: thrown instanceof Error ? thrown.message : String(thrown),
			};
		}
		const folded = foldedFailure(result);
		if (folded !== undefined) return { ok: false, via: "direct", errorCode: folded, error: folded, result };
		return { ok: true, via: "direct", result, application: result?.application ?? null };
	}

	const dropped = await dropDependency(dir, name, seam);
	if (dropped.kind === "unavailable") {
		// Nothing was edited, nothing was installed: the original version stays
		// exactly as it was, which is the safe state.
		return { ok: false, via: "direct", errorCode: "manifest-unavailable", error: dropped.reason, result };
	}
	if (dropped.kind === "absent") {
		// The guard fired but there is no entry: nothing we can safely undo.
		return { ok: false, via: "direct", errorCode: code ?? "already-installed", error: code ?? "already-installed", result };
	}

	let replaced;
	let replaceThrown;
	try {
		replaced = await manager.installBundle(spec, installOptions);
	} catch (error) {
		replaceThrown = error;
	}

	const landed = replaceThrown === undefined && foldedFailure(replaced) === undefined;
	if (!landed) {
		// Put the entry back before returning: a manifest missing a dependency the
		// disk still has would drop the plugin from the profile on the next launch.
		const back = await restoreDependency(dir, name, dropped.spec, seam);
		return {
			ok: false,
			via: "replaced",
			errorCode: foldedFailure(replaced) ?? codeOf(replaceThrown) ?? "operation-error",
			error: replaceThrown instanceof Error
				? replaceThrown.message
				: String(foldedFailure(replaced) ?? "install failed"),
			restored: back.ok === true,
			restoreError: back.error ?? null,
			previousSpec: dropped.spec,
		};
	}
	return {
		ok: true,
		via: "replaced",
		result: replaced,
		application: replaced?.application ?? null,
		previousSpec: dropped.spec,
	};
}