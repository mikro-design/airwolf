const fs = require('node:fs');
const path = require('node:path');
module.exports = async (context) => {
  const mac = context.electronPlatformName === 'darwin';
  const product = context.packager.appInfo.productFilename;
  const app = mac ? path.join(context.appOutDir, `${product}.app`) : context.appOutDir;
  const resources = mac ? path.join(app, 'Contents', 'Resources') : path.join(app, 'resources');
  const executable = mac
    ? path.join(app, 'Contents', 'MacOS', product)
    : path.join(app, context.electronPlatformName === 'win32' ? `${product}.exe` : 'airwolf');
  fs.writeFileSync(
    path.join(context.outDir, 'package-path.json'),
    JSON.stringify({ executable, resources }, null, 2),
  );
};
