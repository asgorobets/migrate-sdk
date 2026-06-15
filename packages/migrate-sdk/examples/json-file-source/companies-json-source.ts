import { fileURLToPath } from "node:url";
import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { Effect, Layer, Schema } from "effect";
import {
  defineMigration,
  type MigrationRunSummary,
  type MigrationStore,
  runMigrations,
  SourceIdentity,
} from "migrate-sdk";
import {
  type InMemoryDestinationEntry,
  InMemoryDestinationTesting,
} from "migrate-sdk/destinations/in-memory/testing";
import {
  type DocumentFetcherPlatform,
  DocumentFetchers,
  DocumentParsers,
  DocumentSourcePlugin,
} from "migrate-sdk/sources/document";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";

const NullableString = Schema.NullOr(Schema.String);

const Contact = Schema.Struct({
  email: Schema.String,
  firstName: Schema.String,
  isPrimary: Schema.Boolean,
  key: Schema.String,
  lastName: Schema.String,
  role: NullableString,
});

const Address = Schema.Struct({
  city: Schema.String,
  country: Schema.String,
  key: Schema.String,
  postalCode: Schema.String,
  region: Schema.String,
  street: Schema.String,
  type: Schema.Literals(["billing", "shipping"]),
});

const BusinessUnit = Schema.Struct({
  addresses: Schema.Array(Address),
  contacts: Schema.Array(Contact),
  key: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["active", "inactive"]),
});

export const CompaniesDocument = Schema.Struct({
  businessUnits: Schema.Array(BusinessUnit),
  exportedAt: Schema.String,
});

const BusinessUnitEntryFields = Schema.Struct({
  billingCity: NullableString,
  key: Schema.String,
  name: Schema.String,
  primaryContactEmail: NullableString,
  shippingCity: NullableString,
  status: Schema.Literals(["active", "inactive"]),
});

const ContactEntryFields = Schema.Struct({
  businessUnitKey: Schema.String,
  businessUnitName: Schema.String,
  businessUnitStatus: Schema.Literals(["active", "inactive"]),
  email: Schema.String,
  firstName: Schema.String,
  isPrimary: Schema.Boolean,
  key: Schema.String,
  lastName: Schema.String,
  role: NullableString,
});

const AddressEntryFields = Schema.Struct({
  businessUnitKey: Schema.String,
  businessUnitName: Schema.String,
  businessUnitStatus: Schema.Literals(["active", "inactive"]),
  city: Schema.String,
  country: Schema.String,
  key: Schema.String,
  postalCode: Schema.String,
  region: Schema.String,
  street: Schema.String,
  type: Schema.Literals(["billing", "shipping"]),
});

const nodePlatformLayer = Layer.mergeAll(nodeFileSystemLayer, nodePathLayer);

const defaultFilePath = () =>
  fileURLToPath(new URL("./companies.json", import.meta.url));

const companiesDocumentParser = DocumentParsers.json(CompaniesDocument);

const tuple2 = <A, B>(first: A, second: B): readonly [A, B] => [first, second];

const BusinessUnitSourceIdentity = {
  id: "companies-business-unit@v1",
  schema: SourceIdentity.key("businessUnitKey", Schema.NonEmptyString),
};

const ContactSourceIdentity = {
  id: "companies-contact@v1",
  schema: SourceIdentity.tuple([
    SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
    SourceIdentity.part("contactKey", Schema.NonEmptyString),
  ]),
};

const AddressSourceIdentity = {
  id: "companies-address@v1",
  schema: SourceIdentity.tuple([
    SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
    SourceIdentity.part("addressKey", Schema.NonEmptyString),
  ]),
};

const makeCompaniesDocumentFetcher = (options: {
  readonly filePath?: string | undefined;
  readonly platform?: DocumentFetcherPlatform | undefined;
}) =>
  DocumentFetchers.fileText({
    path: options.filePath ?? defaultFilePath(),
    platform: options.platform ?? nodePlatformLayer,
  });

const makeBusinessUnitDestination = () =>
  InMemoryDestinationTesting.fixtureEntries({
    contentType: "business-unit",
    commands: {
      upsertEntry: { fields: BusinessUnitEntryFields },
    },
  });

const makeContactDestination = () =>
  InMemoryDestinationTesting.fixtureEntries({
    contentType: "contact",
    commands: {
      upsertEntry: { fields: ContactEntryFields },
    },
  });

const makeAddressDestination = () =>
  InMemoryDestinationTesting.fixtureEntries({
    contentType: "address",
    commands: {
      upsertEntry: { fields: AddressEntryFields },
    },
  });

interface MigrationOptions<Destination> {
  readonly destination?: Destination | undefined;
  readonly filePath?: string | undefined;
  readonly platform?: DocumentFetcherPlatform | undefined;
  readonly store?: Layer.Layer<MigrationStore> | undefined;
}

export const makeBusinessUnitsMigration = (
  options: MigrationOptions<
    ReturnType<typeof makeBusinessUnitDestination>["destination"]
  > = {}
) => {
  const destination =
    options.destination ?? makeBusinessUnitDestination().destination;

  return defineMigration({
    destination,
    id: "companies-business-units",
    pipeline: (source) => {
      const businessUnit = source.item.item;
      const billingAddress = businessUnit.addresses.find(
        (address) => address.type === "billing"
      );
      const shippingAddress = businessUnit.addresses.find(
        (address) => address.type === "shipping"
      );
      const primaryContact = businessUnit.contacts.find(
        (contact) => contact.isPrimary
      );

      return destination.commands.upsertEntry({
        billingCity: billingAddress?.city ?? null,
        key: businessUnit.key,
        name: businessUnit.name,
        primaryContactEmail: primaryContact?.email ?? null,
        shippingCity: shippingAddress?.city ?? null,
        status: businessUnit.status,
      });
    },
    source: DocumentSourcePlugin.make({
      fetcher: makeCompaniesDocumentFetcher(options),
      parser: companiesDocumentParser,
      selector: {
        item: (document) => document.businessUnits,
      },
      identity: {
        ...BusinessUnitSourceIdentity,
        key: ({ item }) => item.key,
      },
      lookup: { kind: "scan" },
      version: { kind: "content-hash" },
    }),
    store: options.store ?? InMemoryMigrationStore.layer(),
  });
};

