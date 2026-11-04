/**
 * 本地快照存储回归测试。全部数据写在系统临时目录，不接触真实 DSH_HOME。
 *
 * Run: node tools/store-check.mjs
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteLocal, listLocal, readLocalIndex, saveLocal, storeDir } from "../lib/store.js";

let passed = 0;
let skipped = 0;
const check = (label, condition, detail = "") => {
	assert.ok(condition, `${label}${detail ? `: ${detail}` : ""}`);
	passed++;
	console.log("  ok  ", label);
};

const snapshot = (n) => ({
	createdAt: new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString(),
	label: `snap-${n}`,
	note: `note ${n}`,
	summary: { total: 1 },
	plugins: [{ name: "fixture", kind: "registry", version: "1.0.0" }],
});

const root = await mkdtemp(join(tmpdir(), "dsh-plugin-cloud-store-"));
const previousHome = process.env.DSH_HOME;
const useHome = (name) => {
	process.env.DSH_HOME = join(root, name);
};
const snapshotFiles = async () => (await readdir(join(storeDir(), "snapshots")))
	.filter((file) => file.endsWith(".json"));
const tempFiles = async () => {
	const indexTemps = (await readdir(storeDir())).filter((file) => file.endsWith(".tmp"));
	const snapshotTemps = (await readdir(join(storeDir(), "snapshots"))).filter((file) => file.endsWith(".tmp"));
	return [...indexTemps, ...snapshotTemps];
};

try {
	// 20 个读改写操作并发入队后，磁盘与索引必须一一对应。
	useHome("concurrent");
	const snapshots = Array.from({ length: 20 }, (_, n) => snapshot(n));
	const saved = await Promise.all(snapshots.map((item) => saveLocal(item)));
	const index = await readLocalIndex();
	check("Promise.all 20 个 saveLocal 后索引为 20 条", index.versions.length === 20, String(index.versions.length));
	check("20 条索引的文件名不重复", new Set(index.versions.map((item) => item.file)).size === 20);
	check("Promise.all 20 个 saveLocal 后磁盘为 20 个快照", (await snapshotFiles()).length === 20);
	const listed = await listLocal();
	check("20 个原子写入的快照全部可解析", listed.length === 20 && listed.every((item) => item.error === undefined));
	check("并发保存后没有遗留临时文件", (await tempFiles()).length === 0);

	// 保存和删除必须共用队列，不能只把 saveLocal 各自串行化。
	await Promise.all([
		deleteLocal(saved[0].file),
		saveLocal(snapshot(20)),
		deleteLocal(saved[1].file),
		saveLocal(snapshot(21)),
	]);
	const mixedIndex = await readLocalIndex();
	check("保存与删除交错后索引仍为 20 条", mixedIndex.versions.length === 20, String(mixedIndex.versions.length));
	check("交错操作移除已删除索引", !mixedIndex.versions.some((item) => item.file === saved[0].file || item.file === saved[1].file));
	check("交错操作保留新增索引", mixedIndex.versions.some((item) => item.label === "snap-20") && mixedIndex.versions.some((item) => item.label === "snap-21"));
	check("保存与删除交错后磁盘与索引数量一致", (await snapshotFiles()).length === mixedIndex.versions.length);

	// 既有语义：索引最多 100 条，超出的快照文件不主动删除。
	useHome("retention");
	await Promise.all(Array.from({ length: 105 }, (_, n) => saveLocal(snapshot(n))));
	const capped = await readLocalIndex();
	check("连续 105 个快照后索引保持 100 条上限", capped.versions.length === 100, String(capped.versions.length));
	check("100 条上限保留最后入队的快照", capped.versions[0]?.label === "snap-104" && capped.versions.at(-1)?.label === "snap-5");
	check("索引截断仍保留磁盘快照文件", (await snapshotFiles()).length === 105);

	// Windows 上只读目标会让 rename 失败，可真实验证旧索引不被截断。
	useHome("atomic-failure");
	await saveLocal(snapshot(200));
	const indexPath = join(storeDir(), "index.json");
	const before = await readFile(indexPath, "utf8");
	if (process.platform === "win32") {
		let failure = null;
		await chmod(indexPath, 0o444);
		try {
			await saveLocal(snapshot(201));
		} catch (error) {
			failure = error;
		} finally {
			await chmod(indexPath, 0o666);
		}
		check("原子替换失败会拒绝本次保存", failure !== null);
		check("原子替换失败不破坏旧索引", await readFile(indexPath, "utf8") === before);
		check("原子替换失败清理临时文件", (await tempFiles()).length === 0);

		// 失败只拒绝自己的调用，不得让统一队列永久处于 rejected 状态。
		await saveLocal(snapshot(202));
		const recovered = await readLocalIndex();
		check("原子替换失败后续保存仍可执行", recovered.versions.length === 2 && recovered.versions[0]?.label === "snap-202");
	} else {
		skipped++;
		console.log("  skip", "只读文件诱发 rename 失败", "— 仅 Windows 可稳定复现");
	}
} finally {
	if (previousHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = previousHome;
	await rm(root, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed${skipped > 0 ? `, ${skipped} skipped` : ""}`);
