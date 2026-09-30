// First-run setup of the editor's nvim profile. The bundled config installs its
// plugins, completion binary, mason tools and treesitter parsers on first use;
// done inside an editor, every progress message became a hit-enter prompt and
// every pane installed at once. So grove runs the config once, headless, before
// the first editor starts (see "First-run setup" in init.lua), and every spawn
// waits for that one run. A stamp keyed on the config's contents skips it on
// later launches and brings it back when the config changes.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { bundledNvimConfigDir, nvimBinary, nvimConfigArgs, nvimEnvOverlay } from './nvimPaths'

const STEP_PREFIX = 'grove-setup: '
const FIRST_STEP = 'Installing plugins'
const SETUP_TIMEOUT_MS = 15 * 60 * 1000

/** Called with the step being worked on, and with null once setup is over. */
export type SetupStepListener = (step: string | null) => void

let running: Promise<void> | null = null
let currentStep: string | null = null

/** The step first-run setup is on, or null when none is running. */
export function nvimSetupStep(): string | null {
  return currentStep
}

/**
 * Resolves once the nvim profile is set up, running setup first if this config
 * has not been set up yet. Never rejects: an editor still starts after a failed
 * setup, and the next launch tries again.
 */
export function ensureNvimSetup(onStep: SetupStepListener): Promise<void> {
  if (running === null) {
    running = setUpNvimProfile(onStep)
  }
  return running
}

/** Runs setup unless the stamp says this config already had it. */
export async function setUpNvimProfile(onStep: SetupStepListener): Promise<void> {
  const overlay = nvimEnvOverlay()
  const dataHome = overlay.XDG_DATA_HOME
  const env = { ...process.env, ...overlay }
  const stampPath = join(dataHome, 'grove-setup')
  const configHash = await hashConfig()
  const stamp = await readFile(stampPath, 'utf8').catch(() => null)
  if (stamp === configHash) return

  const reportStep = (step: string | null): void => {
    currentStep = step
    onStep(step)
  }
  reportStep(FIRST_STEP)
  try {
    await mkdir(dataHome, { recursive: true })
    const succeeded = await runHeadlessSetup(env, dataHome, reportStep)
    if (succeeded) {
      await writeFile(stampPath, configHash)
    } else {
      console.warn('[nvim] first-run setup did not finish; it runs again next launch')
    }
  } finally {
    reportStep(null)
  }
}

/** A hash of the bundled config, so a changed config is set up again. */
async function hashConfig(): Promise<string> {
  const config = await readFile(join(bundledNvimConfigDir(), 'init.lua'), 'utf8')
  return createHash('sha256').update(config).digest('hex')
}

/** Runs the config headless in setup mode. Resolves with whether it all landed. */
function runHeadlessSetup(
  env: NodeJS.ProcessEnv,
  cwd: string,
  reportStep: (step: string) => void
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(nvimBinary(), ['--headless', ...nvimConfigArgs()], {
      cwd,
      env: { ...env, GROVE_PROVISION: '1' },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    const timeout = setTimeout(() => child.kill('SIGKILL'), SETUP_TIMEOUT_MS)
    let partialLine = ''
    // Everything else setup printed, kept to explain a failure.
    const output: string[] = []
    child.stderr.on('data', (chunk: Buffer) => {
      const lines = (partialLine + chunk.toString()).split('\n')
      partialLine = lines.pop() ?? ''
      for (const line of lines) {
        const step = stepFromLine(line)
        if (step !== null) {
          reportStep(step)
        } else if (line.trim() !== '') {
          output.push(line)
        }
      }
    })
    child.on('error', (error) => {
      console.warn('[nvim] first-run setup could not start:', error)
      clearTimeout(timeout)
      resolve(false)
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        console.warn(`[nvim] first-run setup exited ${code}:\n${output.slice(-20).join('\n')}`)
      }
      resolve(code === 0)
    })
  })
}

/** The step a line of setup's stderr announces, or null for any other output. */
export function stepFromLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith(STEP_PREFIX)) return null
  const step = trimmed.slice(STEP_PREFIX.length).trim()
  if (step === '') return null
  return step
}
