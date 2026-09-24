/**
 * Resolves a DOM node and character/child offset within a code line to an
 * LSP 0-based {line, character} position.
 */
export function resolveOffsetInLine(
  node: Node,
  offset: number,
  contentEl?: HTMLElement | null
): { line: number; character: number } | null {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) {
    return null;
  }

  // Reject any click/offset inside the gutter
  if (element.closest(".workspace-code-gutter")) {
    return null;
  }

  // Resolve the nearest .workspace-code-content ancestor
  const content = contentEl ?? element.closest<HTMLElement>(".workspace-code-content");
  if (!content) {
    return null;
  }

  // Resolve the enclosing [data-line] element
  const lineEl = content.closest<HTMLElement>("[data-line]");
  if (!lineEl) {
    return null;
  }

  const dataLine = lineEl.getAttribute("data-line");
  if (!dataLine) {
    return null;
  }

  const parsedLine = parseInt(dataLine, 10);
  if (isNaN(parsedLine) || parsedLine < 1) {
    return null;
  }

  // LSP line is 0-indexed (data-line is 1-indexed)
  const line = parsedLine - 1;

  // Convert text-offset to UTF-16 code units across child nodes within content
  let character = 0;
  let found = false;

  function traverse(curr: Node): boolean {
    if (curr === node) {
      if (curr.nodeType === Node.TEXT_NODE) {
        character += Math.min(offset, (curr.textContent ?? "").length);
        return true;
      } else {
        // Element node: offset is child node index
        for (let i = 0; i < offset && i < curr.childNodes.length; i++) {
          const child = curr.childNodes[i];
          if (child) {
            character += (child.textContent ?? "").length;
          }
        }
        return true;
      }
    }

    if (curr.nodeType === Node.TEXT_NODE) {
      character += (curr.textContent ?? "").length;
      return false;
    }

    for (let i = 0; i < curr.childNodes.length; i++) {
      const child = curr.childNodes[i];
      if (child && traverse(child)) {
        return true;
      }
    }
    return false;
  }

  found = traverse(content);
  if (!found) {
    return null;
  }

  return { line, character };
}

/**
 * Resolves click coordinates to an LSP 0-based {line, character} position.
 */
export function resolveClickPosition(
  clientX: number,
  clientY: number,
  codeContainer?: HTMLElement | null
): { line: number; character: number } | null {
  let targetNode: Node | null = null;
  let targetOffset = 0;

  const doc = document as unknown as {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  if (typeof doc.caretPositionFromPoint === "function") {
    const pos = doc.caretPositionFromPoint(clientX, clientY);
    if (pos) {
      targetNode = pos.offsetNode;
      targetOffset = pos.offset;
    }
  } else if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(clientX, clientY);
    if (range) {
      targetNode = range.startContainer;
      targetOffset = range.startOffset;
    }
  }

  if (!targetNode) {
    return null;
  }

  if (codeContainer && !codeContainer.contains(targetNode)) {
    return null;
  }

  return resolveOffsetInLine(targetNode, targetOffset);
}
