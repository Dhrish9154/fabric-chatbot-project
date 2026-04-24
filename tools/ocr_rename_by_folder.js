const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { createWorker } = require("tesseract.js");

const ROOT = path.join(__dirname, "..");
const BASE_FOLDER = path.join(ROOT, "fabric-images");
const DATA_FOLDER = path.join(ROOT, "data");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const args = process.argv.slice(2);

const selectedQualities = (getArgValue("--qualities") || "")
  .split(",")
  .map((quality) => normalizeQuality(quality))
  .filter(Boolean);
const maxMinutes = Number.parseFloat(getArgValue("--max-minutes") || "20");
const applyRenames = args.includes("--apply");
const minScore = Number.parseInt(getArgValue("--min-score") || "90", 10);
const startedAt = Date.now();
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputJson = path.join(DATA_FOLDER, `ocr_folder_rename_${runStamp}.json`);
const outputCsv = path.join(DATA_FOLDER, `ocr_folder_rename_${runStamp}.csv`);

const IGNORE_WORDS = new Set([
  "TIANSO",
  "GLOBAL",
  "WARP",
  "WARPS",
  "WRAP",
  "WRAPS",
  "FOR",
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
]);

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

function normalizeQuality(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanOcrText(text) {
  let cleaned = String(text || "").toUpperCase();

  for (const word of IGNORE_WORDS) {
    cleaned = cleaned.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, "g"), " ");
  }

  return cleaned
    .replace(/[|()[\]{}:;'",]/g, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getQualityFolders() {
  const folders = fs
    .readdirSync(BASE_FOLDER, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const folderPath = path.join(BASE_FOLDER, entry.name);
      const imageCount = getImageFiles(folderPath).length;
      return { name: entry.name, imageCount };
    })
    .sort((left, right) => left.imageCount - right.imageCount || left.name.localeCompare(right.name));

  if (!selectedQualities.length) {
    return folders;
  }

  return folders.filter((folder) => selectedQualities.includes(normalizeQuality(folder.name)));
}

function getImageFiles(folderPath) {
  return fs
    .readdirSync(folderPath)
    .filter((filename) => IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase()))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function makeRegions(width, height) {
  return [
    {
      name: "top_right",
      left: Math.floor(width * 0.48),
      top: 0,
      width: width - Math.floor(width * 0.48),
      height: Math.floor(height * 0.35)
    },
    {
      name: "bottom",
      left: 0,
      top: Math.floor(height * 0.68),
      width,
      height: height - Math.floor(height * 0.68)
    }
  ];
}

async function recognizeRegion(worker, imagePath, region) {
  const base = sharp(imagePath)
    .extract(region)
    .grayscale()
    .normalise()
    .sharpen()
    .resize({ width: Math.min(region.width * 3, 2600), withoutEnlargement: false });

  const buffer = await base.png().toBuffer();
  const result = await worker.recognize(buffer);
  return result.data.text || "";
}

function extractCandidate(text, quality) {
  const cleaned = cleanOcrText(text);
  const normalizedQuality = normalizeQuality(quality);
  const looseQuality = normalizedQuality.split("").join("[\\s._-]*");
  const patterns = [
    { pattern: new RegExp(`\\b${looseQuality}\\s*(?:T\\s*[-:]?\\s*)?(\\d{2,6})\\b`, "i"), score: 100 },
    { pattern: /\bT\s*[-:]?\s*(\d{2,6})\b/i, score: 90 },
    { pattern: /\b(\d{3,6})\b/i, score: 75 }
  ];

  for (const { pattern, score } of patterns) {
    const match = cleaned.match(pattern);

    if (match) {
      return {
        code: `${normalizedQuality}_${match[1]}`,
        cleaned,
        score
      };
    }
  }

  return {
    code: null,
    cleaned,
    score: 0
  };
}

async function detectCode(worker, imagePath, quality) {
  const metadata = await sharp(imagePath).metadata();
  const attempts = [];

  for (const region of makeRegions(metadata.width, metadata.height)) {
    const text = await recognizeRegion(worker, imagePath, region);
    const candidate = extractCandidate(text, quality);

    attempts.push({
      region: region.name,
      text: candidate.cleaned,
      code: candidate.code,
      score: candidate.score
    });

    if (candidate.score >= 100) {
      break;
    }
  }

  const best = attempts
    .filter((attempt) => attempt.code)
    .sort((left, right) => right.score - left.score)[0];

  return {
    code: best?.code || null,
    score: best?.score || 0,
    attempts
  };
}

function timeLimitReached() {
  return Date.now() - startedAt >= maxMinutes * 60 * 1000;
}

