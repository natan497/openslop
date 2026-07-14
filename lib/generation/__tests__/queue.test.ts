import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CanvasContentElement } from "@/lib/canvas/types";
import type { ConnectorConfig } from "@/lib/connectors/types";
import { pickThumbnailUrl } from "@/lib/project/thumbnail";
import type { GenerationInputs } from "../generationInputs";
import { GenerationQueue, type GenerationJob } from "../queue";

type GenerateFn = (...args: unknown[]) => Promise<unknown>;
let generateMock: ReturnType<typeof vi.fn<GenerateFn>>;

vi.mock("../generateForElement", () => ({
	generateForElement: (...args: unknown[]) => generateMock(...args),
}));

function makeElement(
	id: string,
	inputs: GenerationInputs,
): CanvasContentElement {
	return {
		id,
		type: "sound",
		customAttributes: Object.fromEntries(
			Object.entries(inputs.attributes).map(([k, v]) => [k, String(v)]),
		),
		children: [{ id: `${id}-t`, type: "image", text: inputs.prompt }],
	};
}

type JobOverrides = Partial<GenerationJob> & { inputs?: GenerationInputs };

function makeJob(id: string, overrides: JobOverrides = {}): GenerationJob {
	const config: ConnectorConfig = {
		defaultModel: "test-model",
		models: ["test-model"],
		isDefault: true,
	};
	const { inputs = { prompt: "test prompt", attributes: {} }, ...rest } =
		overrides;
	return {
		elementId: id,
		connectorType: "image",
		provider: "openslop",
		config,
		projectId: "test-project",
		element: makeElement(id, inputs),
		...rest,
	};
}

let generationQueue: GenerationQueue;

