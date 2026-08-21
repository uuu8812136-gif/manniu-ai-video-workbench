import { describe, expect, it } from "vitest";
import { appRouteHash, parseAppRoute } from "../src/renderer/src/lib/app-route";

describe("application hash routing", () => {
  it("parses original workflow routes from hash and pathname", () => {
    expect(parseAppRoute({ hash: "#/inference", pathname: "/index.html" })).toEqual({ view: "inference" });
    expect(parseAppRoute({ hash: "", pathname: "/text-polish" })).toEqual({ view: "polish" });
    expect(parseAppRoute({ hash: "#/novel-optimizer", pathname: "/" })).toEqual({ view: "opening" });
  });

  it("restores project ids and settings shortcuts", () => {
    expect(parseAppRoute({ hash: "#/project/42", pathname: "/" })).toEqual({ view: "project", projectId: 42 });
    expect(parseAppRoute({ hash: "#/settings?section=image", pathname: "/" })).toEqual({
      view: "settings",
      settingsSection: "imagegen",
    });
    expect(appRouteHash({ view: "project", projectId: 42 })).toBe("#/project/42");
    expect(appRouteHash({ view: "settings", settingsSection: "inference" })).toBe("#/settings?tab=inference");
    expect(parseAppRoute({ hash: "#/settings?tab=inference", pathname: "/" })).toEqual({ view: "settings", settingsSection: "inference" });
    expect(parseAppRoute({ hash: "#/settings?tab=text-polish", pathname: "/" })).toEqual({ view: "settings", settingsSection: "text-polish" });
    expect(parseAppRoute({ hash: "#/settings?tab=imagegen", pathname: "/" })).toEqual({ view: "settings", settingsSection: "imagegen" });
    expect(parseAppRoute({ hash: "#/settings?section=text", pathname: "/" })).toEqual({ view: "settings", settingsSection: "text-polish" });
  });

  it("falls back safely for malformed or unknown routes", () => {
    expect(parseAppRoute({ hash: "#/project/0", pathname: "/" })).toEqual({ view: "projects" });
    expect(parseAppRoute({ hash: "#/unknown", pathname: "/" })).toEqual({ view: "projects" });
    expect(parseAppRoute({ hash: "#/settings?section=unknown", pathname: "/" })).toEqual({ view: "settings" });
  });
});
