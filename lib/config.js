/**
 * Component: configuration.
 *
 * Settings live in `$DSH_HOME/dsh-plugin-cloud/config.json`, not in the
 * profile patch. Three reasons:
 *
 *   1. The official Loader validates a declared `Config` through a Standard
 *      Schema (`Config['~standard'].validate`). A profile-installed plugin
 *      cannot import that builder, so declaring a schema would break mounting.
 *   2. `settings.mutate` only accepts entries that declare a schema, so the
 *      patch route cannot write these fields either.
 *   3. A file is re-read per operation, so saving a setting takes effect
 *      immediately; a patch-layer change needs a recomposition.
 *
 * The GitHub token is NOT stored here. It goes to the Host credential service
 * under `tokenRef`, so it never lands in this file, a snapshot, or a log.
 *
 * @module dsh-plugin-cloud/lib/config
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULTS = {
	repo: "",
	tokenRef: "GITHUB_TOKEN",
	autoBackup: true,
	intervalHours: 6,
	maxSnapshots: 50,
	autoPushOnChange: true,
	// GitHub Enterprise Server uses `<host>/api/v3`. Keeping this configurable
	// also lets the cloud path be exercised against a stand-in server.
	apiBase: "https://api.github.com",
	// npm registry for the version check. A private mirror is a real deployment;
	// "" keeps the public registry, which is what a bare DSH install uses.
	registry: "",
};

/** Editable keys, with the coercion each one needs. */
export const FIELDS = {
	repo: (v) => (v === undefined || v === null ? "" : String(v).trim()),
	tokenRef: (v) => String(v ?? "").trim() || DEFAULTS.tokenRef,
	autoBackup: (v) => v === true,
	apiBase: (v) => {
		const s = String(v ?? "").trim().replace(/\/+$/, "");
		if (!s) return DEFAULTS.apiBase;
		// A repository store must not be pointed at an arbitrary host by a
		// mistyped value; require an absolute http(s) origin.
		if (!/^https?:\/\/[^/]+/.test(s)) return DEFAULTS.apiBase;
		return s;
	},
	intervalHours: (v) => {
		const n = Number(v);
		return Number.isFinite(n) ? Math.max(0, Math.min(168, n)) : DEFAULTS.intervalHours;
	},
	maxSnapshots: (v) => {
		const n = Math.round(Number(v));
		return Number.isFinite(n) ? Math.max(1, Math.min(500, n)) : DEFAULTS.maxSnapshots;
	},
	autoPushOnChange: (v) => v === true,
	// Same origin discipline as apiBase: a mistyped value falls back to the
	// public registry rather than pointing the version check at some host.
	registry: (v) => {
		const s = String(v ?? "").trim().replace(/\/+$/, "");
		if (s === "") return DEFAULTS.registry;
		if (!/^https?:\/\/[^/]+/.test(s)) return DEFAULTS.registry;
		return s;
	},
};

/** Validate a repository string without throwing. */
export function validRepo(repo) {
	return /^[\w.-]+\/[\w.-]+$/.test(String(repo ?? "").trim());
}

/** The file that holds this profile's settings. */
export function configFile() {
	const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dsh");
	return join(home, "dsh-plugin-cloud", "config.json");
}

/** Merge a raw object over the defaults with per-field coercion. */
export function normalize(raw) {
	const out = { ...DEFAULTS };
	if (raw && typeof raw === "object") {
		for (const key of Object.keys(FIELDS)) {
			if (raw[key] !== undefined) out[key] = FIELDS[key](raw[key]);
		}
	}
	return out;
}

/** Read the file, falling back to defaults. */
export async function load() {
	const p = configFile();
	if (!existsSync(p)) return normalize({});
	try {
		return normalize(JSON.parse(await readFile(p, "utf8")));
	} catch {
		return normalize({});
	}
}

/**
 * Persist selected fields and return the whole merged configuration.
 *
 * @param {object} patch - only known keys are applied.
 * @returns {Promise<{config: object, path: string, rejected: string[]}>}
 */
export async function save(patch) {
	const current = await load();
	const next = { ...current };
	const rejected = [];
	for (const [key, value] of Object.entries(patch ?? {})) {
		if (!Object.hasOwn(FIELDS, key)) { rejected.push(key); continue; }
		if (key === "repo" && value !== "" && !validRepo(value)) {
			rejected.push(`${key} (应为 owner/name)`);
			continue;
		}
		next[key] = FIELDS[key](value);
	}
	const p = configFile();
	await mkdir(dirname(p), { recursive: true });
	await writeFile(p, JSON.stringify(next, null, 2), "utf8");
	return { config: next, path: p, rejected };
}

/** Whether configuration is complete enough to reach the cloud. */
export function cloudReady(cfg) {
	return validRepo(cfg.repo);
}

/**
 * The schema shown in the settings surface. Descriptive only — the Host's
 * generated form cannot be used because this plugin stores settings in a file.
 */
export const shape = Object.fromEntries(
	Object.entries(DEFAULTS).map(([key, value]) => [key, { type: typeof value, default: value }]),
);
