# Food data packs

Daily offline packs of food products, one SQLite database per country, built from the
[Open Food Facts](https://world.openfoodfacts.org) export.

| Script | Role |
| --- | --- |
| `build.mjs` | Streams the Open Food Facts JSONL export and writes `dist/<country>.sqlite` |
| `pick.mjs` | Keeps the few fields a client needs per product |
| `encode.mjs` | Compact row format (schema 1) |
| `diff.mjs` | Changes between two builds: products to upsert, codes to delete |
| `release.mjs` | Publishes databases, deltas and `manifest.json` to the `db` release |

The GitHub Actions workflow runs every day and can be started by hand (`workflow_dispatch`).

## Files

Everything is attached to the rolling `db` release:
`https://github.com/<owner>/food-data-packs/releases/download/db/<file>`

- `manifest.json`: per country, the current build (`built_at`, `products`, `sqlite_size`),
  the full database (`full.file`, `size`, `sha256`) and the deltas of the last 30 builds
  (`from`, `to`, `file`, `size`, `sha256`, `upserts`, `deletes`).
- `<country>-<stamp>.zip`: full database of one build.
- `<country>-<stamp>.delta.zip`: changes from the previous build to build `<stamp>`.

File names never change once published. A client whose database was built at `from`
applies the deltas in order; when no chain reaches the current build, or when
`schema_version` changes, it downloads the full database again.

## Database layout

- `products(code TEXT PRIMARY KEY, data TEXT, ingredients TEXT)`
  - `data`: compact JSON, see `encode.mjs` (short field names, nutrients as an array).
  - `ingredients`: JSON with the ingredient lists (`ingredients_text`, `ingredients_text_<lc>`).
- `meta(key, value)`: `country`, `schema_version`, `built_at`, `source_last_modified`, `products`.
- Deltas: `upserts` (same columns as `products`), `deletes(code)` and `meta`
  with `from_built_at` and `to_built_at`.

## License

The data comes from Open Food Facts and is available under the
[Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/);
individual contents are under the
[Database Contents License](https://opendatacommons.org/licenses/dbcl/1-0/).
Product images are not included. Any use must credit Open Food Facts and keep
derived databases under the ODbL.
