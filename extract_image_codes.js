const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const BASE_FOLDER = path.join(__dirname, "fabric-images");
const OUTPUT_FILE = path.join(__dirname, "data", "design_code_map.ocr.json");
const TESSERACT_PATH =
  process.env.TESSERACT_PATH || "C:\\Program Files\\Tesseract-OCR\\tesseract.exe";

function getQualityFolders() {
  return fs
    .readdirSync(BASE_FOLDER, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function runTesseract(imagePath) {
  const stdout = execFileSync(
    TESSERACT_PATH,
    [imagePath, "stdout", "--psm", "6"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );

  return stdout;
}

function normalizeCandidate(rawText, quality) {
  const qualityPrefix = quality.toUpperCase();
  const compact = rawText
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, " ")
    .trim();

  const tokens = compact.split(/\s+/).filter(Boolean);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (/^\d{2,4}$/.test(token) && index > 0 && tokens[index - 1] === qualityPrefix) {
      return `${qualityPrefix}_${token.padStart(3, "0")}`;
    }

    if (token.startsWith(qualityPrefix) && /\d/.test(token)) {
      const suffix = token.slice(qualityPrefix.length).replace(/^[^0-9A-Z]+/, "");
      if (suffix) {
        return `${qualityPrefix}_${suffix}`;
      }
    }

    if (token.includes(qualityPrefix) && /\d/.test(token)) {
      const digits = token.replace(/[^0-9A-Z]/g, "").replace(qualityPrefix, "");
      if (digits) {
        return `${qualityPrefix}_${digits}`;
      }
    }
  }

  const fallback = compact.match(/[A-Z]{2,}[ _-]?\d{2,4}/);
  if (fallback) {
    return fallback[0].replace(/[ -]+/g, "_");
  }

  return "";
}

function buildOcrMap() {
  const result = {};

  for (const quality of getQualityFolders()) {
    const qualityUpper = quality.toUpperCase();
    const qualityPath = path.join(BASE_FOLDER, quality);
    const files = fs
      .readdirSync(qualityPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();

    result[qualityUpper] = {};

    for (const fileName of files) {
      const imagePath = path.join(qualityPath, fileName);

      try {
        const rawText = runTesseract(imagePath);
        const suggestedCode = normalizeCandidate(rawText, quality);

        result[qualityUpper][fileName] = {
          suggested_code: suggestedCode || "REVIEW_REQUIRED",
          raw_ocr_text: rawText.trim().slice(0, 200)
        };
      } catch (error) {
        result[qualityUpper][fileName] = {
          suggested_code: "OCR_FAILED",
          raw_ocr_text: error.stderr?.toString?.().trim() || error.message
        };
      }
    }
  }

  return result;
}

function main() {
  if (!fs.existsSync(TESSERACT_PATH)) {
    throw new Error(
      `Tesseract not found at ${TESSERACT_PATH}. Set TESSERACT_PATH or update the script path.`
    );
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  const ocrMap = buildOcrMap();
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(ocrMap, null, 2));
  console.log(`OCR review file written to ${OUTPUT_FILE}`);
}

main();
