const http = require('node:http');
const fs = require('node:fs');
const handler = require('../api/progress.js');
const files = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/cloud.js': 'cloud.js', '/stories.js': 'stories.js', '/style.css': 'style.css' };
http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/progress') {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    req.body = Buffer.concat(chunks).toString();
    res.status = code => { res.statusCode = code; return res; };
    res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    return handler(req, res);
  }
  if (!files[path]) { res.writeHead(404).end('Not found'); return; }
  res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(require('node:path').join(__dirname, '..', files[path])));
}).listen(8000, '127.0.0.1', () => console.log('Story Spark: http://localhost:8000'));
