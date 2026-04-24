import json
import os

BASE_FOLDER = "fabric-images"
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}

catalog = {"qualities": {}}

for quality in sorted(os.listdir(BASE_FOLDER)):
    quality_path = os.path.join(BASE_FOLDER, quality)

    if not os.path.isdir(quality_path):
        continue

    designs = []

    for filename in sorted(os.listdir(quality_path)):
        file_path = os.path.join(quality_path, filename)

        if not os.path.isfile(file_path):
            continue

        name, extension = os.path.splitext(filename)

        if extension.lower() not in ALLOWED_EXTENSIONS:
            continue

        if name.upper() == "REVIEW_REQUIRED":
            continue

        design_id = name.upper()

        designs.append({
            "id": design_id,
            "name": design_id,
            "image": f"https://yourdomain.com/images/{quality.lower()}/{filename}",
            "stock": 0
        })

    catalog["qualities"][quality.upper()] = designs

os.makedirs("data", exist_ok=True)

with open("data/catalog.json", "w", encoding="utf-8") as file:
    json.dump(catalog, file, indent=2)

print("catalog.json created successfully inside data folder.")
