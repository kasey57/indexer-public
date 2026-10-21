CREATE TABLE IF NOT EXISTS gsc_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    domain TEXT NOT NULL,
    last_requested TEXT NOT NULL,
    status TEXT NOT NULL,
    google_service_account TEXT,
    google_creds TEXT,
    UNIQUE (user_id, domain)
);

CREATE TABLE IF NOT EXISTS gsc_urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    domain TEXT NOT NULL,
    url TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    status TEXT NOT NULL,
    details TEXT
);
CREATE INDEX IF NOT EXISTS idx_urls_user ON gsc_urls(user_id);
CREATE INDEX IF NOT EXISTS idx_urls_domain ON gsc_urls(domain);
CREATE INDEX IF NOT EXISTS idx_urls_requested ON gsc_urls(requested_at);

CREATE TABLE IF NOT EXISTS gsc_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    domain TEXT NOT NULL,
    url TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    details TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TEXT,
    UNIQUE (user_id, domain, url, scheduled_for)
);
CREATE INDEX IF NOT EXISTS idx_queue_due ON gsc_queue(status, scheduled_for);
