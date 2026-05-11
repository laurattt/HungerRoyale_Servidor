const fs = require('fs');
const path = require('path');

const FLUTTER_DIR = path.join(__dirname, '../flutter');

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.frag': 'text/plain',
  '.otf':  'font/otf',
  '.bin':  'application/octet-stream',
};

function handleWeb(req, res) {
  let urlPath = req.url.split('?')[0];

  if (urlPath === '/duckgame' || urlPath === '/duckgame/') urlPath = '/duckgame/index.html';
  if (!urlPath.startsWith('/duckgame')) { res.writeHead(404); return res.end('Not found'); }

  const filePath = path.join(FLUTTER_DIR, decodeURIComponent(urlPath.replace('/duckgame', '')));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

module.exports = { handleWeb };
