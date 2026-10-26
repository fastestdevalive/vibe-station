import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatVersion } from "./updateView";

export interface ChangelogViewProps {
  changelog?: string;
  behindCount?: number;
  currentVersion?: string;
  /** Latest release version; the compare link ends at its tag, not `HEAD`. */
  latestVersion?: string;
  releaseUrl?: string;
}

/** Only allow http: and https: protocols to prevent javascript: or data: XSS */
function safeUrlTransform(uri: string): string {
  try {
    const parsed = new URL(uri, "https://example.com");
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return uri;
    }
  } catch {
    // invalid URL
  }
  return "";
}

export function ChangelogView({
  changelog,
  behindCount = 0,
  currentVersion,
  latestVersion,
  releaseUrl,
}: ChangelogViewProps) {
  // If behindCount > 1, render compare link if we have a base repo url
  // e.g. https://github.com/fastestdevalive/vibe-station/compare/v{current}...v{latest}
  const compareUrl = releaseUrl && currentVersion && latestVersion
    ? releaseUrl.replace(
        /\/releases\/tag\/[^/]+$/,
        `/compare/${formatVersion(currentVersion)}...${formatVersion(latestVersion)}`,
      )
    : undefined;

  return (
    <div className="update-changelog">
      {changelog ? (
        <div className="update-changelog__body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={safeUrlTransform}
            components={{
              a: ({ href, children }) => {
                const safeHref = href ? safeUrlTransform(href) : "";
                if (!safeHref) return <span>{children}</span>;
                return (
                  <a
                    href={safeHref}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {children}
                  </a>
                );
              },
            }}
          >
            {changelog}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="update-changelog__empty">No release notes provided.</div>
      )}

      {behindCount > 1 && releaseUrl ? (
        <div className="update-changelog__compare">
          <a
            href={compareUrl || releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {behindCount} releases since {formatVersion(currentVersion ?? "")} — view all changes ↗
          </a>
        </div>
      ) : releaseUrl ? (
        <div className="update-changelog__compare">
          <a
            href={releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            View release on GitHub ↗
          </a>
        </div>
      ) : null}
    </div>
  );
}
