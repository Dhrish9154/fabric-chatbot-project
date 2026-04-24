import json
import os

import requests
from dotenv import load_dotenv

load_dotenv()

CLOUD_NAME = os.getenv("CLOUDINARY_CLOUD_NAME", "dn1zejx9n")
API_KEY = os.getenv("CLOUDINARY_API_KEY", "154431216695392")
API_SECRET = os.getenv("CLOUDINARY_API_SECRET", "qW2aSd66mR0oMYnyBj3okM2-sE4")
BASE_FOLDER = "fabric-images"
SKIP_IDS = {"REVIEW_REQUIRED"}

catalog = {"qualities": {}}


def extract_design_id(public_id):
    filename = public_id.split("/")[-1]
    return filename.upper()


def get_qualities():
    return sorted(
        quality
        for quality in os.listdir(BASE_FOLDER)
        if os.path.isdir(os.path.join(BASE_FOLDER, quality))
    )


for quality in get_qualities():
    url = f"https://api.cloudinary.com/v1_1/{CLOUD_NAME}/resources/search"

    response = requests.post(
        url,
        auth=(API_KEY, API_SECRET),
        json={
            "expression": f"folder=fabric-images/{quality}",
            "max_results": 500,
            "sort_by": [{"public_id": "asc"}]
        }
    )

    data = response.json()

    if "resources" not in data:
        print(f"Could not read folder: {quality}")
        print(data)
        catalog["qualities"][quality.upper()] = []
        continue

    designs = []

    for resource in data["resources"]:
        public_id = resource.get("public_id", "")
        secure_url = resource.get("secure_url", "")
        design_id = extract_design_id(public_id)

        if design_id in SKIP_IDS:
            continue

        designs.append({
            "id": design_id,
            "name": design_id,
            "image": secure_url,
            "stock": 0
        })

    designs.sort(key=lambda item: item["id"])
    catalog["qualities"][quality.upper()] = designs

os.makedirs("data", exist_ok=True)

with open("data/catalog.json", "w", encoding="utf-8") as file:
    json.dump(catalog, file, indent=2)

print("catalog.json created successfully inside data/catalog.json")
