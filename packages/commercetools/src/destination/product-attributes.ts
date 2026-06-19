import type {
  Attribute,
  ProductSetAttributeAction,
  ProductSetAttributeInAllVariantsAction,
  ProductSetProductAttributeAction,
} from "@commercetools/platform-sdk";
import { Effect, Schema } from "effect";
import {
  type NonEmptyUpdateActions,
  nonEmptyUpdateActions,
} from "./update-action-builder.ts";

export type CommercetoolsProductAttributeSchema =
  Schema.Struct<Schema.Struct.Fields> &
    Schema.Codec<object, object, never, never>;

type ProductTypeAttributeConfigRecord = object;

export type SameShapeProductAttributeSchema<ProductAttributeSchema> =
  ProductAttributeSchema extends CommercetoolsProductAttributeSchema
    ? [ProductAttributeSchema["Type"]] extends [
        ProductAttributeSchema["Encoded"],
      ]
      ? [ProductAttributeSchema["Encoded"]] extends [
          ProductAttributeSchema["Type"],
        ]
        ? ProductAttributeSchema
        : never
      : never
    : never;

export interface CommercetoolsProductTypeAttributeConfig<
  ProductAttributeSchema extends
    CommercetoolsProductAttributeSchema = CommercetoolsProductAttributeSchema,
  VariantAttributeSchema extends
    CommercetoolsProductAttributeSchema = CommercetoolsProductAttributeSchema,
> {
  readonly attributes: SameShapeProductAttributeSchema<VariantAttributeSchema>;
  readonly productAttributes: SameShapeProductAttributeSchema<ProductAttributeSchema>;
}

export type CommercetoolsProductAttributeSchemas<
  ProductTypeConfigRecord extends ProductTypeAttributeConfigRecord = Readonly<
    Record<string, CommercetoolsProductTypeAttributeConfig>
  >,
> = {
  readonly [ProductTypeKey in keyof ProductTypeConfigRecord]: ProductTypeConfigRecord[ProductTypeKey] extends CommercetoolsProductTypeAttributeConfig<
    infer ProductAttributeSchema,
    infer VariantAttributeSchema
  >
    ? CommercetoolsProductTypeAttributeConfig<
        ProductAttributeSchema,
        VariantAttributeSchema
      >
    : never;
};

export type CommercetoolsProductAttributeSchemasInput<
  ProductTypeConfigRecord extends ProductTypeAttributeConfigRecord,
> = ProductTypeConfigRecord &
  CommercetoolsProductAttributeSchemas<NoInfer<ProductTypeConfigRecord>>;

type ProductAttributeSchemaFor<ProductTypeConfig> =
  ProductTypeConfig extends CommercetoolsProductTypeAttributeConfig<
    infer ProductAttributeSchema,
    CommercetoolsProductAttributeSchema
  >
    ? ProductAttributeSchema
    : never;

type VariantAttributeSchemaFor<ProductTypeConfig> =
  ProductTypeConfig extends CommercetoolsProductTypeAttributeConfig<
    CommercetoolsProductAttributeSchema,
    infer VariantAttributeSchema
  >
    ? VariantAttributeSchema
    : never;

export type CommercetoolsProductAttributeBag<
  ProductTypeConfigRecord extends ProductTypeAttributeConfigRecord,
  ProductTypeKey extends keyof ProductTypeConfigRecord,
> = ProductAttributeBag<
  ProductAttributeSchemaFor<ProductTypeConfigRecord[ProductTypeKey]>
>;

export type CommercetoolsVariantAttributeBag<
  ProductTypeConfigRecord extends ProductTypeAttributeConfigRecord,
  ProductTypeKey extends keyof ProductTypeConfigRecord,
> = ProductAttributeBag<
  VariantAttributeSchemaFor<ProductTypeConfigRecord[ProductTypeKey]>
>;

type ProductAttributeBag<ProductAttributeSchema> =
  ProductAttributeSchema extends CommercetoolsProductAttributeSchema
    ? ProductAttributeSchema["Type"]
    : never;

type AttributeName<ProductAttributeSchema> = Extract<
  keyof ProductAttributeBag<ProductAttributeSchema>,
  string
>;

type AttributeValue<
  ProductAttributeSchema,
  Name extends AttributeName<ProductAttributeSchema>,
> = ProductAttributeBag<ProductAttributeSchema>[Name];

type AttributeOperation =
  | {
      readonly kind: "set";
      readonly name: string;
      readonly value: unknown;
    }
  | {
      readonly kind: "unset";
      readonly name: string;
    };

type ValidatedAttributeOperation =
  | {
      readonly kind: "set";
      readonly name: string;
      readonly value: unknown;
    }
  | {
      readonly kind: "unset";
      readonly name: string;
    };

