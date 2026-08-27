import packageJson from "../package.json" with { type: "json" };

/** The version of the Migrate SDK implementation serving this module. */
export const MIGRATE_SDK_VERSION = packageJson.version;
