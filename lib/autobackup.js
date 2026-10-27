/**
 * Component: auto-backup.
 *
 * Keeps the cloud copy current without user action. Two triggers:
 *
 *   - interval  — a periodic snapshot; the cadence is read from live config on
 *                 every tick, so changing it in the UI re-arms the timer
 *                 without a restart
 *   - on-change — a snapshot whenever the plugin set actually differs from the
 *                 last one pushed
 *
 * Change detection is a fingerprint over the fields that matter, so a restart
 * alone never produces a duplicate snapshot and a real change never waits for
 * the interval. That is what makes "automatic" mean something.
 *
 * @module dsh-plugin-cloud/lib/autobackup
 */
import { createHash } from "node:crypto";

/** The fields whose change deserves a new snapshot. */
export function fingerprint(snapshot) {
	const material = JSON.stringify({
		bundles: snapshot.bundleOrder,
		disabled: snapshot.disabledRows,
		plugins: (snapshot.plugins ?? [])
			.map((p) => [p.name, p.version, p.enabled, p.git?.commit ?? null])
			.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
	});
	return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/**
 * Own the timers. `start` returns a disposer; the caller registers it with
 * `ctx.effect` so disabling the bundle stops the timers.
 *
 * @param {object} options
 * @param {() => number} options.getIntervalMs - live cadence; 0 disables the timer.
 * @param {() => Promise<object>} options.snapshot - build a snapshot.
 * @param {(snapshot: object, reason: string) => Promise<void>} options.push - persist it.
 * @param {() => boolean} options.enabled - whether auto-backup is on.
 * @param {(event: object) => void} options.onEvent - progress reporting.
 * @param {() => boolean} [options.onChangeEnabled] - whether the change trigger is on.
 * @param {() => Promise<string|null>} [options.seed] - the fingerprint of the
 *   last snapshot already stored. Without it a restart or a bundle reload
 *   forgets what was pushed and writes a duplicate of an unchanged state.
 */
export function createScheduler({ getIntervalMs, snapshot, push, enabled, onEvent, onChangeEnabled, seed }) {
	let lastFingerprint = null;
	let seeded = false;
	let timer = null;
	let armedMs = null;
	let running = false;
	let lastRunAt = null;
	let lastError = null;
	let lastReason = null;

	/** (Re-)arm the periodic timer to match the live configuration. */
	function reschedule() {
		const want = Math.max(0, Math.round(getIntervalMs() || 0));
		if (want === armedMs && timer !== null) return;
		if (timer !== null) clearInterval(timer);
		armedMs = want;
		if (want > 0) {
			timer = setInterval(() => { tick("interval"); }, want);
			if (typeof timer.unref === "function") timer.unref();
		} else {
			timer = null;
		}
	}

	/** One guarded cycle: never overlap, never throw into the event loop. */
	async function tick(reason, detail) {
		if (running) return;
		if (!enabled()) { reschedule(); return; }
		running = true;
		reschedule();
		try {
			// Learn the last stored state from disk once per process: an
			// in-memory-only fingerprint would make every restart push a
			// duplicate of an unchanged environment.
			if (!seeded && seed) {
				seeded = true;
				try { lastFingerprint = await seed(); } catch { /* seeding is best-effort */ }
			}
			const snap = await snapshot();
			const fp = fingerprint(snap);
			// Only an explicit "back up now" may store an unchanged state;
			// startup / interval / change all keep the mirror deduplicated.
			if (fp === lastFingerprint && reason !== "manual") {
				onEvent({ kind: "skip", reason: "unchanged" });
				return;
			}
			await push(snap, reason, detail);
			lastFingerprint = fp;
			lastRunAt = new Date().toISOString();
			lastReason = reason;
			lastError = null;
			onEvent({ kind: "pushed", reason, at: lastRunAt });
		} catch (error) {
			lastError = String(error?.message ?? error).slice(0, 300);
			// The local mirror is written before the cloud push, so a cloud
			// failure still leaves the snapshot stored. Re-read the stored
			// fingerprint so the next cycle does not duplicate it; the cloud
			// missed this one push and catches up on the next real change.
			if (seed) { try { lastFingerprint = await seed(); } catch { /* ignore */ } }
			onEvent({ kind: "error", reason, error: lastError });
		} finally {
			running = false;
		}
	}

	return {
		start() {
			reschedule();
			tick("startup");
			return () => {
				if (timer !== null) clearInterval(timer);
				timer = null;
				armedMs = null;
			};
		},
		/**
		 * Called when the plugin set moved; skipped if the change trigger is off.
		 * @param {string} [detail] - the manager's change reason, recorded on the
		 * snapshot so a version can say *why* it exists.
		 */
		notifyChange(detail) {
			if (onChangeEnabled && !onChangeEnabled()) return;
			tick("change", detail);
		},
		/** Force a snapshot regardless of the fingerprint. */
		force: (detail) => tick("manual", detail),
		/** Re-arm the timer from the live configuration without taking a snapshot. */
		reschedule,
		/**
		 * Stop the timer. Safe before `start()` ran, and idempotent — the mount
		 * effect may be disposed while the first config read is still pending.
		 */
		stop() {
			if (timer !== null) clearInterval(timer);
			timer = null;
			armedMs = null;
		},
		/** Forget the fingerprint so the next cycle definitely pushes. */
		invalidate: () => { lastFingerprint = null; },
		status: () => ({
			running,
			lastRunAt,
			lastError,
			lastReason,
			hasFingerprint: lastFingerprint !== null,
			armedMs,
		}),
	};
}
