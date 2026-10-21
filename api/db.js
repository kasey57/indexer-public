const path = require('path');
const fs = require('fs');

const driver = String(process.env.DB_DRIVER || (process.env.DB_HOST ? 'mysql' : 'sqlite')).toLowerCase();

async function createConnection() {
    if (driver === 'mysql') {
        const mysql = require('mysql2/promise');
        return mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            port: parseInt(process.env.DB_PORT || '3306', 10),
            connectTimeout: 5000,
            ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : null
        });
    }

    if (driver !== 'sqlite') throw new Error('DB_DRIVER must be either "sqlite" or "mysql".');
    const Database = require('better-sqlite3');
    const filename = path.resolve(process.env.SQLITE_PATH || path.join(process.cwd(), 'data', 'indexing.sqlite'));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const db = new Database(filename, { timeout: 5000 });
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sqlite.sql'), 'utf8'));

    return {
        async execute(sql, params = []) {
            const translated = translateSql(sql);
            const statement = db.prepare(translated);
            let values = params.map(value => value instanceof Date ? value.toISOString().slice(0, 19).replace('T', ' ') : value);
            if (/ON DUPLICATE KEY UPDATE\s+last_requested/i.test(sql)) values = values.slice(0, 6);
            if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(translated)) return [statement.all(...values)];
            return [statement.run(...values)];
        },
        async query(sql, params = []) {
            if (/\bVALUES\s+\?/i.test(sql) && Array.isArray(params[0])) {
                const rows = params[0];
                if (!rows.length) return [{ changes: 0 }];
                const rowWidth = rows[0].length;
                const values = rows.map(() => `(${Array(rowWidth).fill('?').join(', ')})`).join(', ');
                const translated = translateSql(sql.replace(/VALUES\s+\?/i, `VALUES ${values}`));
                const flat = rows.flat().map(value => value instanceof Date ? value.toISOString().slice(0, 19).replace('T', ' ') : value);
                return [db.prepare(translated).run(...flat)];
            }
            return this.execute(sql, params);
        },
        async end() { db.close(); }
    };
}

function translateSql(sql) {
    return sql
        .replace(/DATE_FORMAT\(([^,]+),\s*'%Y-%m-%d'\)/gi, 'date($1)')
        .replace(/CURDATE\(\)/gi, "date('now')")
        .replace(/NOW\(\)/gi, "datetime('now')")
        .replace(/ON DUPLICATE KEY UPDATE\s+status\s*=\s*'queued',\s*scheduled_for\s*=\s*VALUES\(scheduled_for\)/gi,
            "ON CONFLICT(user_id, domain, url, scheduled_for) DO UPDATE SET status = 'queued'")
        .replace(/ON DUPLICATE KEY UPDATE\s+last_requested\s*=\s*\?,\s*status\s*=\s*\?,\s*google_service_account\s*=\s*\?,\s*google_creds\s*=\s*\?/gi,
            'ON CONFLICT(user_id, domain) DO UPDATE SET last_requested = excluded.last_requested, status = excluded.status, google_service_account = excluded.google_service_account, google_creds = excluded.google_creds');
}

module.exports = { createConnection, driver };
