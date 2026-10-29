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
    name: "Geist",
    role: "UI typeface, self-hosted via @fontsource/geist",
    license: "OFL-1.1",
    url: "https://github.com/vercel/geist-font",
  },
  {
    name: "Geist Mono",
    role: "Monospace typeface, self-hosted via @fontsource/geist-mono",
    license: "OFL-1.1",
    url: "https://github.com/vercel/geist-font",
  },
  {
    name: "JetBrains Mono",
    role: "Monospace typeface, self-hosted via @fontsource/jetbrains-mono",
    license: "OFL-1.1",
    url: "https://github.com/JetBrains/JetBrainsMono",
  },
];
