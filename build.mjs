// Builds one offline SQLite database per country from the Open Food Facts JSONL export.
// Usage: node build.mjs [--countries fr,be] [--input local.jsonl.gz] [--limit N] [--out dist]
import { createReadStream, mkdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { encodeProduct } from "./encode.mjs";
import { hasName, pickIngredients, pickProduct } from "./pick.mjs";

export const SCHEMA_VERSION = 1;
export const EXPORT_URL = "https://openfoodfacts-ds.s3.eu-west-3.amazonaws.com/openfoodfacts-products.jsonl.gz";
export const COUNTRIES = {
	fr: "en:france",
	be: "en:belgium",
	ch: "en:switzerland",
	lu: "en:luxembourg",
	at: "en:austria",
	es: "en:spain",
	it: "en:italy",
	de: "en:germany",
	gb: "en:united-kingdom",
	us: "en:united-states",
};

const args = Object.fromEntries(
	process.argv.slice(2).reduce((pairs, arg, index, list) => {
		if (arg.startsWith("--")) pairs.push([arg.slice(2), list[index + 1]]);
		return pairs;
	}, [])
);
const countries = (args.countries || Object.keys(COUNTRIES).join(",")).split(",");
const limit = Number(args.limit || Infinity);
const outDir = args.out || "dist";

const openSource = async () => {
	if (args.input) {
		return createReadStream(args.input).pipe(createGunzip());
	}
	const response = await fetch(EXPORT_URL);
	if (!response.ok) {
		throw new Error(`Export download failed: HTTP ${response.status}`);
	}
	return { stream: Readable.fromWeb(response.body).pipe(createGunzip()), lastModified: response.headers.get("last-modified") };
};

const openDatabase = (country) => {
	const path = `${outDir}/${country}.sqlite`;
	rmSync(path, { force: true });
	const db = new DatabaseSync(path);
	db.exec(`
		PRAGMA journal_mode = OFF;
		PRAGMA synchronous = OFF;
		PRAGMA page_size = 4096;
		-- A rowid table: rows are too large for WITHOUT ROWID to stay compact.
		CREATE TABLE products (code TEXT PRIMARY KEY, data TEXT NOT NULL, ingredients TEXT);
		CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		BEGIN;
	`);
	return { db, path, insert: db.prepare("INSERT OR REPLACE INTO products VALUES (?, ?, ?)"), count: 0 };
};

mkdirSync(outDir, { recursive: true });
const source = await openSource();
const input = source.stream || source;
const databases = Object.fromEntries(countries.map((country) => [country, openDatabase(country)]));
const tagToCountry = Object.fromEntries(countries.map((country) => [COUNTRIES[country], country]));

const startedAt = Date.now();
let lines = 0;
for await (const line of createInterface({ input, crlfDelay: Infinity })) {
	if (++lines > limit) break;
	if (lines % 250000 === 0) {
		console.error(`${lines} products read, ${Math.round((Date.now() - startedAt) / 1000)}s`);
	}
	let product;
	try {
		product = JSON.parse(line);
	} catch {
		continue;
	}
	if (!product.code || !hasName(product) || product.obsolete) continue;
	const targets = (product.countries_tags || []).map((tag) => tagToCountry[tag]).filter(Boolean);
	if (targets.length === 0) continue;
	const data = JSON.stringify(encodeProduct(pickProduct(product)));
	const ingredients = pickIngredients(product);
	const ingredientsJson = Object.keys(ingredients).length ? JSON.stringify(ingredients) : null;
	targets.forEach((country) => {
		const target = databases[country];
		target.insert.run(product.code, data, ingredientsJson);
		target.count++;
	});
}

const builtAt = new Date().toISOString();
Object.entries(databases).forEach(([country, { db, count }]) => {
	const setMeta = db.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)");
	setMeta.run("country", country);
	setMeta.run("schema_version", String(SCHEMA_VERSION));
	setMeta.run("built_at", builtAt);
	setMeta.run("source_last_modified", source.lastModified || "");
	setMeta.run("products", String(count));
	db.exec("COMMIT; VACUUM;");
	db.close();
	console.log(`${country}: ${count} products`);
});
console.log(`Done: ${lines} lines in ${Math.round((Date.now() - startedAt) / 1000)}s`);
