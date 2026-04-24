const fs = require("fs");
const path = require("path");

const CATALOG_PATH = path.join(__dirname, "data", "catalog.json");
const UPDATES_PATH = path.join(__dirname, "data", "daily_updates.json");
const REPORT_PATH = path.join(__dirname, "data", "daily_updates_report.json");

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getDesignIndex(catalog) {
  const index = new Map();

  for (const [quality, designs] of Object.entries(catalog.qualities || {})) {
    for (const design of designs) {
      index.set(design.id.toUpperCase(), { quality, design });
    }
  }

  return index;
}

function ensureArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

function normalizeStockUpdates(rawUpdates) {
  return ensureArray(rawUpdates).map((entry) => {
    const designId = String(entry.design_id || entry.id || "").trim().toUpperCase();
    const stock = Number(entry.stock);

    return {
      designId,
      stock,
      hideFromCatalog:
        typeof entry.hide_from_catalog === "boolean" ? entry.hide_from_catalog : undefined
    };
  });
}

function main() {
  if (!fs.existsSync(UPDATES_PATH)) {
    throw new Error(`Missing updates file: ${UPDATES_PATH}`);
  }

  const catalog = loadJson(CATALOG_PATH);
  const updates = loadJson(UPDATES_PATH);
  const designIndex = getDesignIndex(catalog);

  const outOfStockDesigns = ensureArray(updates.out_of_stock_designs).map((designId) =>
    String(designId).trim().toUpperCase()
  );
  const stockUpdates = normalizeStockUpdates(updates.stock_updates);

  const report = {
    generated_at: new Date().toISOString(),
    source_file: UPDATES_PATH,
    out_of_stock_hidden: [],
    stock_updated: [],
    missing_design_ids: []
  };

  for (const designId of outOfStockDesigns) {
    const found = designIndex.get(designId);

    if (!found) {
      report.missing_design_ids.push(designId);
      continue;
    }

    found.design.hidden_from_catalog = true;
    report.out_of_stock_hidden.push(designId);
  }

  for (const update of stockUpdates) {
    if (!update.designId || Number.isNaN(update.stock)) {
      continue;
    }

    const found = designIndex.get(update.designId);

    if (!found) {
      report.missing_design_ids.push(update.designId);
      continue;
    }

    found.design.stock = update.stock;

    if (typeof update.hideFromCatalog === "boolean") {
      found.design.hidden_from_catalog = update.hideFromCatalog;
    } else if (update.stock > 0) {
      found.design.hidden_from_catalog = false;
    }

    report.stock_updated.push({
      design_id: update.designId,
      stock: update.stock,
      hidden_from_catalog: Boolean(found.design.hidden_from_catalog)
    });
  }

  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`Applied daily updates from ${UPDATES_PATH}`);
  console.log(`Updated catalog: ${CATALOG_PATH}`);
  console.log(`Wrote report: ${REPORT_PATH}`);
  console.log(`Out-of-stock hidden: ${report.out_of_stock_hidden.length}`);
  console.log(`Stock updated: ${report.stock_updated.length}`);
  console.log(`Missing design IDs: ${report.missing_design_ids.length}`);
}

main();
