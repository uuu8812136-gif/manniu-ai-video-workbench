import { memo, useEffect, useRef, useState, type ReactElement } from "react";
import { ExternalLink, FolderOpen, ImageIcon, LoaderCircle, Video } from "lucide-react";
import type { Storyboard } from "../../../shared/contracts";
import { localMediaUrl } from "../../../shared/local-media";
import type { StoryboardDisplayState } from "../pages/storyboard-display-state";

type Props = {
  storyboard: Storyboard;
  state: StoryboardDisplayState;
  onOpen(): void;
  onReveal(): void;
  onLoadError?(storyboardId: number): void;
};

function StoryboardMediaPreviewComponent({ storyboard, state, onOpen, onReveal, onLoadError }: Props): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting));
    }, { rootMargin: "300px 0px" });
    observer.observe(root);
    return () => observer.disconnect();
  }, [storyboard.id]);

  useEffect(() => setLoadError(false), [storyboard.updatedAt, state.mediaKind, state.imageIndex]);

  const mediaUrl = state.mediaKind === "video"
    ? localMediaUrl({ storyboardId: storyboard.id, kind: "video" }, storyboard.updatedAt)
    : state.mediaKind === "image" && state.imageIndex !== null
      ? localMediaUrl({ storyboardId: storyboard.id, kind: "image", imageIndex: state.imageIndex }, storyboard.updatedAt)
      : null;
  const suppressMedia = ["queued", "generating"].includes(state.status);

  return (
    <div className={`storyboard-media-preview ${state.status}`} ref={rootRef}>
      {visible && mediaUrl && !suppressMedia && !loadError && state.mediaKind === "video" && (
        <video src={mediaUrl} controls preload="metadata" playsInline onError={() => { setLoadError(true); onLoadError?.(storyboard.id); }} />
      )}
      {visible && mediaUrl && !suppressMedia && !loadError && state.mediaKind === "image" && (
        <img src={mediaUrl} alt={`分镜 ${storyboard.index + 1}`} loading="lazy" onError={() => { setLoadError(true); onLoadError?.(storyboard.id); }} />
      )}
      {(!mediaUrl || suppressMedia || loadError) && (
        <div className="storyboard-media-placeholder">
          {state.status === "generating" || state.status === "queued" ? <LoaderCircle className="spin" size={20} />
            : loadError ? <><ImageIcon size={19} /><span>无法预览</span></>
              : <><Video size={19} /><span>{state.label}</span><small>-</small></>}
          {state.progress !== null && ["queued", "generating"].includes(state.status) && <small>{state.progress}%</small>}
        </div>
      )}
      {mediaUrl && !suppressMedia && (
        <div className="storyboard-media-tools">
          <button className="media-tool-button" title="用系统播放器或看图工具打开" onClick={onOpen}><ExternalLink size={14} /></button>
          <button className="media-tool-button" title="在文件夹中定位" onClick={onReveal}><FolderOpen size={14} /></button>
        </div>
      )}
    </div>
  );
}

export const StoryboardMediaPreview = memo(StoryboardMediaPreviewComponent);
