import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { setupDemoDatabase } = await import("../src/server/demo-database");
const counts = await setupDemoDatabase({
  reset: process.argv.includes("--reset"),
});

process.stdout.write(
  `Demo database ready: ${counts.authors} authors, ${counts.books} books\n`
);
