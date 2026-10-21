const http = require('http');
const fs = require('fs');
const path = require('path');
const handler = require('./api/index');

const port = Number(process.env.PORT || 3000);
const htmlPath = path.join(__dirname, 'public', 'index.html');

http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api')) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > 1024 * 1024) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Request body is too large.' }));
                return;
            }
            chunks.push(chunk);
        }
        let body = {};
        if (chunks.length) {
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch (_) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Invalid JSON request body.' }));
                return;
            }
        }
        req.query = Object.fromEntries(url.searchParams.entries());
        req.body = body;
        res.status = function (code) { this.statusCode = code; return this; };
        res.json = function (data) {
            this.setHeader('Content-Type', 'application/json; charset=utf-8');
            this.end(JSON.stringify(data));
            return this;
        };
        await handler(req, res);
        return;
    }

    if (req.method !== 'GET' || !['/', '/index.html'].includes(url.pathname)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(htmlPath).pipe(res);
}).listen(port, () => console.log(`Indexing Public is running at http://localhost:${port}`));
