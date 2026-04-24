const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BASE_FOLDER = path.join(ROOT, "fabric-images");
const OUTPUT_FILE = path.join(ROOT, "data", "catalog.json");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const SKIP_CODES = new Set(["REVIEW_REQUIRED", "DUPLICATE"]);

function loadReviewRequiredFiles() {
  const dataDir = path.join(ROOT, "data");
  const reviewFiles = new Map();

  if (!fs.existsSync(dataDir)) {
    return reviewFiles;
  }

  for (const filename of fs.readdirSync(dataDir)) {
    if (!/^design_code_map\..*_review\.json$/i.test(filename)) {
      continue;
    }

    const filePath = path.join(dataDir, filename);
    const map = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));

    for (const [quality, entries] of Object.entries(map)) {
      const qualityKey = quality.toUpperCase();
      const skippedFiles = reviewFiles.get(qualityKey) || new Set();

      for (const [sourceFilename, targetName] of Object.entries(entries)) {
        if (SKIP_CODES.has(String(targetName || "").trim().toUpperCase())) {
          skippedFiles.add(sourceFilename.toLowerCase());
        }
      }

      reviewFiles.set(qualityKey, skippedFiles);
    }
  }

  return reviewFiles;
}

function getImageFiles(folderPath) {
  return fs
    .readdirSync(folderPath)
    .filter((filename) => IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase()))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function main() {
  const catalog = { qualities: {} };
  const reviewRequiredFiles = loadReviewRequiredFiles();
  const qualities = fs
    .readdirSync(BASE_FOLDER, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const quality of qualities) {
    const folderPath = path.join(BASE_FOLDER, quality);
    const skippedFiles = reviewRequiredFiles.get(quality.toUpperCase()) || new Set();
    const designs = getImageFiles(folderPath)
      .filter((filename) => !skippedFiles.has(filename.toLowerCase()))
      .map((filename) => {
        const id = path.basename(filename, path.extname(filename)).toUpperCase();

        if (id === "REVIEW_REQUIRED") {
          return null;
        }

        return {
          id,
          name: id,
          image: `https://yourdomain.com/images/${quality.toLowerCase()}/${filename}`,
          stock: 0
        };
      })
      .filter(Boolean);

    catalog.qualities[quality.toUpperCase()] = designs;
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(catalog, null, 2));
  console.log(`Catalog written to ${OUTPUT_FILE}`);
}

main();
