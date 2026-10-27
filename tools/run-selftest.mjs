import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 40123;
const mock = spawn(process.execPath, ["tools/mock-github.mjs", String(PORT)], {
	cwd: process.cwd(),
	stdio: ["ignore", "inherit", "inherit"],
});
await sleep(700);

const test = spawn(process.execPath, ["tools/selftest.mjs", String(PORT)], {
	cwd: process.cwd(),
	stdio: "inherit",
});
const code = await new Promise((r) => test.on("exit", r));
mock.kill("SIGKILL");
process.exit(code ?? 0);
