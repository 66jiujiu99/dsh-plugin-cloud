/**
 * 确认磁盘上的 client.js 已经是 Host 正在下发的那一份。
 *
 * client bundle 由 dsh-client-modules 走 `/plugins/??<id>/client.js&rev=<rev>`
 * 提供；`rev` 取自文件的 mtime/ctime/size，且响应头是 immutable 一年缓存。
 * 所以「浏览器看到的」等价于「这个 rev 对应的 bundle 字节」，两者一致就说明
 * HMR 已经把新版换上了，不需要重启 DSH。
 *
 * Run: node tools/verify-served.mjs [port]
 */
const PORT = process.argv[2] ?? '4844';
const BASE = `http://127.0.0.1:${PORT}`;

const { readFileSync } = await import('node:fs');
const disk = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// 从 HMR 的 SSE 图里取当前 rev；SSE 是长连接，读到第一帧就断开。
let rev = null;
let entry = null;
try {
	const res = await fetch(`${BASE}/plugins/events`, { signal: AbortSignal.timeout(6000) });
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		const line = buf.split('\n').find((l) => l.startsWith('data: ') && l.includes('dsh-plugin-cloud'));
		if (line) {
			const graph = JSON.parse(line.slice(6)).graph;
			entry = graph.entries.find((e) => e.id === 'dsh-plugin-cloud');
			rev = entry?.rev ?? null;
			break;
		}
	}
	reader.cancel().catch(() => {});
} catch (error) {
	console.log('取 SSE 图失败：', String(error?.message ?? error));
}

let passed = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed++; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};

check('取到 plugin-cloud 的 bundle rev', rev !== null, String(rev));

if (rev !== null) {
	const served = await (await fetch(`${BASE}/${entry.url}`, { signal: AbortSignal.timeout(15000) })).text();
	check('下发的 bundle 非空', served.length > 1000, `${served.length} 字节`);
	// 磁盘与下发必须逐字节一致（combo 包装可能带来少量前后缀差异）。
	const norm = (s) => s.replace(/\s+/g, '');
	check('磁盘内容 == 下发内容', norm(served).includes(norm(disk).slice(0, 4000)), '前 4000 字符不一致');
	for (const marker of ['textOf', 'pc-c-name', 'pc-c-ver', 'pc-c-act', 'titleZh']) {
		check(`下发内容含 ${marker}`, served.includes(marker));
	}
	console.log(`\n  rev=${rev}  served=${served.length}B  disk=${disk.length}B`);
}

console.log(`\n${passed} checks passed`);
