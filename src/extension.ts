import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const EXTENSION_ID = "context-vault";
export const EXTENSION_VERSION = "0.1.0";

export function registerContextVault(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus(EXTENSION_ID, `vault v${EXTENSION_VERSION}`);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus(EXTENSION_ID, undefined);
    }
  });
}
