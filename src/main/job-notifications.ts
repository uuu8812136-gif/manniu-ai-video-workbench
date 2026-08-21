import type { JobRecord } from "./jobs";
import type { ProjectRepository, StoryboardRepository } from "./repositories";
import type { WebhookEvent } from "../shared/contracts";
import type { WebhookNotifier } from "./webhook";

type Notification = { event: WebhookEvent; content: string };

function storyboardId(job: JobRecord): number | null {
  if (!job.input || typeof job.input !== "object") return null;
  const value = (job.input as { storyboardId?: unknown }).storyboardId;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function jobNotification(
  job: JobRecord,
  projects: Pick<ProjectRepository, "get">,
  storyboards: Pick<StoryboardRepository, "get" | "list">,
): Notification | null {
  if (job.status === "error") {
    const message = (job.error || "任务失败").slice(0, 300);
    const event: WebhookEvent = /额度|积分|套餐|quota|credit/i.test(message)
      ? "quota"
      : /队列|拥塞|稍后|并发|throttle|in.progress/i.test(message)
        ? "throttle"
        : "error";
    return { event, content: `${job.type} 任务失败：${message}` };
  }
  if (job.status !== "done" || job.type !== "video.generate") return null;
  const id = storyboardId(job);
  if (!id) return null;
  const storyboard = storyboards.get(id);
  const all = storyboards.list(storyboard.projectId);
  if (all.length === 0 || all.some((item) => !item.videoPath)) return null;
  return { event: "complete", content: `项目“${projects.get(storyboard.projectId).name}”的 ${all.length} 个分镜已全部完成` };
}

export function createJobNotificationHandler(options: {
  notifier: Pick<WebhookNotifier, "notify">;
  projects: Pick<ProjectRepository, "get">;
  storyboards: Pick<StoryboardRepository, "get" | "list">;
}): (job: JobRecord) => void {
  return (job) => {
    const notification = jobNotification(job, options.projects, options.storyboards);
    if (notification) void options.notifier.notify(notification.event, notification.content);
  };
}
