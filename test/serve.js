const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 8123);

const types = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
	res.writeHead(status, {
		'Content-Type': type,
		'Cache-Control': 'no-store',
	});
	res.end(body);
}

function safePath(urlPath) {
	const decoded = decodeURIComponent(urlPath.split('?')[0]);
	const rel = decoded === '/' ? '/test/browser-test.html' : decoded;
	const full = path.resolve(root, `.${rel}`);
	return full.startsWith(root) ? full : undefined;
}

const server = http.createServer((req, res) => {
	const filePath = safePath(req.url || '/');
	if (!filePath)
		return send(res, 403, 'Forbidden');

	fs.stat(filePath, (err, stat) => {
		if (err)
			return send(res, 404, 'Not Found');

		const target = stat.isDirectory() ? path.join(filePath, 'index.html') : filePath;
		fs.readFile(target, (readErr, data) => {
			if (readErr)
				return send(res, 404, 'Not Found');

			send(res, 200, data, types[path.extname(target).toLowerCase()] || 'application/octet-stream');
		});
	});
});

server.listen(port, '127.0.0.1', () => {
	console.log(`Server ready at http://127.0.0.1:${port}/test/browser-test.html`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));