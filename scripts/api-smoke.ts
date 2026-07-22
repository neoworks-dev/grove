// Smoke test for the external app API. Run with Grove open (approve the
// pairing dialog on first run):
//   bun scripts/api-smoke.ts [worktreeId]
// Reconnects silently afterwards via the token stored in
// ~/.config/grove/tokens/grove-smoke.

import { connectGrove } from '../sdk/src/client/node'

async function main(): Promise<void> {
  const grove = await connectGrove({
    appId: 'grove-smoke',
    name: 'Grove Smoke Test',
    version: '1.0.0',
    scopes: ['workspace.read', 'git.read', 'editor.read', 'services.read']
  })
  console.log('connected. apiVersion =', grove.apiVersion)
  console.log('granted scopes:', grove.grantedScopes.join(', '))

  const worktrees = await grove.git.worktrees.list()
  console.log('\nworktrees:')
  for (const worktree of worktrees) console.log(` - ${worktree.id} (${worktree.branch})`)

  const worktreeId = process.argv[2] ?? worktrees[0]?.id
  if (!worktreeId) {
    console.log('no worktree available — open a repo in Grove first')
    grove.close()
    return
  }

  const status = await grove.git.status({ worktreeId })
  console.log(`\ngit status @ v${status.version}: branch=${status.branch} dirty=${status.dirty}`)
  for (const file of status.files.slice(0, 5)) {
    console.log(` - ${file.status}${file.staged ? ' (staged)' : ''} ${file.path}`)
  }

  const files = await grove.workspace.findFiles({ worktreeId })
  console.log(`\nworkspace.findFiles: ${files.length} files`)

  console.log('\nsearchText "TODO" (first 5 matches):')
  let matches = 0
  for await (const match of grove.workspace.searchText('TODO', { worktreeId })) {
    console.log(` - ${match.file}:${match.line}`)
    matches += 1
    if (matches >= 5) break
  }

  const activeEditor = await grove.editor.getActiveEditor()
  if (activeEditor) {
    const doc = activeEditor.document
    console.log(`\nactive editor: ${doc.path} v${doc.version} (${doc.languageId})`)
  } else {
    console.log('\nno active editor')
  }

  const services = await grove.services.list({ worktreeId })
  console.log(`\nservices: ${services.map((s) => `${s.name}=${s.status}`).join(', ') || '(none)'}`)

  console.log('\nsubscribing to git./files. events for 10s — touch a file in the worktree…')
  const timeout = setTimeout(() => grove.close(), 10_000)
  try {
    for await (const event of grove.events.subscribe(['git.', 'files.didChange'])) {
      console.log(' event:', event.topic, JSON.stringify(event.payload).slice(0, 120))
    }
  } catch {
    // Connection closed by the timeout above.
  }
  clearTimeout(timeout)
  console.log('done.')
}

main().catch((error) => {
  console.error('smoke test failed:', error.message)
  process.exit(1)
})
