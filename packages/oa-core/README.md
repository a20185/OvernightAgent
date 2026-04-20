# @soulerou/oa-core

Core engine behind the [OvernightAgent](https://github.com/a20185/OvernightAgent) CLI: schemas (Zod), paths, atomic JSON, worktree manager, intake parser, adapter registry, four-gate verify pipeline, fix-loop, events reader/writer, supervisor (`runPlan` + `resumePlan`), daemon launcher, pidfile, control socket, and SUMMARY renderer.

Most users should install the CLI (`@soulerou/oa-cli`), which pulls this in transitively. Import `@soulerou/oa-core` directly only when embedding the supervisor in a custom harness.

See the [main repo README](https://github.com/a20185/OvernightAgent) for architecture, ADRs, and usage.

## License

MIT — see [LICENSE](./LICENSE).
