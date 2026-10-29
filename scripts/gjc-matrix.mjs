import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM = 'Yeachan-Heo/gajae-code'
const README_START = '<!-- gjc-matrix:start -->'
const README_END = '<!-- gjc-matrix:end -->'
const DEFAULT_VERSIONS = ['0.18.12', '0.19.0', 'latest']

/** One e2e entry point the matrix drives per version; `gjc-smoke` is the Electron surface. */
const STEPS = [
  { id: 'sdk-e2e', command: process.execPath, args: ['scripts/gjc-sdk-e2e.mjs'], timeoutMs: 15 * 60_000 },
  { id: 'cancel-e2e', command: process.execPath, args: ['scripts/gjc-cancel-e2e.mjs'], timeoutMs: 10 * 60_000 },
  { id: 'tool-stream-e2e', command: process.execPath, args: ['scripts/gjc-tool-stream-e2e.mjs'], timeoutMs: 10 * 60_000 },
  { id: 'gjc-smoke', command: 'npx', args: ['electron', '.', '--gjc-smoke'], timeoutMs: 5 * 60_000 },
  { id: 'sign-in-contract', command: process.execPath, args: ['scripts/gjc-sign-in-contract.mjs'], timeoutMs: 3 * 60_000 },
]

const USAGE = `Usage:
  node scripts/gjc-matrix.mjs [--versions 0.18.12,0.19.0,latest] [--steps sdk-e2e,...]
        [--out DIR] [--cache DIR] [--preset NAME] [--skip-build]
  node scripts/gjc-matrix.mjs --update-readme [REPORT.json]

Credentials: GJC_MATRIX_PROFILE must name a sanitized GJC agent directory that holds
API-key providers only. It is copied per version and never read back into a report.
Default out: ~/Library/Logs/gajae-gjc-matrix. Default cache: ~/Library/Caches/gajae-gjc-matrix.`

function parseArgs(argv) {
  const options = { versions: DEFAULT_VERSIONS, steps: STEPS.map((s) => s.id), updateReadme: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => argv[++i] ?? fail(`${arg} needs a value`)
    if (arg === '--versions') options.versions = value().split(',').map((v) => v.trim()).filter(Boolean)
    else if (arg === '--steps') options.steps = value().split(',').map((v) => v.trim()).filter(Boolean)
    else if (arg === '--out') options.out = path.resolve(value())
    else if (arg === '--cache') options.cache = path.resolve(value())
    else if (arg === '--preset') options.preset = value()
    else if (arg === '--skip-build') options.skipBuild = true
    else if (arg === '--update-readme') {
      options.updateReadme = true
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) options.reportPath = path.resolve(argv[++i])
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else fail(`unknown argument ${arg}\n${USAGE}`)
  }
  options.out ??= path.join(homedir(), 'Library', 'Logs', 'gajae-gjc-matrix')
  options.cache ??= path.join(homedir(), 'Library', 'Caches', 'gajae-gjc-matrix')
  for (const id of options.steps) if (!STEPS.some((s) => s.id === id)) fail(`unknown step ${id}`)
  return options
}

function fail(message) {
  console.error(message)
  process.exit(2)
}

