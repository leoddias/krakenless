# Active task board

Packets currently in flight or awaiting integration. Format and rules:
`docs/PARALLEL.md`. Empty between fan-outs — this is a scratch board, not
history; outcomes go to `docs/PROGRESS.md`.

## In flight

_(none — v0.1 is feature-complete; the next work is the dogfood gate, which is
not a packet.)_

## Merged this session

Four fan-outs closed on 2026-08-20, six packets in total, every one merged:

| Packet | Loop passes | Reviewer verdicts |
|---|---|---|
| T-M1-1 status parser | 3 | conventions PASS, safety SAFE |
| T-M1-2 log parser | 2 | safety BLOCKED pass 1 (commit message could forge a commit) |
| T-M1-3 diff parser | 3 | safety BLOCKED twice (submodule attribution, combined diffs) |
| T-M1-4/5/6 views | 2–3 | conventions PASS |
| T-M2-1 changes panel | 3 | safety BLOCKED pass 1 (recovery promised for a stash git may not have created) |
| T-M3-1 remote toolbar | 3 | conventions FAILED pass 1 (asserted a fact from an unread read) |
| T-M4-1 refs panel | 3 | safety BLOCKED pass 1 (busy cleared too early; a click could land on the force button) |

Splitting lesson worth keeping: every packet that touched a *shared* file
reported the edit instead of making it, and in four cases that report was the
finding — a worker's reviewer caught a defect in the contract, not in the
packet. Keeping shared files orchestrator-only is what surfaced them.
