# Tiny Tiger Feeder

Have more cats than you have hands? Are they each picky? Does buying food suck? This is my gift to you.

A remote MCP server, used from Claude through a custom connector. It logs what each cat eats and how they respond, keeps a pantry, and produces a "Chewy update sheet" for hand-editing a single Chewy autoship. It never talks to Chewy.

## Tests

```sh
npx vitest run          # unit and integration tests
npm run test:firestore  # Firestore repo and auth store, against the emulator (needs a JDK)
npx tsc --noEmit        # type check
```

## Deploying

See [docs/deploy.md](docs/deploy.md).

## Using it with Claude

Paste [docs/claude-instructions.md](docs/claude-instructions.md) into a Claude Project that has the connector enabled.

## Design

- Spec: [docs/superpowers/specs/2026-11-06-tiny-tiger-feeder-design.md](docs/superpowers/specs/2026-11-06-tiny-tiger-feeder-design.md)
- Plan: [docs/superpowers/plans/2026-11-06-tiny-tiger-feeder-v1.md](docs/superpowers/plans/2026-11-06-tiny-tiger-feeder-v1.md)
