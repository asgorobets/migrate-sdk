import { Schema } from "effect";

export const JsonPlaceholderPostCursor = Schema.Struct({
  offset: Schema.Int,
});

export const JsonPlaceholderPost = Schema.Struct({
  body: Schema.String,
  id: Schema.Finite,
  title: Schema.String,
  userId: Schema.Finite,
});

export const JsonPlaceholderPosts = Schema.Array(JsonPlaceholderPost);

export const JsonPlaceholderPostsDocument = Schema.Struct({
  posts: JsonPlaceholderPosts,
});
