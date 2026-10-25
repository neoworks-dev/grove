#!/usr/bin/env bun
// A stand-in for the GitHub CLI, so the GitHub pane can be driven in the QA harness without
// reading or writing a real repository. It answers the `gh` calls the pane makes with what `--jq`
// would have printed, from a small repository kept in a JSON file, and appends every call that
// changes something (a POST, PATCH or PUT) to a log, so a run can show what the pane sent.
//
//   mkdir -p /tmp/mock-gh && ln -sf "$PWD/scripts/mockGh.mjs" /tmp/mock-gh/gh
//   MOCK_GH_STATE=/tmp/mock-gh/state.json MOCK_GH_LOG=/tmp/mock-gh/writes.log PATH=/tmp/mock-gh:$PATH bun run qa start
//
// Deleting the state file resets the repository.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const REPO = "neoworks-dev/grove-qa-sandbox";
const STATE_FILE = process.env.MOCK_GH_STATE || "/tmp/mock-gh/state.json";
const LOG_FILE = process.env.MOCK_GH_LOG || "/tmp/mock-gh/writes.log";

/** The repository a fresh state starts with. */
function seed() {
  return {
    nextId: 100,
    items: [
      {
        number: 1,
        title: "Tab strip overflows when a pane is split",
        state: "open",
        pull: false,
        body: "The tab strip runs under the window buttons once a pane is split.",
        user: "ada",
        labels: [{ name: "bug", color: "d73a4a" }],
        comments: [{ id: 11, body: "Reproduced on Linux.", created_at: "2026-10-20T09:00:00Z", user: "grace" }],
      },
      {
        number: 2,
        title: "Explorer forgets its scroll position",
        state: "closed",
        pull: false,
        body: "Fixed in the last release.",
        user: "grace",
        labels: [],
        comments: [],
      },
      {
        number: 3,
        title: "Draw the minimap in its own window",
        state: "open",
        pull: true,
        merged: false,
        draft: false,
        body: "Moves the minimap out of the editor surface.",
        user: "ada",
        labels: [{ name: "enhancement", color: "a2eeef" }],
        head: { ref: "minimap", sha: "aaaa111" },
        base: { ref: "main", sha: "bbbb222" },
        files: [{ filename: "src/minimap.rs", status: "modified", additions: 12, deletions: 3 }],
        reviews: [],
        comments: [],
      },
    ],
  };
}

/** The saved repository, made from the seed on first use. */
function load() {
  if (!existsSync(STATE_FILE)) {
    save(seed());
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

/** Writes the repository back. */
function save(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Notes a call that changed something. */
function record(method, path, fields) {
  appendFileSync(LOG_FILE, `${new Date().toISOString()} ${method} ${path} ${JSON.stringify(fields)}\n`);
}

/** The item an issue number names. */
function find(state, number) {
  return state.items.find((item) => item.number === Number(number));
}

/** The `-f key=value` pairs of the arguments. */
function fieldsOf(args) {
  const fields = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-f" || args[index] === "-F") {
      const text = args[index + 1];
      const split = text.indexOf("=");
      fields[text.slice(0, split)] = text.slice(split + 1);
    }
  }
  return fields;
}

/** The value after a flag, or null. */
function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) {
    return null;
  }
  return args[index + 1];
}

/** What the search printed for an item. */
function summaryOf(item) {
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    draft: item.draft === true,
    comments: item.comments.length,
    updated_at: "2026-10-24T10:00:00Z",
    user: item.user,
    labels: item.labels,
    pull: item.pull,
    merged: item.merged === true,
  };
}

/** What the item's page printed for it. */
function pageOf(item) {
  const page = {
    number: item.number,
    title: item.title,
    state: item.state,
    draft: item.draft === true,
    body: item.body,
    comments: item.comments.length,
    created_at: "2026-10-19T08:00:00Z",
    updated_at: "2026-10-24T10:00:00Z",
    html_url: `https://github.com/${REPO}/${item.pull ? "pull" : "issues"}/${item.number}`,
    merged: item.merged === true,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    user: item.user,
    assignees: [],
    labels: item.labels,
    pull: item.pull,
    head: { ref: null, sha: null },
    base: { ref: null, sha: null },
  };
  if (item.pull) {
    page.head = item.head;
    page.base = item.base;
    page.additions = 12;
    page.deletions = 3;
    page.changed_files = item.files.length;
  }
  return page;
}

/** Prints objects one per line, as `--paginate --jq '.[] | {...}'` does. */
function lines(objects) {
  return objects.map((entry) => JSON.stringify(entry)).join("\n") + (objects.length > 0 ? "\n" : "");
}

/** Fails as `gh` does. */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Answers `gh api <path>`. */
function api(args) {
  const path = args[0].split("?")[0];
  const method = flagValue(args, "-X") || (Object.keys(fieldsOf(args)).length > 0 ? "POST" : "GET");
  const fields = fieldsOf(args);
  const state = load();
  let match;

  if (path === "search/issues") {
    const query = fields.q || "";
    let items = state.items.filter((item) => item.pull === query.includes("is:pr"));
    if (query.includes("is:closed")) {
      items = items.filter((item) => item.state === "closed");
    } else {
      items = items.filter((item) => item.state === "open");
    }
    return JSON.stringify({ total: items.length, items: items.map(summaryOf) });
  }

  if ((match = path.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/))) {
    const item = find(state, match[1]);
    if (method === "POST") {
      state.nextId += 1;
      const comment = { id: state.nextId, body: fields.body, created_at: new Date().toISOString(), user: "moritz" };
      item.comments.push(comment);
      save(state);
      record(method, path, fields);
      return JSON.stringify(comment);
    }
    return lines(item.comments);
  }

  if ((match = path.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/))) {
    const item = find(state, match[1]);
    if (!item) {
      fail("gh: Not Found (HTTP 404)");
    }
    if (method === "PATCH") {
      item.state = fields.state;
      save(state);
      record(method, path, fields);
    }
    return JSON.stringify(pageOf(item));
  }

  if ((match = path.match(/^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/))) {
    const item = find(state, match[1]);
    if (!item || !item.pull) {
      fail("gh: Not Found (HTTP 404)");
    }
    return JSON.stringify(pageOf(item));
  }

  if ((match = path.match(/^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/files$/))) {
    return lines(find(state, match[1]).files);
  }
  if ((match = path.match(/^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/))) {
    return lines(find(state, match[1]).reviews);
  }
  if (/\/commits\/[^/]+\/(check-runs|status)$/.test(path)) {
    return "";
  }
  fail(`mock gh: nothing answers ${method} ${path}`);
}

const args = process.argv.slice(2);
if (args[0] === "auth") {
  process.exit(0);
}
if (args[0] === "repo") {
  process.stdout.write(`${REPO}\n`);
  process.exit(0);
}
if (args[0] === "api") {
  process.stdout.write(api(args.slice(1)));
  process.exit(0);
}
fail(`mock gh: unknown command ${args.join(" ")}`);
