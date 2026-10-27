/**
 * Component: long-running upgrade jobs.
 *
 * An upgrade is not one operation but a small pipeline — resolve the target
 * version, drop the manifest entry, run pnpm, put the entry back if pnpm
 * refused — and it can take tens of seconds on a cold registry. Answering it
 * inside the request means the UI has a spinner and nothing else: no idea which
 * step is running, no idea whether it is stuck, no way to tell "downloading" from
 * "waiting on a lock".
 *
 * So an upgrade is a job. `POST /upgrade` starts it and returns an id at once;
 * the UI polls `GET /job?id=…` and paints the current step, the step list, and
 * how long it has been running. A job also survives the page being reloaded,
 * which matters because `application: "restart-required"` invites exactly that.
 *
 * Every step is a real step of the pipeline, not a progress bar invented for
 * looks. If the UI says "正在下载并安装"，pnpm is genuinely running at that
 * moment; if it says "写入配置"，the manifest write is what is happening.
 *
 * @module dsh-plugin-cloud/lib/jobs
 */

/** How long a finished job is kept for a late poll. */
const JOB_TTL_MS = 10 * 60 * 1000;

/** Upper bound on retained jobs, so a long session cannot grow without limit. */
const JOB_MAX = 40;

/**
 * The ordered steps of one upgrade, per plugin.
 *
 * Kept as data rather than inferred from log text: the UI should not have to
 * guess which phase it is in from whatever pnpm happened to print.
 *
 * @param {string} name - plugin being upgraded.
 * @param {string|null} to - target version, when known.
 * @returns {Array<{id:string,label:string}>}
 */
export function stepsFor(name, to) {
	return [
		{ id: "resolve", label: `解析 ${name} 的目标版本${to === null ? "" : `（${to}）`}` },
		{ id: "prepare", label: "检查已装版本" },
		{ id: "manifest", label: "更新 profile 的 package.json" },
		{ id: "install", label: "执行 pnpm 安装" },
		{ id: "verify", label: "校验安装结果" },
	];
}

/**
 * Create a job registry.
 *
 * @returns {object} registry with `create`, `get`, `list`, `advance`, `finish`, `fail`, `cancel`
 */