export const makeContactsMigration = (
  options: MigrationOptions<
    ReturnType<typeof makeContactDestination>["destination"]
  > = {}
) => {
  const destination =
    options.destination ?? makeContactDestination().destination;

  return defineMigration({
    destination,
    id: "companies-contacts",
    pipeline: (source) => {
      const businessUnit = source.item.parent;
      const contact = source.item.item;

      return destination.commands.upsertEntry({
        businessUnitKey: businessUnit.key,
        businessUnitName: businessUnit.name,
        businessUnitStatus: businessUnit.status,
        email: contact.email,
        firstName: contact.firstName,
        isPrimary: contact.isPrimary,
        key: contact.key,
        lastName: contact.lastName,
        role: contact.role,
      });
    },
    source: DocumentSourcePlugin.make({
      fetcher: makeCompaniesDocumentFetcher(options),
      parser: companiesDocumentParser,
      selector: {
        parent: (document) => document.businessUnits,
        item: (businessUnit) => businessUnit.contacts,
      },
      identity: {
        ...ContactSourceIdentity,
        key: ({ item, parent }) => tuple2(parent.key, item.key),
      },
      lookup: { kind: "scan" },
      version: { kind: "content-hash" },
    }),
    store: options.store ?? InMemoryMigrationStore.layer(),
  });
};

export const makeAddressesMigration = (
  options: MigrationOptions<
    ReturnType<typeof makeAddressDestination>["destination"]
  > = {}
) => {
  const destination =
    options.destination ?? makeAddressDestination().destination;

  return defineMigration({
    destination,
    id: "companies-addresses",
    pipeline: (source) => {
      const businessUnit = source.item.parent;
      const address = source.item.item;

      return destination.commands.upsertEntry({
        businessUnitKey: businessUnit.key,
        businessUnitName: businessUnit.name,
        businessUnitStatus: businessUnit.status,
        city: address.city,
        country: address.country,
        key: address.key,
        postalCode: address.postalCode,
        region: address.region,
        street: address.street,
        type: address.type,
      });
    },
    source: DocumentSourcePlugin.make({
      fetcher: makeCompaniesDocumentFetcher(options),
      parser: companiesDocumentParser,
      selector: {
        parent: (document) => document.businessUnits,
        item: (businessUnit) => businessUnit.addresses,
      },
      identity: {
        ...AddressSourceIdentity,
        key: ({ item, parent }) => tuple2(parent.key, item.key),
      },
      lookup: { kind: "scan" },
      version: { kind: "content-hash" },
    }),
    store: options.store ?? InMemoryMigrationStore.layer(),
  });
};

export interface CompaniesJsonSourceExampleResult {
  readonly addressEntries: readonly InMemoryDestinationEntry[];
  readonly businessUnitEntries: readonly InMemoryDestinationEntry[];
  readonly contactEntries: readonly InMemoryDestinationEntry[];
  readonly summary: MigrationRunSummary;
}

export const runCompaniesJsonSourceExample = Effect.fn(
  "runCompaniesJsonSourceExample"
)(function* (options?: {
  readonly filePath?: string;
  readonly platform?: DocumentFetcherPlatform;
}) {
  const store = InMemoryMigrationStore.layer();
  const addressDestination = makeAddressDestination();
  const businessUnitDestination = makeBusinessUnitDestination();
  const contactDestination = makeContactDestination();
  const businessUnits = makeBusinessUnitsMigration({
    destination: businessUnitDestination.destination,
    filePath: options?.filePath,
    platform: options?.platform,
    store,
  });
  const contacts = makeContactsMigration({
    destination: contactDestination.destination,
    filePath: options?.filePath,
    platform: options?.platform,
    store,
  });
  const addresses = makeAddressesMigration({
    destination: addressDestination.destination,
    filePath: options?.filePath,
    platform: options?.platform,
    store,
  });
  const summary = yield* runMigrations({
    definitions: [businessUnits, contacts, addresses],
  });

  return {
    addressEntries: Array.from(addressDestination.entries().values()),
    businessUnitEntries: Array.from(businessUnitDestination.entries().values()),
    contactEntries: Array.from(contactDestination.entries().values()),
    summary,
  } satisfies CompaniesJsonSourceExampleResult;
});

export const formatCompaniesJsonSourceExampleResult = (
  result: CompaniesJsonSourceExampleResult
): string =>
  [
    "Companies JSON Source Example",
    `status: ${result.summary.status}`,
    `businessUnitEntries: ${result.businessUnitEntries.length}`,
    ...result.businessUnitEntries.map(
      (entry) => `  ${entry.sourceIdentity}: ${JSON.stringify(entry.fields)}`
    ),
    `contactEntries: ${result.contactEntries.length}`,
    ...result.contactEntries.map(
      (entry) => `  ${entry.sourceIdentity}: ${JSON.stringify(entry.fields)}`
    ),
    `addressEntries: ${result.addressEntries.length}`,
    ...result.addressEntries.map(
      (entry) => `  ${entry.sourceIdentity}: ${JSON.stringify(entry.fields)}`
    ),
  ].join("\n");
