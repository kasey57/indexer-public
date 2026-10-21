const { google } = require('googleapis');
const { createConnection } = require('./db');
const dns = require('node:dns').promises;
const net = require('node:net');
const CRON_SECRET = process.env.CRON_SECRET || '';
const OWNER_ID = 1;

function getDomainFromList(urlList) {
    const firstUrl = urlList[0].startsWith('http') ? urlList[0] : 'https://' + urlList[0];
    return new URL(firstUrl).hostname;
}

function parseUrlList(urls) {
    if (!urls) return [];
    return urls.split('\n').map(u => u.trim()).filter(u => u.length > 0);
}

const DAILY_QUOTA = 200;

function isBlockedIPv4(address) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const ip = parts.reduce((n, part) => (n * 256) + part, 0);
    const ranges = [
        ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
        ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
        ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
        ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
    ];
    return ranges.some(([base, bits]) => {
        const baseIp = base.split('.').map(Number).reduce((n, part) => (n * 256) + part, 0);
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        return (ip & mask) === (baseIp & mask);
    });
}

function isPublicAddress(address) {
    const family = net.isIP(address);
    if (family === 4) return !isBlockedIPv4(address);
    if (family !== 6) return false;
    const ip = address.toLowerCase().split('%')[0];
    const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return !isBlockedIPv4(mapped[1]);
    const first = parseInt(ip.split(':')[0] || '0', 16);
    if (first < 0x2000 || first > 0x3fff) return false;
    if (/^2001:(?:0{0,3}[0-1]?[0-9a-f]{1,2}|db8)(?::|$)/i.test(ip)) return false;
    return true;
}

async function assertPublicHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
        throw new Error('Private or local hosts are not allowed.');
    }
    const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        throw new Error('Private or local hosts are not allowed.');
    }
}

async function fetchText(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
        let current = new URL(url);
        for (let redirect = 0; redirect <= 4; redirect++) {
            if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password) {
                throw new Error('Only public HTTP or HTTPS URLs are allowed.');
            }
            await assertPublicHost(current.hostname);
            const r = await fetch(current, { signal: ctrl.signal, redirect: 'manual', headers: { 'User-Agent': 'indexing-public/1.0' } });
            if ([301, 302, 303, 307, 308].includes(r.status)) {
                const location = r.headers.get('location');
                if (!location || redirect === 4) throw new Error('Too many or invalid redirects.');
                current = new URL(location, current);
                continue;
            }
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const text = await r.text();
            if (text.length > 10 * 1024 * 1024) throw new Error('Sitemap is larger than 10 MB.');
            return text;
        }
        throw new Error('Too many redirects.');
    } finally {
        clearTimeout(t);
    }
}

function parseLocs(xml) {
    const out = [];
    const re = /<loc>\s*([^<]+?)\s*<\/loc>/g;
    let m;
    while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
    return out;
}

async function getStoredKey(connection, userId, domain) {
    const [rows] = await connection.execute(
        'SELECT google_creds, google_service_account FROM gsc_history WHERE user_id = ? AND domain = ?',
        [userId, domain]
    );
    if (rows.length > 0 && rows[0].google_creds) return rows[0];
    return null;
}

async function getQuotaUsage(connection) {
    const [sentRows] = await connection.execute("SELECT COUNT(*) AS c FROM gsc_urls WHERE requested_at >= CURDATE() AND status = 'Success'");
    const [qRows] = await connection.execute("SELECT COUNT(*) AS c FROM gsc_queue WHERE status = 'queued' AND scheduled_for = CURDATE()");
    const usedToday = Number(sentRows[0].c) + Number(qRows[0].c);
    return { used: usedToday, limit: DAILY_QUOTA, remaining: Math.max(0, DAILY_QUOTA - usedToday) };
}

async function getRemainingQuota(connection) {
    return (await getQuotaUsage(connection)).remaining;
}

