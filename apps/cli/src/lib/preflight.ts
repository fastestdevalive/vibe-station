import { getDaemonUrl } from "./daemon-url.js";
import { die } from "./output.js";

export async function preflight(): Promise<void> {
  const url = getDaemonUrl();
  if (!url) {
    die("Daemon is not running. Run `vrun daemon start`.", 4);
  }

  try {
    const response = await fetch(`${url}/health`);
    if (!response.ok) {
      die("Daemon is not responding. Run `vrun daemon restart`.", 4);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ECONNREFUSED") || message.includes("connect")) {
      die("Daemon is not running. Run `vrun daemon start`.", 4);
    }
    die("Failed to reach daemon.", 4);
  }
}