describe("GenerationQueue", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		generateMock = vi.fn();
		generationQueue = new GenerationQueue({ batchSize: 3 });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("getElementSnapshot", () => {
		it("returns idle snapshot for unknown element", () => {
			const snap = generationQueue.getElementSnapshot("unknown-id");
			expect(snap).toEqual({
				status: "idle",
				seconds: 0,
				result: null,
				error: null,
				resultInputs: null,
				connectorType: null,
				uploaded: false,
			});
		});
	});

	describe("subscribe", () => {
		it("calls listener on enqueue and returns unsubscribe fn", () => {
			const listener = vi.fn();
			const unsub = generationQueue.subscribe(listener);

			generateMock.mockReturnValue(new Promise(() => {}));
			generationQueue.enqueue(makeJob("sub-1"));
			expect(listener).toHaveBeenCalled();

			const callCount = listener.mock.calls.length;
			unsub();
			generationQueue.enqueue(makeJob("sub-2"));
			// After unsubscribe, listener should not be called again
			// (sub-2 is a new job so enqueue would normally notify)
			// Note: sub-1 might still be generating, but sub-2 is different
			expect(listener).toHaveBeenCalledTimes(callCount);

			generationQueue.discard("sub-1");
			generationQueue.discard("sub-2");
		});
	});

	describe("enqueue", () => {
		it("sets element status to generating when under batch limit", () => {
			generateMock.mockReturnValue(new Promise(() => {}));
			generationQueue.enqueue(makeJob("e1"));

			const snap = generationQueue.getElementSnapshot("e1");
			expect(snap.status).toBe("generating");

			generationQueue.discard("e1");
		});

		it("sets element status to queued when at batch limit", () => {
			generateMock.mockReturnValue(new Promise(() => {}));

			// Fill up the batch (size 3)
			generationQueue.enqueueAll([makeJob("b1"), makeJob("b2"), makeJob("b3")]);
			// 4th job should be queued, not generating
			generationQueue.enqueue(makeJob("b4"));

			expect(generationQueue.getElementSnapshot("b1").status).toBe(
				"generating",
			);
			expect(generationQueue.getElementSnapshot("b2").status).toBe(
				"generating",
			);
			expect(generationQueue.getElementSnapshot("b3").status).toBe(
				"generating",
			);
			expect(generationQueue.getElementSnapshot("b4").status).toBe("queued");

			generationQueue.discard("b1");
			generationQueue.discard("b2");
			generationQueue.discard("b3");
			generationQueue.discard("b4");
		});

		it("does not re-enqueue an element already in the queue", () => {
			generateMock.mockReturnValue(new Promise(() => {}));
			const listener = vi.fn();
			generationQueue.subscribe(listener);

			generationQueue.enqueue(makeJob("dup1"));
			const firstCount = listener.mock.calls.length;

			generationQueue.enqueue(makeJob("dup1"));
			// No additional notifications because the element was skipped
			expect(listener).toHaveBeenCalledTimes(firstCount);

			generationQueue.discard("dup1");
		});
	});

	describe("enqueueAll", () => {
		it("enqueues multiple jobs at once", () => {
			generateMock.mockReturnValue(new Promise(() => {}));
			generationQueue.enqueueAll([makeJob("m1"), makeJob("m2")]);

			expect(generationQueue.getElementSnapshot("m1").status).toBe(
				"generating",
			);
			expect(generationQueue.getElementSnapshot("m2").status).toBe(
				"generating",
			);

			generationQueue.discard("m1");
			generationQueue.discard("m2");
		});

		it("does not notify if no new jobs were added", () => {
			generateMock.mockReturnValue(new Promise(() => {}));
			generationQueue.enqueue(makeJob("existing"));

			const listener = vi.fn();
			generationQueue.subscribe(listener);
			generationQueue.enqueueAll([makeJob("existing")]);
			expect(listener).not.toHaveBeenCalled();

			generationQueue.discard("existing");
		});
	});

	describe("successful generation", () => {
		it("stores result and resets to idle on success", async () => {
			const result = { url: "https://example.com/image.png" };
			generateMock.mockResolvedValue(result);

			generationQueue.enqueue(makeJob("ok1"));
			await vi.runAllTimersAsync();

			const snap = generationQueue.getElementSnapshot("ok1");
			expect(snap.status).toBe("idle");
			expect(snap.result).toEqual(result);
			expect(snap.error).toBeNull();
		});
	});

	describe("failed generation", () => {
		it("stores error message on failure", async () => {
			generateMock.mockRejectedValue(new Error("generation failed"));

			generationQueue.enqueue(makeJob("err1"));
			await vi.runAllTimersAsync();

			const snap = generationQueue.getElementSnapshot("err1");
			expect(snap.status).toBe("idle");
			expect(snap.result).toBeNull();
			expect(snap.error).toBe("generation failed");
		});

		it("converts non-Error throws to string", async () => {
			generateMock.mockRejectedValue("string error");

			generationQueue.enqueue(makeJob("err2"));
			await vi.runAllTimersAsync();

			expect(generationQueue.getElementSnapshot("err2").error).toBe(
				"string error",
			);
		});

		it("notifies subscribers when a job fails", async () => {
			generateMock.mockRejectedValue(new Error("boom"));
			generationQueue.enqueue(makeJob("err3"));
			const listener = vi.fn();
			generationQueue.subscribe(listener);

			await vi.runAllTimersAsync();

			// handleJobError owns the failure notify (finalizeJob no longer
			// notifies), so the error must still reach subscribers.
			expect(listener).toHaveBeenCalled();
			expect(generationQueue.getElementSnapshot("err3").error).toBe("boom");
		});

		it("clears the uploaded flag when a regenerate over an upload fails", async () => {
			const inputs = { prompt: "p", attributes: {} };
			generationQueue.commitResult(
				"err4",
				{ imageUrl: "https://example.com/up.png", durationSec: 0 },
				inputs,
				{ connectorType: "image", uploaded: true },
			);
			generateMock.mockRejectedValue(new Error("gen failed"));
			generationQueue.enqueue(makeJob("err4", { inputs }));
			await vi.runAllTimersAsync();

			const snap = generationQueue.getElementSnapshot("err4");
			expect(snap.result).toBeNull();
			expect(snap.uploaded).toBe(false);
		});
	});

	describe("cancel", () => {
		it("cancels a generating job and resets to idle", () => {
			generateMock.mockReturnValue(new Promise(() => {}));
			generationQueue.enqueue(makeJob("c1"));
			expect(generationQueue.getElementSnapshot("c1").status).toBe(
				"generating",
			);

			generationQueue.cancel("c1");
			const snap = generationQueue.getElementSnapshot("c1");
			// No previous result or error, so state is fully deleted
			expect(snap.status).toBe("idle");
			expect(snap.result).toBeNull();
		});

		it("preserves previous result after cancellation", async () => {
			const result = { url: "https://example.com/prev.png" };
			generateMock.mockResolvedValue(result);
			generationQueue.enqueue(makeJob("c2"));
			await vi.runAllTimersAsync();
			expect(generationQueue.getElementSnapshot("c2").result).toEqual(result);

			// Re-enqueue and cancel during generation
			generateMock.mockReturnValue(new Promise(() => {}));
			generationQueue.enqueue(makeJob("c2"));
			generationQueue.cancel("c2");

			const snap = generationQueue.getElementSnapshot("c2");
			expect(snap.status).toBe("idle");
			expect(snap.result).toEqual(result);
		});

		it("is a no-op for elements not in the queue", () => {
			const listener = vi.fn();
			generationQueue.subscribe(listener);
			generationQueue.cancel("nonexistent");
			expect(listener).not.toHaveBeenCalled();
		});

		it("promotes queued jobs when a generating job is cancelled", () => {
			generateMock.mockReturnValue(new Promise(() => {}));
			generationQueue.enqueueAll([
				makeJob("p1"),
				makeJob("p2"),
				makeJob("p3"),
				makeJob("p4"),
			]);
			expect(generationQueue.getElementSnapshot("p4").status).toBe("queued");

			generationQueue.cancel("p1");
			expect(generationQueue.getElementSnapshot("p4").status).toBe(
				"generating",
			);

			generationQueue.discard("p1");
			generationQueue.discard("p2");
			generationQueue.discard("p3");
			generationQueue.discard("p4");
		});
	});

	describe("cancelAll", () => {
		it("cancels all jobs and clears the queue", () => {
			generateMock.mockReturnValue(new Promise(() => {}));
			generationQueue.enqueueAll([
				makeJob("a1"),
				makeJob("a2"),
				makeJob("a3"),
				makeJob("a4"),
			]);

			generationQueue.cancelAll();

			expect(generationQueue.getElementSnapshot("a1").status).toBe("idle");
			expect(generationQueue.getElementSnapshot("a2").status).toBe("idle");
			expect(generationQueue.getElementSnapshot("a3").status).toBe("idle");
			// a4 was queued (not generating), so it had no result/error — state deleted
			expect(generationQueue.getElementSnapshot("a4").status).toBe("idle");
		});
	});

	describe("discard", () => {
		it("removes element state entirely", () => {
			generateMock.mockReturnValue(new Promise(() => {}));
			generationQueue.enqueue(makeJob("d1"));

			generationQueue.discard("d1");
			const snap = generationQueue.getElementSnapshot("d1");
			expect(snap).toEqual({
				status: "idle",
				seconds: 0,
				result: null,
				error: null,
				resultInputs: null,
				connectorType: null,
				uploaded: false,
			});
		});

		it("promotes queued jobs when discarding a generating element", () => {
			generateMock.mockReturnValue(new Promise(() => {}));
			generationQueue.enqueueAll([
				makeJob("d2"),
				makeJob("d3"),
				makeJob("d4"),
				makeJob("d5"),
			]);
			expect(generationQueue.getElementSnapshot("d5").status).toBe("queued");

			generationQueue.discard("d2");
			expect(generationQueue.getElementSnapshot("d5").status).toBe(
				"generating",
			);

			generationQueue.discard("d3");
			generationQueue.discard("d4");
			generationQueue.discard("d5");
		});
	});

	describe("setError", () => {
		it("sets an error on an element", () => {
			generationQueue.setError("se1", "something went wrong");
			const snap = generationQueue.getElementSnapshot("se1");
			expect(snap.error).toBe("something went wrong");
			expect(snap.result).toBeNull();

			generationQueue.discard("se1");
		});

		it("clears the uploaded flag when it nulls the result", () => {
			// Upload, then a failed regenerate lands here — leaving uploaded true
			// with no result would make Generate All skip the element forever.
			generationQueue.commitResult(
				"se2",
				{ imageUrl: "https://example.com/up.png", durationSec: 0 },
				{ prompt: "p", attributes: {} },
				{ connectorType: "image", uploaded: true },
			);
			generationQueue.setError("se2", "regenerate failed");

			const snap = generationQueue.getElementSnapshot("se2");
			expect(snap.result).toBeNull();
			expect(snap.uploaded).toBe(false);

			generationQueue.discard("se2");
		});
	});

	describe("commitResult", () => {
		it("sets result, connectorType, clears error, and moves status to idle", () => {
			const result = {
				imageUrl: "https://example.com/upload.png",
				durationSec: 0,
			};
			const inputs = { prompt: "p", attributes: {} };
			generationQueue.commitResult("sm1", result, inputs, {
				connectorType: "image",
				uploaded: true,
			});

			const snap = generationQueue.getElementSnapshot("sm1");
			expect(snap.status).toBe("idle");
			expect(snap.result).toEqual(result);
			expect(snap.error).toBeNull();
			expect(snap.resultInputs).toEqual(inputs);
			// Without this, pickThumbnailUrl skips the upload and the project card
			// stays blank (no job ran to set connectorType).
			expect(snap.connectorType).toBe("image");
			expect(snap.uploaded).toBe(true);

			generationQueue.discard("sm1");
		});

		it("makes an uploaded-only image project's thumbnail resolve via pickThumbnailUrl", () => {
			// The exact repro: new project, drop an image element, upload without
			// ever hitting generate — pickThumbnailUrl must still find the image.
			generationQueue.commitResult(
				"scene-1",
				{ imageUrl: "https://example.com/upload.png", durationSec: 0 },
				{ prompt: "", attributes: {} },
				{ connectorType: "image", uploaded: true },
			);

			const thumbnail = pickThumbnailUrl(
				Object.entries(generationQueue.snapshot()),
			);
			expect(thumbnail).toBe("https://example.com/upload.png");

			generationQueue.discard("scene-1");
		});

		it("overwrites an existing generated result", async () => {
			const generated = {
				url: "https://example.com/generated.png",
				durationSec: 0,
			};
			generateMock.mockResolvedValue(generated);
			const inputs = { prompt: "p", attributes: {} };
			generationQueue.enqueue(makeJob("sm2", { inputs }));
			await vi.runAllTimersAsync();
			expect(generationQueue.getElementSnapshot("sm2").result).toEqual(
				generated,
			);

			const uploaded = {
				imageUrl: "https://example.com/upload.png",
				durationSec: 0,
			};
			generationQueue.commitResult("sm2", uploaded, inputs, {
				connectorType: "image",
				uploaded: true,
			});
			expect(generationQueue.getElementSnapshot("sm2").result).toEqual(
				uploaded,
			);

			generationQueue.discard("sm2");
		});

		it("overwrites an existing error", () => {
			generationQueue.setError("sm3", "something went wrong");
			expect(generationQueue.getElementSnapshot("sm3").error).toBe(
				"something went wrong",
			);

			const uploaded = {
				imageUrl: "https://example.com/upload.png",
				durationSec: 0,
			};
			generationQueue.commitResult(
				"sm3",
				uploaded,
				{
					prompt: "p",
					attributes: {},
				},
				{ connectorType: "image", uploaded: true },
			);
			const snap = generationQueue.getElementSnapshot("sm3");
			expect(snap.error).toBeNull();
			expect(snap.result).toEqual(uploaded);

			generationQueue.discard("sm3");
		});

		it("populates history so a later restoreResult recovers it", () => {
			const uploaded = {
				imageUrl: "https://example.com/upload.png",
				durationSec: 0,
			};
			const inputs = { prompt: "p", attributes: {} };
			generationQueue.commitResult("sm4", uploaded, inputs, {
				connectorType: "image",
				uploaded: true,
			});
			generationQueue.setError("sm4", "prompt changed");
			expect(generationQueue.getElementSnapshot("sm4").result).toBeNull();

			const restored = generationQueue.restoreResult("sm4", inputs);
			expect(restored).toBe(true);
			expect(generationQueue.getElementSnapshot("sm4").result).toEqual(
				uploaded,
			);

			generationQueue.discard("sm4");
		});

		it("notifies subscribers", () => {
			const listener = vi.fn();
			generationQueue.subscribe(listener);
			generationQueue.commitResult(
				"sm5",
				{ imageUrl: "https://example.com/upload.png", durationSec: 0 },
				{ prompt: "p", attributes: {} },
				{ connectorType: "image", uploaded: true },
			);
			expect(listener).toHaveBeenCalled();

			generationQueue.discard("sm5");
		});

		it("does not let a cancelled in-flight job clobber a result committed after it", async () => {
			let resolveGenerate: (value: unknown) => void = () => {};
			generateMock.mockReturnValue(
				new Promise((resolve) => {
					resolveGenerate = resolve;
				}),
			);
			const inputs = { prompt: "p", attributes: {} };
			generationQueue.enqueue(makeJob("sm6", { inputs }));
			expect(generationQueue.getElementSnapshot("sm6").status).toBe(
				"generating",
			);

			// The caller contract for uploads: cancel the in-flight job, then commit.
			const uploaded = {
				imageUrl: "https://example.com/upload.png",
				durationSec: 0,
			};
			generationQueue.cancel("sm6");
			generationQueue.commitResult("sm6", uploaded, inputs, {
				connectorType: "image",
				uploaded: true,
			});
			expect(generationQueue.getElementSnapshot("sm6").result).toEqual(
				uploaded,
			);

			// The cancelled job resolves afterwards — it must not overwrite the
			// committed result.
			resolveGenerate({
				url: "https://example.com/generated.png",
				durationSec: 0,
			});
			await vi.runAllTimersAsync();
			expect(generationQueue.getElementSnapshot("sm6").result).toEqual(
				uploaded,
			);

			generationQueue.discard("sm6");
		});
	});

	describe("restoreResult", () => {
		it("restores cached result for the same inputs", async () => {
			const result = { url: "https://example.com/asset.png", durationSec: 0 };
			generateMock.mockResolvedValue(result);
			const inputs = { prompt: "p", attributes: { a: "1", b: "2" } };
			generationQueue.enqueue(makeJob("rr1", { inputs }));
			await vi.runAllTimersAsync();

			// Simulate the result drifting by setting an error first
			generationQueue.setError("rr1", "stale");
			expect(generationQueue.getElementSnapshot("rr1").result).toBeNull();

			const restored = generationQueue.restoreResult("rr1", inputs);
			expect(restored).toBe(true);
			const snap = generationQueue.getElementSnapshot("rr1");
			expect(snap.result).toEqual(result);
			expect(snap.error).toBeNull();
		});

		it("returns false when no cached result exists", () => {
			const restored = generationQueue.restoreResult("never-generated", {
				prompt: "p",
				attributes: {},
			});
			expect(restored).toBe(false);
		});

		it("hits cache regardless of attribute key order (serialization stability)", async () => {
			const result = { url: "https://example.com/asset.png", durationSec: 0 };
			generateMock.mockResolvedValue(result);
			generationQueue.enqueue(
				makeJob("rr2", {
					inputs: { prompt: "p", attributes: { a: "1", b: "2" } },
				}),
			);
			await vi.runAllTimersAsync();
			generationQueue.setError("rr2", "stale");

			// Look up with reversed key insertion order
			const restored = generationQueue.restoreResult("rr2", {
				prompt: "p",
				attributes: { b: "2", a: "1" },
			});
			expect(restored).toBe(true);
			expect(generationQueue.getElementSnapshot("rr2").result).toEqual(result);
		});

		it("restores the uploaded flag with the result (upload stays uploaded)", () => {
			const inputs = { prompt: "p", attributes: {} };
			const upload = { imageUrl: "https://example.com/up.png", durationSec: 0 };
			generationQueue.commitResult("rr3", upload, inputs, {
				connectorType: "image",
				uploaded: true,
			});
			generationQueue.setError("rr3", "drifted");

			generationQueue.restoreResult("rr3", inputs);
			const snap = generationQueue.getElementSnapshot("rr3");
			expect(snap.result).toEqual(upload);
			expect(snap.uploaded).toBe(true);
		});

		it("restores a generated result as not-uploaded even over a prior uploaded state", async () => {
			// The laundering repro: upload at prompt A, generate at prompt B, then
			// revert to A. Restoring A must bring back the upload AND its uploaded
			// flag — not inherit uploaded:false from the intervening generation.
			const inputsA = { prompt: "A", attributes: {} };
			const inputsB = { prompt: "B", attributes: {} };
			const upload = { imageUrl: "https://example.com/up.png", durationSec: 0 };
			const generated = { url: "https://example.com/gen.png", durationSec: 0 };

			generationQueue.commitResult("rr4", upload, inputsA, {
				connectorType: "image",
				uploaded: true,
			});
			generateMock.mockResolvedValue(generated);
			generationQueue.enqueue(makeJob("rr4", { inputs: inputsB }));
			await vi.runAllTimersAsync();
			// Now at generated/B, uploaded reset to false.
			expect(generationQueue.getElementSnapshot("rr4").uploaded).toBe(false);

			// Restore B (generated): stays not-uploaded.
			generationQueue.restoreResult("rr4", inputsB);
			expect(generationQueue.getElementSnapshot("rr4").uploaded).toBe(false);

			// Restore A (upload): uploaded travels back with it, so a later
			// Generate All can't launder it into a regeneratable result.
			generationQueue.restoreResult("rr4", inputsA);
			const snap = generationQueue.getElementSnapshot("rr4");
			expect(snap.result).toEqual(upload);
			expect(snap.uploaded).toBe(true);
		});
	});

	describe("batch processing", () => {
		it("processes queued jobs after generating ones complete", async () => {
			let resolve1: (v: { url: string }) => void = () => {};
			const p1 = new Promise<{ url: string }>((r) => {
				resolve1 = r;
			});
			generateMock
				.mockReturnValueOnce(p1)
				.mockReturnValueOnce(new Promise(() => {}))
				.mockReturnValueOnce(new Promise(() => {}))
				.mockReturnValueOnce(new Promise(() => {}));

			generationQueue.enqueueAll([
				makeJob("q1"),
				makeJob("q2"),
				makeJob("q3"),
				makeJob("q4"),
			]);

			expect(generationQueue.getElementSnapshot("q4").status).toBe("queued");

			// Complete the first job and flush microtasks
			resolve1({ url: "done" });
			await vi.advanceTimersByTimeAsync(0);

			expect(generationQueue.getElementSnapshot("q1").status).toBe("idle");
			expect(generationQueue.getElementSnapshot("q4").status).toBe(
				"generating",
			);

			generationQueue.discard("q1");
			generationQueue.discard("q2");
			generationQueue.discard("q3");
			generationQueue.discard("q4");
		});
	});

	describe("timer", () => {
		it("increments seconds while generating", async () => {
			generateMock.mockReturnValue(new Promise(() => {}));
			generationQueue.enqueue(makeJob("t1"));

			expect(generationQueue.getElementSnapshot("t1").seconds).toBe(0);

			await vi.advanceTimersByTimeAsync(3000);
			expect(generationQueue.getElementSnapshot("t1").seconds).toBeGreaterThan(
				0,
			);

			generationQueue.discard("t1");
		});
	});

	describe("snapshot", () => {
		const idleEntry = {
			status: "idle" as const,
			seconds: 0,
			result: { url: "u", durationSec: 2 },
			error: null,
			resultInputs: { prompt: "p", attributes: {} },
			connectorType: "image" as const,
			uploaded: false,
		};

		it("dumps every entry verbatim", async () => {
			generateMock.mockResolvedValue(idleEntry.result);
			generationQueue.enqueue(
				makeJob("s1", { inputs: idleEntry.resultInputs }),
			);
			await vi.advanceTimersByTimeAsync(0);

			expect(generationQueue.snapshot()).toEqual({ s1: idleEntry });
		});

		it("includes errored entries", () => {
			generationQueue.setError("s2", "boom");
			expect(generationQueue.snapshot()).toEqual({
				s2: {
					status: "idle",
					seconds: 0,
					result: null,
					error: "boom",
					resultInputs: null,
					connectorType: null,
					uploaded: false,
				},
			});
		});
	});

	describe("initialState", () => {
		const idleEntry = {
			status: "idle" as const,
			seconds: 0,
			result: { url: "u", durationSec: 2 },
			error: null,
			resultInputs: { prompt: "p", attributes: {} },
			connectorType: "image" as const,
			uploaded: false,
		};

		it("populates entries from the constructor", () => {
			const q = new GenerationQueue({
				batchSize: 3,
				initialState: { h1: idleEntry },
			});
			expect(q.getElementSnapshot("h1")).toEqual(idleEntry);
		});

		it("preserves the uploaded flag across rehydration (reload)", () => {
			// A persisted upload must come back as uploaded:true, or the first
			// Generate All after reload would clobber it.
			const q = new GenerationQueue({
				batchSize: 3,
				initialState: { up: { ...idleEntry, uploaded: true } },
			});
			expect(q.getElementSnapshot("up").uploaded).toBe(true);
		});

		it("normalizes stale 'generating' status back to idle", () => {
			const q = new GenerationQueue({
				batchSize: 3,
				initialState: {
					h2: { ...idleEntry, status: "generating", seconds: 42 },
				},
			});
			const snap = q.getElementSnapshot("h2");
			expect(snap.status).toBe("idle");
			expect(snap.seconds).toBe(0);
		});

		it("makes isStaleResult correct after rehydration", async () => {
			const { isStaleResult } = await import("../queue");
			const q = new GenerationQueue({
				batchSize: 3,
				initialState: { h3: idleEntry },
			});

			expect(
				isStaleResult(q.getElementSnapshot("h3"), idleEntry.resultInputs),
			).toBe(false);
			expect(
				isStaleResult(q.getElementSnapshot("h3"), {
					prompt: "different",
					attributes: {},
				}),
			).toBe(true);
		});
	});
});
