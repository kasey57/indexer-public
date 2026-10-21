-- MySQL schema for Indexing Public. Run once in the database selected for this app.

CREATE TABLE IF NOT EXISTS gsc_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL DEFAULT 1,
    domain VARCHAR(255) NOT NULL,
    last_requested DATETIME NOT NULL,
    status VARCHAR(50) NOT NULL,
    google_service_account VARCHAR(255) NULL,
    google_creds MEDIUMTEXT NULL,
    UNIQUE KEY uq_hist_user_domain (user_id, domain)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gsc_urls (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL DEFAULT 1,
    domain VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    requested_at DATETIME NOT NULL,
    status VARCHAR(50) NOT NULL,
    details TEXT NULL,
    INDEX idx_urls_user (user_id),
    INDEX idx_urls_domain (domain),
    INDEX idx_urls_requested (requested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gsc_queue (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL DEFAULT 1,
    domain VARCHAR(255) NOT NULL,
    url VARCHAR(2000) NOT NULL,
    scheduled_for DATE NOT NULL,
    status ENUM('queued','sent','failed') NOT NULL DEFAULT 'queued',
    details TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at DATETIME NULL,
    UNIQUE KEY uq_queue (user_id, domain(100), url(500), scheduled_for),
    INDEX idx_queue_due (status, scheduled_for)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
