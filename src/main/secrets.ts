// Provider credentials, encrypted at rest.
//
// A model route that is not Anthropic's own needs that provider's key, and a key
// is the one thing in grove that must not sit in `settings.json`: those files are
// human-editable, one of them lives inside the repository, and both are read by
// anything that can read the disk. These live in their own file, encrypted with
// the OS keychain through Electron's `safeStorage`.
//
// Where no keychain is available — a Linux box with no keyring running —
// encryption is refused rather than downgraded: grove stores nothing and says
// to use the environment variable instead. Silently writing a plaintext key
// under a name that promises encryption is worse than not storing it.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'

const SECRETS_FILE = 'credentials.enc'

/** What the renderer may know about a credential: that there is one. */
export interface SecretStatus {
  /** Names grove holds a value for, whether from its store or the environment. */
  present: string[]
  /** False when the platform has no keychain, so nothing new can be stored. */
  storable: boolean
}

export class SecretsService {
  /** Decrypted values, held only for this process's lifetime. */
  private values = new Map<string, string>()
  private loaded = false

  /** Read and decrypt the store. Safe to call more than once. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const stored = await this.read()
    for (const [name, encrypted] of Object.entries(stored)) {
      const value = this.decrypt(encrypted)
      if (value !== null) this.values.set(name, value)
    }
  }

  /**
   * The value for an environment variable name, the environment first.
   *
   * An exported key is what the CLIs themselves read, so grove agreeing with it
   * means one place to change a credential rather than two.
   */
  get(name: string): string | null {
    const fromEnvironment = process.env[name]
    if (fromEnvironment) return fromEnvironment
    return this.values.get(name) ?? null
  }

  /** The first of these names with a value, for a route that accepts several. */
  lookup(names: string[]): string | null {
    for (const name of names) {
      const value = this.get(name)
      if (value) return value
    }
    return null
  }

  has(name: string): boolean {
    return this.get(name) !== null
  }

  storable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  status(names: string[]): SecretStatus {
    return { present: names.filter((name) => this.has(name)), storable: this.storable() }
  }

  /** Store a credential, or refuse when the platform cannot encrypt it. */
  async set(name: string, value: string): Promise<void> {
    if (!this.storable()) {
      throw new Error(
        `no OS keychain is available to encrypt ${name} — export it in grove's environment instead`
      )
    }
    this.values.set(name, value)
    await this.write()
  }

  async clear(name: string): Promise<void> {
    this.values.delete(name)
    await this.write()
  }

  private decrypt(encrypted: string): string | null {
    if (!this.storable()) return null
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      // A store written under a different keychain entry is unreadable, not fatal.
      return null
    }
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(secretsPath(), 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return {}
      return parsed as Record<string, string>
    } catch {
      return {}
    }
  }

  private async write(): Promise<void> {
    const encrypted: Record<string, string> = {}
    for (const [name, value] of this.values) {
      encrypted[name] = safeStorage.encryptString(value).toString('base64')
    }
    const path = secretsPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(encrypted), { encoding: 'utf8', mode: 0o600 })
  }
}

function secretsPath(): string {
  return join(app.getPath('userData'), SECRETS_FILE)
}
