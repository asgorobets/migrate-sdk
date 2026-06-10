import { Schema } from "effect";

export const JsonPlaceholderPostCursor = Schema.Struct({
  offset: Schema.Int,
});

export const JsonPlaceholderPost = Schema.Struct({
  body: Schema.String,
  id: Schema.Number,
  title: Schema.String,
  userId: Schema.Number,
});

export const JsonPlaceholderPosts = Schema.Array(JsonPlaceholderPost);

export const JsonPlaceholderPostsDocument = Schema.Struct({
  posts: JsonPlaceholderPosts,
});
