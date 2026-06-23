import type {
  BusinessUnitSetCustomFieldAction,
  CustomerSetCustomFieldAction,
  CustomFieldsDraft,
  InventoryEntrySetCustomFieldAction,
  ProductSelectionSetCustomFieldAction,
  StoreSetCustomFieldAction,
} from "@commercetools/platform-sdk";
import { Effect, Schema } from "effect";
import {
  type NonEmptyUpdateActions,
  nonEmptyUpdateActions,
  type UpdateActionBase,
} from "./update-action-builder.ts";

export type CommercetoolsCustomFieldSchema =
  Schema.Struct<Schema.Struct.Fields> &
    Schema.Codec<object, object, never, never>;

export type SameShapeCustomFieldSchema<CustomFieldSchema> =
  CustomFieldSchema extends CommercetoolsCustomFieldSchema
    ? [CustomFieldSchema["Type"]] extends [CustomFieldSchema["Encoded"]]
      ? [CustomFieldSchema["Encoded"]] extends [CustomFieldSchema["Type"]]
        ? CustomFieldSchema
        : never
      : never
    : never;

export interface CommercetoolsCustomTypeConfig<
  CustomFieldSchema extends CommercetoolsCustomFieldSchema,
> {
  readonly fields: SameShapeCustomFieldSchema<CustomFieldSchema>;
  readonly typeKey: string;
}

type CustomFieldBag<CustomFieldSchema> =
  CustomFieldSchema extends CommercetoolsCustomFieldSchema
    ? CustomFieldSchema["Type"]
    : never;

type FieldName<CustomFieldSchema> = Extract<
  keyof CustomFieldBag<CustomFieldSchema>,
  string
>;

type FieldValue<
  CustomFieldSchema,
  Name extends FieldName<CustomFieldSchema>,
> = CustomFieldBag<CustomFieldSchema>[Name];

type FieldOperation =
  | {
      readonly kind: "set";
      readonly name: string;
      readonly value: unknown;
    }
  | {
      readonly kind: "unset";
      readonly name: string;
    };

export interface CustomFieldActionBase extends UpdateActionBase {
  readonly action: "setCustomField";
  readonly name: string;
  readonly value?: unknown;
}

export interface CustomFieldBuilder<
  CustomFieldSchema,
  Action extends CustomFieldActionBase,
> {
  readonly set: <const Name extends FieldName<CustomFieldSchema>>(
    name: Name,
    value: FieldValue<CustomFieldSchema, NoInfer<Name>>
  ) => CustomFieldBuilder<CustomFieldSchema, Action>;
  readonly toActions: () => Effect.Effect<
    NonEmptyUpdateActions<Action>,
    Schema.SchemaError
  >;
  readonly toDraft: () => Effect.Effect<CustomFieldsDraft, Schema.SchemaError>;
  readonly unset: <const Name extends FieldName<CustomFieldSchema>>(
    name: Name
  ) => CustomFieldBuilder<CustomFieldSchema, Action>;
}

export interface CustomFieldsHelper<
  CustomFieldSchema,
  Action extends CustomFieldActionBase,
> {
  readonly withFields: (
    fields: Partial<CustomFieldBag<CustomFieldSchema>>
  ) => CustomFieldBuilder<CustomFieldSchema, Action>;
}

export type BusinessUnitCustomFieldBuilder<CustomFieldSchema> =
  CustomFieldBuilder<CustomFieldSchema, BusinessUnitSetCustomFieldAction>;

export type BusinessUnitCustomFieldsHelper<CustomFieldSchema> =
  CustomFieldsHelper<CustomFieldSchema, BusinessUnitSetCustomFieldAction>;

export type CustomerCustomFieldBuilder<CustomFieldSchema> = CustomFieldBuilder<
  CustomFieldSchema,
  CustomerSetCustomFieldAction
>;

export type CustomerCustomFieldsHelper<CustomFieldSchema> = CustomFieldsHelper<
  CustomFieldSchema,
  CustomerSetCustomFieldAction
>;

export type InventoryEntryCustomFieldBuilder<CustomFieldSchema> =
  CustomFieldBuilder<CustomFieldSchema, InventoryEntrySetCustomFieldAction>;

