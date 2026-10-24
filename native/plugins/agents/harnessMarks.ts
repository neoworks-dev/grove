// The mark of each harness, in front of its name in the composer and in its dropdown.

import pi from "@phosphor-icons/core/regular/pi.svg";
import robot from "@phosphor-icons/core/regular/robot.svg";
import claude from "../../assets/harness/claude.svg";
import codex from "../../assets/harness/codex.svg";

export interface HarnessMark {
  svg: string;
  /** The harness's own colour; the text colour where it has none. */
  color?: string;
}

/** Each harness's mark: Claude's in its orange, Codex's, pi's. */
const MARKS: Record<string, HarnessMark> = {
  claude: { svg: claude, color: "#d97757" },
  codex: { svg: codex },
  pi: { svg: pi },
};

/** The mark of a harness, a robot for one without its own. */
export function harnessMark(harness: string): HarnessMark {
  const mark = MARKS[harness];
  if (mark === undefined) {
    return { svg: robot };
  }
  return mark;
}
