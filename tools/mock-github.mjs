/**
 * Minimal GitHub Contents-API stand-in: keeps an in-memory repo so the
 * plugin's push/read/delete orchestration can be exercised end to end without
 * a real token. Not a test of GitHub's contract (that was verified against the
 * live API) — a test of *this plugin's* sequencing: base64, the sha chain
 * (read → write with sha), the three-commit push, and index merging.
 *
 * Run: node mock-github.mjs [port]
 */
import { createServer } from "node:http";
import { Buffer } from "node:buffer";

const files = new Map(); // path -> {content(b64), sha, size}
let seq = 0;
const sha = () => `${(++seq).toString(16).padStart(40, "0")}`;

const json = (res, status, body) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
	if (!m) { json(res, 404, { message: "Not Found" }); return; }
	// Key by repository as well as path. Without the namespace a lookup in one
	// repo would answer from another, so the "missing" cases would never
	// actually be missing and the test would prove nothing.
	const ns = `${m[1]}/${m[2]}/`;
	const path = decodeURIComponent(m[3]);

	if (req.method === "GET") {
		// A directory listing: return every file whose path starts with prefix.
		if (!files.has(ns + path)) {
			const dirPrefix = path.endsWith("/") ? ns + path : `${ns}${path}/`;
			const kids = [...files.keys()].filter((k) => k.startsWith(dirPrefix));
			if (kids.length === 0) return json(res, 404, { message: "Not Found" });
			return json(res, 200, kids.map((k) => ({
				name: k.slice(dirPrefix.length), path: k.slice(ns.length), type: "file", sha: files.get(k).sha, size: files.get(k).size,
			})));
		}
		const f = files.get(ns + path);
		return json(res, 200, { name: path.split("/").pop(), path, sha: f.sha, size: f.size, content: f.content, encoding: "base64" });
	}

	if (req.method === "PUT") {
		const body = JSON.parse(await new Promise((r) => { let d = ""; req.on("data", (c) => d += c); req.on("end", () => r(d)); }));
		const key = ns + path;
		if (files.has(key) && !body.sha) { json(res, 409, { message: "sha required when replacing" }); return; }
		if (files.has(key) && body.sha && files.get(key).sha !== body.sha) {
			json(res, 409, { message: "sha mismatch (409 conflict — optimistic concurrency)" });
			return;
		}
		const existed = files.has(key);
		const buf = Buffer.from(body.content, "base64");
		files.set(key, { content: body.content, sha: sha(), size: buf.length });
		json(res, existed ? 200 : 201, { content: { path, sha: files.get(key).sha }, commit: { sha: sha() } });
		return;
	}

	if (req.method === "DELETE") {
		const body = JSON.parse(await new Promise((r) => { let d = ""; req.on("data", (c) => d += c); req.on("end", () => r(d)); }));
		const key = ns + path;
		if (!files.has(key)) return json(res, 404, { message: "Not Found" });
		if (files.get(key).sha !== body.sha) return json(res, 409, { message: "sha mismatch" });
		files.delete(key);
		json(res, 200, { content: null, commit: { sha: sha() } });
		return;
	}

	json(res, 405, { message: "method not allowed" });
});

const port = Number(process.argv[2] || 39411);
server.listen(port, "127.0.0.1", () => console.log(`mock github on 127.0.0.1:${port}`));