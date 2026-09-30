'use strict';
const http = require('http');
const { app, authorizeSocket, cleanup } = require('./app');
const rt = require('./realtime');

const PORT = Number(process.env.PORT) || 3000;
const server = http.createServer(app);
rt.attach(server, authorizeSocket);

cleanup();
setInterval(cleanup, 12 * 3600e3).unref();

server.listen(PORT, () => {
  const nets = Object.values(require('os').networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal);
  console.log(`영단어 800 서버 실행 중`);
  console.log(`  학생:  http://localhost:${PORT}/`);
  console.log(`  교사:  http://localhost:${PORT}/teacher.html`);
  nets.forEach(n => console.log(`  같은 네트워크: http://${n.address}:${PORT}/`));
});
