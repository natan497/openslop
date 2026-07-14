import isEqual from "lodash/isEqual";
import isNil from "lodash/isNil";
import type { CanvasContentElement } from "../canvas/types";
import type {
	AssetConnectorType,
	AssetResult,
	ConnectorConfig,
	ProviderKey,
} from "../connectors/types";
import { errorMessage } from "../errors";
import { getProjectStore } from "../project/store";
import { generateForElement } from "./generateForElement";
import { getGenerationInputs } from "./getGenerationInputs";
import { serializeInputs, type GenerationInputs } from "./generationInputs";

export type GenerationStatus = "idle" | "queued" | "generating";

export type ElementSnapshot = {
	status: GenerationStatus;
	seconds: number;
	result: AssetResult | null;
	error: string | null;
	resultInputs: GenerationInputs | null;
	connectorType: AssetConnectorType | null;
	uploaded: boolean;
};

export function isStaleResult(
	snapshot: ElementSnapshot,
	currentInputs: GenerationInputs,
): boolean {
	if (isNil(snapshot.result)) return false;
	return !isEqual(currentInputs, snapshot.resultInputs);
}

export type GenerationJob = {
	elementId: string;
	connectorType: AssetConnectorType;
	provider: ProviderKey;
	config: ConnectorConfig;
	projectId: string;
	element: CanvasContentElement;
};

type ResultProvenance = {
	connectorType: AssetConnectorType;
	uploaded: boolean;
};

// history caches the result AND its provenance, so restoreResult can put both
// back — the uploaded bit must travel with the result it describes, not desync
// from it across a revert.
type HistoryEntry = ResultProvenance & { result: AssetResult };

const EMPTY_SNAPSHOT: ElementSnapshot = {
	status: "idle",
	seconds: 0,
	result: null,
	error: null,
	resultInputs: null,
	connectorType: null,
	uploaded: false,
};

const isActive = (status: ElementSnapshot["status"]) =>
	status === "queued" || status === "generating";

export class GenerationQueue {
	private state = new Map<string, ElementSnapshot>();
	private pending: GenerationJob[] = [];
	private controllers = new Map<string, AbortController>();
	private jobStarts = new Map<string, number>();
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private listeners = new Set<() => void>();
	private history = new Map<string, Map<string, HistoryEntry>>();
	private readonly batchSize: number;
	private _resultVersion = 0;
	private _peakActive = 0;

	constructor({
		batchSize,
		initialState = {},
	}: {
		batchSize: number;
		initialState?: Record<string, ElementSnapshot>;
	}) {
		this.batchSize = batchSize;
		for (const [id, snap] of Object.entries(initialState)) {
			// error is transient job state like status/seconds — a failure from a
			// past session shouldn't come back sitting on top of a good result.
			this.state.set(id, { ...snap, status: "idle", seconds: 0, error: null });
		}
	}

	private ensureTickTimer() {
		if (this.tickTimer || this.jobStarts.size === 0) return;
		this.tickTimer = setInterval(() => {
			let changed = false;
			const now = Date.now();
			for (const [id, start] of this.jobStarts) {
				if (this.state.get(id)?.status !== "generating") continue;
				const seconds = ((now - start) / 1000) | 0;
				if (this.getElementSnapshot(id).seconds !== seconds) {
					this.update(id, { seconds });
					changed = true;
				}
			}
			if (changed) this.notify();
		}, 1000);
	}

	private maybeStopTickTimer() {
		if (this.tickTimer && this.jobStarts.size === 0) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
	}

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getElementSnapshot = (id?: string): ElementSnapshot => {
		return (id && this.state.get(id)) || EMPTY_SNAPSHOT;
	};

	getResultVersion = () => this._resultVersion;

	isBusy = (): boolean => {
		for (const snap of this.state.values()) {
			if (isActive(snap.status)) return true;
		}
		return false;
	};

	getActiveCount = (): number => {
		let active = 0;
		for (const snap of this.state.values()) {
			if (isActive(snap.status)) active++;
		}
		return active;
	};

	getPeakActive = (): number => this._peakActive;

	snapshot(): Record<string, ElementSnapshot> {
		return Object.fromEntries(this.state);
	}

	private isInQueue(id: string): boolean {
		const s = this.state.get(id)?.status;
		return s !== undefined && isActive(s);
	}

	private update(id: string, patch: Partial<ElementSnapshot>) {
		if (
			"result" in patch &&
			patch.result !== this.getElementSnapshot(id).result
		)
			this._resultVersion++;
		this.state.set(id, { ...this.getElementSnapshot(id), ...patch });
	}

	private abortJob(id: string) {
		this.controllers.get(id)?.abort();
		this.controllers.delete(id);
		this.stopTimer(id);
		this.pending = this.pending.filter((j) => j.elementId !== id);
	}

	private resetToIdle(id: string) {
		const { result, error, resultInputs, connectorType, uploaded } =
			this.getElementSnapshot(id);
		if (result || error) {
			this.state.set(id, {
				status: "idle",
				seconds: 0,
				result,
				error,
				resultInputs,
				connectorType,
				uploaded,
			});
		} else {
			this.state.delete(id);
		}
	}