async function enqueueUrls(connection, userId, domain, urls) {
    const withDay = urls.map((url, i) => {
        const d = new Date();
        d.setDate(d.getDate() + 1 + Math.floor(i / DAILY_QUOTA));
        return { url, day: d.toISOString().slice(0, 10) };
    });
    for (let i = 0; i < withDay.length; i += 500) {
        const vals = withDay.slice(i, i + 500).map(r => [userId, domain, r.url, r.day]);
        if (vals.length === 0) break;
        await connection.query(
            "INSERT INTO gsc_queue (user_id, domain, url, scheduled_for) VALUES ? ON DUPLICATE KEY UPDATE status = 'queued', scheduled_for = VALUES(scheduled_for)",
            [vals]
        );
    }
    const batches = [];
    withDay.forEach(r => {
        const b = batches.find(x => x.day === r.day);
        if (b) b.count++;
        else batches.push({ day: r.day, count: 1 });
    });
    return batches;
}
async function publishBatch(parsedCredentials, urlList, domain) {
    const auth = new google.auth.GoogleAuth({
        credentials: parsedCredentials,
        scopes: ['https://www.googleapis.com/auth/indexing'],
    });
    const indexing = google.indexing({ version: 'v3', auth: auth });
    const results = [];
    for (const url of urlList) {
        const cleanUrl = url.startsWith('http') ? url : 'https://' + url;
        try {
            await indexing.urlNotifications.publish({
                requestBody: { url: cleanUrl, type: 'URL_UPDATED' }
            });
            results.push({ url: cleanUrl, domain, status: 'Success', details: 'OK' });
        } catch (error) {
            results.push({ url: cleanUrl, domain, status: 'Error', details: error.message });
        }
    }
    return results;
}

async function saveResults(connection, userId, domain, results, activeCreds, activeServiceAccount) {
    const hasErrors = results.some(r => r.status === 'Error');
    const statusText = hasErrors ? 'Partial error' : 'Success';
    const now = new Date();
    await connection.execute(
        `INSERT INTO gsc_history (user_id, domain, last_requested, status, google_service_account, google_creds)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE last_requested = ?, status = ?, google_service_account = ?, google_creds = ?`,
        [userId, domain, now, statusText, activeServiceAccount, activeCreds, now, statusText, activeServiceAccount, activeCreds]
    );
    for (let i = 0; i < results.length; i += 500) {
        const chunk = results.slice(i, i + 500).map(r => [userId, domain, r.url, now, r.status, r.details]);
        if (chunk.length === 0) break;
        await connection.query(
            'INSERT INTO gsc_urls (user_id, domain, url, requested_at, status, details) VALUES ?',
            [chunk]
        );
    }
}

