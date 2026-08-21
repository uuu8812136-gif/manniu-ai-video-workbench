import type { ProjectResetResult, Storyboard } from "../shared/contracts";
import type { JobStore } from "./jobs";
import type { StoryboardRepository } from "./repositories";

export function resetProjectGeneration(options: {
  storyboards: Storyboard[];
  storyboardRepository: Pick<StoryboardRepository, "assertNoBlockingVideoTasks" | "resetProjectGeneration">;
  jobStore: Pick<JobStore, "findBlockingStoryboardJobForAny" | "removeStoryboardHistory">;
}): ProjectResetResult {
  const storyboardIds = options.storyboards.map(({ id }) => id);
  options.storyboardRepository.assertNoBlockingVideoTasks(storyboardIds, "reset project", { allowUncertain: true });
  const blocking = options.jobStore.findBlockingStoryboardJobForAny(storyboardIds);
  if (blocking) {
    throw new Error(`Cannot reset project while ${blocking.type} job ${blocking.id} is ${blocking.status}`);
  }

  const jobsRemoved = options.jobStore.removeStoryboardHistory(storyboardIds);
  const projectId = options.storyboards[0]?.projectId;
  const storyboardsReset = projectId === undefined ? 0 : options.storyboardRepository.resetProjectGeneration(projectId);
  return { storyboardsReset, jobsRemoved };
}
