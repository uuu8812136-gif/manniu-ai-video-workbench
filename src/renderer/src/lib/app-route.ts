export type AppView =
  | "projects"
  | "project"
  | "batch"
  | "opening"
  | "polish"
  | "inference"
  | "image"
  | "video"
  | "settings"
  | "about";

export type SettingsSection =
  | "browsers"
  | "folder"
  | "novel-optimizer"
  | "text-polish"
  | "inference"
  | "imagegen"
  | "jianying"
  | "notifications";

const SETTINGS_SECTION_ALIASES: Readonly<Record<string, SettingsSection>> = {
  browsers: "browsers",
  folder: "folder",
  "novel-optimizer": "novel-optimizer",
  "text-polish": "text-polish",
  inference: "inference",
  imagegen: "imagegen",
  jianying: "jianying",
  notifications: "notifications",
  text: "text-polish",
  image: "imagegen",
};

export type AppRoute = {
  view: AppView;
  projectId?: number;
  settingsSection?: SettingsSection;
};

const PATH_VIEWS: Readonly<Record<string, AppView>> = {
  "/": "projects",
  "/batch": "batch",
  "/novel-optimizer": "opening",
  "/text-polish": "polish",
  "/inference": "inference",
  "/image": "image",
  "/video": "video",
  "/settings": "settings",
  "/about": "about",
};

const VIEW_PATHS: Readonly<Record<Exclude<AppView, "project">, string>> = {
  projects: "/",
  batch: "/batch",
  opening: "/novel-optimizer",
  polish: "/text-polish",
  inference: "/inference",
  image: "/image",
  video: "/video",
  settings: "/settings",
  about: "/about",
};

function routeSource(location: Pick<Location, "hash" | "pathname">): string {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  return hash.startsWith("/") ? hash : location.pathname;
}

export function parseAppRoute(location: Pick<Location, "hash" | "pathname">): AppRoute {
  let url: URL;
  try {
    url = new URL(routeSource(location), "https://ai-tool.local");
  } catch {
    return { view: "projects" };
  }
  const pathname = url.pathname !== "/" ? url.pathname.replace(/\/+$/u, "") : "/";
  const projectMatch = /^\/project\/([1-9]\d*)$/u.exec(pathname);
  if (projectMatch) return { view: "project", projectId: Number(projectMatch[1]) };

  const view = PATH_VIEWS[pathname];
  if (!view) return { view: "projects" };
  if (view !== "settings") return { view };
  const section = url.searchParams.get("tab") ?? url.searchParams.get("section") ?? "";
  const settingsSection = SETTINGS_SECTION_ALIASES[section];
  return settingsSection ? { view, settingsSection } : { view };
}

export function appRouteHash(route: AppRoute): string {
  if (route.view === "project") return `#/project/${route.projectId ?? ""}`;
  const path = VIEW_PATHS[route.view];
  if (route.view === "settings" && route.settingsSection) {
    return `#${path}?tab=${encodeURIComponent(route.settingsSection)}`;
  }
  return `#${path}`;
}
