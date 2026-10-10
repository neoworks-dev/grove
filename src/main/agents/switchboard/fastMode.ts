// Fast mode on a switchboard session.
//
// The Claude harness offers it as a session config option called `fast`, with
// the values `on` and `off`, and only while the model in use supports it.
// switchboard keeps its config options and the call that sets one private, and
// has no typed switch for this one, so this reaches them where they are. Nothing
// else in grove should: the day switchboard grows a `setFastMode`, this file is
// what it replaces.

const FAST_MODE_OPTION = 'fast'

/** The part of a switchboard session that fast mode is set through. */
export interface ConfigurableSession {
  configOptions?: { id: string }[]
  setConfigOption?: (configId: string, value: string) => Promise<void>
}

/**
 * What a harness's list of config options says fast mode is set to, or null when
 * it says nothing: the harness can turn it off by itself, for an account that
 * cannot pay for it, and the list it sends then is the only word of it.
 */
export function reportedFastMode(
  configOptions: { id: string; currentValue?: unknown }[]
): boolean | null {
  const option = configOptions.find((candidate) => candidate.id === FAST_MODE_OPTION)
  if (option === undefined) return null
  if (option.currentValue === true || option.currentValue === 'on') return true
  if (option.currentValue === false || option.currentValue === 'off') return false
  return null
}

/** Turns fast mode on or off; rejects with a reason a person can read when the session cannot. */
export async function requestFastMode(
  session: ConfigurableSession,
  enabled: boolean
): Promise<void> {
  const offered = session.configOptions?.some((option) => option.id === FAST_MODE_OPTION)
  if (offered !== true) {
    throw new Error('this model does not offer it')
  }
  if (!session.setConfigOption) {
    throw new Error('this version of the harness cannot change it')
  }
  let value = 'off'
  if (enabled) value = 'on'
  await session.setConfigOption(FAST_MODE_OPTION, value)
}
