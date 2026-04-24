const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const BASE_FOLDER = path.join(ROOT, "fabric-images");
const OUTPUT_FOLDER = path.join(ROOT, "data", "contact-sheets");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const args = process.argv.slice(2);

const selectedQualities = (getArgValue("--qualities") || "")
  .split(",")
  .map((quality) => normalizeQuality(quality))
  .filter(Boolean);
const selectedQuality = normalizeQuality(getArgValue("--quality") || "");
const cropPercent = parseFloat(getArgValue("--crop-percent") || "0.32");
const cropRegion = String(getArgValue("--region") || "top").toLowerCase();
const columns = parseInt(getArgValue("--columns") || "4", 10);
const cellWidth = parseInt(getArgValue("--cell-width") || "360", 10);
const labelHeight = parseInt(getArgValue("--label-height") || "44", 10);

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

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

  if (selectedQuality) {
    return folders.filter((folder) => normalizeQuality(folder) === selectedQuality);
  }

  return folders;
}

function getImageFiles(folderPath) {
  return fs
    .readdirSync(folderPath)
    .filter((filename) => IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase()))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function makeLabelSvg(filename, width, height) {
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#111827"/>
      <text x="16" y="28" font-family="Verdana, Arial, sans-serif" font-size="18" font-weight="700" fill="#ffffff">
        ${escapeXml(filename)}
      </text>
    </svg>
  `);
}

async function createCell(imagePath, filename) {
  const metadata = await sharp(imagePath).metadata();
  const cropHeight = Math.max(1, Math.floor(metadata.height * cropPercent));
  const top = cropRegion === "bottom" ? Math.max(0, metadata.height - cropHeight) : 0;
  const crop = await sharp(imagePath)
    .extract({
      left: 0,
      top,
      width: metadata.width,
      height: cropHeight
    })
    .resize({ width: cellWidth })
    .jpeg({ quality: 88 })
    .toBuffer();
  const cropMetadata = await sharp(crop).metadata();
  const cellHeight = cropMetadata.height + labelHeight;
  const label = makeLabelSvg(filename, cellWidth, labelHeight);

  return sharp({
    create: {
      width: cellWidth,
      height: cellHeight,
      channels: 3,
      background: "#f3f4f6"
    }
  })
    .composite([
      { input: crop, left: 0, top: 0 },
      { input: label, left: 0, top: cropMetadata.height }
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function createSheet(quality) {
  const folderPath = path.join(BASE_FOLDER, quality);
  const files = getImageFiles(folderPath);

  if (!files.length) {
    console.log(`Skipping ${quality}: no image files`);
    return null;
  }

  const cells = [];
  for (const filename of files) {
    const cell = await createCell(path.join(folderPath, filename), filename);
    const metadata = await sharp(cell).metadata();
    cells.push({ filename, cell, width: metadata.width, height: metadata.height });
  }

  const actualColumns = Math.max(1, Math.min(columns, cells.length));
  const rows = Math.ceil(cells.length / actualColumns);
  const rowHeights = Array.from({ length: rows }, (_, rowIndex) => {
    const rowCells = cells.slice(rowIndex * actualColumns, rowIndex * actualColumns + actualColumns);
    return Math.max(...rowCells.map((cell) => cell.height));
  });
  const sheetWidth = actualColumns * cellWidth;
  const sheetHeight = rowHeights.reduce((total, height) => total + height, 0);
  const composites = [];

  let top = 0;
  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    const rowHeight = rowHeights[rowIndex];
    for (let columnIndex = 0; columnIndex < actualColumns; columnIndex += 1) {
      const cell = cells[rowIndex * actualColumns + columnIndex];
      if (!cell) {
        continue;
      }

      composites.push({
        input: cell.cell,
        left: columnIndex * cellWidth,
        top
      });
    }
    top += rowHeight;
  }

  fs.mkdirSync(OUTPUT_FOLDER, { recursive: true });
  const outputPath = path.join(
    OUTPUT_FOLDER,
    `${normalizeQuality(quality)}_${cropRegion}_contact_sheet.jpg`
  );

  await sharp({
    create: {
      width: sheetWidth,
      height: sheetHeight,
      channels: 3,
      background: "#ffffff"
    }
  })
    .composite(composites)
    .jpeg({ quality: 92 })
    .toFile(outputPath);

  console.log(`Created ${outputPath}`);
  return outputPath;
}

async function main() {
  const qualities = getQualityFolders();

  for (const quality of qualities) {
    await createSheet(quality);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
