# @soulerou/oa-cli

Commander-based CLI that ships the `oa` binary — the entry point for [OvernightAgent](https://github.com/a20185/OvernightAgent). Every subcommand is a thin wrapper around an `@soulerou/oa-core` API.

## Install

```sh
pnpm add -g @soulerou/oa-cli
# or
npm install -g @soulerou/oa-cli
```

Verify:

```sh
oa --version
oa --help
```

## Host-agent shims

After install, drop the slash-command resource files into your coding agent:

```sh
oa shims install --host claude              # project-scope .claude/commands
oa shims install --host codex               # user-scope ~/.codex/prompts
oa shims install --host opencode            # user-scope ~/.config/opencode/commands
oa shims install --host all                 # every host with its default scope
```

See `oa shims install --help` for `--scope project|user`, `--dry-run`, `--force`.

## Quick start

```sh
oa intake submit --payload-file /tmp/task-one.json
oa queue add t_<id>
oa plan create --from-queue --budget 28800
oa run --detach p_<id>
```

See the [main repo README](https://github.com/a20185/OvernightAgent) for the full CLI reference.

## License

MIT — see [LICENSE](./LICENSE).