export type InventoryEntryCustomFieldsHelper<CustomFieldSchema> =
  CustomFieldsHelper<CustomFieldSchema, InventoryEntrySetCustomFieldAction>;

export type ProductSelectionCustomFieldBuilder<CustomFieldSchema> =
  CustomFieldBuilder<CustomFieldSchema, ProductSelectionSetCustomFieldAction>;

export type ProductSelectionCustomFieldsHelper<CustomFieldSchema> =
  CustomFieldsHelper<CustomFieldSchema, ProductSelectionSetCustomFieldAction>;

export type StoreCustomFieldBuilder<CustomFieldSchema> = CustomFieldBuilder<
  CustomFieldSchema,
  StoreSetCustomFieldAction
>;

export type StoreCustomFieldsHelper<CustomFieldSchema> = CustomFieldsHelper<
  CustomFieldSchema,
  StoreSetCustomFieldAction
>;

type ValidatedFieldOperation =
  | {
      readonly kind: "set";
      readonly name: string;
      readonly value: unknown;
    }
  | {
      readonly kind: "unset";
      readonly name: string;
    };

const fieldSchema = (
  schema: CommercetoolsCustomFieldSchema,
  name: string
): Schema.Codec<unknown, unknown, never, never> | undefined => {
  const field = schema.fields[name];

  if (field === undefined) {
    return;
  }

  // The configured struct is service-free; TypeScript cannot infer that for
  // individual fields read back through the generic field map.
  return field as Schema.Codec<unknown, unknown, never, never>;
};

const decodeFieldOperation = <
  CustomFieldSchema extends CommercetoolsCustomFieldSchema,
>(
  schema: CustomFieldSchema,
  operation: FieldOperation
): Effect.Effect<ValidatedFieldOperation, Schema.SchemaError> => {
  const schemaForName = fieldSchema(schema, operation.name);

  if (schemaForName === undefined) {
    return Schema.decodeUnknownEffect(Schema.Never, { errors: "all" })(
      operation
    );
  }

  if (operation.kind === "unset") {
    return Effect.succeed(operation);
  }

  return Schema.decodeUnknownEffect(schemaForName, { errors: "all" })(
    operation.value
  ).pipe(
    Effect.map(
      (value): ValidatedFieldOperation => ({
        kind: "set",
        name: operation.name,
        value,
      })
    )
  );
};

const decodeFieldOperations = <
  CustomFieldSchema extends CommercetoolsCustomFieldSchema,
>(
  schema: CustomFieldSchema,
  operations: readonly FieldOperation[]
): Effect.Effect<readonly ValidatedFieldOperation[], Schema.SchemaError> =>
  Effect.forEach(operations, (operation) =>
    decodeFieldOperation(schema, operation)
  );

const toFieldOperations = <CustomFieldSchema>(
  fields: Partial<CustomFieldBag<CustomFieldSchema>>
): readonly FieldOperation[] =>
  Object.entries(fields).flatMap(([name, value]) =>
    value === undefined ? [] : [{ kind: "set", name, value }]
  );

const toDraftFields = (
  operations: readonly ValidatedFieldOperation[]
): Readonly<Record<string, unknown>> => {
  const fields: Record<string, unknown> = {};

  for (const operation of operations) {
    if (operation.kind === "set") {
      fields[operation.name] = operation.value;
    } else {
      delete fields[operation.name];
    }
  }

  return fields;
};

const toSetCustomFieldActions = <Action extends CustomFieldActionBase>(
  operations: readonly ValidatedFieldOperation[],
  label: string
): NonEmptyUpdateActions<Action> =>
  nonEmptyUpdateActions(
    operations.map((operation) =>
      operation.kind === "set"
        ? {
            action: "setCustomField",
            name: operation.name,
            value: operation.value,
          }
        : {
            action: "setCustomField",
            name: operation.name,
          }
    ) as Action[],
    label
  );

const makeBuilder = <
  Action extends CustomFieldActionBase,
  CustomFieldSchema extends CommercetoolsCustomFieldSchema,
