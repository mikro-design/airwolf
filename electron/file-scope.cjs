// The renderer is a file:// page. Chromium treats every file:// URL as
// same-origin for it, so a compromised renderer could fetch any local file
// (keys, captures, ~/.ssh) despite the sandbox and CSP. The file scheme is
// intercepted and only the app's own build directory is served.
const path = require('node:path');
const { fileURLToPath } = require('node:url');

function insideRoot(url, root) {
  let target;
  try {
    target = path.resolve(fileURLToPath(url));
  } catch {
    return false;
  }
  const base = path.resolve(root);
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return fold(target) === fold(base) || fold(target).startsWith(fold(base) + path.sep);
}

function confineFileProtocol(protocol, net, root) {
  protocol.handle('file', (request) =>
    insideRoot(request.url, root)
      ? net.fetch(request.url, { bypassCustomProtocolHandlers: true })
      : new Response('Outside the application', { status: 403 }),
  );
}

module.exports = { insideRoot, confineFileProtocol };
