import { fileURLToPath } from "node:url";
import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { Effect, Layer, Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecution,
  type MigrationRunSummary,
  type MigrationStore,
  SourceIdentity,
} from "migrate-sdk";
import {
  type DocumentFetcherPlatform,
  DocumentFetchers,
  DocumentParsers,
  DocumentSource,
} from "migrate-sdk/sources/document";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { completedInlineExecution } from "../inline-execution.ts";

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

type BusinessUnitEntryFields = typeof BusinessUnitEntryFields.Type;
type ContactEntryFields = typeof ContactEntryFields.Type;
type AddressEntryFields = typeof AddressEntryFields.Type;

interface RecordedEntry<Fields> {
  readonly fields: Fields;
  readonly sourceIdentity: string;
}

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

interface MigrationOptions<Entry> {
  readonly filePath?: string | undefined;
  readonly platform?: DocumentFetcherPlatform | undefined;
  readonly recordEntry?: (entry: Entry) => void;
  readonly store?: Layer.Layer<MigrationStore> | undefined;
}

export const makeBusinessUnitsMigration = (
  options: MigrationOptions<RecordedEntry<BusinessUnitEntryFields>> = {}
) => {
  return MigrationDefinition.make({
    id: "companies-business-units",
    process: (source) => {
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

      options.recordEntry?.({
        fields: {
          billingCity: billingAddress?.city ?? null,
          key: businessUnit.key,
          name: businessUnit.name,
          primaryContactEmail: primaryContact?.email ?? null,
          shippingCity: shippingAddress?.city ?? null,
          status: businessUnit.status,
        },
        sourceIdentity: source.identity.encoded,
      });
    },
    source: DocumentSource.make({
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
  options: MigrationOptions<RecordedEntry<ContactEntryFields>> = {}
) => {
  return MigrationDefinition.make({
    id: "companies-contacts",
    process: (source) => {
      const businessUnit = source.item.parent;
      const contact = source.item.item;

      options.recordEntry?.({
        fields: {
          businessUnitKey: businessUnit.key,
          businessUnitName: businessUnit.name,
          businessUnitStatus: businessUnit.status,
          email: contact.email,
          firstName: contact.firstName,
          isPrimary: contact.isPrimary,
          key: contact.key,
          lastName: contact.lastName,
          role: contact.role,
        },
        sourceIdentity: source.identity.encoded,
      });
    },
    source: DocumentSource.make({
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
  options: MigrationOptions<RecordedEntry<AddressEntryFields>> = {}
) => {
  return MigrationDefinition.make({
    id: "companies-addresses",
    process: (source) => {
      const businessUnit = source.item.parent;
      const address = source.item.item;

      options.recordEntry?.({
        fields: {
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
        },
        sourceIdentity: source.identity.encoded,
      });
    },
    source: DocumentSource.make({
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

export interface CompaniesDocumentSourceExampleResult {
  readonly addressEntries: readonly RecordedEntry<AddressEntryFields>[];
  readonly businessUnitEntries: readonly RecordedEntry<BusinessUnitEntryFields>[];
  readonly contactEntries: readonly RecordedEntry<ContactEntryFields>[];
  readonly summary: MigrationRunSummary;
}

export const runCompaniesDocumentSourceExample = Effect.fn(
  "runCompaniesDocumentSourceExample"
)(function* (options?: {
  readonly filePath?: string;
  readonly platform?: DocumentFetcherPlatform;
}) {
  const store = InMemoryMigrationStore.layer();
  const addressEntries: RecordedEntry<AddressEntryFields>[] = [];
  const businessUnitEntries: RecordedEntry<BusinessUnitEntryFields>[] = [];
  const contactEntries: RecordedEntry<ContactEntryFields>[] = [];
  const businessUnits = makeBusinessUnitsMigration({
    filePath: options?.filePath,
    platform: options?.platform,
    recordEntry: (entry) => {
      businessUnitEntries.push(entry);
    },
    store,
  });
  const contacts = makeContactsMigration({
    filePath: options?.filePath,
    platform: options?.platform,
    recordEntry: (entry) => {
      contactEntries.push(entry);
    },
    store,
  });
  const addresses = makeAddressesMigration({
    filePath: options?.filePath,
    platform: options?.platform,
    recordEntry: (entry) => {
      addressEntries.push(entry);
    },
    store,
  });
  const registry = MigrationDefinitionRegistry.make({
    definitions: [businessUnits, contacts, addresses] as const,
  });
  const execution = MigrationExecution.make({ registry });
  const summary = yield* completedInlineExecution(execution.run({ all: true }));

  return {
    addressEntries,
    businessUnitEntries,
    contactEntries,
    summary,
  } satisfies CompaniesDocumentSourceExampleResult;
});

export const formatCompaniesDocumentSourceExampleResult = (
  result: CompaniesDocumentSourceExampleResult
): string =>
  [
    "Companies Document Source Example",
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
