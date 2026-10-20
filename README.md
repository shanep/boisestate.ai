<p align="center"><img src="docs/assets/logo.svg" width="96" alt=""></p>

# boisestate.ai

A Claude Code plugin that runs Claude Code on [boisestate.ai](https://boisestate.ai)
instead of your Anthropic account. The `boisestate` command starts a small
bridge on 127.0.0.1 that turns Claude Code's requests into boisestate.ai's
api-converse calls, then starts `claude` pointed at it. The bridge stops when
`claude` exits.

Works on macOS and Linux with Node 22.3 or newer.

- [Quickstart](docs/index.html): setup for students, step by step
- [How it works](docs/how-it-works.html): the bridge, one turn in detail, and
  where your quota goes, with diagrams and charts

## Install

You do not need an Anthropic account, so don't run `claude` and sign in first.
Add the plugin:

```sh
claude plugin marketplace add shanep/boisestate.ai
claude plugin install boisestate@boisestate-ai
```

Then install the `boisestate` command. It goes in `~/.local/bin` and finds the
installed plugin each time it runs, so it keeps working after a plugin update.

```sh
node ~/.claude/plugins/cache/boisestate-ai/boisestate/*/dist/boisestate.cjs install
```

Last, save your API key in your own terminal:

```sh
boisestate login
```

The key goes in the macOS keychain, or `secret-tool` on Linux (a file only
you can read when `secret-tool` is missing). You can also pipe it in:
`pbpaste | boisestate login`.

The first time you run `boisestate` in a folder, Claude Code asks if you trust
it. The answer defaults to "No, exit", so make sure and pick "Yes, I trust this
folder".

## Running

`boisestate` takes the same args as `claude`:

```sh
boisestate
boisestate -c
boisestate -p "explain this stack trace"
```

Sessions run on Opus 5.5 with no MCP servers, and auto mode is switched to
default mode. The bridge sends every tool definition as text in each request,
and auto mode's approval checks used up a month's quota in under an hour.

## Usage and quota

```sh
boisestate usage
```

Every call is logged to `~/.local/state/boisestate-ai/usage.jsonl` with
boisestate.ai's own token counts and priced at its rates. This is an estimate,
the real numbers are on boisestate.ai's usage page. When this month's spend
crosses 80% and then 100% of the quota, the plugin shows a warning at the end
of the turn. `/boisestate:usage` shows the same report inside a session.

## Other commands

- `boisestate status` - Where the key is saved and whether the command is installed
- `boisestate logout` - Remove the saved key
- `boisestate bridge` - Run the bridge alone, for other clients. It speaks the
  Anthropic Messages API and the OpenAI chat completions API. Set
  `BRIDGE_PORT` and `BRIDGE_TOKEN` to pick the port and require a token.

Settings come from the environment: `BOISESTATE_API_KEY` overrides the saved
key, and `BOISESTATE_ENDPOINT`, `BOISESTATE_TIMEOUT_MS` and
`BOISESTATE_USAGE_LOG` change the endpoint, the request timeout and the log
file.

## Building

The plugin runs the committed bundle in `dist/`, since a plugin installs
straight from git with no `npm install`. The pre-commit hook typechecks,
tests, rebuilds and fails if `dist/` is out of date.

```sh
npm install
npm run build
npm test
claude --plugin-dir .
```
