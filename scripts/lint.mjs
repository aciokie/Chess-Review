import { readdir, readFile, writeFile, mkdir, rm, link } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// web-ext lint always validates against Firefox, but the checked-in manifest is a hybrid:
// Chrome's MV3 `background.service_worker` plus Firefox's event-page `background.scripts`,
// with the build stripping one field per browser. Linting that hybrid raises
// BACKGROUND_SERVICE_WORKER_IGNORED. So we lint a staged copy of the Firefox profile the build
// actually ships. The stage hardlinks every file (same volume, so nothing is copied) and rewrites
// only manifest.json, leaving the tracked source untouched.
const root = fileURLToPath(new URL('../', import.meta.url));
const stageRoot = path.join(root, 'web-ext-artifacts');
const stage = path.join(stageRoot, 'lint-source');
const webExt = path.join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
const skip = new Set(['.git', 'node_modules', 'web-ext-artifacts', 'calibration-runs', 'manifest.json']);

async function stageDir(rel) {
  const fromDir = path.join(root, rel);
  for (const entry of await readdir(fromDir, { withFileTypes: true })) {
    if (!rel && skip.has(entry.name)) continue;
    const relPath = rel ? path.join(rel, entry.name) : entry.name;
    const to = path.join(stage, relPath);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await stageDir(relPath);
    } else {
      await link(path.join(root, relPath), to);
    }
  }
}

await mkdir(stageRoot, { recursive: true });
await rm(stage, { recursive: true, force: true });
await mkdir(stage);
let code = 0;
try {
  await stageDir('');
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  delete manifest.background?.service_worker;
  delete manifest.minimum_chrome_version;
  await writeFile(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    execFileSync(process.execPath, [webExt, 'lint', `--source-dir=${stage}`], { stdio: 'inherit' });
  } catch (error) {
    code = typeof error.status === 'number' ? error.status : 1;
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
process.exitCode = code;
