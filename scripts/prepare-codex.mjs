import { cp, chmod, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outputDirectory = path.join(projectRoot, '.packaging', 'codex')

const platformPackages = {
  'darwin-arm64': '@openai/codex-darwin-arm64',
  'darwin-x64': '@openai/codex-darwin-x64',
  'linux-arm64': '@openai/codex-linux-arm64',
  'linux-x64': '@openai/codex-linux-x64',
  'win32-arm64': '@openai/codex-win32-arm64',
  'win32-x64': '@openai/codex-win32-x64',
}

const platformKey = `${process.platform}-${process.arch}`
const platformPackage = platformPackages[platformKey]

if (!platformPackage) {
  throw new Error(`Codex packaging is not supported for ${platformKey}`)
}

const codexPackagePath = require.resolve('@openai/codex/package.json')
const codexPackage = JSON.parse(await readFile(codexPackagePath, 'utf8'))

if (codexPackage.version !== '0.144.5') {
  throw new Error(`Expected @openai/codex 0.144.5, found ${codexPackage.version}`)
}

let platformPackagePath
try {
  platformPackagePath = require.resolve(`${platformPackage}/package.json`, {
    paths: [path.dirname(codexPackagePath)],
  })
} catch (error) {
  throw new Error(
    `The ${platformPackage} optional dependency is missing. Install dependencies on the target architecture before packaging.`,
    { cause: error },
  )
}

const platformRoot = path.dirname(platformPackagePath)
const vendorRoot = path.join(platformRoot, 'vendor')
const vendorEntries = await readdir(vendorRoot, { withFileTypes: true })
const targetDirectories = vendorEntries.filter((entry) => entry.isDirectory())

if (targetDirectories.length !== 1) {
  throw new Error(`Expected one Codex target directory in ${vendorRoot}`)
}

const sourceDirectory = path.join(vendorRoot, targetDirectories[0].name)
const packageManifestPath = path.join(sourceDirectory, 'codex-package.json')
const packageManifest = JSON.parse(await readFile(packageManifestPath, 'utf8'))

if (packageManifest.version !== codexPackage.version) {
  throw new Error(
    `Codex native payload ${packageManifest.version} does not match package ${codexPackage.version}`,
  )
}

const entrypoint = path.join(sourceDirectory, packageManifest.entrypoint)
if (!(await stat(entrypoint)).isFile()) {
  throw new Error(`Codex entrypoint is not a file: ${entrypoint}`)
}

await rm(outputDirectory, { recursive: true, force: true })
await mkdir(path.dirname(outputDirectory), { recursive: true })
await cp(sourceDirectory, outputDirectory, { recursive: true, force: true })

if (process.platform !== 'win32') {
  const executablePaths = [
    packageManifest.entrypoint,
    'bin/codex-code-mode-host',
    `${packageManifest.pathDir}/rg`,
    `${packageManifest.resourcesDir}/zsh/bin/zsh`,
  ]

  for (const executablePath of executablePaths) {
    const absolutePath = path.join(outputDirectory, executablePath)
    try {
      await chmod(absolutePath, 0o755)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error
      }
    }
  }
}

console.log(
  `Prepared Codex ${packageManifest.version} (${packageManifest.target}) at ${outputDirectory}`,
)
