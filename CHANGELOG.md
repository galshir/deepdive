# Changelog

## 0.1.0 — initial MVP

- Multiple saved MySQL connections (passwords in VS Code SecretStorage), connect/disconnect, TLS, read-only mode.
- Offline demo connections ("Acme Shop" and a 1,200-table "Data Lake") backed by SQLite/WebAssembly.
- Interactive bubble canvas: connections → database bubbles → orbiting table nodes → columns, with FK edges.
- Schema diagram with real foreign keys, cardinality, focus mode and large-schema safeguards.
- Data browser with paging, multi-sort, AND/OR filter builder, column chooser, generated SQL and safe editing.
- Visual query builder (joins, aggregates, filters, sorting, grouping) with live SQL preview.
- SQL editor with schema-aware autocomplete, multi-statement runs, cancellation and write confirmation.
- Global metadata search across connections and scoped, cancellable data search.
