// Reduces a full Open Food Facts product to the fields the client reads offline.
// Rows keep Open Food Facts field names and shapes (encoded compactly by encode.mjs);
// the client rebuilds a few derived fields when decoding:
//   id                    = code
//   nutrition_grades      = nutriscore_grade
//   image_front_url       <- front_image ("<lang>.<rev>") and the code
//   <nutrient>_serving    <- <nutrient>_100g * serving_quantity / 100
//   energy_serving        <- energy_value * serving_quantity / 100 (kJ only)
// Fields that only make sense online (alternatives, other images, knowledge panels)
// are left out: the client refetches the full product when the network is back.

export const LOCALES = ["fr", "en", "es", "it", "de"];

// Tags the client reads: product score inputs and key facts.
const KEPT_LABELS = [
	"en:organic",
	"en:eu-organic",
	"fr:ab-agriculture-biologique",
	"en:ab-agriculture-biologique",
	"en:vegan",
	"en:vegetarian",
	"en:gluten-free",
	"en:halal",
	"en:kosher",
	"en:palm-oil-free",
];
const KEPT_ANALYSIS_TAGS = ["en:palm-oil", "en:may-contain-palm-oil", "en:palm-oil-free", "en:vegan", "en:vegetarian"];
const FOOD_LIKE_CATEGORIES = [
	"en:soups",
	"en:cold-soups",
	"en:gazpacho",
	"en:vegetable-soups",
	"en:creams",
	"en:cooking-creams",
	"en:plant-based-creams-for-cooking",
	"en:coconut-milks-and-creams",
	"en:coconut-creams",
];
// Rows of the client's nutrition table.
export const NUTRIENTS = [
	"fat",
	"saturated-fat",
	"carbohydrates",
	"sugars",
	"fiber",
	"proteins",
	"salt",
	"sodium",
	"iron",
	"calcium",
	"magnesium",
	"vitamin-c",
	"vitamin-e",
	"vitamin-pp",
	"vitamin-b1",
	"vitamin-b6",
	"vitamin-b9",
];
const NUTRISCORE_COMPONENTS = [
	"energy",
	"sugars",
	"saturated_fat",
	"salt",
	"proteins",
	"fiber",
	"fruits_vegetables_legumes",
];

const UNIT_TO_GRAMS = { g: 1, mg: 1e-3, "µg": 1e-6, mcg: 1e-6 };
const round = (value) => Number(value.toPrecision(4));
const toNumber = (value) => {
	const number = Number(value);
	return value === null || value === undefined || value === "" || !Number.isFinite(number) ? undefined : number;
};

const isEmpty = (value) =>
	value === undefined ||
	value === null ||
	value === "" ||
	(Array.isArray(value) && value.length === 0) ||
	(typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);

const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => !isEmpty(value)));

// Products saved with schema 1003+ keep their values in nutrition.aggregated_set and
// an empty "nutriments" map in the export (the API converts them on the fly).
// Returns per-100 g values in grams, and the energy as typed (value, unit) per 100 g.
const nutrition100g = (product) => {
	const legacy = product.nutriments || {};
	if (Object.keys(legacy).some((key) => key.endsWith("_100g"))) {
		return { values: legacy, energy: { value: legacy.energy_value, unit: legacy.energy_unit } };
	}
	const set = product.nutrition?.aggregated_set;
	const servingQuantity = toNumber(product.serving_quantity);
	const per100g = set?.per === "serving" ? (servingQuantity > 0 ? 100 / servingQuantity : null) : 1;
	if (!set?.nutrients || set.preparation !== "as_sold" || per100g === null) {
		return { values: {}, energy: {} };
	}
	const values = {};
	Object.entries(set.nutrients).forEach(([name, nutrient]) => {
		const value = nutrient.value ?? nutrient.value_computed;
		// Values estimated from the ingredients are not served by the API either.
		if (typeof value === "number" && nutrient.source !== "estimate") {
			values[`${name}_100g`] = value * (UNIT_TO_GRAMS[nutrient.unit] ?? 1) * per100g;
		}
	});
	const energy = set.nutrients.energy || {};
	return {
		values,
		energy: { value: typeof energy.value === "number" ? energy.value * per100g : undefined, unit: energy.unit },
	};
};

const pickNutriments = (product) => {
	const { values, energy } = nutrition100g(product);
	const picked = {};
	NUTRIENTS.forEach((name) => {
		const value = toNumber(values[`${name}_100g`]);
		if (value !== undefined) {
			picked[`${name}_100g`] = round(value);
		}
	});
	const energyValue = toNumber(energy.value);
	if (energyValue !== undefined && energy.unit) {
		picked.energy_value = round(energyValue);
		picked.energy_unit = energy.unit;
	}
	return picked;
};