export type ProductAttributeActions =
  NonEmptyUpdateActions<ProductSetProductAttributeAction>;

export type VariantAttributeActions = NonEmptyUpdateActions<
  ProductSetAttributeAction | ProductSetAttributeInAllVariantsAction
>;

export type VariantAttributeSingleVariantActions =
  NonEmptyUpdateActions<ProductSetAttributeAction>;

export type VariantAttributeAllVariantsActions =
  NonEmptyUpdateActions<ProductSetAttributeInAllVariantsAction>;

export interface ProductAttributeActionOptions {
  readonly staged?: boolean;
}

export interface VariantAttributeAllVariantsTarget {
  readonly allVariants: true;
  readonly sku?: never;
  readonly staged?: boolean;
  readonly variantId?: never;
}

export type VariantAttributeSingleVariantTarget =
  | {
      readonly allVariants?: never;
      readonly sku: string;
      readonly staged?: boolean;
      readonly variantId?: never;
    }
  | {
      readonly allVariants?: never;
      readonly sku?: never;
      readonly staged?: boolean;
      readonly variantId: number;
    };

export type VariantAttributeActionTarget =
  | VariantAttributeAllVariantsTarget
  | VariantAttributeSingleVariantTarget;

export interface ProductAttributeBuilder<ProductAttributeSchema> {
  readonly set: <const Name extends AttributeName<ProductAttributeSchema>>(
    name: Name,
    value: AttributeValue<ProductAttributeSchema, NoInfer<Name>>
  ) => ProductAttributeBuilder<ProductAttributeSchema>;
  readonly toActions: (
    options?: ProductAttributeActionOptions
  ) => Effect.Effect<ProductAttributeActions, Schema.SchemaError>;
  readonly toDraft: () => Effect.Effect<Attribute[], Schema.SchemaError>;
  readonly unset: <const Name extends AttributeName<ProductAttributeSchema>>(
    name: Name
  ) => ProductAttributeBuilder<ProductAttributeSchema>;
}

export interface VariantAttributeBuilder<VariantAttributeSchema> {
  readonly set: <const Name extends AttributeName<VariantAttributeSchema>>(
    name: Name,
    value: AttributeValue<VariantAttributeSchema, NoInfer<Name>>
  ) => VariantAttributeBuilder<VariantAttributeSchema>;
  readonly toActions: {
    (
      target: VariantAttributeAllVariantsTarget
    ): Effect.Effect<VariantAttributeAllVariantsActions, Schema.SchemaError>;
    (
      target: VariantAttributeSingleVariantTarget
    ): Effect.Effect<VariantAttributeSingleVariantActions, Schema.SchemaError>;
  };
  readonly toDraft: () => Effect.Effect<Attribute[], Schema.SchemaError>;
  readonly unset: <const Name extends AttributeName<VariantAttributeSchema>>(
    name: Name
  ) => VariantAttributeBuilder<VariantAttributeSchema>;
}

export interface ProductAttributesHelper<ProductAttributeSchema> {
  readonly withAttributes: (
    attributes: Partial<ProductAttributeBag<ProductAttributeSchema>>
  ) => ProductAttributeBuilder<ProductAttributeSchema>;
}

export interface VariantAttributesHelper<VariantAttributeSchema> {
  readonly withAttributes: (
    attributes: Partial<ProductAttributeBag<VariantAttributeSchema>>
  ) => VariantAttributeBuilder<VariantAttributeSchema>;
}

export interface CommercetoolsProductHelpers<
  ProductTypeConfigRecord extends ProductTypeAttributeConfigRecord,
> {
  readonly attributes: <
    const ProductTypeKey extends keyof ProductTypeConfigRecord & string,
  >(
    productTypeKey: ProductTypeKey
  ) => VariantAttributesHelper<
    VariantAttributeSchemaFor<ProductTypeConfigRecord[ProductTypeKey]>
  >;
  readonly productAttributes: <
    const ProductTypeKey extends keyof ProductTypeConfigRecord & string,
  >(
    productTypeKey: ProductTypeKey
  ) => ProductAttributesHelper<
    ProductAttributeSchemaFor<ProductTypeConfigRecord[ProductTypeKey]>
  >;
}

const attributeSchema = (
  schema: CommercetoolsProductAttributeSchema,
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

const decodeAttributeOperation = <
  ProductAttributeSchema extends CommercetoolsProductAttributeSchema,
>(
  schema: ProductAttributeSchema,
  operation: AttributeOperation
): Effect.Effect<ValidatedAttributeOperation, Schema.SchemaError> => {
  const schemaForName = attributeSchema(schema, operation.name);

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
      (value): ValidatedAttributeOperation => ({
        kind: "set",
        name: operation.name,
        value,
      })
    )
  );
};

