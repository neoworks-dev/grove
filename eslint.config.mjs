import neoworks from '@neoworks/lint-config/eslint'

/**
 * ESLint is scoped to `.svelte` templates only; oxlint owns TypeScript and JavaScript.
 * The shared setup lives in `@neoworks/lint-config`.
 */
export default [
  ...neoworks,
  {
    ignores: ['**/node_modules', '**/dist', '**/out', '**/resources', 'sdk/**', 'src/main/agents/tools/hashline/**']
  },
  {
    files: ['**/*.svelte'],
    rules: {
      'svelte/no-unused-svelte-ignore': 'off'
    }
  }
]
