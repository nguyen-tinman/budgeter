-- chat_log: the assistant transcript, so a reload does not throw the
-- conversation away.
--
-- Until now the chat lived only in ChatPanel's component state: refreshing the
-- page, or navigating away and back, silently discarded it. The rest of the
-- app's state is in this database, and the transcript is user data like any
-- other, so it belongs here rather than in localStorage — it survives a cleared
-- browser cache, moves with the .db file, and is included in backups.
--
-- Rows are the messages the panel RENDERS, in display order (`seq`), not the
-- messages sent to the model. That is deliberate: restoring has to reproduce
-- what the user was looking at, including the tool chips and the step bubbles
-- between them. The model-facing history is rebuilt from these rows by the
-- client exactly as it was before a reload.
--
-- Deliberately NOT stored: pendingActions. A restored Approve button would
-- invite the user to authorize a mutation proposed against a workspace state
-- that has since moved on, and the approval replay guard is per-process. An
-- unresolved proposal is dropped on reload; the user can ask again.
--
-- Single conversation, no threads: "New chat" clears the table (see
-- POST /api/chat/clear). If threads ever arrive, add a conversation_id column
-- and a conversations table — the seq ordering carries over unchanged.

CREATE TABLE chat_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  seq        INTEGER NOT NULL,
  role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  text       TEXT    NOT NULL DEFAULT '',
  -- JSON array of {name, count} tool chips, or NULL when the message has none.
  tools_json TEXT,
  -- Display flags that change how the bubble renders; see ChatPanel's
  -- ChatMessage. Stored as 0/1 rather than a flags blob so a human reading the
  -- table can see what a row is.
  is_step    INTEGER NOT NULL DEFAULT 0 CHECK (is_step IN (0, 1)),
  stopped    INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1)),
  compaction INTEGER NOT NULL DEFAULT 0 CHECK (compaction IN (0, 1)),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_log_seq ON chat_log (seq);
