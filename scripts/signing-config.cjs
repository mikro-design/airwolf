// electron-builder configuration for signed release builds: package.json's
// "build" field plus the signing settings that only apply when credentials
// exist. CI passes it with --config only on version tags that have them
// (see "Configure release signing" in .github/workflows/check.yml), so pull
// request, main and unsigned tag builds keep using package.json unchanged.
const { build } = require('../package.json');

const config = structuredClone(build);
if (process.env.AIRWOLF_SIGN_WINDOWS === '1') {
  const required = [
    'AZURE_SIGNING_ENDPOINT',
    'AZURE_SIGNING_ACCOUNT',
    'AZURE_SIGNING_PROFILE',
    'AZURE_SIGNING_PUBLISHER',
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Windows signing needs ${missing.join(', ')}`);
  config.win = {
    ...config.win,
    // electron-builder signs only .exe files by default; the bundled radio
    // libraries (libhackrf, libusb, libiio, FFTW) are DLLs.
    signExts: ['.dll'],
    azureSignOptions: {
      // Must equal the certificate subject's common name exactly.
      publisherName: process.env.AZURE_SIGNING_PUBLISHER,
      endpoint: process.env.AZURE_SIGNING_ENDPOINT,
      codeSigningAccountName: process.env.AZURE_SIGNING_ACCOUNT,
      certificateProfileName: process.env.AZURE_SIGNING_PROFILE,
    },
  };
}
// macOS needs no extra configuration: electron-builder signs every Mach-O file
// in the bundle (including Resources/native workers and dylibs) with CSC_LINK's
// Developer ID identity, hardened runtime and its default Electron
// entitlements, and notarizes and staples the app when APPLE_API_KEY,
// APPLE_API_KEY_ID and APPLE_API_ISSUER are set.
module.exports = config;
