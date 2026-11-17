-- When the queue consumer picked a session up. A session's time limit runs from here, not from when it
-- was queued, so one that waited behind other queue messages is not closed while it is still working.
ALTER TABLE assistant_sessions ADD COLUMN started_at TEXT;
