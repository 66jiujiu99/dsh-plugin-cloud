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
import { join } from "node:path";
import { homedir } from "node:os";

/** Local mirror root. */
export function storeDir() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "dsh-plugin-cloud");
}

// Manual backups, scheduled backups, and deletes all share this in-process
// queue. Without it, concurrent read-modify-write cycles overwrite each other's
// index entries even though every snapshot file reaches disk.
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

/** Persist one snapshot locally and return its index entry. */
export async function saveLocal(snapshot) {
	return enqueueLocalMutation(async () => {
		const dir = join(storeDir(), "snapshots");
		await mkdir(dir, { recursive: true });
		const file = fileNameOf(snapshot);
		await writeJsonAtomic(join(dir, file), snapshot);
		const index = await readLocalIndex();
		const versions = [
			{ file, label: snapshot.label, note: snapshot.note ?? "", createdAt: snapshot.createdAt, summary: snapshot.summary },
			...index.versions.filter((v) => v.file !== file),
		].slice(0, 100);
		await writeJsonAtomic(join(storeDir(), "index.json"),
			{ schema: "dsh-plugin-cloud-index/1", versions });
		return { file, versions };
	});
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
