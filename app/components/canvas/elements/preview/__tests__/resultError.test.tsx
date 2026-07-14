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

// The shimmer skeleton is legitimately inset-0, so scope to the error element.
const errorClass = (html: string) => {
	const match = html.match(/class="([^"]*bg-destructive[^"]*)"/);
	if (!match) throw new Error("error element not found in rendered markup");
	return match[1];
};

describe("errors stay visible when a result is present", () => {
	it("MediaPreview shows the error without covering the result", () => {
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
		expect(errorClass(html)).not.toContain("inset-0");
	});

	it("MediaPreview shows no error when there is none", () => {
		const html = render(
			<MediaPreview
				url="https://example.com/up.png"
				outputKind="image"
				status="idle"
				seconds={0}
				error={null}
			/>,
		);
		expect(html).not.toContain("bg-destructive");
	});

	it("AudioResult shows the error alongside the player", () => {
		const html = render(
			<AudioResult
				src="https://example.com/a.mp3"
				status="idle"
				seconds={0}
				error="tts failed"
			/>,
		);
		expect(html).toContain("tts failed");
		expect(errorClass(html)).not.toContain("inset-0");
	});
});
