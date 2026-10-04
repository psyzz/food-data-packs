// Builds a delta database between two builds of the same country.
// Usage: node diff.mjs <previous.sqlite> <current.sqlite> <delta.sqlite>
// The delta holds the products to upsert and the codes to delete; the client applies
// it in one transaction when its base matches the delta's "from" build.
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const buildDelta = (previousPath, currentPath, deltaPath) => {
	rmSync(deltaPath, { force: true });
	const db = new DatabaseSync(deltaPath);
	db.exec(`ATTACH '${previousPath}' AS previous; ATTACH '${currentPath}' AS current;`);

	const readMeta = (schema) =>
		Object.fromEntries(
			db
				.prepare(`SELECT key, value FROM ${schema}.meta`)
				.all()
				.map((row) => [row.key, row.value]),
		);
	const previousMeta = readMeta("previous");
	const currentMeta = readMeta("current");
	if (previousMeta.schema_version !== currentMeta.schema_version) {
		throw new Error("Schema versions differ: clients must download the full database instead of a delta.");
	}

	db.exec(`
	PRAGMA journal_mode = OFF;
	CREATE TABLE upserts (code TEXT PRIMARY KEY, data TEXT NOT NULL, ingredients TEXT) WITHOUT ROWID;
	CREATE TABLE deletes (code TEXT PRIMARY KEY) WITHOUT ROWID;
	CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	BEGIN;
	INSERT INTO upserts
		SELECT c.code, c.data, c.ingredients FROM current.products c
		LEFT JOIN previous.products p ON p.code = c.code
		WHERE p.code IS NULL OR p.data IS NOT c.data OR p.ingredients IS NOT c.ingredients;
	INSERT INTO deletes
		SELECT p.code FROM previous.products p
		LEFT JOIN current.products c ON c.code = p.code
		WHERE c.code IS NULL;
`);

	const setMeta = db.prepare("INSERT INTO meta VALUES (?, ?)");
	const upserts = db.prepare("SELECT count(*) AS n FROM upserts").get().n;
	const deletes = db.prepare("SELECT count(*) AS n FROM deletes").get().n;
	setMeta.run("country", currentMeta.country);
	setMeta.run("schema_version", currentMeta.schema_version);
	setMeta.run("from_built_at", previousMeta.built_at);
	setMeta.run("to_built_at", currentMeta.built_at);
	setMeta.run("upserts", String(upserts));
	setMeta.run("deletes", String(deletes));
	db.exec("COMMIT; DETACH previous; DETACH current; VACUUM;");
	db.close();
	return { upserts, deletes };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [previousPath, currentPath, deltaPath] = process.argv.slice(2);
	if (!deltaPath) {
		console.error("Usage: node diff.mjs <previous.sqlite> <current.sqlite> <delta.sqlite>");
		process.exit(1);
	}
	const { upserts, deletes } = buildDelta(previousPath, currentPath, deltaPath);
	console.log(`${upserts} upserts, ${deletes} deletes`);
}
