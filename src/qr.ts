import QRCode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { resolve } from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";

export const qrPngPath = resolve(config.authDir, "..", "qr.png");

let openedOnce = false;

/** OS-native "open this file" command. */
function opener(): { cmd: string; args: string[] } | null {
  switch (platform()) {
    case "darwin":
      return { cmd: "open", args: [qrPngPath] };
    case "win32":
      return { cmd: "cmd", args: ["/c", "start", "", qrPngPath] };
    case "linux":
      return { cmd: "xdg-open", args: [qrPngPath] };
    default:
      return null;
  }
}

/**
 * Render the pairing QR three ways: in the terminal, as a PNG file, and —
 * unless disabled — auto-opened in the OS image viewer so it can be scanned
 * with a phone without squinting at terminal blocks. Auto-open fires once
 * per process so rotating QRs don't spawn a window each refresh.
 */
export async function showQr(qr: string): Promise<void> {
  console.log("\nScan this QR with WhatsApp (Settings → Linked Devices → Link a Device):\n");
  qrcodeTerminal.generate(qr, { small: true });

  try {
    await QRCode.toFile(qrPngPath, qr, { width: 512, margin: 2 });
    log.info(`QR image written: ${qrPngPath}`);
  } catch (e: any) {
    log.warn(`Could not write QR image: ${e?.message ?? e}`);
    return;
  }

  if (!config.qrAutoOpen || openedOnce) return;
  const o = opener();
  if (!o) return;
  openedOnce = true;
  try {
    spawn(o.cmd, o.args, { stdio: "ignore", detached: true }).unref();
    log.info("Opened QR image in default viewer.");
  } catch (e: any) {
    log.warn(`Could not auto-open QR image: ${e?.message ?? e}`);
  }
}
