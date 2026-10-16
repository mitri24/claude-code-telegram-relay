# claude-code-telegram-relay

Talk to several Claude Code sessions from your phone through **one Telegram bot**, one conversation at a time.

You run one Claude Code session per ticket (for example one git worktree per ticket). When a session finishes a step or needs a decision, it reports to the relay. The relay pings you on Telegram. Each ticket gets **its own chat thread**. You answer by **voice message or text**, and the answer goes back into exactly that session.

The agents' instructions and the Telegram texts are in German. The setup is described here in English.

## What it does

- **One at a time.** Only the session whose turn it is pings you. The others wait in a queue. Their pending question shows up silently in their own thread, so you can answer early if you want.
- **A thread per ticket.** The relay creates a Telegram topic for each ticket (`DEV-123 · Title`). Writing in a thread talks to that session directly.
- **Voice in, text out.** Voice messages are transcribed **locally** with whisper.cpp. Nothing leaves your machine except the Telegram messages themselves. The agent cleans up the transcript and confirms it ("Verstanden: …").
- **Always an answer.**
  - "Wartet jemand?" / "status" is answered by the relay itself.
  - If an agent is busy, the relay replies after 15 s with what it is doing, read from its tmux pane.
  - A silent conversation no longer blocks the queue.
- **Next ticket.** Each agent message has a "➡️ Nächstes Ticket" button. Saying "nächstes Ticket", "weiter" or "fertig" works too.
- **Permission prompts.** Claude Code tool approvals are relayed with Allow/Deny buttons.
- **Spec PDFs.** If the session keeps a spec at `docs/specs/*dev-123*design-doc.md`, the relay renders it to a PDF (Mermaid diagrams included) whenever its status changes (GEPLANT → UMGESETZT → VERIFIZIERT) and sends it to the ticket thread. Rendering happens locally in headless Chrome and costs no model tokens.
- **Survives restarts.** The queue and undelivered messages are saved when the relay stops.

## How it works

```
Claude Code session (claude-ticket) ─┐  MCP channel "vermittlung" (kanal.mjs)
Claude Code session (claude-ticket) ─┼──────────────► relay daemon (daemon.mjs, 127.0.0.1:47823)
Claude Code session (claude-ticket) ─┘                 • queue, one active conversation
        Stop hook (stopp.mjs) ────────────────────────► • Telegram bot (long polling)
                                                       • whisper.cpp transcription, spec PDFs
```

- **`kanal.mjs`** is a Claude Code **channel** (MCP server). It gives the session the tools `melden` (send a message to you) and `beenden` (end the conversation). It also pushes your replies into the session.
- **`daemon.mjs`** is the single process that owns the bot and the queue. The first session starts it automatically.
- **`stopp.mjs`** is a Stop hook. When a session finishes a turn that you started from Telegram, or one that ran longer than 2 minutes, it gets queued to report back.
- **`claude-ticket`** starts Claude Code with the channel enabled.

## Requirements

- macOS with Homebrew. `say` is used for the optional read-aloud feature.
- Node.js 20+
- Claude Code with a claude.ai login. Channels are a research preview. On Team/Enterprise plans an admin must enable them.
- A Telegram account
- `brew install ffmpeg whisper-cpp`, optionally `tmux`
- Google Chrome, for spec PDFs

## Setup

1. **Clone and install**
   ```sh
   git clone <this repo> && cd claude-code-telegram-relay
   ./install.sh
   ```
   The installer does the following:
   - runs `npm install`
   - downloads the Whisper model (~570 MB)
   - writes `~/.claude/vermittlung/settings.json` (Stop hook and tool permissions)
   - registers the MCP server `vermittlung` in your user config
   - links `claude-ticket` into `~/.local/bin`

   The MCP server stays silent in normal sessions. It only becomes active in sessions started with `claude-ticket`.

2. **Create the bot.** In Telegram, open **@BotFather** and send `/newbot`. Then go to **Bot Settings → Threaded Mode** and turn it on. This is what gives you one thread per ticket.

3. **Connect the bot**
   ```sh
   node vermittlung.mjs einrichten
   ```
   Paste the token. It is stored in `~/.claude/vermittlung/.env` with mode 600. Then send the printed 6-digit code to your bot. From then on the bot only accepts your Telegram account.