>(
  config: CommercetoolsCustomTypeConfig<CustomFieldSchema>,
  label: string,
  operations: readonly FieldOperation[]
): CustomFieldBuilder<CustomFieldSchema, Action> => ({
  set: (name, value) =>
    makeBuilder(config, label, [
      ...operations,
      {
        kind: "set",
        name,
        value,
      },
    ]),
  toActions: () =>
    decodeFieldOperations(config.fields, operations).pipe(
      Effect.map((validatedOperations) =>
        toSetCustomFieldActions<Action>(validatedOperations, label)
      )
    ),
  toDraft: () =>
    decodeFieldOperations(config.fields, operations).pipe(
      Effect.map((validatedOperations) => {
        const fields = toDraftFields(validatedOperations);

        return {
          ...(Object.keys(fields).length === 0 ? {} : { fields }),
          type: {
            key: config.typeKey,
            typeId: "type",
          },
        };
      })
    ),
  unset: (name) =>
    makeBuilder(config, label, [
      ...operations,
      {
        kind: "unset",
        name,
      },
    ]),
});

const missingCustomTypeConfig = <
  Action extends CustomFieldActionBase,
  CustomFieldSchema,
>(
  label: string
): CustomFieldBuilder<CustomFieldSchema, Action> => {
  const error = new Error(`${label} require a configured custom type`);

  return {
    set: () => missingCustomTypeConfig<Action, CustomFieldSchema>(label),
    toActions: () => Effect.die(error),
    toDraft: () => Effect.die(error),
    unset: () => missingCustomTypeConfig<Action, CustomFieldSchema>(label),
  };
};

const makeCustomFieldsHelper = <
  Action extends CustomFieldActionBase,
  CustomFieldSchema extends CommercetoolsCustomFieldSchema,
>(
  config: CommercetoolsCustomTypeConfig<CustomFieldSchema> | undefined,
  label: string
): CustomFieldsHelper<CustomFieldSchema, Action> => ({
  withFields: (fields) => {
    if (config === undefined) {
      return missingCustomTypeConfig<Action, CustomFieldSchema>(label);
    }

    return makeBuilder<Action, CustomFieldSchema>(
      config,
      label,
      toFieldOperations<CustomFieldSchema>(fields)
    );
  },
});

export const makeBusinessUnitCustomFieldsHelper = <
  CustomFieldSchema extends CommercetoolsCustomFieldSchema,
>(
  config: CommercetoolsCustomTypeConfig<CustomFieldSchema> | undefined
): BusinessUnitCustomFieldsHelper<CustomFieldSchema> =>
  makeCustomFieldsHelper<BusinessUnitSetCustomFieldAction, CustomFieldSchema>(
    config,
    "Business unit custom fields"
  );

export const makeCustomerCustomFieldsHelper = <
  CustomFieldSchema extends CommercetoolsCustomFieldSchema,
>(
  config: CommercetoolsCustomTypeConfig<CustomFieldSchema> | undefined
): CustomerCustomFieldsHelper<CustomFieldSchema> =>
  makeCustomFieldsHelper<CustomerSetCustomFieldAction, CustomFieldSchema>(
    config,
    "Customer custom fields"
  );

export const makeInventoryEntryCustomFieldsHelper = <
  CustomFieldSchema extends CommercetoolsCustomFieldSchema,
>(
  config: CommercetoolsCustomTypeConfig<CustomFieldSchema> | undefined
): InventoryEntryCustomFieldsHelper<CustomFieldSchema> =>
  makeCustomFieldsHelper<InventoryEntrySetCustomFieldAction, CustomFieldSchema>(
    config,
    "Inventory entry custom fields"
  );

export const makeProductSelectionCustomFieldsHelper = <
  CustomFieldSchema extends CommercetoolsCustomFieldSchema,
>(
  config: CommercetoolsCustomTypeConfig<CustomFieldSchema> | undefined
): ProductSelectionCustomFieldsHelper<CustomFieldSchema> =>
  makeCustomFieldsHelper<
    ProductSelectionSetCustomFieldAction,
    CustomFieldSchema
  >(config, "Product selection custom fields");

export const makeStoreCustomFieldsHelper = <
  CustomFieldSchema extends CommercetoolsCustomFieldSchema,
>(
  config: CommercetoolsCustomTypeConfig<CustomFieldSchema> | undefined
): StoreCustomFieldsHelper<CustomFieldSchema> =>
  makeCustomFieldsHelper<StoreSetCustomFieldAction, CustomFieldSchema>(
    config,
    "Store custom fields"
  );
