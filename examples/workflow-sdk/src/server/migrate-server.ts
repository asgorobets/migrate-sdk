import {
  WorkflowSdkClient,
  WorkflowSdkMigrationExecutable,
} from "@migrate-sdk/workflow-sdk";
import { Layer } from "effect";
import {
  MigrateServerHttp,
  RegistryMigrateServer,
} from "migrate-sdk/server/http";
import { catalogRegistry } from "../migrations/catalog";
import { catalogMigrationWorkflow } from "../migrations/catalog-migration.workflow";

const executableLayer = WorkflowSdkMigrationExecutable.layer({
  workflow: catalogMigrationWorkflow,
}).pipe(Layer.provide(WorkflowSdkClient.layer));

const environmentLabel =
  process.env.VERCEL_PROJECT_PRODUCTION_URL === undefined
    ? "Local Workflow dev server"
    : `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/`;

export const migrateServerLayer = RegistryMigrateServer.layer({
  environment: {
    id: process.env.VERCEL_ENV ?? "local",
    label: environmentLabel,
  },
  registry: catalogRegistry,
}).pipe(Layer.provide(executableLayer));

export const migrateServerHttpLayer = MigrateServerHttp.layer.pipe(
  Layer.provide(migrateServerLayer)
);
