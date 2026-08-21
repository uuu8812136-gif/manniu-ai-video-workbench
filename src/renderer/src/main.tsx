import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { batchQueueController } from "./pages/batch-queue-controller";
import { applyThemeMode, readThemeMode } from "./lib/theme-state";
import "./styles.css";

async function bootstrap(): Promise<void> {
  applyThemeMode(readThemeMode(localStorage));
  if (import.meta.env.DEV) {
    const { installDevelopmentMock } = await import("./dev-mock");
    installDevelopmentMock();
    import.meta.hot?.accept("./dev-mock", (module) => {
      module?.installDevelopmentMock();
    });
  }
  batchQueueController.activate();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
