import fs from 'node:fs';
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (process.argv[2] !== `v${version}`)
  throw new Error(`Release tag must match package.json: v${version}`);