	enqueue(job: GenerationJob) {
		this.enqueueAll([job]);
	}

	enqueueAll(jobs: GenerationJob[]) {
		let added = false;
		for (const job of jobs) {
			if (this.isInQueue(job.elementId)) continue;
			this.update(job.elementId, {
				status: "queued",
				seconds: 0,
				connectorType: job.connectorType,
				// The previous attempt's error is stale the moment we retry.
				error: null,
			});
			this.pending.push(job);
			added = true;
		}
		if (added) {
			this.notify();
			this.processQueue();
		}
	}

	cancel(elementId: string) {
		if (!this.isInQueue(elementId)) return;
		this.abortJob(elementId);
		this.resetToIdle(elementId);
		this.notify();
		this.processQueue();
	}

	cancelAll() {
		for (const [id, controller] of this.controllers) {
			controller.abort();
			this.stopTimer(id);
		}
		this.controllers.clear();
		this.pending = [];
		for (const id of this.state.keys()) {
			this.resetToIdle(id);
		}
		this.notify();
	}

	discard(elementId: string) {
		const hadEntry = this.isInQueue(elementId);
		if (hadEntry) this.abortJob(elementId);
		if (this.state.get(elementId)?.result) this._resultVersion++;
		this.state.delete(elementId);
		this.notify();
		if (hadEntry) this.processQueue();
	}

	// Caller must cancel() any in-flight job first, or a late-resolving job can clobber this.
	commitResult(
		elementId: string,
		result: AssetResult,
		inputs: GenerationInputs,
		provenance: ResultProvenance,
	): void {
		const key = serializeInputs(inputs);
		const elHistory =
			this.history.get(elementId) ?? new Map<string, HistoryEntry>();
		elHistory.set(key, { result, ...provenance });
		this.history.set(elementId, elHistory);
		this.update(elementId, {
			status: "idle",
			seconds: 0,
			result,
			error: null,
			resultInputs: inputs,
			...provenance,
		});
		this.notify();
	}

	restoreResult(elementId: string, inputs: GenerationInputs): boolean {
		const key = serializeInputs(inputs);
		const cached = this.history.get(elementId)?.get(key);
		if (!cached) return false;
		this.update(elementId, {
			result: cached.result,
			error: null,
			resultInputs: inputs,
			connectorType: cached.connectorType,
			uploaded: cached.uploaded,
		});
		this.notify();
		return true;
	}

	private notify() {
		const active = this.getActiveCount();
		this._peakActive = active === 0 ? 0 : Math.max(this._peakActive, active);
		for (const listener of this.listeners) {
			listener();
		}
	}

	private stopTimer(elementId: string) {
		this.jobStarts.delete(elementId);
		this.maybeStopTickTimer();
	}

	private processQueue() {
		while (this.controllers.size < this.batchSize && this.pending.length > 0) {
			const job = this.pending.shift();
			if (!job) break;
			this.runJob(job);
		}
	}

	private runJob(job: GenerationJob) {
		const { elementId } = job;
		const controller = new AbortController();
		this.controllers.set(elementId, controller);

		this.update(elementId, { status: "generating", seconds: 0 });
		this.notify();
		this.startElapsedTimer(elementId);

		const { metadata } = getProjectStore(job.projectId).getState();
		const inputs = getGenerationInputs(job.element, metadata);
		generateForElement(job, inputs)
			.then((result) => this.handleJobSuccess(job, inputs, result, controller))
			.catch((err) => this.handleJobError(elementId, err, controller))
			.finally(() => this.finalizeJob(elementId, controller));
	}

	private startElapsedTimer(elementId: string) {
		this.jobStarts.set(elementId, Date.now());
		this.ensureTickTimer();
	}

	private handleJobSuccess(
		job: GenerationJob,
		inputs: GenerationInputs,
		result: AssetResult,
		controller: AbortController,
	) {
		if (controller.signal.aborted) return;
		this.commitResult(job.elementId, result, inputs, {
			connectorType: job.connectorType,
			uploaded: false,
		});
	}

	private handleJobError(
		elementId: string,
		err: unknown,
		controller: AbortController,
	) {
		if (controller.signal.aborted) return;
		console.error(`Generation failed for element ${elementId}:`, err);
		// Keep the existing result: an upload can't be re-rolled, history isn't
		// persisted, and restoreResult can't fire once result is nil.
		this.update(elementId, {
			status: "idle",
			seconds: 0,
			error: errorMessage(err),
		});
		this.notify();
	}

	// Both terminal handlers notify (commitResult on success, handleJobError on
	// failure), so this only does queue bookkeeping.
	private finalizeJob(elementId: string, controller: AbortController) {
		if (controller.signal.aborted) return;
		this.stopTimer(elementId);
		this.controllers.delete(elementId);
		this.processQueue();
	}
}

export const DEFAULT_BATCH_SIZE = 2;
