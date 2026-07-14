import type { ElementSnapshot } from "@/lib/generation/queue";

export type GenerationState = {
	status: ElementSnapshot["status"];
	seconds: number;
	error: string | null;
};

export type PlaceholderProps = GenerationState & {
	onDiscard: () => void;
};
