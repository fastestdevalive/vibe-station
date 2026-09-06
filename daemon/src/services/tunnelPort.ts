/**
 * VST_TUNNEL_PORT lets dev environments (docker, local Vite) point cloudflared
 * at the web UI server instead of the daemon. In production the daemon serves
 * the SPA directly so this env var is not set and `port` is used as-is.
 *
 * Shared between `routes/mobileAuth.ts` (manual enable) and `main.ts`
 * (boot-time restore) so both always target the same port — see
 * tunnel-persistence plan, Decision 6.
 */
export function resolveTunnelPort(port: number): number {
  return process.env.VST_TUNNEL_PORT ? Number(process.env.VST_TUNNEL_PORT) : port;
}
