# Destination Command Groups

We will model destination plugin authoring around three levels: destination plugin definitions, destination command groups, and destination command definitions. This refines ADR-0001's decision to use destination-specific commands by adding the grouping layer needed for multi-entity destinations while preserving a flat authoring path for simple plugins.

## Status

Accepted

## Considered Options

- Keep destination plugins as one flat set of command definitions.
- Split each destination entity into a separate destination plugin.
- Add destination command groups inside one destination plugin definition.
- Require every plugin to expose grouped command factories.
- Support top-level command groups for simple or intentionally flat plugin surfaces.

## Decision

Destination plugin definitions are the destination-level container. They own shared destination configuration, command groups, command definitions, and the Effect services or layers used by their handlers.

Destination command groups are the entity or module-level container inside a plugin. They organize related command definitions such as Contentful entries and assets, or commerce products, inventory, prices, and product selections.

Destination command definitions remain the operation-level unit. They define one command `kind`, one schema, whether the command is identity-bearing, and any destination-owned command factories.

Command `kind` values must be unique across the full destination plugin definition. The runner decodes destination commands through the plugin's combined command schema and dispatches execution by decoded `kind`, so groups organize authoring and handler registration but do not create separate runtime dispatch domains.

Named command groups expose factories under `commands.<group>`. Top-level command groups expose their factories directly under `commands`. Directly adding commands to a plugin remains root-level sugar for simple plugins.

Destination plugin handlers follow the same shape. Top-level commands are implemented with `handlers.handle(...)`; named group commands are implemented with `handlers.group("group", ...)`. Every command in the plugin definition must have exactly one handler before the plugin can be used as a runtime destination plugin service.

## Consequences

- Simple destination plugins can keep a compact public surface such as `destination.commands.upsertEntry(...)`.
- Multi-entity destination plugins can avoid one large flat command namespace by grouping commands by destination concept.
- Destination plugins can share one configuration and one service layer across multiple command groups.
- Plugin authors can organize large provider integrations without splitting shared configuration across many destination plugins.
- TypeScript inference must preserve command factory shape across root commands, top-level groups, and named groups.
- The runtime still validates one combined command schema and one complete handler set for the whole destination plugin.
- Future provider plugin packages should use groups as the default scaling mechanism before introducing multiple destination plugins for the same provider.
