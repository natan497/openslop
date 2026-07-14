import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";

// Needs a PreviewCacheContext we don't care about here.
vi.mock("../../AudioPlayer", () => ({
	AudioPlayer: () => null,
}));

const { AudioResult, MediaPlaceholder, MediaPreview } =
	await import("../results");

const render = (node: React.ReactNode) =>
	renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

// Anchor on the alert wrapper: it owns the positioning. The badge inside is
// inline-flex w-fit, so asserting against it could never catch a full cover.
const alertClass = (html: string) => {
	const match = html.match(/role="alert"[^>]*class="([^"]*)"/);
	if (!match) throw new Error("alert wrapper not found in rendered markup");
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
		expect(alertClass(html)).not.toContain("inset-0");
	});

	it("MediaPreview error is reachable without a mouse", () => {
		const html = render(
			<MediaPreview
				url="https://example.com/up.png"
				outputKind="image"
				status="idle"
				seconds={0}
				error="provider exploded"
			/>,
		);
		// Truncated text means the full message only lives in the tooltip, so the
		// trigger must be focusable and announce as an error.
		expect(html).toContain('role="alert"');
		expect(html).toMatch(/<button[^>]*aria-label="Generation failed: provider/);
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
		expect(html).not.toContain('role="alert"');
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
		expect(alertClass(html)).not.toContain("inset-0");
	});

	it("AudioResult error can shrink, so a long message truncates", () => {
		const html = render(
			<AudioResult
				src="https://example.com/a.mp3"
				status="idle"
				seconds={0}
				error="the provider rejected this request for a reason it described at considerable length"
			/>,
		);
		expect(alertClass(html)).toContain("min-w-0");
	});

	// Static markup can't drive `copied`, so this pins the resting contract only:
	// the trigger is named after the error, and a polite region exists to carry
	// the confirmation instead of the name.
	it.each([
		[
			"badge",
			() => <AudioResult src="a.mp3" status="idle" seconds={0} error="boom" />,
		],
		[
			"placeholder",
			() => (
				<MediaPlaceholder
					status="idle"
					seconds={0}
					error="boom"
					onDiscard={() => {}}
				/>
			),
		],
	])(
		"%s names its copy trigger and has a polite status region",
		(_name, node) => {
			const html = render(node());
			expect(html).toMatch(/<button[^>]*aria-label="Generation failed: boom\./);
			expect(html).toMatch(/role="status"/);
		},
	);

	// The placeholder is the more common failure: an element that never generated
	// has no result, so a provider blowup lands here rather than on the badge.
	// Naming is covered by the it.each above; this covers the message itself
	// being inside the live region.
	it("MediaPlaceholder announces the error in the live region", () => {
		const html = render(
			<MediaPlaceholder
				status="idle"
				seconds={0}
				error="provider exploded"
				onDiscard={() => {}}
			/>,
		);
		expect(html).toMatch(/role="alert"[^>]*>provider exploded/);
	});
});
