import type {
  BusinessUnit,
  BusinessUnitDraft,
  BusinessUnitUpdate,
  BusinessUnitUpdateAction,
} from "@commercetools/platform-sdk";
import { Context, Effect, Layer } from "effect";
import { CommercetoolsSdk, type CommercetoolsSdkError } from "../sdk.ts";

export type CommercetoolsBusinessUnitSelector =
  | {
      readonly id: string;
      readonly kind: "id";
    }
  | {
      readonly key: string;
      readonly kind: "key";
    };

export type CommercetoolsBusinessUnitUpdateActions = readonly [
  BusinessUnitUpdateAction,
  ...BusinessUnitUpdateAction[],
];

export interface CommercetoolsUpdateBusinessUnitInput {
  readonly actions: CommercetoolsBusinessUnitUpdateActions;
  readonly selector: CommercetoolsBusinessUnitSelector;
  readonly version: number;
}

export interface CommercetoolsBusinessUnitsLayerOptions {
  readonly projectKey: string;
}

export class CommercetoolsBusinessUnits extends Context.Service<
  CommercetoolsBusinessUnits,
  {
    readonly createBusinessUnitDraft: (
      draft: BusinessUnitDraft
    ) => Effect.Effect<BusinessUnit, CommercetoolsSdkError>;
    readonly updateBusinessUnit: (
      input: CommercetoolsUpdateBusinessUnitInput
    ) => Effect.Effect<BusinessUnit, CommercetoolsSdkError>;
  }
>()("@migrate-sdk/commercetools/CommercetoolsBusinessUnits") {
  static readonly layer = (
    options: CommercetoolsBusinessUnitsLayerOptions
  ): Layer.Layer<CommercetoolsBusinessUnits, never, CommercetoolsSdk> =>
    Layer.effect(
      CommercetoolsBusinessUnits,
      Effect.gen(function* () {
        const sdk = yield* CommercetoolsSdk;
        const project = sdk.apiRoot.withProjectKey({
          projectKey: options.projectKey,
        });

        const createBusinessUnitDraft = Effect.fn(
          "CommercetoolsBusinessUnits.createBusinessUnitDraft"
        )((draft: BusinessUnitDraft) =>
          sdk.execute(
            "businessUnits.createDraft",
            project.businessUnits().post({
              body: draft,
            })
          )
        );

        const updateBusinessUnit = Effect.fn(
          "CommercetoolsBusinessUnits.updateBusinessUnit"
        )((input: CommercetoolsUpdateBusinessUnitInput) => {
          const body: BusinessUnitUpdate = {
            actions: [...input.actions],
            version: input.version,
          };
          const businessUnits = project.businessUnits();
          const businessUnit =
            input.selector.kind === "id"
              ? businessUnits.withId({ ID: input.selector.id })
              : businessUnits.withKey({ key: input.selector.key });

          return sdk.execute(
            "businessUnits.update",
            businessUnit.post({
              body,
            })
          );
        });

        return {
          createBusinessUnitDraft,
          updateBusinessUnit,
        };
      })
    );
}
