export interface ThirdPartyLicense {
  name: string;
  role: string;
  license: string;
  url: string;
}

export const THIRD_PARTY_LICENSES: ThirdPartyLicense[] = [
  {
    name: "@agentclientprotocol/claude-agent-acp (+ @agentclientprotocol/sdk)",
    role: "Claude Rich Chat adapter, compiled into claude-acp",
    license: "Apache-2.0",
    url: "https://github.com/agentclientprotocol/claude-agent-acp",
  },
  {
    name: "@anthropic-ai/claude-agent-sdk",
    role: "Runs the user's claude CLI, embedded in claude-acp",
    license: "Anthropic terms",
    url: "https://code.claude.com/docs/en/legal-and-compliance",
  },
  {
    name: "Bun runtime",
    role: "Embedded in claude-acp by bun build --compile",
    license: "MIT",
    url: "https://github.com/oven-sh/bun",
  },
  {
    name: "agy-acp (openab)",
    role: "agy ACP adapter, shipped beside vst",
    license: "MIT",
    url: "https://github.com/fastestdevalive/openab",
  },
  {
    name: "cloudflared",
    role: "Remote-access tunnel, desktop app bundle only",
    license: "Apache-2.0",
    url: "https://github.com/cloudflare/cloudflared",
  },
];
