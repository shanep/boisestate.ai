<p align="center"><img src="assets/logo.svg" width="112" alt=""></p>

<h1 align="center">Claude Code on your boisestate.ai account</h1>

<p align="center">
  <b>Quickstart</b> · <a href="how-it-works.md">How it works</a> · <a href="../README.md">README</a>
</p>

Use Claude Code for your projects without an Anthropic account. Every request
goes through boisestate.ai, so it comes out of your Boise State quota. Setup
takes about 5 minutes.

## What you need

| | |
|---|---|
| **macOS or Linux** | On Windows use WSL, which is Linux. I have not tested it there yet. |
| **A boisestate.ai API key** | You can make one in your [boisestate.ai settings](https://boisestate.ai/settings). |

The setup installs everything else (Node and Claude Code) if you don't have it.

## Setup

You only do this once. Open a terminal (on Windows, the Ubuntu app from WSL)
and paste this line:

```sh
curl -fsSL https://raw.githubusercontent.com/shanep/boisestate.ai/master/install.sh | sh
```

It works through 6 steps and tells you what it is doing at each one:

1. **Checks your computer.** It installs git if you don't have it. On a Mac
   that pops up a window asking to install the Command Line Tools. Click
   Install, wait for it to finish, and run the line above again.
2. **Node.** If yours is missing or older than 22.3, it puts a new one in your
   home folder. It leaves the one you have alone.
3. **Claude Code.** It installs it if you don't have it.
4. **The plugin.** It installs the boisestate plugin, or updates it.
5. **The `boisestate` command.** It goes in `~/.local/bin`, and the script adds
   that folder to your PATH.
6. **Your API key.** It opens your boisestate.ai settings page in the browser.
   Copy your key and paste it into the terminal when it asks. Nothing shows up
   while you paste, that is on purpose.

> [!CAUTION]
> Never paste your API key into a Claude chat, a commit or a file in your repo.
> Anything you type into Claude goes to the model and into the session history,
> and anyone with your key can spend your quota.

When it is done you should see something like this:

```text
All set!
  key: saved in the macOS login keychain
  command: ~/.local/bin/boisestate
  usage log: ~/.local/state/boisestate-ai/usage.jsonl
```

If it stops with a red `x`, read the message under it, fix that, and run the
same line again. It is safe to run as many times as you want, since it skips
the steps that already worked. If it says it changed your PATH, close the
terminal and open a new one before going on.

## Start coding

Go to your project and run `boisestate` instead of `claude`.

```sh
cd ~/my-project
boisestate
```

> [!WARNING]
> The first time, Claude Code asks you to pick a color theme and then asks if
> you trust the folder. Make sure and pick **Yes, I trust this folder**. The
> default is No, which just exits.

> [!TIP]
> That's it! You are all setup. `boisestate` takes the same args as `claude`,
> so `boisestate -c` picks up your last conversation.

## Setup by hand

You only need this if the script does not work on your computer, or if you
want to see each step. You need Node 22.3 or newer for it, so check with
`node --version` first.

### Step 1 - Install Claude Code

Skip this step if you already have it. You do **not** need to sign in to
Anthropic, so don't run `claude` yet.

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

### Step 2 - Add the plugin

The first command tells Claude Code where to find the plugin, and the second
one installs it.

```sh
claude plugin marketplace add shanep/boisestate.ai
claude plugin install boisestate@boisestate-ai
```

You should see:

```text
✔ Successfully added marketplace: boisestate-ai
✔ Successfully installed plugin: boisestate@boisestate-ai (scope: user)
```

### Step 3 - Install the `boisestate` command

This puts a small `boisestate` command in `~/.local/bin`. It finds the newest
version of the plugin each time it runs, so plugin updates just work.

```sh
node ~/.claude/plugins/cache/boisestate-ai/boisestate/*/dist/boisestate.cjs install
```

If it also says `~/.local/bin is not on your PATH`, add this line to the end of
`~/.zshrc` (macOS) or `~/.bashrc` (Linux), then open a new terminal.

```sh
export PATH="$HOME/.local/bin:$PATH"
```

### Step 4 - Save your API key

Paste your key when it asks. Nothing shows up while you paste, that is on
purpose.

```console
$ boisestate login
boisestate.ai API key:
Saved the key to the macOS login keychain.
```

Then go to [Start coding](#start-coding).

## Watch your quota

Every message costs real money out of your monthly boisestate.ai quota. Each
call to the model carries Claude Code's instructions and tool list, which is
about 12,000 tokens before you type a word, so it adds up faster than you would
think.

| | |
|---|---|
| **`/clear` between tasks** | The whole conversation is sent again on every call. Start fresh when you switch to something new and each call stays small. |
| **`boisestate usage`** | Shows what you have spent this month, by model and by day. Inside a session, run `/boisestate:usage`. |
| **Warnings at 80% and 100%** | Claude Code shows a warning at the end of a turn when your spend crosses 80% and then 100% of the quota. |
| **No auto mode** | `boisestate` turns auto mode off. Its safety checks cost about 6 times more than the work itself, and they burned through a month of quota in under an hour. |

> [!NOTE]
> The plugin's numbers are an estimate from its own log. The real numbers are
> on your [boisestate.ai usage page](https://boisestate.ai/settings/usage).

## Commands

| Command | What it does |
|---|---|
| `boisestate` | Start Claude Code on boisestate.ai |
| `boisestate -c` | Continue your last conversation |
| `boisestate -p "question"` | Ask one question and print the answer |
| `boisestate usage` | Show this month's spend |
| `boisestate status` | Show where your key is saved and if the command is installed |
| `boisestate login` | Save or replace your API key |
| `boisestate logout` | Remove your saved key |
| `boisestate --help` | Show every command |

## Troubleshooting

<details>
<summary>The setup stopped with an error</summary>

Read the red `x` line and the lines under it, since they say what went wrong
and what to do. Fix that and run the setup line again. If you are stuck, send
your instructor everything the script printed.

</details>

<details>
<summary><code>boisestate: command not found</code></summary>

Open a new terminal first, since a terminal only reads your PATH when it
starts. If it still happens, `~/.local/bin` is not on your PATH. Add the
`export PATH` line from step 3 of the setup by hand to your shell profile and
open a new terminal.

</details>

<details>
<summary><code>boisestate: it needs Node 22.3 or newer</code></summary>

An older `node` comes first on your PATH. Run the setup line again, then open
a new terminal.

</details>

<details>
<summary>It says no API key is saved</summary>

Run `boisestate login` and paste your key. Then run `boisestate status` to
check where it went.

</details>

<details>
<summary>Claude Code wants me to log in</summary>

You ran `claude` instead of `boisestate`. Plain `claude` talks to Anthropic and
needs an Anthropic account. Quit and run `boisestate`.

</details>

<details>
<summary>"Your boisestate.ai quota is used up"</summary>

You have spent this month's quota, and boisestate.ai refuses every call until
it resets at the start of next month. There is nothing to fix on your end, so
plan accordingly.

</details>

<details>
<summary>"The backend did not respond within its time limit"</summary>

boisestate.ai stops any single request after about 60 seconds. This mostly
happens when you ask for a very large answer at once. Ask for smaller pieces of
work, or just try again.

</details>

<details>
<summary>Linux: where did my key go?</summary>

On Linux the key goes in your keyring through `secret-tool`. If you don't have
`secret-tool`, or it has no keyring to talk to (WSL and ssh usually don't), it
goes in `~/.config/boisestate-ai/api-key`, a file only you can read. To use the keyring on Ubuntu, install it and log in again:

```sh
sudo apt install libsecret-tools
boisestate login
```

</details>

<details>
<summary>Updating the plugin</summary>

Run the setup line again. Or, by hand:

```sh
claude plugin marketplace update boisestate-ai
claude plugin update boisestate@boisestate-ai
```

</details>

<details>
<summary>Removing everything</summary>

```sh
boisestate logout
claude plugin uninstall boisestate@boisestate-ai
claude plugin marketplace remove boisestate-ai
rm ~/.local/bin/boisestate
```

If the setup installed Node for you, remove that too:

```sh
rm -rf ~/.local/share/boisestate-ai
rm ~/.local/bin/node ~/.local/bin/npm ~/.local/bin/npx
```

Last, delete the `# Added by the boisestate.ai installer` lines from your
shell profile (`~/.zshrc` or `~/.bashrc`).

</details>

---

Want to know what is going on under the hood? [How it works](how-it-works.md)
has diagrams of every piece and charts of where your quota goes.
