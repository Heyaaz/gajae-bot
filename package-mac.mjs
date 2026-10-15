import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { packager } from '@electron/packager';

const exec = promisify(execFile);
const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const args = new Set(process.argv.slice(2));
const release = args.has('--release') || args.has('--public-release') || process.env.PUBLIC_RELEASE === '1' || process.env.GJC_PUBLIC_RELEASE === '1';
if (args.has('--notarize') && !release)
  throw new Error('--notarize is valid only with --public-release.');
const notarize = release;

function option(name) {
  const prefix = `${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}

const identity = option('--identity') || process.env.GJC_DEVELOPER_IDENTITY;
const notaryProfile = option('--notary-profile') || process.env.GAJA_NOTARY_KEYCHAIN_PROFILE;
const assetRightsConfirmed = process.env.GAJAE_ASSET_RIGHTS_CONFIRMED === '1';
const entitlements = path.join(root, 'build', 'entitlements.mac.plist');
const releaseDirectory = path.join(root, 'release');
const releaseBaseName = `${packageJson.productName}-${packageJson.version}-darwin-arm64`;
const publicDirectory = path.join(releaseDirectory, releaseBaseName);
const stagingDirectory = path.join(releaseDirectory, `.gajae-${packageJson.version}-${process.pid}`);

async function exists(file) {
  try { await access(file); return true; }
  catch { return false; }
}

if (release && (!identity || !identity.startsWith('Developer ID Application:'))) {
  throw new Error('Public release requires a Developer ID Application identity (--identity or GJC_DEVELOPER_IDENTITY).');
}
if (release && !assetRightsConfirmed) {
  throw new Error('Public release requires GAJAE_ASSET_RIGHTS_CONFIRMED=1 after confirming redistribution rights for bundled artwork.');
}
if (notarize && !notaryProfile) {
  throw new Error('Notarization requires a Keychain profile (--notary-profile or GAJA_NOTARY_KEYCHAIN_PROFILE).');
}
if (release) {
  // Public artifacts are immutable per SemVer. A rerun cannot overwrite a valid
  // same-version release or make an older file look like output from this process.
  if (await exists(publicDirectory))
    throw new Error(`Release ${releaseBaseName} already exists; bump package.json version before publishing again.`);
  await rm(stagingDirectory, { recursive: true, force: true });
  process.once('exit', () => rmSync(stagingDirectory, { recursive: true, force: true }));
}

await exec('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });

const [outputDirectory] = await packager({
  dir: root,
  name: packageJson.productName,
  platform: 'darwin',
  arch: 'arm64',
  out: release ? stagingDirectory : releaseDirectory,
  overwrite: true,
  asar: true,
  prune: true,
  appBundleId: 'com.gajae.desktop',
  appVersion: packageJson.version,
  icon: path.join(root, 'src/assets/gajae-icon'),
  ...(release
    ? {
        osxSign: {
          identity,
          hardenedRuntime: true,
          entitlements,
          entitlementsInherit: entitlements,
          gatekeeperAssess: false,
        },
      }
    : {}),
  // Root source is excluded without matching the compiled
  // `/dist-electron/electron` runtime directory. Dependency test trees are also
  // omitted, while package implementation sources remain available when a module
  // publishes them as runtime code.
  ignore: [
    /^\/\.[^/]+(?:\/|$)/,
    /^\/(?:src|electron|scripts|build|artifacts|release|docs|web)(?:\/|$)/,
    /^\/(?:README(?:\.[^/]+)?|CHANGELOG(?:\.[^/]+)?|package-lock\.json|package-mac\.mjs)$/,
    /^\/(?:tsconfig|vite\.config|vite\.web\.config|vitest\.config)(?:\.[^/]+)?$/,
    /\/(?:test|tests|__tests__)(?:\/|$)/,
    /\/(?:[^/]+)\.(?:test|spec)\.[^/]+$/,
    /\/node_modules\/\.cache(?:\/|$)/,
  ],
});
const appPath = path.join(outputDirectory, `${packageJson.productName}.app`);

if (!release)
  await exec('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    cwd: root,
  });
await exec('codesign', ['--verify', '--deep', '--strict', appPath], { cwd: root, stdio: 'inherit' });

if (notarize) {
  const submissionZip = path.join(stagingDirectory, `${packageJson.productName}-notary.zip`);
  await exec('ditto', ['-c', '-k', '--keepParent', appPath, submissionZip], { cwd: root });
  await exec('xcrun', ['notarytool', 'submit', submissionZip, '--keychain-profile', notaryProfile, '--wait'], { cwd: root });
  await exec('xcrun', ['stapler', 'staple', appPath], { cwd: root, stdio: 'inherit' });
  await exec('xcrun', ['stapler', 'validate', appPath], { cwd: root });
  await rm(submissionZip, { force: true });
}

if (release) {
  await exec('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath], { cwd: root });
  const publicationDirectory = path.join(stagingDirectory, 'publication');
  await mkdir(publicationDirectory);
  const temporaryArchive = path.join(publicationDirectory, `${releaseBaseName}.zip`);
  await exec('ditto', ['-c', '-k', '--keepParent', appPath, temporaryArchive], { cwd: root });
  const { stdout } = await exec('shasum', ['-a', '256', path.basename(temporaryArchive)], { cwd: publicationDirectory });
  const temporaryChecksum = `${temporaryArchive}.sha256`;
  await writeFile(temporaryChecksum, stdout, 'utf8');
  try {
    // Renaming one directory publishes the ZIP and its matching checksum as one
    // atomic unit. A concurrent same-version publisher can no longer interleave
    // files or delete the winner's output.
    await rename(publicationDirectory, publicDirectory);
  } catch (error) {
    throw error;
  }
  await rm(stagingDirectory, { recursive: true, force: true });
}

console.log(
  release
    ? `Public notarized macOS arm64 package ready: ${publicDirectory}`
    : `Development macOS arm64 package ready: ${appPath}`,
);
