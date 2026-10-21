import { cp, mkdir, writeFile } from "node:fs/promises";

const source = new URL("../.data/source/", import.meta.url);
await mkdir(source, { recursive: true });
await mkdir(new URL("../.data/destination/", import.meta.url), {
  recursive: true,
});
await mkdir(new URL("../.data/state/", import.meta.url), { recursive: true });
await cp(new URL("../fixtures/", import.meta.url), source, {
  recursive: true,
  force: false,
});

try {
  await writeFile(
    new URL("sample.bin", source),
    Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index % 256),
    { flag: "wx" }
  );
} catch (error) {
  if (error.code !== "EEXIST") {
    throw error;
  }
}

console.log(
  "Source fixtures ready in .data/source; existing files and state preserved."
);
