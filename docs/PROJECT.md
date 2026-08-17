# KINO GitHub Project

The live execution board is [KINO D4 project #3](https://github.com/users/b5463/projects/3). It is linked to `b5463/kino-d4`.

[`ROADMAP.md`](../ROADMAP.md) records direction without dates. The project contains work that is concrete enough to plan, build, test, or validate. Do not maintain a second backlog in a planning document.

## Views

| View | Use |
|---|---|
| Backlog | Every item still in `Todo` |
| Board | Work grouped by `Todo`, `In Progress`, and `Done` |
| D4-V1 | Physical build, firmware, measurements, and bench validation |
| Studio + KDP | Device workbench, protocol, and recovery work |
| Roll MVP | Public client, processing, retention, and weak-network work |
| Twin 0.1 | Measured model, simulator, and KDP connection |
| Releases | Packaging, signing, rollback, backup, and manufacturing support |

## Fields

Every issue on the board has these fields:

- **Status:** `Todo`, `In Progress`, or `Done`.
- **Priority:** `P0` blocks the current build; `P1` is next for the active target; `P2` is planned; `P3` is later.
- **Area:** the part of KINO that owns the work.
- **Target:** `D4-V1`, `Studio 0.9`, `Roll MVP`, `Twin 0.1`, `Release foundations`, or `Later`.

Milestones carry the same target boundaries in the repository issue list. Labels keep the owning area visible outside the project.

## Start work

1. Read the issue and its acceptance checks.
2. Check the board for blockers and related pull requests.
3. Assign the issue to the person doing the work.
4. Move it to `In Progress` only after work starts.
5. Use the issue number in the branch or pull request and link the pull request to the issue.

```bash
npm run project -- list
npm run project -- start 3
```

Do not silently widen an issue. Add a comment, split the work, or open a follow-up issue and put it on the board.

## Add work

Create an issue from the repository form, then add it with all required project fields:

```bash
npm run project -- add 17 --priority P1 --area Firmware --target D4-V1
```

Valid field values are printed when the helper rejects a value. The helper reads field and option IDs from GitHub instead of storing them in the repository.

GitHub CLI needs the `project` scope:

```bash
gh auth refresh -h github.com -s project
```

## Finish work

1. Run the relevant tests and checks.
2. Update maintained contracts, hardware records, versions, and changelogs where required.
3. Put bench evidence on hardware issues. Keep units and test conditions with the result.
4. Link the merged pull request.
5. Close the issue only when its acceptance checks are complete.
6. Move the project item to `Done`.

```bash
npm run project -- done 3
```

`done` changes the project field. It does not close the issue.

## Ownership

- `ROADMAP.md` owns direction and explicit non-goals.
- The issue owns scope and acceptance checks.
- The project owns execution status, priority, area, and target.
- Tested source and maintained technical documents still win when an issue contains stale technical detail.
