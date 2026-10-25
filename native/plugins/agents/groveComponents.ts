// The neoui components Grove offers the agent, as data: a description for the agent, typed
// params, and a body over the `suite@1` library. The daemon expands a use such as
// `<grove.IssueCard …/>` into the library components the body draws, so the chat needs no
// drawing code of its own. A plugin adds components the same way, through
// `AgentsService.registerComponents`.

import type { AppComponent } from "./contributions";

/** Which tool a card's button calls to show a file in the editor; see `groveTools.ts`. */
export const OPEN_FILE_TOOL = "grove.openFile";

/** Which tool the cards' "Open in Grove" buttons call to show an issue or pull request in the GitHub pane; see `groveTools.ts`. */
export const OPEN_ISSUE_TOOL = "grove.openIssue";

/** A GitHub issue: where it is, what it says, and its state. */
const issueCard: AppComponent = {
  description:
    "A GitHub issue as a card: title, open or closed, labels, a short excerpt, a link, and a button that opens it in Grove's GitHub pane. Use it when you tell the user about an issue instead of describing it in prose. Fetch the data with `gh issue view`; state is `open` or `closed`, body is an excerpt of a few lines.",
  params: {
    repo: "string",
    number: "number",
    title: "string",
    state: "string",
    author: "string?",
    labels: "string[]?",
    body: "string?",
    comments: "number?",
    url: "string?",
  },
  neoui: `<Card>
  <Header title={title} subtitle={\`\${repo} #\${number}\`}/>
  <Stack direction="row" gap="s" align="center" wrap={true}>
    <If when={state == "closed"}><Tag label="Closed" tone="accent"/></If>
    <If when={state != "closed"}><Tag label="Open" tone="success"/></If>
    <For each={labels} as="label"><Tag label={label}/></For>
  </Stack>
  <If when={body}><Text text={body}/></If>
  <If when={author || comments != null}>
    <KeyValue>
      <If when={author}><KV key="Author" value={author}/></If>
      <If when={comments != null}><KV key="Comments" value={comments}/></If>
    </KeyValue>
  </If>
  <Buttons>
    <Button hx-post="${OPEN_ISSUE_TOOL}" hx-vals={{ repo: repo, number: number, kind: "issue" }}>Open in Grove</Button>
    <If when={url}><Button variant="secondary" href={url}>Open on GitHub</Button></If>
  </Buttons>
</Card>`,
};

/** A GitHub pull request: branches, size, checks and review next to its state. */
const prCard: AppComponent = {
  description:
    "A GitHub pull request as a card: title, open, draft, merged or closed, the branches, size, checks, review, a link, and a button that opens it in Grove's GitHub pane. Use it when you tell the user about a pull request instead of describing it in prose. Fetch the data with `gh pr view`; state is `open`, `draft`, `merged` or `closed`, checks is `passing`, `failing` or `pending`, review is `approved`, `changes requested` or `required`.",
  params: {
    repo: "string",
    number: "number",
    title: "string",
    state: "string",
    head: "string",
    base: "string",
    author: "string?",
    additions: "number?",
    deletions: "number?",
    changedFiles: "number?",
    checks: "string?",
    review: "string?",
    url: "string?",
  },
  neoui: `<Card>
  <Header title={title} subtitle={\`\${repo} #\${number}\`}/>
  <Stack direction="row" gap="s" align="center" wrap={true}>
    <If when={state == "open"}><Tag label="Open" tone="success"/></If>
    <If when={state == "draft"}><Tag label="Draft" tone="muted"/></If>
    <If when={state == "merged"}><Tag label="Merged" tone="accent"/></If>
    <If when={state == "closed"}><Tag label="Closed" tone="danger"/></If>
  </Stack>
  <Text text={\`\\\`\${head}\\\` into \\\`\${base}\\\`\`}/>
  <If when={author || additions != null || deletions != null || changedFiles != null || checks || review}>
    <KeyValue>
      <If when={author}><KV key="Author" value={author}/></If>
      <If when={additions != null}><KV key="Added" value={\`+\${additions}\`} tone="success"/></If>
      <If when={deletions != null}><KV key="Removed" value={\`-\${deletions}\`} tone="danger"/></If>
      <If when={changedFiles != null}><KV key="Files changed" value={changedFiles}/></If>
      <If when={checks == "passing"}><KV key="Checks" value="Passing" tone="success"/></If>
      <If when={checks == "failing"}><KV key="Checks" value="Failing" tone="danger"/></If>
      <If when={checks == "pending"}><KV key="Checks" value="Running" tone="muted"/></If>
      <If when={review == "approved"}><KV key="Review" value="Approved" tone="success"/></If>
      <If when={review == "changes requested"}><KV key="Review" value="Changes requested" tone="danger"/></If>
      <If when={review == "required"}><KV key="Review" value="Waiting for review" tone="muted"/></If>
    </KeyValue>
  </If>
  <Buttons>
    <Button hx-post="${OPEN_ISSUE_TOOL}" hx-vals={{ repo: repo, number: number, kind: "pull" }}>Open in Grove</Button>
    <If when={url}><Button variant="secondary" href={url}>Open on GitHub</Button></If>
  </Buttons>
</Card>`,
};

/** An explanation of code or of a concept, with a button to the code when there is some. */
const explainCard: AppComponent = {
  description:
    "An explanation as a card: a title, the explanation in markdown, optional key points, and optionally the code it is about with its path, so the user can open the file in the editor at that line. Use it to explain code (pass code, path, startLine and language) or a concept (pass just title and explanation, with key points if they help). startLine is the line of the first line of code, counted from 1; path is absolute or relative to the repository.",
  params: {
    title: "string",
    explanation: "string",
    points: "string[]?",
    code: "string?",
    path: "string?",
    startLine: "number?",
    language: "string?",
  },
  neoui: `<Card>
  <Header title={title}/>
  <Text text={explanation}/>
  <If when={len(points) > 0}><List items={points}/></If>
  <If when={code}>
    <Stack gap="s">
      <If when={path && startLine}><Text text={\`\${path}:\${startLine}\`} tone="muted" role="code"/></If>
      <If when={path && !startLine}><Text text={path} tone="muted" role="code"/></If>
      <Code code={code} language={language}/>
    </Stack>
  </If>
  <If when={path}>
    <Buttons><Button variant="secondary" hx-post="${OPEN_FILE_TOOL}" hx-vals={{ path: path, line: startLine }}>Open in editor</Button></Buttons>
  </If>
</Card>`,
};

/** The components Grove registers under its own app id: `grove.IssueCard`, `grove.PrCard` and `grove.ExplainCard`. */
export const groveComponents: Record<string, AppComponent> = {
  IssueCard: issueCard,
  PrCard: prCard,
  ExplainCard: explainCard,
};
