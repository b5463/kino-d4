## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code or documentation, run `graphify update . --force` to keep the graph current (AST-only, no API cost).

## Project map

- Read `README.md` for the product and repository overview.
- The README uses `docs/assets/kino-studio-demo.png`, captured from the included simulator. Replace it only with a newer capture of the real app. Do not use generated or invented UI artwork.
- Read `docs/README.md` before changing documentation. It defines the authority order and points to the right source for hardware, protocol, architecture, and development work.
- Use `docs/HARDWARE.md` for the current D4 hardware snapshot. Keep measured, manufacturer-specified, seller-specified, provisional, and conflicting dimensions distinct.
- Use `docs/ARCHITECTURE.md` for system boundaries and package ownership.
- Use `docs/DEVELOPMENT.md` for local commands and test prerequisites.
- Treat `packages/kdp/src/protocol/*` and `packages/schemas/src/*` as normative when prose disagrees with implemented contracts. `firmware-contract/README.md` records known deviations.
- Write like an engineer at the bench: concrete nouns, exact units, short sentences, no marketing filler, no fake certainty, and no AI-assistant phrasing.
