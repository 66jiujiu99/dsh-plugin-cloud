/**
 * Snapshot integrity regressions: collection must fail loudly when the
 * authoritative manager inventory is unavailable, and fingerprints must cover
 * the exact dependency specs needed for restoration.
 *
 * Run: node tools/snapshot-integrity-check.mjs
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../lib/collector.js";
import { fingerprint } from "../lib/autobackup.js";

let passed = 0;
const check = (label, ok, detail = "") => {
	if (ok) { passed++; console.log("  ok  ", label); }
	else { console.error("  FAIL", label, detail); process.exitCode = 1; }
};

async function expectRejection(label, promise, pattern, expectedCause) {
	try {
		await promise;
		check(label, false, "unexpectedly resolved");
	} catch (error) {
		const message = String(error?.message ?? error);
		const causeOk = expectedCause === undefined || error?.cause === expectedCause;
		check(label, pattern.test(message) && causeOk, `${message}; cause=${String(error?.cause)}`);
	}
}

const dir = await mkdtemp(join(tmpdir(), "pc-snapshot-integrity-"));
try {
	await writeFile(join(dir, "package.json"), JSON.stringify({
		dependencies: { demo: "^1.2.3" },
		dsh: { profile: { bundles: ["demo"] } },
	}), "utf8");
	const base = { profileDir: dir, profile: "test", label: "test", note: "" };

	await expectRejection(
		"missing manager rejects instead of fabricating an inventory",
		collect({ ...base, manager: null }),
		/pluginManager\.listBundles 不可用/,
	);
	await expectRejection(
		"missing listBundles rejects instead of fabricating an inventory",
		collect({ ...base, manager: {} }),
		/pluginManager\.listBundles 不可用/,
	);

	const managerError = new Error("manager exploded");
	await expectRejection(
		"listBundles throw aborts collection and preserves its cause",
		collect({ ...base, manager: { async listBundles() { throw managerError; } } }),
		/pluginManager\.listBundles 调用失败.*manager exploded/,
		managerError,
	);
	await expectRejection(
		"invalid listBundles result aborts collection",
		collect({ ...base, manager: { async listBundles() { return null; } } }),
		/pluginManager\.listBundles 返回了无效结果/,
	);

	const collected = await collect({
		...base,
		manager: {
			async listBundles() {
				return [{ name: "demo", version: "1.2.3", enabled: true, installed: true, official: false }];
			},
		},
	});
	const row = collected.plugins[0];
	check(
		"explicit manager injection still collects exact installed metadata",
		collected.plugins.length === 1
			&& row?.spec === "^1.2.3"
			&& row?.version === "1.2.3"
			&& row?.installed === true
			&& row?.enabled === true,
		JSON.stringify(row),
	);
} finally {
	await rm(dir, { recursive: true, force: true });
}

const plugin = (overrides = {}) => ({
	name: "demo",
	kind: "git",
	version: "1.0.0",
	enabled: true,
	spec: "git+https://github.com/example/demo.git#1111111111111111111111111111111111111111",
	...overrides,
});
const snapshot = (plugins) => ({
	createdAt: "2026-01-01T00:00:00.000Z",
	label: "original",
	bundleOrder: ["demo", "other"],
	disabledRows: [],
	plugins,
});

const stableA = snapshot([
	plugin(),
	plugin({ name: "other", kind: "registry", spec: "^2.0.0", version: "2.0.0" }),
]);
const stableB = {
	...stableA,
	createdAt: "2026-01-02T00:00:00.000Z",
	label: "renamed",
	plugins: [...stableA.plugins].reverse(),
};
check("unchanged dependency state keeps the same fingerprint", fingerprint(stableA) === fingerprint(stableB));

const registryA = snapshot([plugin({ kind: "registry", spec: "^1.0.0" })]);
const registryB = snapshot([plugin({ kind: "registry", spec: "~1.0.0" })]);
check("same-version registry spec changes the fingerprint", fingerprint(registryA) !== fingerprint(registryB));

const gitA = snapshot([plugin()]);
const gitB = snapshot([plugin({ spec: "git+https://github.com/example/demo.git#2222222222222222222222222222222222222222" })]);
check("same-version pinned git spec changes the fingerprint", fingerprint(gitA) !== fingerprint(gitB));

const pathA = snapshot([plugin({ kind: "path", spec: "file:../demo-a", git: { commit: "abc123" } })]);
const pathB = snapshot([plugin({ kind: "path", spec: "file:../demo-b", git: { commit: "abc123" } })]);
check("same-version path spec changes the fingerprint", fingerprint(pathA) !== fingerprint(pathB));

const commitA = snapshot([plugin({ kind: "path", spec: "link:../demo", git: { commit: "abc123" } })]);
const commitB = snapshot([plugin({ kind: "path", spec: "link:../demo", git: { commit: "def456" } })]);
check("same-spec local git commit changes the fingerprint", fingerprint(commitA) !== fingerprint(commitB));

console.log(`\n${passed} checks passed${process.exitCode ? " — WITH FAILURES" : ""}`);
