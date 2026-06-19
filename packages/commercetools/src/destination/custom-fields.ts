import type {
  BusinessUnitSetCustomFieldAction,
  CustomFieldsDraft,
} from "@commercetools/platform-sdk";
import { Effect, Schema } from "effect";
import {
  type NonEmptyUpdateActions,
  nonEmptyUpdateActions,
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

export interface BusinessUnitCustomFieldBuilder<CustomFieldSchema> {
  readonly set: <const Name extends FieldName<CustomFieldSchema>>(
    name: Name,
    value: FieldValue<CustomFieldSchema, NoInfer<Name>>
  ) => BusinessUnitCustomFieldBuilder<CustomFieldSchema>;
  readonly toActions: () => Effect.Effect<
    NonEmptyBusinessUnitCustomFieldActions,
    Schema.SchemaError
  >;
  readonly toDraft: () => Effect.Effect<CustomFieldsDraft, Schema.SchemaError>;
  readonly unset: <const Name extends FieldName<CustomFieldSchema>>(
    name: Name
  ) => BusinessUnitCustomFieldBuilder<CustomFieldSchema>;
}

export interface BusinessUnitCustomFieldsHelper<CustomFieldSchema> {
  readonly withFields: (
    fields: Partial<CustomFieldBag<CustomFieldSchema>>
  ) => BusinessUnitCustomFieldBuilder<CustomFieldSchema>;
}

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

type NonEmptyBusinessUnitCustomFieldActions =
  NonEmptyUpdateActions<BusinessUnitSetCustomFieldAction>;

const fieldSchema = (
  schema: CommercetoolsCustomFieldSchema,
  name: string
): Schema.Codec<unknown, unknown, never, never> | undefined => {
  const field = schema.fields[name];

  if (field === undefined) {
    return undefined;
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

const toSetCustomFieldActions = (
  operations: readonly ValidatedFieldOperation[]
): NonEmptyBusinessUnitCustomFieldActions =>
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
    ),
    "Business unit custom fields"
  );

const makeBuilder = <CustomFieldSchema extends CommercetoolsCustomFieldSchema>(
  config: CommercetoolsCustomTypeConfig<CustomFieldSchema>,
  operations: readonly FieldOperation[]
): BusinessUnitCustomFieldBuilder<CustomFieldSchema> => ({
  set: (name, value) =>
    makeBuilder(config, [
      ...operations,
      {
        kind: "set",
        name,
        value,
      },
    ]),
  toActions: () =>
    decodeFieldOperations(config.fields, operations).pipe(
      Effect.map(toSetCustomFieldActions)
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
    makeBuilder(config, [
      ...operations,
      {
        kind: "unset",
        name,
      },
    ]),
});

const missingCustomTypeConfig = <
  CustomFieldSchema,
>(): BusinessUnitCustomFieldBuilder<CustomFieldSchema> => {
  const error = new Error(
    "Commercetools business unit custom fields require a configured custom type"
  );

  return {
    set: () => missingCustomTypeConfig<CustomFieldSchema>(),
    toActions: () => Effect.die(error),
    toDraft: () => Effect.die(error),
    unset: () => missingCustomTypeConfig<CustomFieldSchema>(),
  };
};

export const makeBusinessUnitCustomFieldsHelper = <
  CustomFieldSchema extends CommercetoolsCustomFieldSchema,
>(
  config: CommercetoolsCustomTypeConfig<CustomFieldSchema> | undefined
): BusinessUnitCustomFieldsHelper<CustomFieldSchema> => ({
  withFields: (fields) => {
    if (config === undefined) {
      return missingCustomTypeConfig<CustomFieldSchema>();
    }

    return makeBuilder(config, toFieldOperations<CustomFieldSchema>(fields));
  },
});
