import { useCallback, useEffect, useState, type ReactElement } from "react";
import {
  BookOpenText,
  Boxes,
  CircleHelp,
  FilePenLine,
  Image,
  Film,
  FolderKanban,
  Lightbulb,
  Moon,
  Settings,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import type { Project } from "../../shared/contracts";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { BatchPage } from "./pages/BatchPage";
import { TextWorkflowPage } from "./pages/TextWorkflowPage";
import { AboutPage } from "./pages/AboutPage";
import { ImagePage } from "./pages/ImagePage";
import { VideoPage } from "./pages/VideoPage";
import { applyThemeMode, readThemeMode, saveThemeMode, type ThemeMode } from "./lib/theme-state";
import { appRouteHash, parseAppRoute, type AppRoute, type AppView, type SettingsSection } from "./lib/app-route";

const navigation = [
  { id: "projects" as const, label: "创作", icon: FilePenLine },
  { id: "batch" as const, label: "批量", icon: Boxes },
  { id: "opening" as const, label: "开头", icon: BookOpenText },
  { id: "polish" as const, label: "捋文", icon: Sparkles },
  { id: "inference" as const, label: "推理", icon: Lightbulb },
  { id: "image" as const, label: "生图", icon: Image },
  { id: "video" as const, label: "视频", icon: Film },
  { id: "settings" as const, label: "设置", icon: Settings },
  { id: "about" as const, label: "关于软件", icon: CircleHelp },
];

export function App(): ReactElement {
  const [route, setRoute] = useState<AppRoute>(() => parseAppRoute(window.location));
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(() => readThemeMode(localStorage));

  const navigate = useCallback((next: AppRoute, replace = false): void => {
    const href = appRouteHash(next);
    if (window.location.hash !== href) {
      window.history[replace ? "replaceState" : "pushState"](null, "", href);
    }
    setRoute(next);
  }, []);

  useEffect(() => {
    const restoreRoute = (): void => {
      const restored = parseAppRoute(window.location);
      const canonical = appRouteHash(restored);
      if (window.location.hash !== canonical) window.history.replaceState(null, "", canonical);
      setRoute(restored);
    };
    restoreRoute();
    window.addEventListener("popstate", restoreRoute);
    window.addEventListener("hashchange", restoreRoute);
    return () => {
      window.removeEventListener("popstate", restoreRoute);
      window.removeEventListener("hashchange", restoreRoute);
    };
  }, []);

  useEffect(() => {
    if (route.view !== "project" || route.projectId === undefined) {
      setProjectLoading(false);
      return;
    }
    if (selectedProject?.id === route.projectId) {
      setProjectLoading(false);
      return;
    }

    let disposed = false;
    setProjectLoading(true);
    void window.offline.projects.list().then((projects) => {
      if (disposed) return;
      const project = projects.find(({ id }) => id === route.projectId);
      if (!project) {
        setSelectedProject(null);
        navigate({ view: "projects" }, true);
        return;
      }
      setSelectedProject(project);
      setProjectLoading(false);
    }).catch(() => {
      if (disposed) return;
      setSelectedProject(null);
      setProjectLoading(false);
      navigate({ view: "projects" }, true);
    });
    return () => { disposed = true; };
  }, [navigate, route.projectId, route.view, selectedProject?.id]);

  const toggleTheme = (): void => {
    const next = theme === "dark" ? "light" : "dark";
    applyThemeMode(next);
    saveThemeMode(next, localStorage);
    setTheme(next);
  };

  let content: ReactElement;
  if (route.view === "project" && selectedProject !== null && selectedProject.id === route.projectId && !projectLoading) {
    content = (
      <ProjectDetailPage
        project={selectedProject}
        onBack={() => navigate({ view: "projects" })}
        onProjectChange={setSelectedProject}
      />
    );
  } else if (route.view === "project") {
    content = <div className="page-shell" aria-busy="true" />;
  } else if (route.view === "projects") {
    content = <ProjectsPage onOpen={(project) => { setSelectedProject(project); navigate({ view: "project", projectId: project.id }); }} />;
  } else if (route.view === "settings") {
    content = <SettingsPage
      focusSection={route.settingsSection}
      onSelectSection={(settingsSection) => navigate({ view: "settings", settingsSection })}
    />;
  } else if (route.view === "batch") {
    content = <BatchPage />;
  } else if (route.view === "opening" || route.view === "polish" || route.view === "inference") {
    const section: SettingsSection = route.view === "inference"
      ? "inference"
      : route.view === "opening"
        ? "novel-optimizer"
        : "text-polish";
    content = <TextWorkflowPage kind={route.view} onOpenSettings={() => navigate({ view: "settings", settingsSection: section })} />;
  } else if (route.view === "image") {
    content = <ImagePage onOpenSettings={() => navigate({ view: "settings", settingsSection: "imagegen" })} />;
  } else if (route.view === "video") {
    content = <VideoPage />;
  } else if (route.view === "about") {
    content = <AboutPage />;
  } else {
    content = <ProjectsPage onOpen={(project) => { setSelectedProject(project); navigate({ view: "project", projectId: project.id }); }} />;
  }

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">AI</div>
          <div>
            <strong>AI工具</strong>
            <span>WORKSPACE</span>
          </div>
        </div>
        <nav>
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={route.view === item.id ? "nav-item active" : "nav-item"}
                key={item.id}
                onClick={() => navigate({ view: item.id as Exclude<AppView, "project"> })}
                title={item.label}
                data-divider={item.id === "settings" ? "true" : undefined}
              >
                <Icon size={19} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        {selectedProject && (
          <div className="sidebar-project">
            <span>当前项目</span>
            <div>
              <button className={route.view === "project" ? "active" : undefined} title={`返回项目：${selectedProject.name}`} onClick={() => navigate({ view: "project", projectId: selectedProject.id })}>
                <FolderKanban size={16} />
                <strong>{selectedProject.name}</strong>
              </button>
              <button className="icon-button" title="退出当前项目" onClick={() => { setSelectedProject(null); navigate({ view: "projects" }); }}><X size={14} /></button>
            </div>
          </div>
        )}
        <div className="sidebar-footer">
          <div className="sidebar-status">
            <span className="status-dot" />
            本地模式
          </div>
          <button className="icon-button theme-toggle" title={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"} onClick={toggleTheme}>
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </div>
      </aside>
      <main className={route.view === "project" ? "project-main-surface" : undefined}>{content}</main>
    </div>
  );
}
