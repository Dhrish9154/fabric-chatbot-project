const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { createWorker } = require("tesseract.js");

const ROOT = path.join(__dirname, "..");
const BASE_FOLDER = path.join(ROOT, "fabric-images");
const OUTPUT_JSON = path.join(ROOT, "data", "design_code_map.preview.json");
const OUTPUT_REVIEW = path.join(ROOT, "data", "ocr_review_required.json");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const args = process.argv.slice(2);
const selectedQuality = getArgValue("--quality");
const selectedQualities = (getArgValue("--qualities") || "")
  .split(",")
  .map((quality) => normalizeQuality(quality))
  .filter(Boolean);
const imageLimit = Number.parseInt(getArgValue("--limit") || "", 10);
const minDigits = Number.parseInt(process.env.OCR_MIN_DIGITS || "3", 10);
const numberPattern = `\\d{${Number.isNaN(minDigits) ? 4 : minDigits},6}`;

const DEFAULT_LOGO_WORDS = [
  "TIANSO",
  "GLOBAL",
  "FABRIC",
  "FABRICS",
  "TEXTILE",
  "TEXTILES",
  "DESIGN",
  "CATALOG",
  "CATALOGUE",
  "QUALITY",
  "PREMIUM",
  "COLLECTION",
  "WHATSAPP",
  "IMAGE"
];

const EXTRA_IGNORE_WORDS = (process.env.OCR_IGNORE_WORDS || "")
  .split(",")
  .map((word) => word.trim().toUpperCase())
  .filter(Boolean);

const IGNORE_WORDS = new Set([...DEFAULT_LOGO_WORDS, ...EXTRA_IGNORE_WORDS]);

function normalizeQuality(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
}

function normalizeCodeName(quality, number) {
  return `${normalizeQuality(quality)}_${number}`;
}

function cleanOcrText(text) {
  let cleaned = String(text || "").toUpperCase();

  for (const word of IGNORE_WORDS) {
    cleaned = cleaned.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, "g"), " ");
  }

  return cleaned
    .replace(/[|()[\]{}:;'",.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildCandidatePatterns(quality) {
  const normalizedQuality = normalizeQuality(quality);
  const looseQuality = normalizedQuality.split("").join("[\\s._-]*");

  return [
    new RegExp(`\\b(${looseQuality})[\\s._-]*(${numberPattern})\\b`, "i"),
    new RegExp(`\\b([A-Z]{2,20})[\\s._-]+(${numberPattern})\\b`, "i"),
    new RegExp(`\\b(${numberPattern})\\b`)
  ];
}

function extractCandidate(text, quality) {
  const cleaned = cleanOcrText(text);
  const patterns = buildCandidatePatterns(quality);

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);

    if (!match) {
      continue;
    }

    const number = match[2] || match[1];
    const word = match[2] ? normalizeQuality(match[1]) : normalizeQuality(quality);
    const score = match[2] && word === normalizeQuality(quality) ? 100 : match[2] ? 60 : 50;

    return {
      code: normalizeCodeName(word || quality, number),
      cleaned,
      score
    };
  }

  return {
    code: null,
    cleaned,
    score: 0
  };
}

function getImageFiles(folderPath) {
  return fs
    .readdirSync(folderPath)
    .filter((filename) => IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase()))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function getQualityFolders() {
  const folders = fs
    .readdirSync(BASE_FOLDER, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (selectedQualities.length) {
    return folders.filter((folder) => selectedQualities.includes(normalizeQuality(folder)));
  }

  if (!selectedQuality) {
    return folders;
  }

  const normalizedSelection = normalizeQuality(selectedQuality);
  return folders.filter((folder) => normalizeQuality(folder) === normalizedSelection);
}

function getArgValue(name) {
  const match = args.find((arg) => arg === name || arg.startsWith(`${name}=`));

  if (!match) {
    return null;
  }

  if (match.includes("=")) {
    return match.split("=").slice(1).join("=");
  }

  const index = args.indexOf(match);
  return args[index + 1] || null;
}

function makeRegions(width, height) {
  return [
    {
      name: "top_right",
      left: Math.floor(width * 0.52),
      top: 0,
      width: width - Math.floor(width * 0.52),
      height: Math.floor(height * 0.3)
    },
    {
      name: "top",
      left: 0,
      top: 0,
      width,
      height: Math.floor(height * 0.25)
    },
    {
      name: "bottom",
      left: 0,
      top: Math.floor(height * 0.68),
      width,
      height: height - Math.floor(height * 0.68)
    },
    {
      name: "full",
      left: 0,
      top: 0,
      width,
      height
    }
  ];
}

async function recognizeRegion(worker, imagePath, region) {
  const buffer = await sharp(imagePath)
    .extract(region)
    .grayscale()
    .normalise()
    .sharpen()
    .resize({ width: Math.min(region.width * 2, 2400), withoutEnlargement: false })
    .png()
    .toBuffer();

  const result = await worker.recognize(buffer);
  return result.data.text || "";
}

async function detectCode(worker, imagePath, quality) {
  const metadata = await sharp(imagePath).metadata();
  const regions = makeRegions(metadata.width, metadata.height);
  const attempts = [];

  for (const region of regions) {
    const text = await recognizeRegion(worker, imagePath, region);
    const candidate = extractCandidate(text, quality);

    attempts.push({
      region: region.name,
      text: candidate.cleaned,
      code: candidate.code,
      score: candidate.score
    });

    if (candidate.code && candidate.score >= 100) {
      break;
    }
  }

  const best = attempts
    .filter((attempt) => attempt.code)
    .sort((left, right) => right.score - left.score)[0];

  return {
    code: best?.code || null,
    attempts
  };
}

function buildSafeMapping(results) {
  const mapping = {};
  const review = [];

  for (const [quality, rows] of Object.entries(results)) {
    mapping[quality] = {};
    const seenCodes = new Set();

    for (const row of rows) {
      if (!row.code || row.score < 90 || seenCodes.has(row.code)) {
        review.push(row);
        continue;
      }

      seenCodes.add(row.code);
      mapping[quality][row.filename] = row.code;
    }
  }

  return { mapping, review };
}

async function main() {
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });

  const worker = await createWorker("eng");
  const results = {};

  for (const quality of getQualityFolders()) {
    const folderPath = path.join(BASE_FOLDER, quality);
    const files = Number.isNaN(imageLimit)
      ? getImageFiles(folderPath)
      : getImageFiles(folderPath).slice(0, imageLimit);

    results[quality] = [];
    console.log(`Scanning ${quality}: ${files.length} image(s)`);

    for (const filename of files) {
      const imagePath = path.join(folderPath, filename);
      const detected = await detectCode(worker, imagePath, quality);

      results[quality].push({
        quality,
        filename,
        code: detected.code,
        score: Math.max(0, ...detected.attempts.map((attempt) => attempt.score)),
        attempts: detected.attempts
      });

      console.log(`  ${filename} -> ${detected.code || "REVIEW_REQUIRED"}`);
    }
  }

  await worker.terminate();

  const { mapping, review } = buildSafeMapping(results);
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(mapping, null, 2));
  fs.writeFileSync(OUTPUT_REVIEW, JSON.stringify(review, null, 2));

  console.log(`Preview mapping written to ${OUTPUT_JSON}`);
  console.log(`Review list written to ${OUTPUT_REVIEW}`);
  console.log("No files were renamed. After review, copy the preview to data/design_code_map.json and run rename_images.py.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
