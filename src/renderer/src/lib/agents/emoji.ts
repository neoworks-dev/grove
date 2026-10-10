// A small built-in set of common emoji shortcodes for the composer's `:name` completion.

export interface EmojiEntry {
  name: string
  emoji: string
}

const EMOJI_BY_NAME: Record<string, string> = {
  smile: '😄', smiley: '😃', grin: '😁', laughing: '😆', joy: '😂', rofl: '🤣',
  slightly_smiling_face: '🙂', wink: '😉', blush: '😊', innocent: '😇', heart_eyes: '😍',
  star_struck: '🤩', kissing_heart: '😘', yum: '😋', stuck_out_tongue: '😛', thinking: '🤔',
  neutral_face: '😐', expressionless: '😑', unamused: '😒', roll_eyes: '🙄', grimacing: '😬',
  relieved: '😌', pensive: '😔', sleepy: '😪', sleeping: '😴', sunglasses: '😎', nerd_face: '🤓',
  confused: '😕', worried: '😟', cry: '😢', sob: '😭', scream: '😱', angry: '😠', rage: '😡',
  sweat_smile: '😅', sweat: '😓', tired_face: '😫', exploding_head: '🤯', partying_face: '🥳',
  pleading_face: '🥺', hugs: '🤗', shushing_face: '🤫', zany_face: '🤪', skull: '💀',
  ghost: '👻', alien: '👽', robot: '🤖', poop: '💩', see_no_evil: '🙈', hear_no_evil: '🙉',
  speak_no_evil: '🙊', clown_face: '🤡', facepalm: '🤦', shrug: '🤷', pray: '🙏',
  thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎', clap: '👏', wave: '👋', ok_hand: '👌',
  raised_hands: '🙌', muscle: '💪', point_up: '☝️', point_down: '👇', point_left: '👈',
  point_right: '👉', v: '✌️', crossed_fingers: '🤞', handshake: '🤝', fist: '✊', eyes: '👀',
  brain: '🧠', heart: '❤️', orange_heart: '🧡', yellow_heart: '💛', green_heart: '💚',
  blue_heart: '💙', purple_heart: '💜', black_heart: '🖤', broken_heart: '💔', sparkling_heart: '💖',
  fire: '🔥', sparkles: '✨', star: '⭐', boom: '💥', zap: '⚡', rocket: '🚀', tada: '🎉',
  confetti_ball: '🎊', balloon: '🎈', gift: '🎁', trophy: '🏆', medal: '🏅', crown: '👑',
  gem: '💎', bulb: '💡', bell: '🔔', mega: '📣', pushpin: '📌', paperclip: '📎', memo: '📝',
  book: '📖', books: '📚', bookmark: '🔖', link: '🔗', lock: '🔒', unlock: '🔓', key: '🔑',
  mag: '🔍', hammer: '🔨', wrench: '🔧', gear: '⚙️', nut_and_bolt: '🔩', package: '📦',
  computer: '💻', keyboard: '⌨️', iphone: '📱', email: '📧', inbox_tray: '📥', outbox_tray: '📤',
  calendar: '📅', chart_with_upwards_trend: '📈', chart_with_downwards_trend: '📉',
  hourglass: '⌛', alarm_clock: '⏰', stopwatch: '⏱️', coffee: '☕', tea: '🍵', beer: '🍺',
  pizza: '🍕', hamburger: '🍔', cake: '🍰', cookie: '🍪', apple: '🍎', banana: '🍌',
  avocado: '🥑', dog: '🐶', cat: '🐱', mouse: '🐭', rabbit: '🐰', fox_face: '🦊', bear: '🐻',
  panda_face: '🐼', unicorn: '🦄', bug: '🐛', bee: '🐝', butterfly: '🦋', snake: '🐍',
  turtle: '🐢', crab: '🦀', octopus: '🐙', whale: '🐳', penguin: '🐧', chicken: '🐔',
  seedling: '🌱', evergreen_tree: '🌲', herb: '🌿', four_leaf_clover: '🍀', sunflower: '🌻',
  rose: '🌹', sunny: '☀️', cloud: '☁️', umbrella: '☔', snowflake: '❄️', rainbow: '🌈',
  ocean: '🌊', earth_africa: '🌍', moon: '🌙', full_moon: '🌕', white_check_mark: '✅',
  heavy_check_mark: '✔️', x: '❌', negative_squared_cross_mark: '❎', warning: '⚠️',
  no_entry: '⛔', stop_sign: '🛑', question: '❓', exclamation: '❗', bangbang: '‼️',
  interrobang: '⁉️', heavy_plus_sign: '➕', heavy_minus_sign: '➖', recycle: '♻️',
  arrow_right: '➡️', arrow_left: '⬅️', arrow_up: '⬆️', arrow_down: '⬇️', repeat: '🔁',
  construction: '🚧', rotating_light: '🚨', checkered_flag: '🏁', 100: '💯', hash: '#️⃣',
  red_circle: '🔴', large_blue_circle: '🔵', green_circle: '🟢', yellow_circle: '🟡'
}

// Aliases such as `+1` and `thumbsup` share a glyph; the first name listed is the one shown.
const ENTRIES: EmojiEntry[] = []
for (const [name, emoji] of Object.entries(EMOJI_BY_NAME)) {
  if (!ENTRIES.some((entry) => entry.emoji === emoji)) {
    ENTRIES.push({ name, emoji })
  }
}

/**
 * Emoji whose shortcode matches what was typed after the colon, names that start with it ahead of
 * names that merely contain it.
 */
export function searchEmoji(query: string, limit = 20): EmojiEntry[] {
  const needle = query.toLowerCase()
  if (needle.length === 0) {
    return []
  }
  const prefixMatches = ENTRIES.filter((entry) => entry.name.startsWith(needle))
  const containedMatches = ENTRIES.filter(
    (entry) => !entry.name.startsWith(needle) && entry.name.includes(needle)
  )
  return [...prefixMatches, ...containedMatches].slice(0, limit)
}
