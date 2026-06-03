import { Effect } from "effect";

const result = Effect.runSyncExit(Effect.succeed("Hello, world!"));
console.log(result);
