---
description: Put the boisestate command on your PATH and check the API key
---

Set up the `boisestate` command for the user:

1. Run `boisestate install` to write the command to `~/.local/bin/boisestate`.
   The plugin puts `boisestate` on the Bash tool's PATH, but not the user's.
   If it says the folder is not on the PATH, tell the user which line to add
   to their shell profile.
2. Run `boisestate status` to see whether a key is saved. It never prints the
   key.
3. If no key is saved, tell the user to run `boisestate login` in their own
   terminal and paste the key from https://boisestate.ai. Do not ask for the key
   in chat. It would end up in the transcript.
4. Tell the user to start a session with `boisestate` (it takes the same args
   as `claude`) and to check their spend with `boisestate usage` or
   `/boisestate:usage`.
