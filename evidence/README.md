# Evidence records

This branch is the append-only store for **evidence batches**: real-world data —
customer feedback, analytics, test results — recorded as dated records that plans
can be checked against.

- One file per batch: `evidence/<date>-<source>.json`.
- Each batch also has an issue labelled `evidence:batch`, which is where it is
  reviewed and where a contradiction is recorded.
- Recording the same date and source again **appends** to that batch's file; a
  different source on the same date starts a new one.

**Why this branch and not the main one.** The main branch requires a passing plan
check on every push, and the scheduled collector holds no credential that can
satisfy it — so its records were refused, every time. Keeping them here means the
main branch stays strict: no automation is granted a way around that check.

Nothing merges this branch. Its history starts fresh here and only ever grows:
force-pushes and deletion are blocked, so a record that has been written cannot
be quietly rewritten or removed.

Read the batches from the dashboard's **Evidence** page — that is where they are
reviewed and where a batch is marked as contradicting a plan.
