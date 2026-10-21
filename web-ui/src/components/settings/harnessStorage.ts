const KEY = "vst.settings.harnessTab";

export function readHarnessTab(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeHarnessTab(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // storage unavailable (private mode / blocked) — selection just isn't remembered
  }
}
