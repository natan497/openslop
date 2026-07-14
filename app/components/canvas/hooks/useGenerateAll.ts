import { useCallback } from "react";
import { Editor } from "slate";
import { useConfig } from "@/lib/config/ConfigProvider";
import { ELEMENT_CONFIGS } from "@/lib/canvas/elementConfigs";
import { getContentElements } from "@/lib/canvas/scenes";
import { getGenerationInputs } from "@/lib/generation/getGenerationInputs";
import { isStaleResult } from "@/lib/generation/queue";
import { useGenerationQueue } from "@/lib/generation/GenerationQueueProvider";
import { scheduleGeneration } from "@/lib/generation/scheduleGeneration";
import { getProjectStore } from "@/lib/project/store";
import { buildGenerationJob } from "@/lib/generation/buildGenerationJob";

export function useGenerateAll(editor: Editor) {
	const { projectId, connectorConfig } = useConfig();
	const queue = useGenerationQueue();

	const generateAll = useCallback(() => {
		const { metadata } = getProjectStore(projectId).getState();
		const jobs = getContentElements(editor.children)
			.filter((el) => {
				const inputs = getGenerationInputs(el, metadata);
				const snap = queue.getElementSnapshot(el.id);
				// A type change (e.g. Animate) rewrites the element in place and
				// keeps its id, so the queue entry can be provenance for a connector
				// this element no longer uses -- that invalidates all of it, not just
				// the uploaded flag.
				const producedForCurrentType =
					snap.connectorType === ELEMENT_CONFIGS[el.type].connector;
				const shouldGenerate =
					inputs.prompt &&
					(!producedForCurrentType ||
						(!snap.uploaded && (!snap.result || isStaleResult(snap, inputs))));
				return shouldGenerate;
			})
			.map((el) => buildGenerationJob(el, connectorConfig, projectId));
		scheduleGeneration(queue, jobs, { projectId, registry: connectorConfig });
	}, [queue, editor, connectorConfig, projectId]);

	return { generateAll };
}
