import { rm } from "node:fs/promises";

export const removeTemporaryDirectory = (directory) =>
  rm(directory, {
    force: true,
    maxRetries: 15,
    recursive: true,
    retryDelay: 250,
  });
