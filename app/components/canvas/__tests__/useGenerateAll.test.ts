import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Descendant } from "slate";
import type { ConnectorRegistry } from "@/lib/config/ConfigProvider";
import type { GenerationJob } from "@/lib/generation/queue";
import type { CanvasContentElement, SceneElement } from "@/lib/canvas/types";

const registry: ConnectorRegistry = {
	llm: {
		openslop: {
			defaultModel: "m",
			models: ["m"],
			isDefault: true,
		},
	},
	tts: {
		openslop: {
			defaultModel: "m",
			models: ["m"],
			isDefault: true,
		},
	},
	image: {
		openslop: {
			defaultModel: "m",
			models: ["m"],
			isDefault: true,
		},
	},
	animated_image: {
		openslop: {
			defaultModel: "m",
			models: ["m"],
			isDefault: true,
		},
	},
	video: {
		openslop: {
			defaultModel: "m",
			models: ["m"],
			isDefault: true,
		},
	},
	sfx: {
		openslop: {
			defaultModel: "m",
			models: ["m"],
			isDefault: true,
		},
	},
	music: {
		openslop: {
			defaultModel: "m",
			models: ["m"],
			isDefault: true,
		},
	},
};

vi.mock("@/lib/config/ConfigProvider", () => ({
	useConfig: () => ({ projectId: "test-project", connectorConfig: registry }),
}));

vi.mock("react", () => ({
	useCallback: <T>(fn: T) => fn,
}));

const enqueueAllSpy = vi.fn();
const getElementSnapshotSpy = vi.fn();

vi.mock("@/lib/generation/GenerationQueueProvider", () => ({
	useGenerationQueue: () => ({
		enqueueAll: (...args: unknown[]) => enqueueAllSpy(...args),
		getElementSnapshot: (...args: unknown[]) => getElementSnapshotSpy(...args),
	}),
}));

vi.mock("@/lib/project/ensureCharacterAvatars", () => ({
	ensureCharacterAvatars: vi.fn(),
}));

function makeElement(
	id: string,
	type: CanvasContentElement["type"],
	text: string,
	attrs?: Record<string, string>,
): CanvasContentElement {
	return {
		id,
		type,
		customAttributes: attrs,
		children: [{ id: `${id}-t`, type, text }],
	};
}

function wrapInScene(elements: CanvasContentElement[]): SceneElement {
	return { id: "scene-1", type: "scene", children: elements };
}

beforeEach(() => {
	vi.clearAllMocks();
	getElementSnapshotSpy.mockReturnValue({
		status: "idle",
		seconds: 0,
		result: null,
		error: null,
		resultInputs: null,
	});
});

