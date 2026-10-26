import type { InstallMethod } from "@/api/types";

/** Human label for an install method; shared by the dialog and Settings. */
export const METHOD_LABEL: Record<InstallMethod, string> = {
  curl: "Install script (curl)",
  "curl-appimage": "Install script (AppImage)",
  appimage: "AppImage",
  dmg: "macOS app (dmg)",
  deb: "Debian package",
  unknown: "Unknown",
};
