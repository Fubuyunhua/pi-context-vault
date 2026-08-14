import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContextVault } from "../src/extension.js";

export default function contextVaultExtension(pi: ExtensionAPI): void {
  registerContextVault(pi);
}
