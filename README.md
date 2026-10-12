# context-controls

A Claude Code mod that sits above the prompt:

- **Three nested rings**: context used (clay), 5-hour limit left (gold), weekly limit left (sage). Hover a ring for its percentage; the key shows reset timers. Refreshes live every 10s.
- **Compact at**: choose the token count where auto-compaction fires (100k–750k), or **Compact now**.
- **Subagents**: choose the model (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5) and effort, then **Lock** to force every subagent onto them.

Needs Claude Code 2.1.287+ (terminal or the Desktop Code tab).

## Install

```text
/plugin marketplace add DerpcatMusic/claude-context-controls
/plugin install context-controls@context-controls
```

Then `/reload-plugins`.

## Notes

- If your `settings.json` `env` sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or `CLAUDE_CODE_SUBAGENT_MODEL`, those win over the panel. Remove them so the panel controls them.
- `/control-panel percent 30 | compact now | model <id> | effort medium | lock on|off` does the same from the prompt.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

MIT licensed.
