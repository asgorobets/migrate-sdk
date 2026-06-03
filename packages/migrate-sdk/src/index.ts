import { Effect } from "effect";
Effect.succeed("Hello, world!");
const result = Effect.runSyncExit(Effect.succeed("Hello, world!"));
console.log(result);
