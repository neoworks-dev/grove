// Where each part of a doc sits. A node's path is its place in the tree (`/children.2/tabs.0/children.1`),
// which names what has no `key` of its own: a tab strip, an accordion item, a carousel.

/** The path of a prop of the node at `path`, or of one entry of a list prop. */
export function childPath(path: string, prop: string, index?: number): string {
  return index === undefined ? `${path}/${prop}` : `${path}/${prop}.${index}`;
}
