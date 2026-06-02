## Agent skills

### Issue tracker

When running inside a repository, first check for repo-local Pi instructions at:

- `.pi/agent/AGENTS.md`
- `.pi/agent/docs/agents/issue-tracker.md`

If `.pi/agent/AGENTS.md` exists, it overrides this global file and any shared project docs under `docs/agents/`.

Only use `docs/agents/issue-tracker.md` when there is no repo-local `.pi/agent/docs/agents/issue-tracker.md`.

If no repo-local Pi issue-tracker instructions exist, issues and PRDs are tracked with Beads via the `bd` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-role triage vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context by default; also read any `CONTEXT.md` / ADRs in the repo where the Pi session is started. See `docs/agents/domain.md`.
