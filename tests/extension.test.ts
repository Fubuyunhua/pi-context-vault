import { describe, expect, it, vi } from "vitest";
import { EXTENSION_ID, EXTENSION_VERSION, registerContextVault } from "../src/extension.js";

type Handler = (...args: unknown[]) => unknown;

describe("extension bootstrap", () => {
  it("registers lifecycle hooks and exposes its version in interactive sessions", async () => {
    const handlers = new Map<string, Handler>();
    const pi = {
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    };

    registerContextVault(pi as never);

    expect(pi.on).toHaveBeenCalledTimes(2);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);

    const setStatus = vi.fn();
    const ctx = { hasUI: true, ui: { setStatus } };
    await handlers.get("session_start")?.({}, ctx);
    expect(setStatus).toHaveBeenCalledWith(EXTENSION_ID, `vault v${EXTENSION_VERSION}`);

    await handlers.get("session_shutdown")?.({}, ctx);
    expect(setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, undefined);
  });

  it("does not touch the UI in headless sessions", async () => {
    const handlers = new Map<string, Handler>();
    registerContextVault({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as never);

    await expect(handlers.get("session_start")?.({}, { hasUI: false })).resolves.toBeUndefined();
  });
});