const pickNutriscoreData = (product, foodLikeCategories) => {
	const data = product.nutriscore_data;
	if (!data) {
		return undefined;
	}
	const picked = {
		// Usually equal to nutriscore_score / nutriscore_grade: only kept when they differ.
		score: data.score !== toNumber(product.nutriscore_score) ? data.score : undefined,
		grade: data.grade !== product.nutriscore_grade ? data.grade : undefined,
		is_beverage: data.is_beverage || undefined,
		is_water: data.is_water || undefined,
		is_fat_oil_nuts_seeds: data.is_fat_oil_nuts_seeds || undefined,
	};
	// Components are only read to re-score foods misfiled as beverages.
	if (data.is_beverage === 1 && foodLikeCategories.length > 0 && data.components) {
		picked.components = Object.fromEntries(
			Object.entries(data.components).map(([part, components]) => [
				part,
				components
					.filter((component) => NUTRISCORE_COMPONENTS.includes(component.id))
					.map(({ id, value }) => ({ id, value })),
			]),
		);
	}
	return compact(picked);
};

// Front image as "<lang>.<rev>" (a few bytes instead of a 90-byte URL).
const pickFrontImage = (product) => {
	const selected = product.images?.selected?.front;
	const languages = selected
		? Object.keys(selected).filter((lang) => selected[lang]?.rev)
		: Object.keys(product.images || {})
				.filter((key) => key.startsWith("front_") && product.images[key]?.rev)
				.map((key) => key.slice("front_".length));
	if (languages.length === 0) {
		return undefined;
	}
	// Same choice as the world API: English first, then the product language.
	const lang = languages.includes("en") ? "en" : languages.includes(product.lang) ? product.lang : languages[0];
	const rev = selected ? selected[lang].rev : product.images[`front_${lang}`].rev;
	return `${lang}.${rev}`;
};

const hasIngredients = (product) =>
	toNumber(product.ingredients_n) > 0 ||
	Boolean(product.ingredients_text || LOCALES.some((locale) => product[`ingredients_text_${locale}`]));

export const hasName = (product) =>
	Boolean(product.product_name || LOCALES.some((locale) => product[`product_name_${locale}`]));

export const pickProduct = (product) => {
	const foodLikeCategories = (product.categories_tags || []).filter((tag) => FOOD_LIKE_CATEGORIES.includes(tag));
	const picked = compact({
		code: product.code,
		product_name: product.product_name,
		brands: product.brands,
		quantity: product.quantity,
		serving_size: product.serving_size,
		serving_quantity: product.serving_size ? toNumber(product.serving_quantity) : undefined,
		front_image: pickFrontImage(product),
		nutriscore_grade: product.nutriscore_grade,
		nutriscore_score: toNumber(product.nutriscore_score),
		nutriscore_data: pickNutriscoreData(product, foodLikeCategories),
		nova_group: toNumber(product.nova_group),
		ingredients_n: toNumber(product.ingredients_n),
		ingredients_analysis_tags: (product.ingredients_analysis_tags || []).filter((tag) =>
			KEPT_ANALYSIS_TAGS.includes(tag),
		),
		labels_tags: (product.labels_tags || []).filter((tag) => KEPT_LABELS.includes(tag)),
		categories_tags: foodLikeCategories,
		allergens_tags: product.allergens_tags,
		traces_tags: product.traces_tags,
		// The API serves the store names as typed ("Magasins U"), the export only has slugs.
		stores_tags: product.stores
			? product.stores.split(",").map((store) => store.trim()).filter(Boolean)
			: product.stores_tags,
		nutriments: pickNutriments(product),
	});
	// An empty list means "no additive" for the score, so it must survive compact()
	// whenever the ingredients are known.
	if (Array.isArray(product.additives_tags) && (product.additives_tags.length > 0 || hasIngredients(product))) {
		picked.additives_tags = product.additives_tags;
	}
	LOCALES.forEach((locale) => {
		const name = product[`product_name_${locale}`];
		if (name && name !== product.product_name) {
			picked[`product_name_${locale}`] = name;
		}
	});
	return picked;
};

// Ingredients text is the heaviest field: stored in its own column.
export const pickIngredients = (product) => {
	const picked = { ingredients_text: product.ingredients_text };
	LOCALES.forEach((locale) => {
		const text = product[`ingredients_text_${locale}`];
		if (text && text !== product.ingredients_text) {
			picked[`ingredients_text_${locale}`] = text;
		}
	});
	return compact(picked);
};
