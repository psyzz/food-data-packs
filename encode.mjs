// Compact row format (schema 1), about half the size of plain Open Food Facts JSON.
// Clients decode it back to Open Food Facts field names: bump SCHEMA_VERSION in
// build.mjs whenever this format changes.
//
// - Field names are shortened (FIELD_KEYS), product_name_<lc> becomes n_<lc>.
// - Taxonomy tags (PREFIXED_TAGS) lose their "en:" prefix; the rare tag without any
//   prefix is written ":tag" so that it is not given one back when decoded.
// - nutriments becomes "nu": the per-100 g values of NUTRIENTS in order, then
//   energy_value, with null for missing values and trailing nulls dropped.
//   "eu" holds energy_unit when it is not kJ.
// - code is not repeated: it is the primary key of the row.
import { NUTRIENTS } from "./pick.mjs";

export const FIELD_KEYS = {
	product_name: "n",
	brands: "b",
	quantity: "q",
	serving_size: "ss",
	serving_quantity: "sq",
	front_image: "fi",
	ingredients_image: "ii",
	nutrition_image: "ni",
	compared_to_category: "cc",
	nutriscore_grade: "g",
	nutriscore_score: "s",
	nutriscore_data: "nd",
	nova_group: "nv",
	ingredients_n: "in",
	additives_tags: "a",
	ingredients_analysis_tags: "ia",
	labels_tags: "l",
	categories_tags: "c",
	allergens_tags: "al",
	traces_tags: "t",
	stores_tags: "st",
};

const PREFIXED_TAGS = [
	"additives_tags",
	"ingredients_analysis_tags",
	"labels_tags",
	"categories_tags",
	"allergens_tags",
	"traces_tags",
];

const stripPrefix = (tags) =>
	tags.map((tag) => (tag.startsWith("en:") ? tag.slice(3) : tag.includes(":") ? tag : `:${tag}`));

export const encodeProduct = (product) => {
	const encoded = {};
	Object.entries(product).forEach(([field, value]) => {
		if (field === "code") {
			return;
		}
		if (field === "nutriments") {
			const values = [...NUTRIENTS.map((name) => value[`${name}_100g`] ?? null), value.energy_value ?? null];
			while (values.length > 0 && values[values.length - 1] === null) {
				values.pop();
			}
			if (values.length > 0) {
				encoded.nu = values;
			}
			if (value.energy_unit && value.energy_unit !== "kJ") {
				encoded.eu = value.energy_unit;
			}
			return;
		}
		if (field.startsWith("product_name_")) {
			encoded[`n_${field.slice("product_name_".length)}`] = value;
			return;
		}
		const key = FIELD_KEYS[field];
		if (!key) {
			throw new Error(`No compact key for field ${field}`);
		}
		encoded[key] = PREFIXED_TAGS.includes(field) ? stripPrefix(value) : value;
	});
	return encoded;
};
