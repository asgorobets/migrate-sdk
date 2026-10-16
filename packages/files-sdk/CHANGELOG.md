# @migrate-sdk/files-sdk

## 0.17.0

### Minor Changes

- 1800ebc: Add first-party Files SDK file and folder Document Fetchers for DocumentSource,
  a Source for migrating files, journaled Destination helpers and file transfers,
  and a JSON-record Migration Store with explicitly disclosed non-atomic locks.
  Introduce DocumentParsers.each(parser) for array-valued fetched resources, usable
  with Files SDK and custom Effect Document Fetchers.