function buildRenamePlan(folderPath, rows) {
  const safeRows = rows.filter((row) => row.code && row.score >= minScore);
  const seenCodes = new Set();
  const duplicates = new Set();

  for (const row of safeRows) {
    if (seenCodes.has(row.code)) {
      duplicates.add(row.code);
    }
    seenCodes.add(row.code);
  }

  return safeRows
    .filter((row) => !duplicates.has(row.code))
    .map((row, index) => {
      const extension = path.extname(row.filename).toLowerCase();
      const targetName = `${row.code}${extension}`;

      return {
        ...row,
        targetName,
        oldPath: path.join(folderPath, row.filename),
        tempName: `.__ocr_tmp__${runStamp}_${index}${extension}`,
        tempPath: path.join(folderPath, `.__ocr_tmp__${runStamp}_${index}${extension}`),
        newPath: path.join(folderPath, targetName)
      };
    });
}

function applyRenamePlan(plan) {
  for (const row of plan) {
    const targetIsPlannedSource = plan.some((other) => other.oldPath === row.newPath);

    if (fs.existsSync(row.newPath) && row.oldPath !== row.newPath && !targetIsPlannedSource) {
      row.status = "skipped_target_exists";
      continue;
    }

    row.status = row.oldPath === row.newPath ? "already_named" : "planned";
  }

  const actionable = plan.filter((row) => row.status === "planned");

  for (const row of actionable) {
    fs.renameSync(row.oldPath, row.tempPath);
  }

  for (const row of actionable) {
    fs.renameSync(row.tempPath, row.newPath);
    row.status = "renamed";
  }
}

function writeOutputs(results) {
  fs.mkdirSync(DATA_FOLDER, { recursive: true });
  fs.writeFileSync(outputJson, JSON.stringify(results, null, 2));

  const csvRows = ["folder,filename,code,score,status,targetName,bestText"];
  for (const row of results.rows) {
    csvRows.push([
      row.folder,
      row.filename,
      row.code || "",
      row.score,
      row.status || "",
      row.targetName || "",
      (row.attempts || []).map((attempt) => `${attempt.region}: ${attempt.text}`).join(" | ")
    ].map(csvEscape).join(","));
  }
  fs.writeFileSync(outputCsv, `${csvRows.join("\n")}\n`);
}

function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

async function main() {
  const worker = await createWorker("eng");
  const results = {
    apply: applyRenames,
    minScore,
    maxMinutes,
    startedAt: new Date(startedAt).toISOString(),
    rows: []
  };

  try {
    for (const folder of getQualityFolders()) {
      if (timeLimitReached()) {
        console.log("Time limit reached before starting next folder.");
        break;
      }

      const folderPath = path.join(BASE_FOLDER, folder.name);
      const files = getImageFiles(folderPath);
      const folderRows = [];

      console.log(`Scanning ${folder.name}: ${files.length} image(s)`);

      for (const filename of files) {
        if (timeLimitReached()) {
          console.log("Time limit reached during folder; stopping cleanly.");
          break;
        }

        const detected = await detectCode(worker, path.join(folderPath, filename), folder.name);
        const row = {
          folder: folder.name,
          filename,
          code: detected.code,
          score: detected.score,
          status: detected.code && detected.score >= minScore ? "detected" : "review_required",
          attempts: detected.attempts
        };

        folderRows.push(row);
        results.rows.push(row);
        console.log(`  ${filename} -> ${detected.code || "REVIEW_REQUIRED"} (${detected.score})`);
      }

      const plan = buildRenamePlan(folderPath, folderRows);
      const byFilename = new Map(folderRows.map((row) => [row.filename, row]));

      for (const planned of plan) {
        Object.assign(byFilename.get(planned.filename), {
          targetName: planned.targetName,
          oldPath: planned.oldPath,
          tempName: planned.tempName,
          tempPath: planned.tempPath,
          newPath: planned.newPath
        });
      }

      if (applyRenames) {
        applyRenamePlan(plan);
      }

      for (const planned of plan) {
        const row = byFilename.get(planned.filename);
        row.status = applyRenames ? planned.status : "dry_run";
      }

      writeOutputs(results);
    }
  } finally {
    await worker.terminate();
    writeOutputs(results);
  }

  const renamed = results.rows.filter((row) => row.status === "renamed").length;
  const review = results.rows.filter((row) => row.status === "review_required").length;

  console.log(`Output JSON: ${outputJson}`);
  console.log(`Output CSV: ${outputCsv}`);
  console.log(`Renamed: ${renamed}`);
  console.log(`Review required: ${review}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
