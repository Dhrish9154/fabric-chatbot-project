const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const sharp = require("sharp");
require("dotenv").config();

const BASE_FOLDER = path.join(__dirname, "fabric-images");
const OUTPUT_DIR = path.join(__dirname, "catalogs");
const OUTPUT_JSON = path.join(__dirname, "data", "catalog_documents.json");
const CATALOG_PATH = path.join(__dirname, "data", "catalog.json");
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;
const CLOUDINARY_FOLDER = "fabric-catalogs";
const SHOULD_UPLOAD = process.argv.includes("--upload") || process.env.UPLOAD_CATALOGS === "true";

function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
}

function loadExistingDocuments() {
  if (!fs.existsSync(OUTPUT_JSON)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(OUTPUT_JSON, "utf8"));
}

function getDesignsForQuality(catalog, quality) {
  return (catalog.qualities[quality.toUpperCase()] || [])
    .filter((design) => !design.hidden_from_catalog)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function getLocalImagePath(quality, designId) {
  const qualityFolder = path.join(BASE_FOLDER, quality.toLowerCase());
  const extensions = [".jpg", ".jpeg", ".png", ".webp"];

  for (const extension of extensions) {
    const candidate = path.join(qualityFolder, `${designId}${extension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function optimizeImageForPdf(imagePath) {
  return sharp(imagePath)
    .rotate()
    .resize({
      width: 900,
      height: 1100,
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({
      quality: 62,
      mozjpeg: true
    })
    .toBuffer();
}

async function createPdfForQuality(catalog, quality) {
  const designs = getDesignsForQuality(catalog, quality).map((design) => ({
    ...design,
    localImagePath: getLocalImagePath(quality, design.id)
  }));
  const printableDesigns = designs.filter((design) => design.localImagePath);
  const optimizedDesigns = [];

  for (const design of printableDesigns) {
    optimizedDesigns.push({
      ...design,
      pdfImage: await optimizeImageForPdf(design.localImagePath)
    });
  }

  const outputPath = path.join(OUTPUT_DIR, `${quality.toUpperCase()}_catalog.pdf`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false, size: "A4", margin: 36 });
    const stream = fs.createWriteStream(outputPath);

    stream.on("finish", () => resolve({ outputPath, images: optimizedDesigns }));
    stream.on("error", reject);
    doc.on("error", reject);

    doc.pipe(stream);

    optimizedDesigns.forEach((design, index) => {
      doc.addPage();
      doc.fontSize(24).font("Helvetica-Bold").text(`${quality.toUpperCase()} Catalog`, 36, 30);
      doc
        .fontSize(14)
        .font("Helvetica")
        .text(`Design ${index + 1} of ${printableDesigns.length}`, 36, 62);
      doc.fontSize(18).font("Helvetica-Bold").text(design.id, 36, 88);

      doc.image(design.pdfImage, 36, 120, {
        fit: [523, 640],
        align: "center",
        valign: "center"
      });

      doc
        .fontSize(12)
        .font("Helvetica")
        .text("For availability, rate, quantity, or delivery, contact the Tianso Global sales team.", 36, 780, {
          width: 523,
          align: "center"
        });
    });

    doc.end();

    if (!printableDesigns.length) {
      console.warn(`No printable designs found for ${quality}.`);
    }
  });
}

function buildSignature(params) {
  const payload = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  return crypto.createHash("sha1").update(`${payload}${API_SECRET}`).digest("hex");
}

function getCloudinaryPublicId(quality) {
  return `${quality.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}_catalog`;
}

async function uploadPdf(filePath, quality) {
  if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
    throw new Error(
      "CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET are required."
    );
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = getCloudinaryPublicId(quality);
  const params = {
    folder: CLOUDINARY_FOLDER,
    overwrite: "true",
    public_id: publicId,
    timestamp: String(timestamp)
  };

  const signature = buildSignature(params);
  const buffer = await fs.promises.readFile(filePath);
  const form = new FormData();

  form.append("file", new Blob([buffer], { type: "application/pdf" }), path.basename(filePath));
  form.append("api_key", API_KEY);
  form.append("timestamp", String(timestamp));
  form.append("folder", CLOUDINARY_FOLDER);
  form.append("public_id", publicId);
  form.append("overwrite", "true");
  form.append("signature", signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/raw/upload`, {
    method: "POST",
    body: form
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return {
    quality: quality.toUpperCase(),
    public_id: data.public_id,
    secure_url: data.secure_url
  };
}

async function uploadPdfToWhatsApp(filePath) {
  if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
    throw new Error("PHONE_NUMBER_ID and WHATSAPP_TOKEN are required for WhatsApp media upload.");
  }

  const buffer = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append(
    "file",
    new Blob([buffer], { type: "application/pdf" }),
    path.basename(filePath)
  );

  const response = await fetch(`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/media`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`
    },
    body: form
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data.id;
}

async function main() {
  const catalog = loadCatalog();
  const documents = loadExistingDocuments();
  const canUploadToCloudinary = SHOULD_UPLOAD && Boolean(CLOUD_NAME && API_KEY && API_SECRET);
  const canUploadToWhatsApp = SHOULD_UPLOAD && Boolean(PHONE_NUMBER_ID && WHATSAPP_TOKEN);

  if (!SHOULD_UPLOAD) {
    console.warn("Upload disabled. Local PDFs will be generated and existing document links will be preserved.");
  } else if (!canUploadToCloudinary || !canUploadToWhatsApp) {
    console.warn(
      "Upload credentials are incomplete. Local PDFs will be generated and existing document links will be preserved."
    );
  }

  for (const quality of Object.keys(catalog.qualities).sort()) {
    const { outputPath, images } = await createPdfForQuality(catalog, quality);

    if (!images.length) {
      documents[quality.toUpperCase()] = {
        ...(documents[quality.toUpperCase()] || {}),
        local_path: outputPath,
        filename: `${quality.toUpperCase()}_catalog.pdf`
      };
      continue;
    }

    if (!canUploadToCloudinary || !canUploadToWhatsApp) {
      documents[quality.toUpperCase()] = {
        ...(documents[quality.toUpperCase()] || {}),
        local_path: outputPath,
        filename: `${quality.toUpperCase()}_catalog.pdf`
      };
      continue;
    }

    const uploaded = await uploadPdf(outputPath, quality);
    const whatsappMediaId = await uploadPdfToWhatsApp(outputPath);
    documents[quality.toUpperCase()] = {
      media_id: whatsappMediaId,
      url: uploaded.secure_url,
      local_path: outputPath,
      filename: `${quality.toUpperCase()}_catalog.pdf`
    };
  }

  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(documents, null, 2));
  console.log(`Catalog documents written to ${OUTPUT_JSON}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
