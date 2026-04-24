const fs = require("fs");
const os = require("os");
const path = require("path");
const { PDFParse } = require("pdf-parse");

const DOWNLOADS_DIR = path.join(os.homedir(), "Downloads");
const CATALOG_PATH = path.join(__dirname, "data", "catalog.json");
const REPORT_PATH = path.join(__dirname, "data", "stock_import_report.json");

function resolvePdfInputs(catalog) {
  const pdfInputs = {};

  for (const quality of Object.keys(catalog.qualities || {})) {
    const qualityPrefix = quality.toLowerCase();
    const matchedFile = fs
      .readdirSync(DOWNLOADS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
      .map((entry) => entry.name)
      .find((fileName) => fileName.toLowerCase().startsWith(qualityPrefix));

    if (matchedFile) {
      pdfInputs[quality] = path.join(DOWNLOADS_DIR, matchedFile);
    }
  }

  return pdfInputs;
}

function normalizeDesignNumber(value, quality) {
  const numericValue = String(value || "").trim();

  if (!/^\d{1,5}$/.test(numericValue)) {
    return null;
  }

  return numericValue.padStart(quality === "UKRAINE" ? 3 : numericValue.length, "0");
}

function parseDesignSummaries(text, quality) {
  const summaries = new Map();
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  let currentDesign = null;

  for (const line of lines) {
    const fields = line.split(/\t+/).map((part) => part.trim()).filter(Boolean);

    if (/^\d{1,5}$/.test(line)) {
      currentDesign = normalizeDesignNumber(line, quality);
      continue;
    }

    if (fields.length >= 9) {
      const designNumber = normalizeDesignNumber(fields[6], quality);
      const meters = Number.parseFloat(fields[8]);
      const color = fields[5];

      if (!designNumber || Number.isNaN(meters) || !color) {
        continue;
      }

      const designId = `${quality}_${designNumber}`;
      const summary = summaries.get(designId) || {
        total: 0,
        color_stock: {}
      };

      summary.total += meters;
      summary.color_stock[color] = (summary.color_stock[color] || 0) + meters;
      summaries.set(designId, summary);
      continue;
    }

    if (!line.startsWith("Design Wise Total")) {
      continue;
    }

    const match = line.match(/([0-9]+(?:\.[0-9]+)?)\s*$/);
    if (!match || !currentDesign) {
      continue;
    }

    const designId = `${quality}_${currentDesign}`;
    const summary = summaries.get(designId) || {
      total: 0,
      color_stock: {}
    };

    summary.total = Number.parseFloat(match[1]);
    summaries.set(designId, summary);
    currentDesign = null;
  }

  for (const summary of summaries.values()) {
    for (const [color, stock] of Object.entries(summary.color_stock)) {
      summary.color_stock[color] = Number.parseFloat(stock.toFixed(2));
    }

    summary.colors = Object.keys(summary.color_stock).sort();
  }

  return summaries;
}

async function extractPdfSummaries(filePath, quality) {
  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  const result = await parser.getText();
  await parser.destroy();
  return parseDesignSummaries(result.text, quality);
}

function formatList(values) {
  return values.length ? values.join(", ") : "none";
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
  const parsedSummaries = new Map();
  const pdfInputs = resolvePdfInputs(catalog);
  const missingPdfFiles = Object.keys(catalog.qualities || {}).filter((quality) => !pdfInputs[quality]);

  for (const [quality, filePath] of Object.entries(pdfInputs)) {
    const summaries = await extractPdfSummaries(filePath, quality);

    for (const [designId, summary] of summaries.entries()) {
      parsedSummaries.set(designId, summary);
    }
  }

  const missingFromPdfs = [];

  for (const designs of Object.values(catalog.qualities)) {
    for (const design of designs) {
      if (parsedSummaries.has(design.id)) {
        const summary = parsedSummaries.get(design.id);
        design.stock = summary.total;
        design.colors = summary.colors;
        design.color_stock = summary.color_stock;
      } else {
        design.stock = null;
        design.colors = [];
        design.color_stock = {};
        missingFromPdfs.push(design.id);
      }
    }
  }

  const catalogIds = new Set(
    Object.values(catalog.qualities).flatMap((designs) => designs.map((design) => design.id))
  );
  const missingFromCatalog = [...parsedSummaries.keys()].filter((designId) => !catalogIds.has(designId));

  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        parsed_totals: parsedSummaries.size,
        pdf_files_found: pdfInputs,
        qualities_missing_pdf_files: missingPdfFiles,
        catalog_ids_missing_from_pdfs: missingFromPdfs,
        pdf_ids_missing_from_catalog: missingFromCatalog
      },
      null,
      2
    )
  );

  console.log(`Updated stock in ${CATALOG_PATH}`);
  console.log(`Wrote import report to ${REPORT_PATH}`);
  console.log(`Parsed totals: ${parsedSummaries.size}`);
  console.log(`Qualities missing PDF files: ${formatList(missingPdfFiles)}`);
  console.log(`Catalog IDs missing from PDFs: ${formatList(missingFromPdfs)}`);
  console.log(`PDF IDs missing from catalog: ${formatList(missingFromCatalog)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
