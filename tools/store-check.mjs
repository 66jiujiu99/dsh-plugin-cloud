/**
 * 本地快照存储回归测试。全部数据写在系统临时目录，不接触真实 DSH_HOME。
 *
 * Run: node tools/store-check.mjs
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "../lib/store.js";

const { deleteLocal, fileNameOf, listLocal, pruneLocal, readLocalIndex, saveLocal, storeDir } = store;
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
const snapshotFiles = async () => (await readdir(join(storeDir(), "snapshots"), { withFileTypes: true }))
	.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
	.map((entry) => entry.name)
	.sort()
	.reverse();
const tempFiles = async () => {
	const indexTemps = (await readdir(storeDir())).filter((file) => file.endsWith(".tmp"));
	const snapshotTemps = (await readdir(join(storeDir(), "snapshots"))).filter((file) => file.endsWith(".tmp"));
	return [...indexTemps, ...snapshotTemps];
};
const sameFiles = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

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

	// 配置 keep 后，真实文件和索引都必须收敛到最新的同一批文件。
	useHome("retention");
	await Promise.all(Array.from({ length: 105 }, (_, n) => saveLocal(snapshot(n), { keep: 5 })));
	const capped = await readLocalIndex();
	const cappedFiles = await snapshotFiles();
	check("连续 105 个 keep=5 保存后索引准确保留 5 条", capped.versions.length === 5, String(capped.versions.length));
	check("keep=5 保留最后入队的 snap-100 至 snap-104", capped.versions[0]?.label === "snap-104" && capped.versions.at(-1)?.label === "snap-100");
	check("keep=5 同时删除旧快照文件", cappedFiles.length === 5, String(cappedFiles.length));
	check("keep=5 的索引与磁盘文件完全一致", sameFiles(capped.versions.map((item) => item.file), cappedFiles));
	check("keep=5 后 listLocal 不再显示旧文件", (await listLocal()).length === 5);

	// 云端与本地集合不完全相同时，合并后的可见列表也必须受同一上限约束。
	const mergeRow = (n) => {
		const item = snapshot(n);
		return { file: fileNameOf(item), createdAt: item.createdAt, label: item.label };
	};
	const merged = store.mergeIndexes(
		[0, 1, 2, 3, 9].map(mergeRow),
		[0, 1, 2, 3, 4].map((n) => ({ ...mergeRow(n), file: `snapshots/${mergeRow(n).file}` })),
	);
	check("cloud/local 各自 5 条时并集可以超过 5 条", merged.length === 6, String(merged.length));
	const visible = merged.slice(0, 5);
	check("合并结果 cap=5 后准确保留五项", visible.length === 5);
	check("合并 cap 保留 local-only 最新项与云端项", visible[0]?.label === "snap-9" && visible.some((item) => item.label === "snap-4"));
	check("合并 cap 丢弃最旧项而不是额外删除云端", !visible.some((item) => item.label === "snap-0") && merged.some((item) => item.label === "snap-0"));

	// 旧索引只截断条目、不删文件，因此 prune 必须扫描磁盘而不是信任索引。
	useHome("orphans");
	await Promise.all(Array.from({ length: 6 }, (_, n) => saveLocal(snapshot(n))));
	const truncated = await readLocalIndex();
	await writeFile(join(storeDir(), "index.json"), JSON.stringify({
		schema: "dsh-plugin-cloud-index/1",
		versions: truncated.versions.slice(0, 2),
	}, null, 2), "utf8");
	check("测试夹具确有索引外 orphan", (await readLocalIndex()).versions.length === 2 && (await snapshotFiles()).length === 6);
	const pruned = await pruneLocal(3);
	const orphanFiles = await snapshotFiles();
	const orphanIndex = await readLocalIndex();
	check("pruneLocal 扫描并清理索引外 orphan", pruned.deleted.length === 3 && orphanFiles.length === 3);
	check("pruneLocal 保留磁盘最新三个文件", sameFiles(orphanFiles, [3, 4, 5].map((n) => fileNameOf(snapshot(n)))));
	check("被旧索引截掉的最新 orphan 也进入新索引", orphanIndex.versions.some((item) => item.label === "snap-3"));
	check("prune 后索引与保留文件完全一致", sameFiles(orphanIndex.versions.map((item) => item.file), orphanFiles));

	// 非快照文件、目录和 snapshots 外同名文件不属于清理范围。
	await writeFile(join(storeDir(), "outside.json"), "keep", "utf8");
	await writeFile(join(storeDir(), "snapshots", "notes.txt"), "keep", "utf8");
	await mkdir(join(storeDir(), "snapshots", "directory.json"));
	await writeFile(join(storeDir(), "snapshots", "directory.json", "child.txt"), "keep", "utf8");
	const one = await pruneLocal(1);
	check("keep=1 边界只保留最新一个快照", one.kept === 1 && (await snapshotFiles()).length === 1);
	check("prune 不触碰 snapshots 外 JSON", await readFile(join(storeDir(), "outside.json"), "utf8") === "keep");
	check("prune 不触碰非 JSON 文件", await readFile(join(storeDir(), "snapshots", "notes.txt"), "utf8") === "keep");
	check("prune 不删除 JSON 后缀目录", await readFile(join(storeDir(), "snapshots", "directory.json", "child.txt"), "utf8") === "keep");
	const upper = await pruneLocal(500);
	check("keep=500 是合法上限且不会误删", upper.keep === 500 && (await snapshotFiles()).length === 1);
	for (const [label, value] of [["0", 0], ["NaN", Number.NaN], ["501", 501], ["小数", 1.5], ["字符串", "5"], ["null", null]]) {
		await assert.rejects(() => pruneLocal(value), /keep/);
		check(`非法 keep=${label} 被拒绝且不清空`, (await snapshotFiles()).length === 1 && (await readLocalIndex()).versions.length === 1);
	}
	await assert.rejects(() => saveLocal(snapshot(99), { keep: 0 }), /keep/);
	check("saveLocal 非法 keep 不写入或清空", (await snapshotFiles()).length === 1 && (await readLocalIndex()).versions.length === 1);

	// prune/save/delete 必须共用队列；中间缩容也不能丢掉后来的新增。
	useHome("concurrent-retention");
	const seeded = await Promise.all(Array.from({ length: 5 }, (_, n) => saveLocal(snapshot(n))));
	await Promise.all([
		pruneLocal(3),
		saveLocal(snapshot(10), { keep: 5 }),
		deleteLocal(seeded[4].file),
		saveLocal(snapshot(11), { keep: 5 }),
		pruneLocal(5),
	]);
	const concurrentFiles = await snapshotFiles();
	const concurrentIndex = await readLocalIndex();
	check("并发保存/删除/prune 后索引与磁盘一致", sameFiles(concurrentIndex.versions.map((item) => item.file), concurrentFiles));
	check("并发缩容后保留两个新增快照", concurrentFiles.includes(fileNameOf(snapshot(10))) && concurrentFiles.includes(fileNameOf(snapshot(11))));
	check("并发删除没有复活旧索引或旧文件", !concurrentFiles.includes(seeded[4].file));
	check("并发保留最终文件集合准确", sameFiles(concurrentFiles, [2, 3, 10, 11].map((n) => fileNameOf(snapshot(n)))));
	check("并发 prune 后没有遗留临时文件", (await tempFiles()).length === 0);

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

	// prune 先原子替换索引再删除：替换失败时旧索引和全部旧文件都必须还在。
	useHome("prune-atomic-failure");
	await Promise.all([200, 201, 202].map((n) => saveLocal(snapshot(n))));
	const pruneIndexPath = join(storeDir(), "index.json");
	const pruneBefore = await readFile(pruneIndexPath, "utf8");
	if (process.platform === "win32") {
		let failure = null;
		await chmod(pruneIndexPath, 0o444);
		try {
			await pruneLocal(1);
		} catch (error) {
			failure = error;
		} finally {
			await chmod(pruneIndexPath, 0o666);
		}
		check("prune 原子替换失败会拒绝操作", failure !== null);
		check("prune 原子替换失败不破坏旧索引", await readFile(pruneIndexPath, "utf8") === pruneBefore);
		check("prune 原子替换失败前不删除任何旧快照", (await snapshotFiles()).length === 3);
		check("prune 原子替换失败清理临时文件", (await tempFiles()).length === 0);
		await saveLocal(snapshot(203), { keep: 2 });
		const recoveredFiles = await snapshotFiles();
		const recoveredIndex = await readLocalIndex();
		check("prune 失败后带 keep 保存仍可恢复队列", recoveredFiles.length === 2 && recoveredIndex.versions.length === 2);
		check("恢复后的保留项仍是磁盘最新文件", sameFiles(recoveredFiles, [202, 203].map((n) => fileNameOf(snapshot(n)))));
	} else {
		skipped++;
		console.log("  skip", "只读文件诱发 prune rename 失败", "— 仅 Windows 可稳定复现");
	}
} finally {
	if (previousHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = previousHome;
	await rm(root, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed${skipped > 0 ? `, ${skipped} skipped` : ""}`);