describe("useGenerateAll", () => {
	it("enqueues jobs for all elements without results", async () => {
		const { useGenerateAll } = await import("../hooks/useGenerateAll");
		const children: Descendant[] = [
			wrapInScene([
				makeElement("a", "image", "sunset"),
				makeElement("b", "narration", "hello"),
			]),
		];
		const editor = { children } as unknown as Parameters<
			typeof useGenerateAll
		>[0];

		const { generateAll } = useGenerateAll(editor);
		generateAll();

		expect(enqueueAllSpy).toHaveBeenCalledOnce();
		const jobs: GenerationJob[] = enqueueAllSpy.mock.calls[0][0];
		expect(jobs).toHaveLength(2);
		expect(jobs.map((j) => j.elementId)).toEqual(["a", "b"]);
	});

	it("skips elements that already have a current result", async () => {
		getElementSnapshotSpy.mockImplementation((id: string) => ({
			status: "idle",
			seconds: 0,
			result: id === "a" ? { url: "https://example.com/img.png" } : null,
			error: null,
			resultInputs:
				id === "a"
					? { prompt: "sunset", attributes: { width: 2560, height: 1440 } }
					: null,
			connectorType: id === "a" ? "image" : null,
		}));

		const { useGenerateAll } = await import("../hooks/useGenerateAll");
		const children: Descendant[] = [
			wrapInScene([
				makeElement("a", "image", "sunset"),
				makeElement("b", "narration", "hello"),
			]),
		];
		const editor = { children } as unknown as Parameters<
			typeof useGenerateAll
		>[0];

		const { generateAll } = useGenerateAll(editor);
		generateAll();

		const jobs: GenerationJob[] = enqueueAllSpy.mock.calls[0][0];
		expect(jobs).toHaveLength(1);
		expect(jobs[0].elementId).toBe("b");
	});

	it("re-generates elements with stale prompt", async () => {
		getElementSnapshotSpy.mockImplementation((id: string) => ({
			status: "idle",
			seconds: 0,
			result: id === "a" ? { url: "https://example.com/img.png" } : null,
			error: null,
			resultInputs:
				id === "a" ? { prompt: "old prompt", attributes: {} } : null,
			connectorType: id === "a" ? "image" : null,
		}));

		const { useGenerateAll } = await import("../hooks/useGenerateAll");
		const children: Descendant[] = [
			wrapInScene([
				makeElement("a", "image", "new prompt"),
				makeElement("b", "narration", "hello"),
			]),
		];
		const editor = { children } as unknown as Parameters<
			typeof useGenerateAll
		>[0];

		const { generateAll } = useGenerateAll(editor);
		generateAll();

		const jobs: GenerationJob[] = enqueueAllSpy.mock.calls[0][0];
		expect(jobs).toHaveLength(2);
		expect(jobs.map((j) => j.elementId)).toEqual(["a", "b"]);
	});

	it("re-generates elements with stale attributes", async () => {
		getElementSnapshotSpy.mockImplementation((id: string) => ({
			status: "idle",
			seconds: 0,
			result: id === "a" ? { url: "https://example.com/img.png" } : null,
			error: null,
			resultInputs:
				id === "a"
					? { prompt: "hello", attributes: { emotion: "calm" } }
					: null,
			connectorType: id === "a" ? "tts" : null,
		}));

		const { useGenerateAll } = await import("../hooks/useGenerateAll");
		const children: Descendant[] = [
			wrapInScene([
				makeElement("a", "narration", "hello", { emotion: "happy" }),
				makeElement("b", "image", "sunset"),
			]),
		];
		const editor = { children } as unknown as Parameters<
			typeof useGenerateAll
		>[0];

		const { generateAll } = useGenerateAll(editor);
		generateAll();

		const jobs: GenerationJob[] = enqueueAllSpy.mock.calls[0][0];
		expect(jobs).toHaveLength(2);
		expect(jobs.map((j) => j.elementId)).toEqual(["a", "b"]);
	});

	it("enqueues nothing when all elements have current results", async () => {
		getElementSnapshotSpy.mockImplementation((id: string) => {
			const inputs: Record<
				string,
				{ prompt: string; attributes: Record<string, string | number> }
			> = {
				a: { prompt: "sunset", attributes: { width: 2560, height: 1440 } },
				b: { prompt: "hello", attributes: {} },
			};
			const connectorType: Record<string, string> = { a: "image", b: "tts" };
			return {
				status: "idle",
				seconds: 0,
				result: { url: "https://example.com/asset.png" },
				error: null,
				resultInputs: inputs[id],
				connectorType: connectorType[id],
			};
		});

		const { useGenerateAll } = await import("../hooks/useGenerateAll");
		const children: Descendant[] = [
			wrapInScene([
				makeElement("a", "image", "sunset"),
				makeElement("b", "narration", "hello"),
			]),
		];
		const editor = { children } as unknown as Parameters<
			typeof useGenerateAll
		>[0];

		const { generateAll } = useGenerateAll(editor);
		generateAll();

		const jobs: GenerationJob[] = enqueueAllSpy.mock.calls[0][0];
		expect(jobs).toHaveLength(0);
	});

	// A generated (not uploaded) result left over from before a type change can
	// coincidentally look non-stale under the new type's inputs -- only the
	// connector mismatch reveals it belongs to a connector this element no
	// longer uses.
	it("regenerates a non-uploaded result left over from a type change", async () => {
		getElementSnapshotSpy.mockImplementation((id: string) => ({
			status: "idle",
			seconds: 0,
			result: id === "a" ? { imageUrl: "https://example.com/gen.png" } : null,
			error: null,
			// Matches the width/height/videoWidth/videoHeight the default 16:9
			// aspect ratio injects for an animated_image element, so this result
			// is NOT stale under isStaleResult -- only the connector mismatch
			// (left over from before the type change) reveals it's unusable.
			resultInputs:
				id === "a"
					? {
							prompt: "wizard sign",
							attributes: {
								width: 2560,
								height: 1440,
								videoWidth: 1280,
								videoHeight: 720,
							},
						}
					: null,
			uploaded: false,
			connectorType: id === "a" ? "image" : null,
		}));

		const { useGenerateAll } = await import("../hooks/useGenerateAll");
		const children: Descendant[] = [
			wrapInScene([makeElement("a", "animated_image", "wizard sign")]),
		];
		const editor = { children } as unknown as Parameters<
			typeof useGenerateAll
		>[0];

		const { generateAll } = useGenerateAll(editor);
		generateAll();

		const jobs: GenerationJob[] = enqueueAllSpy.mock.calls[0][0];
		expect(jobs).toHaveLength(1);
		expect(jobs[0].elementId).toBe("a");
	});

	// Animate rewrites the element's type in place, keeping its id, so the
	// queue entry -- still stamped with the old connector -- is provenance for
	// a connector this element no longer uses.
	it("includes an animated image whose queue entry predates the Animate conversion", async () => {
		getElementSnapshotSpy.mockImplementation((id: string) => ({
			status: "idle",
			seconds: 0,
			result:
				id === "a" ? { imageUrl: "https://example.com/upload.png" } : null,
			error: null,
			resultInputs:
				id === "a" ? { prompt: "wizard sign", attributes: {} } : null,
			uploaded: id === "a",
			connectorType: id === "a" ? "image" : null,
		}));

		const { useGenerateAll } = await import("../hooks/useGenerateAll");
		const children: Descendant[] = [
			wrapInScene([
				makeElement("a", "animated_image", "wizard sign", {
					videoPrompt: "slow pan",
				}),
			]),
		];
		const editor = { children } as unknown as Parameters<
			typeof useGenerateAll
		>[0];

		const { generateAll } = useGenerateAll(editor);
		generateAll();

		const jobs: GenerationJob[] = enqueueAllSpy.mock.calls[0][0];
		expect(jobs).toHaveLength(1);
		expect(jobs[0].elementId).toBe("a");
	});

	it("excludes an uploaded image with a real prompt even when attributes drift", async () => {
		getElementSnapshotSpy.mockImplementation((id: string) => ({
			status: "idle",
			seconds: 0,
			result:
				id === "a" ? { imageUrl: "https://example.com/upload.png" } : null,
			error: null,
			resultInputs:
				id === "a"
					? { prompt: "wizard sign", attributes: { emotion: "calm" } }
					: null,
			uploaded: id === "a",
			connectorType: id === "a" ? "image" : null,
		}));

		const { useGenerateAll } = await import("../hooks/useGenerateAll");
		const children: Descendant[] = [
			wrapInScene([
				makeElement("a", "image", "wizard sign", { emotion: "happy" }),
				makeElement("b", "narration", "hello"),
			]),
		];
		const editor = { children } as unknown as Parameters<
			typeof useGenerateAll
		>[0];

		const { generateAll } = useGenerateAll(editor);
		generateAll();

		const jobs: GenerationJob[] = enqueueAllSpy.mock.calls[0][0];
		expect(jobs).toHaveLength(1);
		expect(jobs[0].elementId).toBe("b");
	});

	it("skips elements with empty prompts", async () => {
		const { useGenerateAll } = await import("../hooks/useGenerateAll");
		const children: Descendant[] = [
			wrapInScene([
				makeElement("a", "image", "sunset"),
				makeElement("b", "narration", "   "),
			]),
		];
		const editor = { children } as unknown as Parameters<
			typeof useGenerateAll
		>[0];

		const { generateAll } = useGenerateAll(editor);
		generateAll();

		const jobs: GenerationJob[] = enqueueAllSpy.mock.calls[0][0];
		expect(jobs).toHaveLength(1);
		expect(jobs[0].elementId).toBe("a");
	});
});