const decodeAttributeOperations = <
  ProductAttributeSchema extends CommercetoolsProductAttributeSchema,
>(
  schema: ProductAttributeSchema,
  operations: readonly AttributeOperation[]
): Effect.Effect<readonly ValidatedAttributeOperation[], Schema.SchemaError> =>
  Effect.forEach(operations, (operation) =>
    decodeAttributeOperation(schema, operation)
  );

const toAttributeOperations = <ProductAttributeSchema>(
  attributes: Partial<ProductAttributeBag<ProductAttributeSchema>>
): readonly AttributeOperation[] =>
  Object.entries(attributes).flatMap(([name, value]) =>
    value === undefined ? [] : [{ kind: "set", name, value }]
  );

const toDraftAttributes = (
  operations: readonly ValidatedAttributeOperation[]
): Attribute[] =>
  Object.entries(
    operations.reduce<Record<string, unknown>>((attributes, operation) => {
      if (operation.kind === "set") {
        attributes[operation.name] = operation.value;
      } else {
        delete attributes[operation.name];
      }

      return attributes;
    }, {})
  ).map(([name, value]) => ({ name, value }));

const optionalStaged = (
  options: ProductAttributeActionOptions | VariantAttributeActionTarget
): Pick<ProductSetProductAttributeAction, "staged"> =>
  options.staged === undefined ? {} : { staged: options.staged };

const toProductAttributeActions = (
  operations: readonly ValidatedAttributeOperation[],
  options: ProductAttributeActionOptions = {}
): ProductAttributeActions => {
  const actions: ProductSetProductAttributeAction[] = operations.map(
    (operation) =>
      operation.kind === "set"
        ? {
            action: "setProductAttribute",
            name: operation.name,
            value: operation.value,
            ...optionalStaged(options),
          }
        : {
            action: "setProductAttribute",
            name: operation.name,
            ...optionalStaged(options),
          }
  );

  return nonEmptyUpdateActions(actions, "Product attributes");
};

function toVariantAttributeActions(
  operations: readonly ValidatedAttributeOperation[],
  target: VariantAttributeAllVariantsTarget
): VariantAttributeAllVariantsActions;
function toVariantAttributeActions(
  operations: readonly ValidatedAttributeOperation[],
  target: VariantAttributeSingleVariantTarget
): VariantAttributeSingleVariantActions;
function toVariantAttributeActions(
  operations: readonly ValidatedAttributeOperation[],
  target: VariantAttributeActionTarget
): VariantAttributeActions {
  if (target.allVariants === true) {
    const actions: ProductSetAttributeInAllVariantsAction[] = operations.map(
      (operation) =>
        operation.kind === "set"
          ? {
              action: "setAttributeInAllVariants",
              name: operation.name,
              value: operation.value,
              ...optionalStaged(target),
            }
          : {
              action: "setAttributeInAllVariants",
              name: operation.name,
              ...optionalStaged(target),
            }
    );

    return nonEmptyUpdateActions(actions, "Variant attributes");
  }

  if (target.sku !== undefined) {
    const actions: ProductSetAttributeAction[] = operations.map((operation) =>
      operation.kind === "set"
        ? {
            action: "setAttribute",
            name: operation.name,
            sku: target.sku,
            value: operation.value,
            ...optionalStaged(target),
          }
        : {
            action: "setAttribute",
            name: operation.name,
            sku: target.sku,
            ...optionalStaged(target),
          }
    );

    return nonEmptyUpdateActions(actions, "Variant attributes");
  }

  const actions: ProductSetAttributeAction[] = operations.map((operation) =>
    operation.kind === "set"
      ? {
          action: "setAttribute",
          name: operation.name,
          value: operation.value,
          variantId: target.variantId,
          ...optionalStaged(target),
        }
      : {
          action: "setAttribute",
          name: operation.name,
          variantId: target.variantId,
          ...optionalStaged(target),
        }
  );

  return nonEmptyUpdateActions(actions, "Variant attributes");
}

const makeVariantAttributeActionsProjector = <
  VariantAttributeSchema extends CommercetoolsProductAttributeSchema,
>(
  schema: VariantAttributeSchema,
  operations: readonly AttributeOperation[]
): VariantAttributeBuilder<VariantAttributeSchema>["toActions"] => {
  function toActions(
    target: VariantAttributeAllVariantsTarget
  ): Effect.Effect<VariantAttributeAllVariantsActions, Schema.SchemaError>;
  function toActions(
    target: VariantAttributeSingleVariantTarget
  ): Effect.Effect<VariantAttributeSingleVariantActions, Schema.SchemaError>;
  function toActions(
    target: VariantAttributeActionTarget
  ): Effect.Effect<VariantAttributeActions, Schema.SchemaError> {
    if (target.allVariants === true) {
      return decodeAttributeOperations(schema, operations).pipe(
        Effect.map((validatedOperations) =>
          toVariantAttributeActions(validatedOperations, target)
        )
      );
    }

    return decodeAttributeOperations(schema, operations).pipe(
      Effect.map((validatedOperations) =>
        toVariantAttributeActions(validatedOperations, target)
      )
    );
  }

  return toActions;
};

