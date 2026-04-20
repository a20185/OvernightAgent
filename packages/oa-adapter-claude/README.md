# @soulerou/oa-adapter-claude

Headless `claude` AgentAdapter for [OvernightAgent](https://github.com/a20185/OvernightAgent). Invokes `claude -p <prompt> --model <M> --output-format stream-json` and parses `session_id` from the stream.

Resolved dynamically by `@soulerou/oa-core`'s adapter registry — import only if embedding the adapter directly in a custom harness.

See the [main repo README](https://github.com/a20185/OvernightAgent) and [ADR-0009](https://github.com/a20185/OvernightAgent/blob/main/docs/adr/0009-agent-adapter-interface.md) for the `AgentAdapter` contract.

## License

MIT — see [LICENSE](./LICENSE).
