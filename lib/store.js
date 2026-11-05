/**
 * Component: the version store.
 *
 * Snapshots live in GitHub when a repository is configured, and always in a
 * local mirror under $DSH_HOME/dsh-plugin-cloud/. The local mirror is what
 * makes the feature usable before the cloud is set up, survives a network
 * outage, and lets a restore run without touching the API.
 *
 * @module dsh-plugin-cloud/lib/store
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

/** Local mirror root. */
export function storeDir() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "dsh-plugin-cloud");
}

// Manual backups, scheduled backups, deletes, and retention all share this
// in-process queue. Without it, concurrent read-modify-write cycles overwrite
// each other's index entries even though every snapshot file reaches disk.
let localMutationQueue = Promise.resolve();

function enqueueLocalMutation(operation) {
	const result = localMutationQueue.then(operation);
	// A failed mutation must reject its own caller without blocking later ones.
	localMutationQueue = result.then(() => undefined, () => undefined);
	return result;
}

/** Write JSON through a same-directory temp file and atomically replace target. */
async function writeJsonAtomic(path, value) {
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let renamed = false;
	try {
		await writeFile(temp, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
		await rename(temp, path);
		renamed = true;
	} finally {
		if (!renamed) {
			try {
				await unlink(temp);
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
	}
}

/** Safe filename for a snapshot. */
export function fileNameOf(snapshot) {
	const stamp = String(snapshot.createdAt ?? new Date().toISOString()).replace(/[:.]/g, "-");
	return `${stamp}.json`;
}

function checkedKeep(keep) {
	if (!Number.isInteger(keep) || keep < 1 || keep > 500) {
		throw new RangeError("keep must be an integer between 1 and 500");
	}
	return keep;
}

/** Only a plain .json basename directly inside snapshots is eligible. */
function snapshotFileName(file) {
	if (typeof file !== "string" || file.length <= 5 || file !== basename(file)
		|| file.includes("/") || file.includes("\\") || !file.endsWith(".json")) return null;
	return file;
}

function indexEntry(file, snapshot) {
	return { file, label: snapshot.label, note: snapshot.note ?? "", createdAt: snapshot.createdAt, summary: snapshot.summary };
}

/** Run inside the existing mutation queue; never enqueue from here. */
async function pruneLocalMutation(keep) {
	const dir = join(storeDir(), "snapshots");
	await mkdir(dir, { recursive: true });
	const entries = await readdir(dir, { withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile() && snapshotFileName(entry.name) !== null)
		.map((entry) => entry.name)
		.sort()
		.reverse();
	const retained = files.slice(0, keep);
	const expired = files.slice(keep);
	const versions = [];
	for (const file of retained) {
		try {
			const snapshot = JSON.parse(await readFile(join(dir, file), "utf8"));
			versions.push(indexEntry(file, snapshot));
		} catch {
			versions.push({ file, label: file, note: "", error: "unreadable" });
		}
	}

	// Replace the index before deleting anything. If rename fails, the old index
	// and every old snapshot remain intact; a later retry can safely converge.
	await writeJsonAtomic(join(storeDir(), "index.json"),
		{ schema: "dsh-plugin-cloud-index/1", versions });
	const deleted = [];
	for (const file of expired) {
		const safe = snapshotFileName(file);
		if (safe === null) continue;
		try {
			await unlink(join(dir, safe));
			deleted.push(safe);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
	return { keep, kept: versions.length, deleted, versions };
}

/** Persist one snapshot locally and return its index entry. */
export async function saveLocal(snapshot, { keep } = {}) {
	const validKeep = keep === undefined ? null : checkedKeep(keep);
	return enqueueLocalMutation(async () => {
		const dir = join(storeDir(), "snapshots");
		await mkdir(dir, { recursive: true });
		const file = fileNameOf(snapshot);
		await writeJsonAtomic(join(dir, file), snapshot);
		if (validKeep !== null) {
			const localPrune = await pruneLocalMutation(validKeep);
			return { file, versions: localPrune.versions, localPrune };
		}
		const index = await readLocalIndex();
		const versions = [
			indexEntry(file, snapshot),
			...index.versions.filter((v) => v.file !== file),
		].slice(0, 100);
		await writeJsonAtomic(join(storeDir(), "index.json"),
			{ schema: "dsh-plugin-cloud-index/1", versions });
		return { file, versions };
	});
}

/** Keep the newest real snapshot files, including files absent from the index. */
export async function pruneLocal(keep) {
	const validKeep = checkedKeep(keep);
	return enqueueLocalMutation(() => pruneLocalMutation(validKeep));
}

/** Read the local index. */
export async function readLocalIndex() {
	const p = join(storeDir(), "index.json");
	if (!existsSync(p)) return { versions: [] };
	try {
		const parsed = JSON.parse(await readFile(p, "utf8"));
		return { versions: Array.isArray(parsed.versions) ? parsed.versions : [] };
	} catch {
		return { versions: [] };
	}
}

/** Load one local snapshot by file name. */
export async function loadLocal(file) {
	const safe = String(file).replace(/[\\/]/g, "").replace(/\.\./g, "");
	const p = join(storeDir(), "snapshots", safe);
	if (!existsSync(p)) return null;
	return JSON.parse(await readFile(p, "utf8"));
}

/** Delete one local snapshot. */
export async function deleteLocal(file) {
	return enqueueLocalMutation(async () => {
		const safe = String(file).replace(/[\\/]/g, "").replace(/\.\./g, "");
		const p = join(storeDir(), "snapshots", safe);
		if (!existsSync(p)) return { deleted: false };
		await unlink(p);
		const index = await readLocalIndex();
		const versions = index.versions.filter((v) => v.file !== safe);
		await writeJsonAtomic(join(storeDir(), "index.json"),
			{ schema: "dsh-plugin-cloud-index/1", versions });
		return { deleted: true };
	});
}

/** List every local snapshot file with its parsed summary. */
export async function listLocal() {
	const dir = join(storeDir(), "snapshots");
	if (!existsSync(dir)) return [];
	const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort().reverse();
	const out = [];
	for (const file of files) {
		try {
			const snap = JSON.parse(await readFile(join(dir, file), "utf8"));
			out.push({ file, label: snap.label, note: snap.note ?? "", createdAt: snap.createdAt, summary: snap.summary, storedAt: "local" });
		} catch {
			out.push({ file, label: file, error: "unreadable", storedAt: "local" });
		}
	}
	return out;
}

/**
 * Merge local and remote indexes into one list the UI can render.
 * Remote entries win on duplicate timestamps because the repository is the
 * shared truth; local-only entries stay visible when the cloud is down.
 */
export function mergeIndexes(localVersions, remoteVersions) {
	const byFile = new Map();
	for (const v of localVersions) byFile.set(v.file, { ...v, storedAt: "local" });
	for (const v of remoteVersions) {
		const key = String(v.file).replace(/^snapshots\//, "");
		byFile.set(key, { ...v, file: key, storedAt: "cloud" });
	}
	return [...byFile.values()].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}
