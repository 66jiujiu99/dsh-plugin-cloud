/**
 * 表格对齐的静态检查。
 *
 * 这里不跑浏览器，而是把 CSS 与渲染出的单元格结构对照检查：每个列有固定
 * 轨道宽度、每个单元格声明了对齐方式、行高不随内容跳动、操作列的按钮不会
 * 因为数量不同而改变列宽。这几条正是"东倒西歪"的成因。
 *
 * Run: node tools/table-check.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let passed = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed++; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};

/** 取出 CSS 模板字符串的内容。 */
const css = (() => {
	const m = source.match(/const CSS = `([\s\S]*?)`;\n/);
	if (!m) throw new Error('没有找到 CSS 常量');
	return m[1];
})();

/** 取出某条规则的声明块。 */
const rule = (selector) => {
	const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
	const m = css.match(re);
	return m ? m[1] : null;
};

// ── 1. 网格轨道：五列，全部固定宽度 ─────────────────────────
{
	const body = rule('.pc-row');
	check('存在 .pc-row 规则', body !== null);
	const grid = body?.match(/grid-template-columns:([^;]+);/)?.[1]?.trim() ?? '';
	check('声明了 grid-template-columns', grid !== '', grid);
	const tracks = grid.split(/\s+/).filter(Boolean);
	check('恰好五列', tracks.length === 5, grid);
	// 第一列可伸展（名称），后四列必须是固定像素轨道，否则每行会自行定宽。
	const fixed = tracks.slice(1);
	check('后四列是固定像素值', fixed.every((t) => /^\d+px$/.test(t)), fixed.join(' '));
	check('没有任何一列用 auto/max-content', !/\bauto\b|max-content|min-content/.test(grid), grid);
	check('最后一列（操作）有足够宽度容纳两个按钮',
		Number(fixed[3]?.replace('px', '')) >= 140, fixed[3]);
}

// ── 2. 行内垂直居中 ─────────────────────────────────────────
{
	const body = rule('.pc-row');
	check('.pc-row 垂直居中', /align-items:\s*center/.test(body ?? ''), body?.slice(0, 120));
	const cells = rule('.pc-row > \\*') ?? rule('.pc-row > *');
	check('单元格统一 min-height', /min-height:\s*\d+px/.test(cells ?? ''), cells?.slice(0, 120));
	check('单元格统一 flex 居中', /align-items:\s*center/.test(cells ?? ''), cells?.slice(0, 120));
	check('单元格禁止 overflow 撑破', /min-width:\s*0/.test(cells ?? ''), cells?.slice(0, 120));
}

// ── 3. 每一列都有明确对齐 ───────────────────────────────────
{
	const name = rule('.pc-c-name');
	const ver = rule('.pc-c-ver');
	const status = rule('.pc-c-status');
	const act = rule('.pc-c-act');
	check('名称列左对齐（flex-start）', /align-items:\s*flex-start/.test(name ?? ''), name);
	check('版本列右对齐', /justify-content:\s*flex-end/.test(ver ?? '') && /text-align:\s*right/.test(ver ?? ''), ver);
	check('版本列等宽数字', /tabular-nums/.test(rule('.pc-ver') ?? ''), rule('.pc-ver'));
	check('状态列左对齐', /align-items:\s*flex-start/.test(status ?? ''), status);
	check('操作列右对齐', /justify-content:\s*flex-end/.test(act ?? ''), act);
	check('操作列不换行（保持单行高度）', /flex-wrap:\s*nowrap/.test(act ?? ''), act);
}

// ── 4. 徽标尺寸固定，不因文字长短改变行高 ───────────────────
{
	const badge = rule('.pc-badge');
	check('徽标固定高度', /height:\s*\d+px/.test(badge ?? ''), badge?.slice(0, 160));
	check('徽标不收缩', /flex:\s*none/.test(badge ?? ''), badge?.slice(0, 160));
	check('徽标不换行', /white-space:\s*nowrap/.test(badge ?? ''), badge?.slice(0, 160));
	const dot = rule('.pc-dot');
	check('状态圆点不收缩', /flex:\s*none/.test(dot ?? ''), dot);
}

// ── 5. 响应式下仍保留网格语义 ───────────────────────────────
{
	const media = css.match(/@media \(max-width:720px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
	check('存在窄屏断点', media !== '');
	const narrow = media.match(/\.pc-row\s*\{([^}]*)\}/)?.[1] ?? '';
	const g = narrow.match(/grid-template-columns:([^;]+);/)?.[1]?.trim() ?? '';
	const tracks = g.split(/\s+/).filter(Boolean);
	check('窄屏仍声明固定轨道（三列）', tracks.length === 3, g);
	check('窄屏第二三列是固定像素', tracks.slice(1).every((t) => /^\d+px$/.test(t)), g);
	check('窄屏隐藏两个版本列', /\.pc-col-opt\s*\{\s*display:\s*none/.test(media), media.slice(0, 120));
}

// ── 6. 渲染结构：表头与每一行用同一套单元格 class ───────────
{
	let factory;
	const sandbox = {
		window: { __ModuleLoader__: { load: (d) => { factory = d.factory; } } },
		document: {
			baseURI: 'http://x/',
			getElementById: () => null,
			createElement: () => ({ textContent: '' }),
			head: { appendChild: () => {} },
		},
		console,
		fetch: async () => ({ ok: false, status: 599, json: async () => ({}) }),
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: 'client.js' });

	// 直接检查源码里的结构：表头与数据行都必须使用这四个列 class。
	// 名称/状态/操作各一列：表头 1 次 + 数据行 1 次。
	// 版本 class 被「当前版本」和「最新」两列共用：表头 2 次 + 数据行 2 次。
	const expected = { 'pc-c-name': 2, 'pc-c-ver': 4, 'pc-c-status': 2, 'pc-c-act': 2 };
	for (const [cls, want] of Object.entries(expected)) {
		const count = (source.match(new RegExp(`'${cls}(?:\\s|')`, 'g')) ?? []).length;
		check(`表头与数据行都使用 ${cls}`, count === want, `期望 ${want} 次，实际 ${count} 次`);
	}
	check('渲染里不再有旧的 .pc-actions 类', !/className: 'pc-actions'/.test(source));
	check('渲染里不再用内联 textAlign 修表头',
		!/style: \{ textAlign: 'right' \}, t\('colActions'\)/.test(source));
	check('版本号用 span 而非单元格本身承载 mono 样式',
		/h\('span', \{ className: 'pc-ver' \}/.test(source));
}

// ── 7. 版本列表行：按钮成组，不会逐个被 flex 拉伸 ───────────
{
	const acts = rule('.pc-ver-actions');
	check('版本行按钮成组', acts !== null, acts);
	check('版本行按钮组垂直居中', /align-items:\s*center/.test(acts ?? ''), acts);
	check('版本行按钮组不换行', /flex-wrap:\s*nowrap/.test(acts ?? ''), acts);
	const line = rule('.pc-ver-line');
	check('版本行改为 center 对齐（原 baseline 会让按钮发飘）',
		/align-items:\s*center/.test(line ?? ''), line);
}

console.log(`\n${passed} checks passed`);
