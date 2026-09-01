import { rm } from "node:fs/promises";

export const removeTemporaryDirectory = (directory) =>
  rm(directory, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