module.exports = async (req, res) => {
    const { action } = req.query;
    const isCron = Boolean(CRON_SECRET) && req.method === 'GET' && action === 'process-queue' && req.headers.authorization === `Bearer ${CRON_SECRET}`;

    if (req.method !== 'POST' && !isCron) {
        return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    let connection;
    try {
        connection = await createConnection();
    } catch (e) {
        console.error('DB connect error:', e);
        return res.status(500).json({ success: false, message: 'Database connection failed.' });
    }

    try {

        // Shared workspace history. Restrict access through the server or network.
        if (action === 'get-history') {
            const [domains] = await connection.execute('SELECT user_id, domain, last_requested, status, google_service_account FROM gsc_history WHERE user_id = ? ORDER BY last_requested DESC LIMIT 500', [OWNER_ID]);
            const [urls] = await connection.execute('SELECT id, user_id, domain, url, requested_at, status, details FROM gsc_urls WHERE user_id = ? ORDER BY requested_at DESC LIMIT 5000', [OWNER_ID]);
            const quota = await getQuotaUsage(connection);
            await connection.end();
            connection = null;
            const byKey = new Map();
            for (const u of urls) {
                const key = u.user_id + '||' + u.domain;
                if (!byKey.has(key)) byKey.set(key, []);
                byKey.get(key).push(u);
            }
            const structuredData = domains.map(d => ({ ...d, subUrls: byKey.get(d.user_id + '||' + d.domain) || [] }));
            return res.status(200).json({ success: true, domains: structuredData, quota });
        }

        // Delete a domain and related history.
        if (action === 'delete-domain') {
            const { domain } = req.body;
            if (!domain) {
                await connection.end();
                connection = null;
                return res.status(400).json({ success: false, message: 'Domain is required.' });
            }
            const targetUser = OWNER_ID;
            await connection.execute('DELETE FROM gsc_urls WHERE user_id = ? AND domain = ?', [targetUser, domain]);
            await connection.execute('DELETE FROM gsc_history WHERE user_id = ? AND domain = ?', [targetUser, domain]);
            await connection.execute('DELETE FROM gsc_queue WHERE user_id = ? AND domain = ? AND status = ?', [targetUser, domain, 'queued']);
            await connection.end();
            connection = null;
            return res.status(200).json({ success: true });
        }

        // Delete one URL record.
        if (action === 'delete-url') {
            const { id } = req.body;
            if (!id) {
                await connection.end();
                connection = null;
                return res.status(400).json({ success: false, message: 'ID is required.' });
            }
            await connection.execute('DELETE FROM gsc_urls WHERE id = ? AND user_id = ?', [id, OWNER_ID]);
            await connection.end();
            connection = null;
            return res.status(200).json({ success: true });
        }

        // Import sitemap URLs and queue items beyond the daily quota.
        if (action === 'import-sitemap') {
            const { googleCreds, serviceAccount, sitemapUrl, incognito } = req.body;
            const isIncognito = incognito === true || incognito === 'true' || incognito === 1;
            if (!sitemapUrl) {
                await connection.end();
                connection = null;
                return res.status(400).json({ success: false, message: 'Enter a sitemap URL.' });
            }

            let xml;
            try {
                xml = await fetchText(sitemapUrl.trim());
            } catch (e) {
                await connection.end();
                connection = null;
                return res.status(400).json({ success: false, message: 'Could not fetch the sitemap: ' + e.message });
            }

            let locs = parseLocs(xml);
            const xmlLocs = locs.filter(u => u.toLowerCase().split('?')[0].endsWith('.xml'));
            if (locs.length > 0 && xmlLocs.length === locs.length && xmlLocs.length <= 100) {
                const nested = [];
                for (const s of xmlLocs) {
                    try {
                        parseLocs(await fetchText(s)).forEach(u => nested.push(u));
                    } catch (e) {}
                }
                locs = nested;
            }

            const urls = [...new Set(
                locs.filter(u => /^https?:\/\//i.test(u) && !u.toLowerCase().split('?')[0].endsWith('.xml'))
            )].slice(0, 10000);

            if (urls.length === 0) {
                await connection.end();
                connection = null;
                return res.status(400).json({ success: false, message: 'No page URLs found in this sitemap (it may be an index with no child sitemaps).' });
            }

            let targetDomain = '';
            try {
                targetDomain = new URL(urls[0]).hostname;
            } catch (e) {
                await connection.end();
                connection = null;
                return res.status(400).json({ success: false, message: 'The sitemap contains an invalid URL.' });
            }

            let activeCreds = googleCreds;
            let activeServiceAccount = serviceAccount;
            if (!activeCreds) {
                if (isIncognito) {
                    await connection.end();
                    connection = null;
                    return res.status(400).json({ success: false, message: 'Private mode: upload a service account JSON key.' });
                }
                const stored = await getStoredKey(connection, OWNER_ID, targetDomain);
                if (stored) {
                    activeCreds = stored.google_creds;
                    activeServiceAccount = stored.google_service_account;
                } else {
                    await connection.end();
                    connection = null;
                    return res.status(400).json({
                        success: false,
                        message: `No saved key for domain ${targetDomain}. Upload a service account JSON key before importing the sitemap.`
                    });
                }
            }

            let parsedCredentials;
            try {
                parsedCredentials = JSON.parse(activeCreds);
            } catch (e) {
                await connection.end();
                connection = null;
                return res.status(400).json({ success: false, message: 'Saved credentials are invalid. Upload the key again.' });
            }
            if (!activeServiceAccount && parsedCredentials.client_email) {
                activeServiceAccount = parsedCredentials.client_email;
            }

            const remaining = await getRemainingQuota(connection);

            const todayBatch = urls.slice(0, remaining);
            const rest = urls.slice(remaining);

            let sent = [];
            if (todayBatch.length > 0) {
                sent = await publishBatch(parsedCredentials, todayBatch, targetDomain);
                if (!isIncognito) {
                    await saveResults(connection, OWNER_ID, targetDomain, sent, activeCreds, activeServiceAccount);
                }
            }

            const batches = isIncognito ? [] : await enqueueUrls(connection, OWNER_ID, targetDomain, rest);

            await connection.end();
            connection = null;
            return res.status(200).json({
                success: true,
                domain: targetDomain,
                total: urls.length,
                sentToday: sent.length,
                sent,
                queued: isIncognito ? 0 : rest.length,
                dropped: isIncognito ? rest.length : 0,
                incognito: isIncognito,
                batches
            });
        }

        // Read the pending queue.
        if (action === 'get-queue') {
            const [rows] = await connection.execute(
                "SELECT id, user_id, domain, url, DATE_FORMAT(scheduled_for, '%Y-%m-%d') AS day, status, details FROM gsc_queue WHERE user_id = ? AND status = 'queued' ORDER BY scheduled_for LIMIT 5000",
                [OWNER_ID]
            );
            const [batches] = await connection.execute(
                "SELECT domain, DATE_FORMAT(scheduled_for, '%Y-%m-%d') AS day, COUNT(*) AS c FROM gsc_queue WHERE user_id = ? AND status = 'queued' GROUP BY domain, scheduled_for ORDER BY scheduled_for",
                [OWNER_ID]
            );
            await connection.end();
            connection = null;
            return res.status(200).json({ success: true, queue: rows, batches });
        }

        if (action === 'delete-queued') {
            const { id, domain, day, all } = req.body;
            if (id) {
                await connection.execute('DELETE FROM gsc_queue WHERE id = ? AND user_id = ?', [id, OWNER_ID]);
            } else if (domain && day) {
                await connection.execute("DELETE FROM gsc_queue WHERE domain = ? AND scheduled_for = ? AND status = 'queued' AND user_id = ?", [domain, day, OWNER_ID]);
            } else if (day) {
                await connection.execute("DELETE FROM gsc_queue WHERE scheduled_for = ? AND status = 'queued' AND user_id = ?", [day, OWNER_ID]);
            } else if (domain) {
                await connection.execute("DELETE FROM gsc_queue WHERE domain = ? AND status = 'queued' AND user_id = ?", [domain, OWNER_ID]);
            } else if (all) {
                await connection.execute("DELETE FROM gsc_queue WHERE status = 'queued' AND user_id = ?", [OWNER_ID]);
            } else {
                await connection.end();
                connection = null;
                return res.status(400).json({ success: false, message: 'Provide an item, domain, day, or all flag.' });
            }
            await connection.end();
            connection = null;
            return res.status(200).json({ success: true });
        }

        // Process due URLs, capped by the shared daily quota.
        if (action === 'process-queue') {
            const remaining = await getRemainingQuota(connection);
            if (remaining <= 0) {
                await connection.end();
                connection = null;
                return res.status(200).json({ success: true, processed: 0, results: [], message: 'Daily quota (200) reached.' });
            }
            const [due] = await connection.query(
                "SELECT id, user_id, domain, url FROM gsc_queue WHERE status = 'queued' AND scheduled_for <= CURDATE() ORDER BY scheduled_for LIMIT ?",
                [Math.min(200, remaining)]
            );
            if (due.length === 0) {
                await connection.end();
                connection = null;
                return res.status(200).json({ success: true, processed: 0, results: [] });
            }

            const byKey = {};
            due.forEach(r => { const k = r.user_id + '||' + r.domain; (byKey[k] = byKey[k] || []).push(r); });

            const summary = [];
            for (const key of Object.keys(byKey)) {
                const sep = key.indexOf('||');
                const uid = Number(key.slice(0, sep));
                const domain = key.slice(sep + 2);
                const stored = await getStoredKey(connection, uid, domain);
                if (!stored) {
                    for (const r of byKey[key]) {
                        await connection.execute("UPDATE gsc_queue SET status = 'failed', details = 'No key stored in the database', sent_at = NOW() WHERE id = ?", [r.id]);
                    }
                    summary.push({ domain, ok: 0, failed: byKey[key].length, error: 'No saved key' });
                    continue;
                }
                let parsed;
                try {
                    parsed = JSON.parse(stored.google_creds);
                } catch (e) {
                    for (const r of byKey[key]) {
                        await connection.execute("UPDATE gsc_queue SET status = 'failed', details = 'Invalid credentials JSON', sent_at = NOW() WHERE id = ?", [r.id]);
                    }
                    summary.push({ domain, ok: 0, failed: byKey[key].length, error: 'Invalid credentials' });
                    continue;
                }
                const results = await publishBatch(parsed, byKey[key].map(r => r.url), domain);
                let ok = 0;
                for (let i = 0; i < results.length; i++) {
                    const r = results[i];
                    const rowId = byKey[key][i].id;
                    if (r.status === 'Success') {
                        ok++;
                        await connection.execute("UPDATE gsc_queue SET status = 'sent', details = 'OK', sent_at = NOW() WHERE id = ?", [rowId]);
                    } else {
                        await connection.execute("UPDATE gsc_queue SET status = 'failed', details = ?, sent_at = NOW() WHERE id = ?", [r.details, rowId]);
                    }
                }
                await saveResults(connection, uid, domain, results, stored.google_creds, stored.google_service_account);
                summary.push({ domain, ok, failed: results.length - ok });
            }

            await connection.end();
            connection = null;
            return res.status(200).json({ success: true, processed: due.length, summary });
        }

        // Submit URLs and queue requests beyond the daily quota.
        if (action === 'index-urls') {
            const { googleCreds, serviceAccount, urls, incognito } = req.body;
            const isIncognito = incognito === true || incognito === 'true' || incognito === 1;
            const urlList = [...new Set(parseUrlList(urls))];
            if (urlList.length === 0) {
                await connection.end();
                connection = null;
                return res.status(400).json({ success: false, message: 'The URL list is empty.' });
            }

            let targetDomain = '';
            try {
                targetDomain = getDomainFromList(urlList);
            } catch (e) {
                await connection.end();
                connection = null;
                return res.status(400).json({ success: false, message: 'The first URL is invalid.' });
            }

            let activeCreds = googleCreds;
            let activeServiceAccount = serviceAccount;

            // Reuse the saved domain key unless Private request mode is enabled.
            if (!activeCreds) {
                if (isIncognito) {
                    await connection.end();
                    connection = null;
                    return res.status(400).json({ success: false, message: 'Private mode: upload a service account JSON key.' });
                }
                const stored = await getStoredKey(connection, OWNER_ID, targetDomain);

                if (stored) {
                    activeCreds = stored.google_creds;
                    activeServiceAccount = stored.google_service_account;
                } else {
                    await connection.end();
                    connection = null;
                    return res.status(400).json({
                        success: false,
                        message: `No saved key for domain ${targetDomain}. Upload a service account JSON key for the first request.`
                    });
                }
            }

            let parsedCredentials;
            try {
                parsedCredentials = JSON.parse(activeCreds);
            } catch (e) {
                await connection.end();
                connection = null;
                return res.status(400).json({ success: false, message: 'Saved credentials are invalid. Upload the key again.' });
            }
            if (!activeServiceAccount && parsedCredentials.client_email) {
                activeServiceAccount = parsedCredentials.client_email;
            }

            const remaining = await getRemainingQuota(connection);
            const todayBatch = urlList.slice(0, remaining);
            const rest = urlList.slice(remaining);

            let results = [];
            if (todayBatch.length > 0) {
                results = await publishBatch(parsedCredentials, todayBatch, targetDomain);
                if (!isIncognito) {
                    await saveResults(connection, OWNER_ID, targetDomain, results, activeCreds, activeServiceAccount);
                }
            }

            const batches = isIncognito ? [] : await enqueueUrls(connection, OWNER_ID, targetDomain, rest.map(u => u.startsWith('http') ? u : 'https://' + u));

            await connection.end();
            connection = null;
            return res.status(200).json({ success: true, results, sentToday: results.length, queued: isIncognito ? 0 : rest.length, dropped: isIncognito ? rest.length : 0, incognito: isIncognito, batches, domain: targetDomain, total: urlList.length });
        }

        await connection.end();
        connection = null;
        return res.status(400).json({ success: false, message: 'Unknown action' });

    } catch (err) {
        console.error('API error:', action, err);
        if (connection) try { await connection.end(); } catch (e) {}
        return res.status(500).json({ success: false, message: 'Request failed. Check the server logs.' });
    }
};
