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
// Candidate packs: ISO 3166 code -> Open Food Facts country tag. A pack is only
// published when it holds at least MIN_PRODUCTS products, so countries join on their
// own as Open Food Facts grows.
export const COUNTRIES = {
	fr: "en:france",
	be: "en:belgium",
	ch: "en:switzerland",
	lu: "en:luxembourg",
	de: "en:germany",
	at: "en:austria",
	nl: "en:netherlands",
	es: "en:spain",
	pt: "en:portugal",
	it: "en:italy",
	gb: "en:united-kingdom",
	ie: "en:ireland",
	pl: "en:poland",
	cz: "en:czech-republic",
	sk: "en:slovakia",
	hu: "en:hungary",
	ro: "en:romania",
	bg: "en:bulgaria",
	gr: "en:greece",
	hr: "en:croatia",
	si: "en:slovenia",
	rs: "en:serbia",
	se: "en:sweden",
	dk: "en:denmark",
	no: "en:norway",
	fi: "en:finland",
	us: "en:united-states",
	ca: "en:canada",
	mx: "en:mexico",
	br: "en:brazil",
	ar: "en:argentina",
	co: "en:colombia",
	cl: "en:chile",
	au: "en:australia",
	nz: "en:new-zealand",
	ma: "en:morocco",
	dz: "en:algeria",
	tn: "en:tunisia",
	sn: "en:senegal",
	ci: "en:cote-d-ivoire",
	re: "en:reunion",
	gp: "en:guadeloupe",
	mq: "en:martinique",
	gf: "en:french-guiana",
	yt: "en:mayotte",
	nc: "en:new-caledonia",
	pf: "en:french-polynesia",
	tr: "en:turkey",
	il: "en:israel",
	ae: "en:united-arab-emirates",
	sa: "en:saudi-arabia",
	in: "en:india",
	th: "en:thailand",
	jp: "en:japan",
	za: "en:south-africa",
};
export const MIN_PRODUCTS = Number(process.env.MIN_PRODUCTS || 3000);
// Products of every other country, and of the candidates below MIN_PRODUCTS, are
// gathered in this pack so that small countries are covered too.
export const OTHER_PACK = "world";

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
// The "other countries" pack only makes sense in a full build (no --countries filter).
const withOtherPack = !args.countries || countries.includes(OTHER_PACK);
const candidates = countries.filter((country) => country !== OTHER_PACK);
const databases = Object.fromEntries(candidates.map((country) => [country, openDatabase(country)]));
const otherPack = withOtherPack ? openDatabase(OTHER_PACK) : null;
const tagToCountry = Object.fromEntries(candidates.map((country) => [COUNTRIES[country], country]));
const candidateTags = new Set(Object.values(COUNTRIES));

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
	const tags = product.countries_tags || [];
	const targets = tags.map((tag) => tagToCountry[tag]).filter(Boolean);
	// Sold in a country that is not a candidate ("en:world" included).
	const toOtherPack = otherPack !== null && tags.some((tag) => !candidateTags.has(tag));
	if (targets.length === 0 && !toOtherPack) continue;
	const data = JSON.stringify(encodeProduct(pickProduct(product)));
	const ingredients = pickIngredients(product);
	const ingredientsJson = Object.keys(ingredients).length ? JSON.stringify(ingredients) : null;
	targets.forEach((country) => {
		const target = databases[country];
		target.insert.run(product.code, data, ingredientsJson);
		target.count++;
	});
	if (toOtherPack) {
		otherPack.insert.run(product.code, data, ingredientsJson);
	}
}

// Candidates below MIN_PRODUCTS are not published on their own: their products join
// the "other countries" pack.
Object.entries(databases)
	.filter(([, { count }]) => count < MIN_PRODUCTS)
	.forEach(([country, { db, path, count }]) => {
		db.exec("COMMIT;");
		db.close();
		if (otherPack) {
			otherPack.db.exec("COMMIT;");
			otherPack.db.prepare("ATTACH DATABASE ? AS small").run(path);
			otherPack.db.exec("INSERT OR IGNORE INTO products SELECT * FROM small.products; DETACH DATABASE small; BEGIN;");
		}
		rmSync(path, { force: true });
		delete databases[country];
		console.log(`${country}: ${count} products, below ${MIN_PRODUCTS}${otherPack ? `, merged into ${OTHER_PACK}` : ", skipped"}`);
	});
if (otherPack) {
	otherPack.count = otherPack.db.prepare("SELECT count(*) AS n FROM products").get().n;
	databases[OTHER_PACK] = otherPack;
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
