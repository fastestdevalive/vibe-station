import { useState } from "react";
import type { DoctorHintDto, HintCommandDto, HintOs } from "@/api/types";
import { openExternal } from "@/lib/openExternal";
import { CommandBlock } from "./CommandBlock";
import "./doctor.css";

interface DoctorHintBlockProps {
  hint: DoctorHintDto;
  /** Daemon host OS (`macos` | `linux` | `windows`); picks the default command set. */
  hostOs: string;
  /** When set (and the macOS/Linux switch is shown), captions which machine the commands are for. */
  hostname?: string;
}

/** Commands for `os`; falls back to the OS-agnostic (`any`) ones. */
function commandsFor(commands: HintCommandDto[], os: HintOs | string): HintCommandDto[] {
  const specific = commands.filter((c) => c.os === os);
  return specific.length > 0 ? specific : commands.filter((c) => c.os === "any");
}

/**
 * Why a check failed and how to fix it, from the daemon's hint table (this
 * component never carries hint text of its own). The macOS/Linux switch only
 * appears when both exist and differ.
 */
export function DoctorHintBlock({ hint, hostOs, hostname }: DoctorHintBlockProps) {
  const macos = commandsFor(hint.commands.filter((c) => c.os === "macos"), "macos");
  const linux = commandsFor(hint.commands.filter((c) => c.os === "linux"), "linux");
  const showSwitch =
    macos.length > 0 &&
    linux.length > 0 &&
    macos.map((c) => c.command).join("\n") !== linux.map((c) => c.command).join("\n");

  const [picked, setPicked] = useState<"macos" | "linux" | null>(null);
  // A Windows host defaults to its own commands (the switch below is only the
  // macOS/Linux pair); an explicit pick still wins.
  const selected: string =
    picked ?? (hostOs === "windows" ? "windows" : showSwitch ? (hostOs === "macos" ? "macos" : "linux") : hostOs);
  const shown = commandsFor(hint.commands, selected);

  return (
    <div className="doctor-hint">
      {hint.title ? <div className="doctor-hint__title">{hint.title}</div> : null}
      <div className="doctor-hint__why">{hint.why}</div>
      {showSwitch ? (
        <div className="doctor-hint__os" role="radiogroup" aria-label="Operating system">
          {(["macos", "linux"] as const).map((os) => (
            <button
              key={os}
              type="button"
              role="radio"
              aria-checked={selected === os}
              onClick={() => setPicked(os)}
            >
              {os === "macos" ? "macOS" : "Linux"}
            </button>
          ))}
        </div>
      ) : null}
      {showSwitch && hostname ? (
        <div className="doctor-hint__caption">
          Run on {hostname} ({hostOs})
        </div>
      ) : null}
      {shown.map((c) => (
        <CommandBlock key={`${c.os}:${c.command}`} command={c.command} />
      ))}
      {hint.docsUrl ? (
        <a
          className="doctor-hint__docs"
          href={hint.docsUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            e.preventDefault();
            openExternal(hint.docsUrl!);
          }}
        >
          Docs
        </a>
      ) : null}
    </div>
  );
}
