---
"migrate-sdk": minor
---

Intentionally skipped items no longer appear as errors in traces. Skipped items
keep their reason and history of changes. Skipping does not undo changes already
made.

**Breaking change:** Update migration code that skips items:

- In a pipeline, replace `return yield* skipItem(reason)` with
  `return skipItem(reason)`.
- For a batch item, replace `Effect.fail(skipItem(reason))` with
  `Effect.succeed(skipItem(reason))`.
- Replace `new SkipItem({ reason })` with `skipItem(reason)`.
- If a helper returns a skip, return that value from the calling pipeline too.
  Returning a skip only exits the function that returns it.

Processing must finish with either no return value (`undefined`) or
`skipItem(reason)` with a string reason. Other results now fail the item, including
in JavaScript configurations. If your pipeline returns a write operation's result,
use `.pipe(Effect.asVoid)` to discard that result after the operation finishes.

Skipping creation of a required reference still fails the item that needs it.
