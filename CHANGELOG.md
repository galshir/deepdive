# Changelog

## 0.3.0

- Schema compare: a new *Compare* tab that compares two databases (same or different servers, e.g. QA vs Staging) and reports missing and differing tables, columns, indexes and foreign keys, with options to ignore column order, comments, MySQL version differences and letter case.
- Server-level compare: match databases of two connections by name, compare every pair, and list databases that exist on one side only.
- Sync scripts: generate the CREATE/ALTER statements that bring the target in line with the source (MySQL), open them in the SQL editor or run them on the target after confirmation.

## 0.2.0

- Saved queries: name, describe and tag SQL from the editor (Cmd/Ctrl+Shift+S), optionally tied to a connection and database; load, insert or run them from the new **Queries** panel.
- Persistent query history with outcome, duration and row count, searchable and filterable per connection (`deepdive.history.*` settings).
- Run on multiple databases: run one script on many databases of a connection, pick targets by name pattern or table/column presence, skip failing databases, and get a report with grouped errors, partial-apply detection, retry of failed databases and continue-from-failed-statement for partial ones (`deepdive.multiRun.*` settings).
- SQL editor errors now carry the server error code (e.g. `ER_DUP_FIELDNAME`).

## 0.1.0 — initial MVP

- Multiple saved MySQL connections (passwords in VS Code SecretStorage), connect/disconnect, TLS, read-only mode.
- Offline demo connections ("Acme Shop" and a 1,200-table "Data Lake") backed by SQLite/WebAssembly.
- Interactive bubble canvas: connections → database bubbles → orbiting table nodes → columns, with FK edges.
- Schema diagram with real foreign keys, cardinality, focus mode and large-schema safeguards.
- Data browser with paging, multi-sort, AND/OR filter builder, column chooser, generated SQL and safe editing.
- Visual query builder (joins, aggregates, filters, sorting, grouping) with live SQL preview.
- SQL editor with schema-aware autocomplete, multi-statement runs, cancellation and write confirmation.
- Global metadata search across connections and scoped, cancellable data search.
