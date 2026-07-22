# PyCharm Shelve parity matrix

## Verification status

This matrix is based on the frozen IntelliGit shelve plan, not a live PyCharm
session. Live-IDE verification is required before release; each row remains
marked **TODO: verify against live IDE**. This is the documented deviation from
Phase 0 step 1: no PyCharm IDE is available in this environment.

| Behavior | IntelliGit target | Source | Status |
| --- | --- | --- | --- |
| Shelve Changes | Named patch capture, then revert selected changes | Frozen plan, Phase 0/2 | TODO: verify against live IDE |
| Save to Shelf | Capture without reverting local changes (`keepLocal`) | Frozen plan, Phase 2 step 10 | TODO: verify against live IDE |
| Unshelve default | Flattened working-tree apply; preserve index | Frozen plan, Phase 2 step 11 | TODO: verify against live IDE |
| Exact state | Explicit opt-in restore of index and working tree | IntelliGit extension, frozen plan | TODO: verify against live IDE |
| Unversioned files | Supported and visibly labeled IntelliGit extension | Frozen plan, Phase 0 step 1 | TODO: verify against live IDE |
| Base revisions disabled | Resolve conflict base from pinned repository history | Frozen plan, Phase 0 step 1 | TODO: verify against live IDE |
| Drag and drop | Ctrl-drag copies/keeps shelf; normal drag moves/applies | Frozen plan, Phase 0/5 | TODO: verify against live IDE |
| Already unshelved shelves | Retained as ghosts until explicit deletion | Frozen plan, Phase 0/4 | TODO: verify against live IDE |
| Clean Up Shelf | Delete ghosts, optionally older-than-N-days; no default auto-delete | Frozen plan, Phase 0/4 | TODO: verify against live IDE |

## Deliberate divergences

- IntelliGit shelves untracked files. PyCharm behavior is documented in the
  frozen plan as excluding unversioned files.
- IntelliGit offers `exactState` unshelve in addition to PyCharm-compatible
  flattened unshelve.
- IntelliGit stores patch data outside the repository and never reads or writes
  JetBrains `.idea/shelf` XML.