export function createJobRegistry() {
	/** @type {Map<string, object>} */
	const jobs = new Map();

	/** Drop the oldest finished jobs once the cap is exceeded. */
	const prune = () => {
		if (jobs.size <= JOB_MAX) return;
		const finished = [...jobs.values()]
			.filter((job) => job.status !== "running")
			.sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
		for (const job of finished.slice(0, jobs.size - JOB_MAX)) jobs.delete(job.id);
	};

	let counter = 0;
	return {
		/**
		 * Start a new job.
		 *
		 * @param {object} spec
		 * @param {string[]} spec.names - plugins being upgraded.
		 * @param {string[][]} spec.stepSets - one label list per plugin.
		 * @returns {object} the job snapshot.
		 */
		create({ names, stepSets }) {
			counter += 1;
			const id = `job-${Date.now().toString(36)}-${counter.toString(36)}`;
			const job = {
				id,
				names,
				status: "running",
				phase: "waiting",
				startedAt: Date.now(),
				finishedAt: null,
				// Per-plugin progress: "3/5" needs to know which plugin and which step.
				index: 0,
				stepIndex: 0,
				stepSets,
				steps: stepSets[0] ?? [],
				current: null,
				// Results accumulate as plugins finish, so a poll mid-batch shows
				// the ones already done rather than an empty list.
				results: [],
				errors: [],
				cancelled: false,
				// Merged into the snapshot by `finish`; empty until then.
				summary: {},
			};
			jobs.set(id, job);
			prune();
			return this.get(id);
		},

		/**
		 * Read a job snapshot, with an `elapsedMs` the UI can render directly.
		 *
		 * The arrays are copied, not shared. A caller that mutates the snapshot —
		 * appending to `results`, sorting `steps` — must not reach back into the
		 * registry, because that would corrupt every later poll of the same job.
		 *
		 * @param {string} id - job id.
		 * @returns {object|null} snapshot or null.
		 */
		get(id) {
			const job = jobs.get(id);
			if (job === undefined) return null;
			const end = job.finishedAt ?? Date.now();
			return {
				id: job.id,
				names: [...job.names],
				status: job.status,
				phase: job.phase,
				startedAt: job.startedAt,
				finishedAt: job.finishedAt,
				elapsedMs: end - job.startedAt,
				index: job.index,
				total: job.names.length,
				stepIndex: job.stepIndex,
				steps: job.steps.map((step) => ({ ...step })),
				completedSteps: [...(job.completedSteps ?? [])],
				current: job.current,
				results: job.results.map((result) => ({ ...result })),
				errors: [...job.errors],
				cancelled: job.cancelled,
				// Fields merged in by `finish` (restartRequired, ok, …) must reach the
				// UI too: they are computed from the pipeline and never stored twice.
				...job.summary,
			};
		},

		/**
		 * Mark which plugin and step is running.
		 *
		 * Steps before `stepIndex` are recorded as completed, so the UI can paint
		 * ticks without having to infer them from the index.
		 *
		 * @param {string} id - job id.
		 * @param {object} position
		 * @param {number} position.index - zero-based plugin index.
		 * @param {number} position.stepIndex - zero-based step index.
		 * @param {string} [position.phase] - machine phase for the UI.
		 */
		advance(id, { index, stepIndex, phase }) {
			const job = jobs.get(id);
			if (job === undefined) return;
			job.index = index;
			job.stepIndex = stepIndex;
			job.steps = job.stepSets[index] ?? [];
			job.current = job.steps[stepIndex]?.id ?? null;
			job.completedSteps = job.steps.slice(0, stepIndex).map((step) => step.id);
			if (typeof phase === "string") job.phase = phase;
		},

		/**
		 * Record one plugin's result.
		 *
		 * @param {string} id - job id.
		 * @param {object} row - the per-plugin result.
		 */
		pushResult(id, row) {
			const job = jobs.get(id);
			if (job === undefined) return;
			job.results.push(row);
		},

		/**
		 * Record a job-level error that is not tied to one plugin.
		 *
		 * @param {string} id - job id.
		 * @param {string} message - error text.
		 */
		pushError(id, message) {
			const job = jobs.get(id);
			if (job === undefined) return;
			job.errors.push(message);
		},

		/**
		 * Finish a job successfully.
		 *
		 * @param {string} id - job id.
		 * @param {object} [summary] - extra fields merged into the snapshot.
		 */
		finish(id, summary = {}) {
			const job = jobs.get(id);
			if (job === undefined) return;
			job.status = job.cancelled ? "cancelled" : "done";
			job.phase = "done";
			job.finishedAt = Date.now();
			job.stepIndex = job.steps.length;
			job.current = null;
			job.summary = { ...job.summary, ...summary };
		},

		/**
		 * Finish a job as failed.
		 *
		 * @param {string} id - job id.
		 * @param {string} message - failure text.
		 */
		fail(id, message) {
			const job = jobs.get(id);
			if (job === undefined) return;
			job.status = "failed";
			job.phase = "failed";
			job.finishedAt = Date.now();
			job.current = null;
			job.errors.push(message);
		},

		/**
		 * Ask a running job to stop.
		 *
		 * The pipeline checks `isCancelled` between steps; a pnpm run that is
		 * already in flight is not killed mid-write, because interrupting a
		 * half-finished install is how a manifest loses an entry.
		 *
		 * @param {string} id - job id.
		 * @returns {boolean} whether the job was running.
		 */
		cancel(id) {
			const job = jobs.get(id);
			if (job === undefined || job.status !== "running") return false;
			job.cancelled = true;
			job.phase = "cancelling";
			return true;
		},

		/**
		 * Whether a job has been asked to stop.
		 *
		 * @param {string} id - job id.
		 * @returns {boolean}
		 */
		isCancelled(id) {
			return jobs.get(id)?.cancelled === true;
		},

		/**
		 * Find the job currently running, if any.
		 *
		 * One upgrade at a time: two concurrent `pnpm add` runs against the same
		 * profile would race on the lockfile and the manifest.
		 *
		 * @returns {object|null} snapshot of the running job.
		 */
		running() {
			for (const job of jobs.values()) {
				if (job.status === "running") return this.get(job.id);
			}
			return null;
		},

		/** Remove expired jobs. */
		sweep() {
			const cutoff = Date.now() - JOB_TTL_MS;
			for (const [id, job] of jobs) {
				if (job.status !== "running" && (job.finishedAt ?? 0) < cutoff) jobs.delete(id);
			}
		},
	};
}
