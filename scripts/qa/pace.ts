// How often a run is allowed to photograph the app.
//
// Screenshotting after every action is the habit the tree in `probe` exists to
// break: a picture costs a thousand times what reading the tree does, and two
// pictures of a screen nothing has happened to cannot differ. So the harness
// says no mechanically rather than asking whoever is driving it to be
// disciplined — with one exception, the closer look a full shot raises.

/** What a run has done since its last screenshot. */
export interface Pace {
  lastShot: string | null
  lastFraming: string | null
  // Pictures taken since the app was last acted on. Every click, drag or
  // keypress resets it, because those are what make a new one worth taking.
  sinceAction: number
  taken: number
}

/** Pictures of one unchanged screen: the frame, and one closer look at it. */
export const PICTURES_PER_SCREEN = 2

export function emptyPace(): Pace {
  return { lastShot: null, lastFraming: null, sinceAction: 0, taken: 0 }
}

/** Why a picture was refused, or null when it may be taken. */
export function refusePicture(pace: Pace, framing: string): string | null {
  if (pace.lastShot === null) return null
  if (pace.sinceAction === 0) return null

  const reframed = pace.lastFraming !== framing
  if (reframed && pace.sinceAction < PICTURES_PER_SCREEN) return null

  let why = `nothing has happened since ${pace.lastShot} — that picture is still the screen.`
  if (reframed) {
    why = `${pace.sinceAction} pictures of this screen already, the last ${pace.lastShot}.`
  }
  return (
    `${why}\n` +
    'Read what you have, or run "qa probe" for what is on screen now. Another\n' +
    'picture needs an action first — a click, a drag, a keypress.'
  )
}

/** Record a picture, which uses up part of this screen's allowance. */
export function notePicture(pace: Pace, framing: string, shot: string | null): Pace {
  return {
    lastShot: shot,
    lastFraming: framing,
    sinceAction: pace.sinceAction + 1,
    taken: pace.taken + 1
  }
}

/** Record something that changed the app, which gives the allowance back. */
export function noteAction(pace: Pace): Pace {
  return { ...pace, sinceAction: 0 }
}
