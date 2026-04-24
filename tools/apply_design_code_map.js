const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BASE_FOLDER = path.join(ROOT, "fabric-images");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const SKIP_CODES = new Set(["REVIEW_REQUIRED", "DUPLICATE"]);
const mappingPath = path.resolve(ROOT, process.argv[2] || "data/design_code_map.json");

function normalizeFolderName(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function getQualityFolder(quality) {
  const normalized = normalizeFolderName(quality);
  const match = fs
    .readdirSync(BASE_FOLDER, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .find((entry) => normalizeFolderName(entry.name) === normalized);

  if (!match) {
    throw new Error(`Quality folder not found for ${quality}`);
  }

  return path.join(BASE_FOLDER, match.name);
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function renameFromMapping(mapping) {
  const operations = [];
  const targetPaths = new Set();
  const pendingRenames = [];

  for (const [quality, rows] of Object.entries(mapping)) {
    const folderPath = getQualityFolder(quality);

    for (const [oldName, rawCode] of Object.entries(rows)) {
      const code = normalizeCode(rawCode);

      if (!code || SKIP_CODES.has(code)) {
        operations.push({ status: "skipped_review", quality, oldName });
        continue;
      }

      const extension = path.extname(oldName).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) {
        operations.push({ status: "skipped_extension", quality, oldName });
        continue;
      }

      const oldPath = path.join(folderPath, oldName);
      const targetName = `${code}${extension}`;
      const targetPath = path.join(folderPath, targetName);
      const targetKey = targetPath.toUpperCase();

      if (targetPaths.has(targetKey)) {
        throw new Error(`Duplicate target in mapping: ${targetPath}`);
      }
      targetPaths.add(targetKey);

      if (oldPath.toUpperCase() === targetPath.toUpperCase()) {
        operations.push({ status: "already_named", quality, oldName, targetName });
        continue;
      }

      if (!fileExists(oldPath)) {
        if (fileExists(targetPath)) {
          operations.push({ status: "already_renamed", quality, oldName, targetName });
          continue;
        }

        throw new Error(`Missing source file: ${oldPath}`);
      }

      pendingRenames.push({ quality, oldName, oldPath, targetName, targetPath });
    }
  }

  const sourcePaths = new Set(pendingRenames.map((operation) => operation.oldPath.toUpperCase()));

  for (const operation of pendingRenames) {
    if (fileExists(operation.targetPath) && !sourcePaths.has(operation.targetPath.toUpperCase())) {
      throw new Error(`Target already exists: ${operation.targetPath}`);
    }
  }

  const stagedRenames = pendingRenames.map((operation, index) => {
    const tempPath = path.join(
      path.dirname(operation.oldPath),
      `.rename_tmp_${Date.now()}_${index}${path.extname(operation.oldPath).toLowerCase()}`
    );

    fs.renameSync(operation.oldPath, tempPath);
    return { ...operation, tempPath };
  });

  for (const operation of stagedRenames) {
    fs.renameSync(operation.tempPath, operation.targetPath);
    operations.push({
      status: "renamed",
      quality: operation.quality,
      oldName: operation.oldName,
      targetName: operation.targetName
    });
  }

  return operations;
}

function main() {
  const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
  const operations = renameFromMapping(mapping);

  for (const operation of operations) {
    if (operation.status === "renamed") {
      console.log(`Renamed ${operation.quality}: ${operation.oldName} -> ${operation.targetName}`);
    } else if (operation.status === "skipped_review") {
      console.log(`Skipped ${operation.quality}: ${operation.oldName} marked REVIEW_REQUIRED`);
    } else {
      console.log(`${operation.status} ${operation.quality}: ${operation.oldName}`);
    }
  }
}

main();