const makeProductAttributeBuilder = <
  ProductAttributeSchema extends CommercetoolsProductAttributeSchema,
>(
  schema: ProductAttributeSchema,
  operations: readonly AttributeOperation[]
): ProductAttributeBuilder<ProductAttributeSchema> => ({
  set: (name, value) =>
    makeProductAttributeBuilder(schema, [
      ...operations,
      {
        kind: "set",
        name,
        value,
      },
    ]),
  toActions: (options) =>
    decodeAttributeOperations(schema, operations).pipe(
      Effect.map((validatedOperations) =>
        toProductAttributeActions(validatedOperations, options)
      )
    ),
  toDraft: () =>
    decodeAttributeOperations(schema, operations).pipe(
      Effect.map(toDraftAttributes)
    ),
  unset: (name) =>
    makeProductAttributeBuilder(schema, [
      ...operations,
      {
        kind: "unset",
        name,
      },
    ]),
});

const makeVariantAttributeBuilder = <
  VariantAttributeSchema extends CommercetoolsProductAttributeSchema,
>(
  schema: VariantAttributeSchema,
  operations: readonly AttributeOperation[]
): VariantAttributeBuilder<VariantAttributeSchema> => ({
  set: (name, value) =>
    makeVariantAttributeBuilder(schema, [
      ...operations,
      {
        kind: "set",
        name,
        value,
      },
    ]),
  toActions: makeVariantAttributeActionsProjector(schema, operations),
  toDraft: () =>
    decodeAttributeOperations(schema, operations).pipe(
      Effect.map(toDraftAttributes)
    ),
  unset: (name) =>
    makeVariantAttributeBuilder(schema, [
      ...operations,
      {
        kind: "unset",
        name,
      },
    ]),
});

const missingProductAttributeSchema = <
  ProductAttributeSchema,
>(): ProductAttributeBuilder<ProductAttributeSchema> => {
  const error = new Error(
    "Commercetools product attributes require a configured product attribute schema"
  );

  return {
    set: () => missingProductAttributeSchema<ProductAttributeSchema>(),
    toActions: () => Effect.die(error),
    toDraft: () => Effect.die(error),
    unset: () => missingProductAttributeSchema<ProductAttributeSchema>(),
  };
};

const missingVariantAttributeSchema = <
  VariantAttributeSchema,
>(): VariantAttributeBuilder<VariantAttributeSchema> => {
  const error = new Error(
    "Commercetools variant attributes require a configured variant attribute schema"
  );

  return {
    set: () => missingVariantAttributeSchema<VariantAttributeSchema>(),
    toActions: () => Effect.die(error),
    toDraft: () => Effect.die(error),
    unset: () => missingVariantAttributeSchema<VariantAttributeSchema>(),
  };
};

const makeProductAttributesHelper = <
  ProductAttributeSchema extends CommercetoolsProductAttributeSchema,
>(
  schema: ProductAttributeSchema | undefined
): ProductAttributesHelper<ProductAttributeSchema> => ({
  withAttributes: (attributes) => {
    if (schema === undefined) {
      return missingProductAttributeSchema<ProductAttributeSchema>();
    }

    return makeProductAttributeBuilder(
      schema,
      toAttributeOperations<ProductAttributeSchema>(attributes)
    );
  },
});

const makeVariantAttributesHelper = <
  VariantAttributeSchema extends CommercetoolsProductAttributeSchema,
>(
  schema: VariantAttributeSchema | undefined
): VariantAttributesHelper<VariantAttributeSchema> => ({
  withAttributes: (attributes) => {
    if (schema === undefined) {
      return missingVariantAttributeSchema<VariantAttributeSchema>();
    }

    return makeVariantAttributeBuilder(
      schema,
      toAttributeOperations<VariantAttributeSchema>(attributes)
    );
  },
});

export const makeProductHelpers = <
  const ProductTypeConfigRecord extends ProductTypeAttributeConfigRecord,
>(
  productTypes:
    | CommercetoolsProductAttributeSchemasInput<ProductTypeConfigRecord>
    | undefined
): CommercetoolsProductHelpers<ProductTypeConfigRecord> => ({
  attributes: (productTypeKey) =>
    makeVariantAttributesHelper(productTypes?.[productTypeKey]?.attributes),
  productAttributes: (productTypeKey) =>
    makeProductAttributesHelper(
      productTypes?.[productTypeKey]?.productAttributes
    ),
});
