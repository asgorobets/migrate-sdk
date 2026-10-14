import { Effect, Schema } from "effect";
import { AuthorRow } from "./source.ts";

const input: unknown = {
  id: "author-1",
  firstName: "Ada",
  lastName: "Morgan",
};

const decodeAuthor = Schema.decodeUnknownEffect(AuthorRow);
const author = await Effect.runPromise(decodeAuthor(input));
//    ^?

const firstName = author.firstName;
//    ^?

console.log(firstName.toUpperCase());
