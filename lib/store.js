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
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/** Local mirror root. */
export function storeDir() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "dsh-plugin-cloud");
}

/** Safe filename for a snapshot. */
export function fileNameOf(snapshot) {
	const stamp = String(snapshot.createdAt ?? new Date().toISOString()).replace(/[:.]/g, "-");
	return `${stamp}.json`;
}

/** Persist one snapshot locally and return its index entry. */
export async function saveLocal(snapshot) {
	const dir = join(storeDir(), "snapshots");
	await mkdir(dir, { recursive: true });
	const file = fileNameOf(snapshot);
	await writeFile(join(dir, file), JSON.stringify(snapshot, null, 2), "utf8");
	const index = await readLocalIndex();
	const versions = [
		{ file, label: snapshot.label, note: snapshot.note ?? "", createdAt: snapshot.createdAt, summary: snapshot.summary },
		...index.versions.filter((v) => v.file !== file),
	].slice(0, 100);
	await writeFile(join(storeDir(), "index.json"),
		JSON.stringify({ schema: "dsh-plugin-cloud-index/1", versions }, null, 2), "utf8");
	return { file, versions };
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
	const safe = String(file).replace(/[\\/]/g, "").replace(/\.\./g, "");
	const p = join(storeDir(), "snapshots", safe);
	if (!existsSync(p)) return { deleted: false };
	await unlink(p);
	const index = await readLocalIndex();
	const versions = index.versions.filter((v) => v.file !== safe);
	await writeFile(join(storeDir(), "index.json"),
		JSON.stringify({ schema: "dsh-plugin-cloud-index/1", versions }, null, 2), "utf8");
	return { deleted: true };
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
