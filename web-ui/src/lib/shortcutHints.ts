export function shortcutHints() {
  if (typeof navigator === "undefined") {
    return {
      terminal: "⌘⇧Z",
      quickOpen: "⌘P",
      toolPane: "⌘\\",
      fileTreeToggle: "⌘E",
      splitToggle: "⌘/",
      find: "⌘F",
    };
  }
  const mac = /Mac|iPhone|iPod|iPad/i.test(navigator.platform ?? navigator.userAgent);
  if (mac) {
    return {
      terminal: "⌘⇧Z",
      quickOpen: "⌘P",
      toolPane: "⌘\\",
      fileTreeToggle: "⌘E",
      splitToggle: "⌘/",
      find: "⌘F",
    };
  }
  return {
    terminal: "Ctrl+Shift+Z",
    quickOpen: "Ctrl+P",
    toolPane: "Ctrl+\\",
    fileTreeToggle: "Ctrl+E",
    splitToggle: "Ctrl+/",
    find: "Ctrl+F",
  };
}
