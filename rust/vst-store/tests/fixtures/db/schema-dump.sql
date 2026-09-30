CREATE TABLE global_drafts (
      id         TEXT PRIMARY KEY,
      draftPrompt TEXT,
      draftConfig TEXT,
      createdAt  TEXT NOT NULL
    , name TEXT, nameSource TEXT, sortOrder REAL);
CREATE INDEX idx_sessions_projectId ON sessions(projectId);
CREATE INDEX idx_sessions_worktreeId ON sessions(worktreeId);
CREATE INDEX idx_worktrees_projectId ON worktrees(projectId);
CREATE TABLE manifest_migrations (
      projectId TEXT PRIMARY KEY,
      migratedAt TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
      error TEXT
    );
CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      absolutePath TEXT NOT NULL,
      prefix TEXT NOT NULL,
      isGit INTEGER NOT NULL,
      defaultBranch TEXT,
      createdAt TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      directSessionSeq INTEGER NOT NULL DEFAULT 0,
      nextWorktreeNum INTEGER NOT NULL DEFAULT 1
    , lspEnabled INTEGER, openFiles TEXT);
CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      worktreeId TEXT REFERENCES worktrees(id) ON DELETE CASCADE,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      isMain INTEGER NOT NULL DEFAULT 0 CHECK (isMain = 0 OR worktreeId IS NOT NULL),
      sortOrder REAL NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('agent','terminal')),
      modeId TEXT,
      name TEXT,
      nameSource TEXT CHECK (nameSource IN ('auto','user') OR nameSource IS NULL),
      tmuxName TEXT NOT NULL,
      useTmux INTEGER NOT NULL,
      channel TEXT,
      state TEXT NOT NULL,
      reason TEXT,
      lastTransitionAt TEXT NOT NULL,
      transcriptKind TEXT,
      transcriptPath TEXT,
      agentChatId TEXT,
      modelOverride TEXT,
      pinnedAt TEXT,
      initialPrompt TEXT,
      archivedAt TEXT,
      handoffSummary TEXT
    , spawnedFrom TEXT, supersededBy TEXT, prState TEXT, prNumber INTEGER, prUrl TEXT, prCheckedAt TEXT, prBranch TEXT, acpSessionId TEXT, draftPrompt TEXT, draftConfig TEXT);
CREATE TABLE tunnel_state (
      id         INTEGER PRIMARY KEY,
      enabled    INTEGER NOT NULL DEFAULT 0,
      currentUrl TEXT,
      currentPid INTEGER,
      startedAt  TEXT,
      port       INTEGER
    );
CREATE TABLE user_ordered_lists (
      userId TEXT NOT NULL,
      scopeKey TEXT NOT NULL,
      itemIds TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (userId, scopeKey)
    );
CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT,
      branch TEXT NOT NULL,
      baseBranch TEXT,
      baseSha TEXT,
      createdAt TEXT NOT NULL,
      pinnedAt TEXT,
      hiddenAt TEXT,
      sortOrder REAL NOT NULL,
      terminalSeq INTEGER NOT NULL DEFAULT 0,
      agentSeq INTEGER NOT NULL DEFAULT 0,
      branchIsPlaceholder INTEGER NOT NULL DEFAULT 0
    , lspEnabled INTEGER, openFiles TEXT);
