/**
 * Component: the GitHub store.
 *
 * A private repository holds one directory per snapshot:
 *
 *   snapshots/<ISO timestamp>.json     the snapshot itself
 *   latest.json                        a copy of the newest snapshot
 *   index.json                         the version list the UI reads
 *
 * Every write goes through the Contents API so each snapshot is a real commit:
 * the repository's git history *is* the version history, and a snapshot can be
 * restored by checking out an old commit.
 *
 * The token never reaches the browser: the Host reads it per call from the
 * credential service and keeps it in memory only for the request.
 *
 * @module dsh-plugin-cloud/lib/github
 */
import { Buffer } from "node:buffer";

const API = "https://api.github.com";

/** Subdirectory inside the configured repository. */
const ROOT = "";

/**
 * Resolve the API root. Enterprise Server uses `<host>/api/v3`; omission keeps
 * github.com. Passed in per call rather than imported so the module never
 * reads global state.
 */
function apiRoot(base) {
	const s = String(base ?? "").trim().replace(/\/+$/, "");
	return s && /^https?:\/\/[^/]+/.test(s) ? s : API;
}

/** One request against the GitHub API. */
async function call(token, method, path, body, base) {
	const res = await fetch(`${apiRoot(base)}${path}`, {
		method,
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"x-github-api-version": "2022-11-28",
			"user-agent": "dsh-plugin-cloud",
			...(body ? { "content-type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = null;
	}
	if (!res.ok) {
		const message = json?.message ?? text.slice(0, 200) ?? `HTTP ${res.status}`;
		const error = new Error(`GitHub ${method} ${path} → ${res.status}: ${message}`);
		error.status = res.status;
		throw error;
	}
	return json;
}

/** Decode a Contents API file payload. */
function decodeContent(file) {
	if (!file?.content) return null;
	return Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8").toString("utf8");
}

/** Split `owner/repo` and reject anything else. */
export function parseRepo(repo) {
	const m = String(repo ?? "").trim().match(/^([\w.-]+)\/([\w.-]+)$/);
	if (!m) return null;
	return { owner: m[1], name: m[2] };
}

/** Verify the token and that the repository is reachable and private-friendly. */
export async function verifyRepo(token, repo, base) {
	const parsed = parseRepo(repo);
	if (!parsed) throw new Error("repository must be owner/name");
	const info = await call(token, "GET", `/repos/${parsed.owner}/${parsed.name}`, undefined, base);
	return {
		fullName: info.full_name,
		private: info.private === true,
		defaultBranch: info.default_branch,
		pushedAt: info.pushed_at,
		permissions: info.permissions ?? null,
	};
}

/** Read one file, or null when it does not exist. */
export async function readFile(token, repo, path, base) {
	const parsed = parseRepo(repo);
	try {
		const file = await call(token, "GET", `/repos/${parsed.owner}/${parsed.name}/contents/${ROOT}${path}`, undefined, base);
		if (Array.isArray(file)) return null;
		return { content: decodeContent(file), sha: file.sha, size: file.size };
	} catch (error) {
		if (error.status === 404) return null;
		throw error;
	}
}

/** Create or replace one file with a commit. */
export async function writeFile(token, repo, path, content, message, previousSha, base) {
	const parsed = parseRepo(repo);
	const body = {
		message,
		content: Buffer.from(content, "utf8").toString("base64"),
		...(previousSha ? { sha: previousSha } : {}),
	};
	return call(token, "PUT", `/repos/${parsed.owner}/${parsed.name}/contents/${ROOT}${path}`, body, base);
}

/** List snapshot files, newest first. */
export async function listSnapshots(token, repo, base) {
	const parsed = parseRepo(repo);
	try {
		const entries = await call(token, "GET", `/repos/${parsed.owner}/${parsed.name}/contents/snapshots`, undefined, base);
		if (!Array.isArray(entries)) return [];
		return entries
			.filter((e) => e.type === "file" && e.name.endsWith(".json"))
			.map((e) => ({ file: e.name, path: e.path, sha: e.sha, size: e.size }))
			.sort((a, b) => b.file.localeCompare(a.file));
	} catch (error) {
		if (error.status === 404) return [];
		throw error;
	}
}

/** Read the index document maintained next to the snapshots. */
export async function readIndex(token, repo, base) {
	const file = await readFile(token, repo, "index.json", base);
	if (!file) return { versions: [] };
	try {
		const parsed = JSON.parse(file.content);
		return { versions: Array.isArray(parsed.versions) ? parsed.versions : [], sha: file.sha };
	} catch {
		return { versions: [], sha: file.sha };
	}
}

/**
 * Push one snapshot: the file itself, the `latest.json` pointer, and the
 * version index — three commits so a partial failure leaves a readable state.
 *
 * @returns {Promise<{file: string, repo: string}>}
 */
export async function pushSnapshot(token, repo, snapshot, options = {}) {
	const base = options.apiBase;
	const stamp = snapshot.createdAt.replace(/[:.]/g, "-");
	const file = `snapshots/${stamp}.json`;
	const text = JSON.stringify(snapshot, null, 2);
	const label = snapshot.label || "snapshot";

	await writeFile(token, repo, file, text, `chore: 保存插件快照 ${label} (${snapshot.createdAt})`, undefined, base);

	const latest = await readFile(token, repo, "latest.json", base);
	await writeFile(token, repo, "latest.json", text, `chore: 更新 latest 指针 ${label}`, latest?.sha, base);

	const index = await readIndex(token, repo, base);
	const versions = [
		{ file, label, note: snapshot.note ?? "", createdAt: snapshot.createdAt, summary: snapshot.summary },
		...index.versions.filter((v) => v.file !== file),
	].slice(0, options.keep ?? 50);
	await writeFile(token, repo, "index.json", JSON.stringify({ schema: "dsh-plugin-cloud-index/1", versions }, null, 2),
		`chore: 更新快照索引 (${versions.length} 个版本)`, index.sha, base);

	return { file: file.replace(/^snapshots\//, ""), repo };
}

/** Delete one snapshot file and drop it from the index. */
export async function deleteSnapshot(token, repo, file, base) {
	const existing = await readFile(token, repo, `snapshots/${file}`, base);
	if (!existing) return { deleted: false };
	const parsed = parseRepo(repo);
	await call(token, "DELETE", `/repos/${parsed.owner}/${parsed.name}/contents/snapshots/${file}`, {
		message: `chore: 删除插件快照 ${file}`,
		sha: existing.sha,
	}, base);
	const index = await readIndex(token, repo, base);
	const versions = index.versions.filter((v) => !String(v.file).endsWith(file));
	await writeFile(token, repo, "index.json", JSON.stringify({ schema: "dsh-plugin-cloud-index/1", versions }, null, 2),
		`chore: 从索引移除 ${file}`, index.sha, base);
	return { deleted: true };
}