function run(command, args, { cwd = repoRoot, env = process.env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let output = ''
    let timedOut = false
    const collect = (chunk) => {
      output += chunk.toString()
      if (output.length > 400_000) output = output.slice(-200_000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, output: `${output}${error.message}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, output, timedOut })
    })
  })
}

const assetName = () => {
  const platform = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform]
  const arch = { arm64: 'arm64', x64: 'x64' }[process.arch]
  if (!platform || !arch) fail(`unsupported platform ${process.platform}/${process.arch}`)
  return platform === 'windows' ? 'gjc-windows-x64.exe' : `gjc-${platform}-${arch}`
}

async function resolveVersion(spec) {
  if (spec !== 'latest') return spec.replace(/^v/, '')
  const result = await run('gh', ['api', `repos/${UPSTREAM}/releases/latest`, '--jq', '.tag_name'])
  if (result.code !== 0) throw new Error(`could not resolve the latest release: ${result.output.trim().slice(0, 200)}`)
  return result.output.trim().replace(/^v/, '')
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

/** Downloads a release binary into the cache (never ~/.local/bin) and verifies it against the release checksum file. */
async function obtainBinary(version, cacheDir) {
  const asset = assetName()
  const dir = path.join(cacheDir, version)
  const binary = path.join(dir, asset)
  const checksums = path.join(dir, 'gajae-release-binaries.sha256')
  await mkdir(dir, { recursive: true })
  if (!(await stat(binary).catch(() => undefined))) {
    const download = await run('gh', [
      'release', 'download', `v${version}`, '-R', UPSTREAM,
      '-p', asset, '-p', 'gajae-release-binaries.sha256', '-D', dir, '--clobber',
    ], { timeoutMs: 10 * 60_000 })
    if (download.code !== 0) throw new Error(`download failed: ${download.output.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`)
  }
  const expected = (await readFile(checksums, 'utf8'))
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1]?.replace(/^\*/, '').endsWith(asset))?.[0]
  if (!expected) throw new Error(`no checksum for ${asset} in the release checksum file`)
  const actual = await sha256(binary)
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset}`)
  await chmod(binary, 0o755)
  const versionRun = await run(binary, ['--version'], { timeoutMs: 30_000 })
  const reported = versionRun.output.match(/\d+\.\d+\.\d+\S*/)?.[0]
  if (versionRun.code !== 0 || reported !== version) {
    throw new Error(`binary reports ${JSON.stringify(versionRun.output.trim().slice(0, 80))}, expected ${version}`)
  }
  return { binary, sha256: actual }
}

/** Reports carry only a bounded tail, with anything shaped like a credential masked. */
function redact(text) {
  return text
    .replace(/\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[redacted]')
    .replace(/("?(?:api[_-]?key|token|secret|authorization|password)"?\s*[:=]\s*)"?[^\s",}]{8,}"?/gi, '$1[redacted]')
}

const tail = (text, lines = 30) => redact(text.trim().split('\n').slice(-lines).join('\n'))

async function runVersion(version, binary, options, versionDir) {
  const profile = process.env.GJC_MATRIX_PROFILE
  const agentDir = path.join(versionDir, 'agent')
  const userDataDir = path.join(versionDir, 'user-data')
  await mkdir(userDataDir, { recursive: true })
  await cp(profile, agentDir, { recursive: true })
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), `gajae-matrix-${version}-`))
  const env = {
    ...process.env,
    GJC_BIN: binary,
    GJC_CODING_AGENT_DIR: agentDir,
    GAJAE_USER_DATA_DIR: userDataDir,
    AGENT_CONTROL_GJC_PRESET: options.preset,
    AGENT_CONTROL_WORKSPACE: '',
  }
  delete env.AGENT_CONTROL_WORKSPACE
  const steps = []
  try {
    for (const id of options.steps) {
      const step = STEPS.find((candidate) => candidate.id === id)
      const stepEnv = { ...env, GJC_E2E_REPORT: path.join(versionDir, `${id}-detail.json`) }
      const started = Date.now()
      console.log(`[${version}] ${id} ...`)
      const result = await run(step.command, step.args, { env: stepEnv, timeoutMs: step.timeoutMs })
      const passed = result.code === 0 && !result.timedOut
      steps.push({
        id,
        passed,
        exitCode: result.code,
        timedOut: result.timedOut,
        durationMs: Date.now() - started,
        tail: tail(result.output, passed ? 8 : 30),
      })
      console.log(`[${version}] ${id} ${passed ? 'passed' : 'FAILED'}`)
    }
  } finally {
    // The per-version agent dir holds the copied profile; nothing later needs it.
    await rm(agentDir, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
  }
  return steps
}

const verdict = (steps) => steps.length > 0 && steps.every((s) => s.passed)

function markdownReport(report) {
  const ids = report.stepIds
  const rows = report.versions.map((entry) => {
    const cells = ids.map((id) => {
      const step = entry.steps?.find((s) => s.id === id)
      return step ? (step.passed ? 'pass' : 'FAIL') : '-'
    })
    const status = entry.error ? `unavailable: ${entry.error}` : verdict(entry.steps) ? 'verified' : 'failed'
    return `| ${entry.spec === entry.version || !entry.version ? (entry.version ?? entry.spec) : `${entry.version} (${entry.spec})`} | ${cells.join(' | ')} | ${status} |`
  })
  return [
    `# GJC compatibility matrix`,
    '',
    `Run at ${report.finishedAt} on ${report.platform}, preset \`${report.preset}\`.`,
    '',
    `| version | ${ids.join(' | ')} | result |`,
    `| --- | ${ids.map(() => '---').join(' | ')} | --- |`,
    ...rows,
    '',
  ].join('\n')
}

const semverKey = (v) => v.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
const compareVersions = (a, b) => {
  const [ka, kb] = [semverKey(a), semverKey(b)]
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
  return 0
}

function readmeBlock(report) {
  const verified = report.versions
    .filter((entry) => !entry.error && verdict(entry.steps))
    .map((entry) => entry.version)
    .sort(compareVersions)
  const failed = report.versions.filter((entry) => !entry.error && !verdict(entry.steps)).map((entry) => entry.version)
  const date = report.finishedAt.slice(0, 10)
  const lines = [
    README_START,
    verified.length > 0
      ? `Verified on ${verified.map((v) => `\`${v}\``).join(', ')} by \`npm run gjc:matrix\` (${date}; ${report.stepIds.join(', ')}).`
      : `No version passed the latest \`npm run gjc:matrix\` run (${date}).`,
  ]
  if (failed.length > 0) lines.push(`Failed in that run: ${failed.map((v) => `\`${v}\``).join(', ')}.`)
  lines.push(README_END)
  return lines.join('\n')
}

async function updateReadme(options) {
  const reportPath = options.reportPath ?? path.join(options.out, 'latest', 'report.json')
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const readmePath = path.join(repoRoot, 'README.md')
  const readme = await readFile(readmePath, 'utf8')
  const start = readme.indexOf(README_START)
  const end = readme.indexOf(README_END)
  if (start < 0 || end < start) fail(`README.md has no ${README_START} ... ${README_END} block`)
  const next = readme.slice(0, start) + readmeBlock(report) + readme.slice(end + README_END.length)
  await writeFile(readmePath, next)
  console.log(`README.md compatibility block rewritten from ${reportPath}`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.updateReadme) return updateReadme(options)

  const profile = process.env.GJC_MATRIX_PROFILE
  if (!profile || !(await stat(profile).catch(() => undefined))?.isDirectory()) {
    fail('GJC_MATRIX_PROFILE must name a sanitized GJC agent directory (API-key providers only)')
  }
  const realAgent = path.join(homedir(), '.gjc', 'agent')
  if (path.resolve(profile) === realAgent) fail('GJC_MATRIX_PROFILE must be a copy, never ~/.gjc/agent')
  options.preset = options.preset || process.env.GJC_MATRIX_PRESET || 'way'

  if (!options.skipBuild) {
    const build = await run('npm', ['run', 'build'], { timeoutMs: 10 * 60_000 })
    if (build.code !== 0) fail(`npm run build failed:\n${tail(build.output)}`)
  }

  const startedAt = new Date().toISOString()
  const stamp = startedAt.replace(/[:.]/g, '-')
  const runDir = path.join(options.out, stamp)
  await mkdir(runDir, { recursive: true })

  const versions = []
  for (const spec of options.versions) {
    const entry = { spec, version: undefined, steps: [] }
    try {
      entry.version = await resolveVersion(spec)
      // `latest` often names a version already listed; running it twice only burns spend.
      if (versions.some((seen) => seen.version === entry.version)) continue
      versions.push(entry)
      const obtained = await obtainBinary(entry.version, options.cache)
      entry.binarySha256 = obtained.sha256
      const versionDir = path.join(runDir, entry.version)
      await mkdir(versionDir, { recursive: true })
      entry.steps = await runVersion(entry.version, obtained.binary, options, versionDir)
    } catch (error) {
      if (!versions.includes(entry)) versions.push(entry)
      entry.error = redact(error?.message ?? String(error))
      console.error(`[${spec}] ${entry.error}`)
    }
  }

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    preset: options.preset,
    stepIds: options.steps,
    versions,
  }
  await writeFile(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(path.join(runDir, 'report.md'), markdownReport(report))
  const latest = path.join(options.out, 'latest')
  await rm(latest, { force: true })
  await import('node:fs/promises').then((fs) => fs.symlink(runDir, latest))
  console.log(`\n${markdownReport(report)}\nreport: ${runDir}`)
  process.exit(versions.every((entry) => !entry.error && verdict(entry.steps)) ? 0 : 1)
}

await main()
