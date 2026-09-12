import type { FastifyInstance } from "fastify";
import * as tailscale from "../services/tailscaleServe.js";
import { mintOneTimeCode } from "./mobileAuth.js";
import type { TokenPayload } from "../types.js";

export interface TailscaleRoutesOpts {
  port?: number;
}

export function registerTailscaleRoutes(app: FastifyInstance, opts: TailscaleRoutesOpts): void {
  const { port = 7421 } = opts;

  // GET /tailscale/status — live Tailscale + serve status. Fetched independently
  // of the tunnel state; no polling (state changes out-of-band, UI offers refresh).
  app.get("/tailscale/status", async (_req, reply) => {
    try {
      return reply.send(await tailscale.getStatus(port));
    } catch (err) {
      return reply.send({ state: "error", message: (err as Error).message });
    }
  });

  // POST /tailscale/serve/enable — register the serve rule for this daemon port.
  app.post("/tailscale/serve/enable", async (_req, reply) => {
    try {
      const { httpsUrl } = await tailscale.enableServe(port);
      return reply.send({ httpsUrl, enabled: true });
    } catch (err) {
      const enableUrl = (err as { enableUrl?: string }).enableUrl;
      if (enableUrl) {
        return reply.status(409).send({ error: "CERT_NEEDS_ENABLEMENT", enableUrl });
      }
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // POST /tailscale/serve/disable — remove the serve rule. Refuses with 409 when
  // the existing rule isn't ours (points at a different port).
  app.post("/tailscale/serve/disable", async (_req, reply) => {
    try {
      await tailscale.disableServe(port);
      return reply.send({ enabled: false });
    } catch (err) {
      if (err instanceof tailscale.TailscaleRuleNotOursError) {
        return reply.status(409).send({ error: "RULE_NOT_OURS", actualPort: err.actualPort });
      }
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // POST /tailscale/up — desktop/loopback only: mutates host network state.
  // 200 is returned even for a failed command (exitCode != 0); only ENOENT or an
  // unexpected throw surfaces as 500.
  app.post("/tailscale/up", async (req, reply) => {
    const authPayload = (req as typeof req & { authPayload?: TokenPayload }).authPayload;
    if (authPayload && authPayload.scope !== "tauri") {
      return reply.status(403).send({ error: "DESKTOP_ONLY" });
    }
    try {
      return reply.send(await tailscale.runUp());
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // GET /tailscale/qr — mint a one-time code for a tailnet peer to log in through
  // the serve URL. The QR overlay needs `expiresAt`; the code is redeemed via the
  // existing /mobile-auth transport gate.
  app.get("/tailscale/qr", async (_req, reply) => {
    const status = await tailscale.getStatus(port);
    if (status.state !== "serve_active") {
      return reply.status(409).send({ error: "TAILSCALE_SERVE_NOT_ACTIVE" });
    }
    const { code, expiresAt } = mintOneTimeCode("local");
    return reply.send({ qrUrl: `${status.httpsUrl}/mobile-auth?code=${code}`, expiresAt });
  });
}
