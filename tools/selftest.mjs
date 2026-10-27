/**
 * Drives lib/github.js + lib/store.js against tools/mock-github.mjs.
 * Verifies the plugin's own sequencing (base64, the read→write sha chain, the
 * three-commit push, index merge, delete-then-reindex) without a real token.
 * Run: node selftest.mjs <mockPort>
 */
import { createHash } from "node:crypto";
import * as gh from "../lib/github.js";
import { fingerprint } from "../lib/autobackup.js";

const BASE = `http://127.0.0.1:${process.argv[2] || 39411}`;
const REPO = "tester/dsh-env";
const TOKEN = "fake-token";

const snap = (n, extra = {}) => ({
	createdAt: `2026-01-0${n}T00:00:00.000Z`,
	label: `snap-${n}`,
	note: `note ${n}`,
	summary: { total: 3, registry: 2, local: 1, disabled: 0, withGit: 1, dirty: 0 },
	bundleOrder: ["a", "b", "c"],
	disabledRows: [],
	plugins: [
		{ name: "a", kind: "registry", version: "1.0.0", enabled: true },
		{ name: "b", kind: "registry", version: "2.0.0", enabled: true },
		{ name: "c", kind: "path", version: "0.1.0", enabled: true, git: { commit: "deadbeefcafe", short: "deadbeefcafe" } },
		...extra.plugins ?? [],
	],
});

let passed = 0;
const check = (label, ok, detail = "") => {
	if (ok) { passed++; console.log("  ok  ", label); }
	else { console.error("  FAIL", label, detail); process.exitCode = 1; }
};

// 1. first push on an empty repo
const r1 = await gh.pushSnapshot(TOKEN, REPO, snap(1), { apiBase: BASE, keep: 50 });
check("push#1 returns file name", /2026-01-01T00-00-00-000Z\.json$/.test(r1.file), r1.file);

const idx1 = await gh.readIndex(TOKEN, REPO, BASE);
check("index has 1 version", idx1.versions.length === 1, JSON.stringify(idx1.versions.length));
check("index entry points at the snapshot file", idx1.versions[0]?.file === `snapshots/${"2026-01-01T00-00-00-000Z"}.json`, idx1.versions[0]?.file);

// 2. latest.json mirrors the snapshot
const latest = await gh.readFile(TOKEN, REPO, "latest.json", BASE);
check("latest.json exists and decodes", latest && latest.content.includes('"label": "snap-1"'), latest?.content?.slice(0, 40));

// 3. second push must reuse the existing sha for latest.json + index.json
const r2 = await gh.pushSnapshot(TOKEN, REPO, snap(2), { apiBase: BASE, keep: 50 });
const idx2 = await gh.readIndex(TOKEN, REPO, BASE);
check("index now lists 2, newest first", idx2.versions.length === 2 && idx2.versions[0].file === `snapshots/${"2026-01-02T00-00-00-000Z"}.json`, JSON.stringify(idx2.versions.map(v=>v.file)));

// 4. keep() truncation
await gh.pushSnapshot(TOKEN, REPO, snap(3), { apiBase: BASE, keep: 2 });
const idx3 = await gh.readIndex(TOKEN, REPO, BASE);
check("keep=2 truncates index", idx3.versions.length === 2, JSON.stringify(idx3.versions.map(v=>v.file)));

// 5. fingerprint stability — the dedup the whole auto-backup rests on
const a = fingerprint(snap(1));
const b = fingerprint(snap(1));
const c = fingerprint(snap(1, { plugins: [{ name: "d", kind: "registry", version: "9.9.9", enabled: true }] }));
check("fingerprint stable for identical state", a === b, `${a} vs ${b}`);
check("fingerprint changes when a plugin is added", a !== c, `${a} vs ${c}`);
const moved = snap(1); moved.plugins[0].version = "1.0.1";
check("fingerprint changes on a version bump", fingerprint(moved) !== a);
const disabled = snap(1); disabled.plugins[1].enabled = false;
check("fingerprint changes on enablement", fingerprint(disabled) !== a);

// 6. delete removes the file and drops it from the index
const del = await gh.deleteSnapshot(TOKEN, REPO, "2026-01-03T00-00-00-000Z.json", BASE);
check("delete reports deleted", del.deleted === true);
const idxAfter = await gh.readIndex(TOKEN, REPO, BASE);
check("deleted file is out of the index", !idxAfter.versions.some((v) => v.file.includes("2026-01-03")), JSON.stringify(idxAfter.versions.map(v=>v.file)));

// 7. a 404 directory reads as an empty list, not an error
const missing = await gh.listSnapshots(TOKEN, "nobody/nothing", BASE);
check("missing snapshots dir → empty list", Array.isArray(missing) && missing.length === 0, JSON.stringify(missing));

console.log(`\n${passed} checks passed${process.exitCode ? " — WITH FAILURES" : ""}`);
