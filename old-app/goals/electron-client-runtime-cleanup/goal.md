# Electron Client Runtime Cleanup

## Objective

Clean up the Electron/client runtime architecture so IPC communication follows `.docs/clean-electron-client-runtime-architecture.md` and the Electron, renderer, worker-script/node, and `src` code is grouped into a sane, maintainable folder structure.

## Original Request

Clean up electron, renderer, worker-script/node and src: clean up IPC communication to use `.docs/clean-electron-client-runtime-architecture.md`, and group the files to a sane folder structure.

## Intake Summary

- Input shape: `specific`
- Audience: maintainers of this repo and future contributors working on Electron/runtime code
- Authority: `requested`
- Proof type: `test`
- Completion proof: the architecture doc has been read and implemented, IPC boundaries are centralized/typed according to that doc, folders are reorganized coherently, imports/build config are updated, and relevant lint/type/build/test commands pass or have documented blockers.
- Likely misfire: only moving files around, or only making cosmetic IPC wrapper changes, while leaving the runtime contract and Electron/client boundaries inconsistent with the architecture doc.
- Blind spots considered: packaging/build path assumptions, preload/main/renderer security boundaries, worker/node runtime import cycles, test coverage gaps, stale docs after moves, and hidden IPC channel consumers.
- Existing plan facts: preserve the user-provided targets: `.docs/clean-electron-client-runtime-architecture.md`, Electron, renderer, worker-script/node, and `src`; validate the plan against the actual repo before implementation.

## Goal Kind

`specific`

## Current Tranche

Discover the current Electron/client runtime shape, validate it against `.docs/clean-electron-client-runtime-architecture.md`, then complete successive safe verified implementation slices until IPC communication and folder organization satisfy the original request. Do not stop at planning, discovery, or a single file move if safe follow-up slices remain.

## Non-Negotiable Constraints

- Read `.docs/clean-electron-client-runtime-architecture.md` before choosing implementation slices.
- Preserve runtime behavior unless the architecture doc explicitly requires a behavior change.
- Keep Electron main/preload/renderer/worker boundaries explicit and avoid expanding unsafe renderer access.
- Move files in reviewable slices and update imports/config/tests with each slice.
- Do not mark complete until verification commands prove the reorganized runtime still builds or failures are documented as blockers tied to specific tasks.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if the user asked for working software or automation and a safe Worker task can be activated.

Do not stop after a single verified Worker slice when the broader owner outcome still has safe local follow-up slices. After each slice audit, advance the board to the next highest-leverage safe Worker task and continue.

Do not stop because a slice needs owner input, credentials, production access, destructive operations, or policy decisions. Mark that exact slice blocked with a receipt, create the smallest safe follow-up or workaround task, and continue all local, non-destructive work that can still move the goal toward the full outcome.

## Canonical Board

Machine truth lives at:

`docs/goals/electron-client-runtime-cleanup/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/electron-client-runtime-cleanup/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available and mention a newer version without blocking.
4. Re-check the intake: original request, input shape, authority, proof, blind spots, existing plan facts, and likely misfire.
5. Work only on the active board task.
6. Assign Scout, Judge, Worker, or PM according to the task.
7. Write a compact task receipt.
8. Update the board.
9. If Judge selected a safe Worker task with `allowed_files`, `verify`, and `stop_if`, activate it and continue unless blocked.
10. If a problem, suggestion, or follow-up should become a repo artifact, create an approved issue/PR or ask the operator whether to create one.
11. Treat a slice audit as a checkpoint, not completion, unless it explicitly proves the full original outcome is complete.
12. Finish only with a Judge/PM audit receipt that maps receipts and verification back to the original user outcome and records `full_outcome_complete: true`.

Issue and PR handoffs are supporting artifacts. `state.yaml` remains authoritative, and every external artifact decision must be recorded in a task receipt.
