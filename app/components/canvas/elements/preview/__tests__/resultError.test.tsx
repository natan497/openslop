import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";

// Needs a PreviewCacheContext we don't care about here.
vi.mock("../../AudioPlayer", () => ({
	AudioPlayer: () => null,
}));

const { AudioResult, MediaPreview } = await import("../results");

const render = (node: React.ReactNode) =>
	renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

describe("errors stay visible when a result is present", () => {
	it("MediaPreview renders the error over the existing image", () => {
		const html = render(
			<MediaPreview
				url="https://example.com/up.png"
				outputKind="image"
				status="idle"
				seconds={0}
				error="provider exploded"
			/>,
		);
		expect(html).toContain("provider exploded");
		expect(html).toContain("https://example.com/up.png");
	});

	it("MediaPreview renders no error box when there is none", () => {
		const html = render(
			<MediaPreview
				url="https://example.com/up.png"
				outputKind="image"
				status="idle"
				seconds={0}
				error={null}
			/>,
		);
		expect(html).not.toContain("Copy error message");
	});

	it("AudioResult renders the error alongside the player", () => {
		const html = render(
			<AudioResult
				src="https://example.com/a.mp3"
				status="idle"
				seconds={0}
				error="tts failed"
			/>,
		);
		expect(html).toContain("tts failed");
	});
});
