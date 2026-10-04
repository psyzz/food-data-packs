// Publishes the databases built in dist/ to a rolling GitHub release, with one delta
// per country since the previous publication. Needs the gh CLI and the zip/unzip commands.
// Usage: node release.mjs [--dist dist] [--tag db] [--keep-deltas 14]
//
// Release assets:
//   manifest.json                  what clients read first
//   <country>-<stamp>.zip          full database of build <stamp> (<country>.sqlite inside)
//   <country>-<stamp>.delta.zip    changes from the previous build to build <stamp>
// File names never change once published, so a client holding an older manifest can
// still finish its download: the previous full database is only removed one day later.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { buildDelta } from "./diff.mjs";

const args = Object.fromEntries(
	process.argv.slice(2).reduce((pairs, arg, index, list) => {
		if (arg.startsWith("--")) pairs.push([arg.slice(2), list[index + 1]]);
		return pairs;
	}, []),
);
const DIST = args.dist || "dist";
const TAG = args.tag || "db";
// GitHub caps a release at 1000 assets: about 50 packs x (full + deltas) must fit.
const KEEP_DELTAS = Number(args["keep-deltas"] || 14);
const REPO = process.env.GITHUB_REPOSITORY || execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).toString().trim();
const BASE_URL = `https://github.com/${REPO}/releases/download/${TAG}`;
const WORK = `${DIST}/release`;

const gh = (...params) => execFileSync("gh", params, { stdio: ["ignore", "pipe", "inherit"] }).toString();
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const zip = (zipPath, filePath) => {
	rmSync(zipPath, { force: true });
	execFileSync("zip", ["-9", "-j", "-q", zipPath, filePath]);
	return { file: zipPath.split("/").pop(), size: statSync(zipPath).size, sha256: sha256(zipPath) };
};
const readMeta = (path) => {
	const db = new DatabaseSync(path, { readOnly: true });
	const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((row) => [row.key, row.value]));
	db.close();
	return meta;
};
// 2026-10-04T08:12:45.123Z -> 202610040812
const stampOf = (isoDate) => isoDate.replace(/[-:T]/g, "").slice(0, 12);

rmSync(WORK, { recursive: true, force: true });
mkdirSync(`${WORK}/previous`, { recursive: true });

const releaseExists = (() => {
	try {
		gh("release", "view", TAG, "--repo", REPO);
		return true;
	} catch {
		return false;
	}
})();
if (!releaseExists) {
	gh("release", "create", TAG, "--repo", REPO, "--title", "Food data packs", "--notes", "Rolling release, rebuilt every day.", "--latest");
}

let previousManifest = { countries: {} };
try {
	gh("release", "download", TAG, "--repo", REPO, "--pattern", "manifest.json", "--dir", `${WORK}/previous`);
	previousManifest = JSON.parse(readFileSync(`${WORK}/previous/manifest.json`, "utf8"));
} catch {
	console.log("No previous manifest: full databases only.");
}

const manifest = { schema_version: null, generated_at: new Date().toISOString(), base_url: BASE_URL, countries: {} };
const uploads = [];
const removals = [];

for (const sqliteFile of readdirSync(DIST).filter((name) => name.endsWith(".sqlite"))) {
	const country = sqliteFile.replace(".sqlite", "");
	const sqlitePath = `${DIST}/${sqliteFile}`;
	const meta = readMeta(sqlitePath);
	manifest.schema_version = Number(meta.schema_version);
	const previous = previousManifest.countries[country];
	const sameSchema = previous && previous.schema_version === Number(meta.schema_version);
	let deltas = sameSchema ? previous.deltas : [];

	if (sameSchema && previous.built_at !== meta.built_at) {
		gh("release", "download", TAG, "--repo", REPO, "--pattern", previous.full.file, "--dir", `${WORK}/previous`);
		execFileSync("unzip", ["-o", "-q", `${WORK}/previous/${previous.full.file}`, "-d", `${WORK}/previous`]);
		const deltaPath = `${WORK}/${country}-${stampOf(meta.built_at)}.delta.sqlite`;
		const { upserts, deletes } = buildDelta(`${WORK}/previous/${sqliteFile}`, sqlitePath, deltaPath);
		const delta = zip(deltaPath.replace(".sqlite", ".zip"), deltaPath);
		uploads.push(`${WORK}/${delta.file}`);
		deltas = [...previous.deltas, { from: previous.built_at, to: meta.built_at, upserts, deletes, ...delta }];
		const expired = deltas.slice(0, Math.max(deltas.length - KEEP_DELTAS, 0));
		removals.push(...expired.map((entry) => entry.file));
		deltas = deltas.slice(expired.length);
		console.log(`${country}: delta ${upserts} upserts, ${deletes} deletes, ${delta.size} bytes`);
	}

	const full = zip(`${WORK}/${country}-${stampOf(meta.built_at)}.zip`, sqlitePath);
	uploads.push(`${WORK}/${full.file}`);
	if (previous?.retired_full) removals.push(previous.retired_full);
	manifest.countries[country] = {
		built_at: meta.built_at,
		schema_version: Number(meta.schema_version),
		products: Number(meta.products),
		sqlite_size: statSync(sqlitePath).size,
		full,
		deltas,
		retired_full: previous && previous.full.file !== full.file ? previous.full.file : previous?.retired_full,
	};
	console.log(`${country}: ${meta.products} products, full ${full.size} bytes`);
}

// A pack that is no longer built (fell below the minimum size) leaves the release.
Object.entries(previousManifest.countries)
	.filter(([country]) => !manifest.countries[country])
	.forEach(([country, previous]) => {
		removals.push(previous.full.file, ...previous.deltas.map((delta) => delta.file));
		if (previous.retired_full) removals.push(previous.retired_full);
		console.log(`${country}: no longer built, removed from the release`);
	});

// Full databases and deltas first, the manifest last: a client never sees a
// manifest that points to files not uploaded yet.
for (const path of uploads) {
	gh("release", "upload", TAG, path, "--clobber", "--repo", REPO);
}
writeFileSync(`${WORK}/manifest.json`, JSON.stringify(manifest, null, "\t"));
gh("release", "upload", TAG, `${WORK}/manifest.json`, "--clobber", "--repo", REPO);
// A file already gone (manual cleanup, rerun) must not fail the nightly build.
for (const file of new Set(removals)) {
	try {
		gh("release", "delete-asset", TAG, file, "--yes", "--repo", REPO);
	} catch {
		console.log(`${file} was already removed.`);
	}
}
console.log(`Published ${uploads.length} files, removed ${removals.length} expired files.`);
