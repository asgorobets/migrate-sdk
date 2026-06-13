import type {
  BusinessUnit,
  Customer,
  Product,
} from "@commercetools/platform-sdk";
import { Schema } from "effect";

export const CommercetoolsSourceCursor = Schema.Struct({
  lastId: Schema.String,
});

export type CommercetoolsSourceCursor = typeof CommercetoolsSourceCursor.Type;

export const isRecord = (
  value: unknown
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const sourceResourceSchema = <Resource>(
  identifier: string,
  isResource: (value: unknown) => value is Resource
) => Schema.declare<Resource>(isResource, { identifier });

const isProductSourceResource = (value: unknown): value is Product =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.version === "number" &&
  (value.key === undefined || typeof value.key === "string") &&
  isRecord(value.productType) &&
  isRecord(value.masterData);

export const ProductSourceSchema = sourceResourceSchema<Product>(
  "CommercetoolsProduct",
  isProductSourceResource
);

const isCustomerSourceResource = (value: unknown): value is Customer =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.version === "number" &&
  (value.key === undefined || typeof value.key === "string") &&
  typeof value.email === "string";

export const CustomerSourceSchema = sourceResourceSchema<Customer>(
  "CommercetoolsCustomer",
  isCustomerSourceResource
);

const isBusinessUnitSourceResource = (value: unknown): value is BusinessUnit =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.version === "number" &&
  typeof value.key === "string" &&
  typeof value.name === "string" &&
  typeof value.unitType === "string";

export const BusinessUnitSourceSchema = sourceResourceSchema<BusinessUnit>(
  "CommercetoolsBusinessUnit",
  isBusinessUnitSourceResource
);
