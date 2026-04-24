const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;
const BASE_FOLDER = path.join(__dirname, "fabric-images");
const OUTPUT_FILE = path.join(__dirname, "data", "catalog.json");
const SKIP_IDS = new Set(["REVIEW_REQUIRED"]);

function getQualities() {
  return fs
    .readdirSync(BASE_FOLDER, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function extractDesignId(publicId) {
  const filename = publicId.split("/").pop().toUpperCase();
  const parts = filename.split("_");

  if (parts.length >= 3) {
    return parts.slice(0, -1).join("_");
  }

  return filename;
}

async function fetchQualityCatalog(quality) {
  const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/resources/search`;
  const response = await axios.post(
    url,
    {
      expression: `folder=fabric-images/${quality}`,
      max_results: 500,
      sort_by: [{ public_id: "asc" }]
    },
    {
      auth: {
        username: API_KEY,
        password: API_SECRET
      }
    }
  );

  const resources = response.data.resources || [];

  return resources
    .map((resource) => {
      const designId = extractDesignId(resource.public_id || "");
      return {
        id: designId,
        name: designId,
        image: resource.secure_url || "",
        stock: 0
      };
    })
    .filter((item) => item.id && !SKIP_IDS.has(item.id))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function main() {
  if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
    throw new Error(
      "CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET are required."
    );
  }

  const catalog = { qualities: {} };

  for (const quality of getQualities()) {
    try {
      catalog.qualities[quality.toUpperCase()] = await fetchQualityCatalog(quality);
    } catch (error) {
      console.error(`Could not read folder: ${quality}`);
      console.error(error.response?.data || error.message);
      catalog.qualities[quality.toUpperCase()] = [];
    }
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(catalog, null, 2));
  console.log(`catalog.json created successfully inside ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