## Usage

In each ticket's worktree, start Claude Code with:

```sh
claude-ticket "/develop"      # any normal claude arguments work
```

Confirm the one-time "development channels" warning. The session then talks to you on Telegram.

| In Telegram | Effect |
|---|---|
| Voice message or text in a ticket thread | Goes to that session. That session becomes the active conversation. |
| `weiter` / `nächstes Ticket` / `fertig` / button "➡️ Nächstes Ticket" | Ends the current conversation; the next waiting session comes up. |
| `später` | Put the current session back at the end of the queue. |
| `an DEV-123` | Switch to that session. |
| `liste` / `status` / `wartet jemand?` | Who is active, who is waiting. |
| `pause` / `los` | Hold all sessions back / resume. |
| `ja <code>` / `nein <code>`, or the buttons | Answer a permission prompt. A plain "ja" works if only one is open. |

Manage the relay:

```sh
node vermittlung.mjs status     # active conversation, queue, sessions
node vermittlung.mjs neustart   # restart (queue is preserved)
node vermittlung.mjs stopp
```

To watch a session while it runs, start it inside tmux (for example `tmux new -s dev123 claude-ticket "/develop"`). Attach from any terminal, including VS Code's, with `tmux attach -t dev123`.

## Configuration

Set these environment variables in the shell that runs `claude-ticket` or the relay:

| Variable | Default | Purpose |
|---|---|---|
| `VERMITTLUNG_DIR` | `~/.claude/vermittlung` | Runtime data: token, pairing, queue state, chat log, model |
| `VERMITTLUNG_PORT` | `47823` | Local port of the relay (127.0.0.1 only) |
| `VERMITTLUNG_NAME` | `die Nutzerin` | How the agents refer to you |
| `VERMITTLUNG_FACHBEGRIFFE` | generic | Domain terms the agents should expect when cleaning up transcripts |
| `VERMITTLUNG_WHISPER_PROMPT` | generic | Vocabulary hint for whisper.cpp |
| `VERMITTLUNG_VORLESEN` | off | `1` = also send the agent's first message of a conversation as a voice note (macOS `say`) |
| `VERMITTLUNG_STIMME` | `Anna` | macOS voice for read-aloud |
| `VERMITTLUNG_MODELL` | `$VERMITTLUNG_DIR/modelle/ggml-large-v3-turbo-q5_0.bin` | Whisper model |
| `VERMITTLUNG_CHROME` | Google Chrome app path | Browser used to render spec PDFs |

The ticket ID comes from the worktree folder (`projekt-dev123-…`) or else from the branch name (`…dev-123…`).

## Data and privacy

- **What lives where:** Tokens, the pairing, the queue state and a raw chat log (`verlauf/`) live only in `VERMITTLUNG_DIR` and are never part of this repo (see `.gitignore`).
- **Who can talk to the agents:** The relay accepts messages from the paired Telegram account only. The local HTTP API requires a random secret (`geheim`).
- **Telegram is not end-to-end encrypted:** Bot chats are not end-to-end encrypted, so don't send customer, patient or personal data through it. The agent instructions say the same.
- **Audio stays local:** Voice messages are downloaded, transcribed locally and deleted.

## Limitations

- Custom channels need `--dangerously-load-development-channels` during the Claude Code research preview. They only work in sessions started from a terminal, not in the IDE side panel.
- One bot per machine: only one relay can poll a bot token.
- The agent prompts and messages are German.
- macOS-centric (`say`, Homebrew paths).

## Files

| File | Role |
|---|---|
| `daemon.mjs` | Relay: Telegram bot, queue, threads, transcription, spec PDFs, local API |
| `kanal.mjs` | Claude Code channel (MCP) per session |
| `stopp.mjs` | Stop hook: reports finished turns to the relay |
| `vermittlung.mjs` | `einrichten` (token + pairing), `status`, `neustart`, `stopp` |
| `spec-pdf.mjs` | Renders a Markdown spec (Mermaid, no embedded images) to PDF |
| `claude-ticket` | Starts Claude Code with the channel |
| `install.sh`, `settings.example.json` | One-time setup |
