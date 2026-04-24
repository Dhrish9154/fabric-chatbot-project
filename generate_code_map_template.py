import json
from pathlib import Path

BASE_FOLDER = Path("fabric-images")
OUTPUT_FILE = Path("data/design_code_map.template.json")


def main():
    template = {}

    for quality_path in sorted(BASE_FOLDER.iterdir()):
        if not quality_path.is_dir():
            continue

        template[quality_path.name.upper()] = {}

        for image_path in sorted(quality_path.iterdir()):
            if image_path.is_file():
                template[quality_path.name.upper()][image_path.name] = "REPLACE_WITH_CODE_FROM_IMAGE"

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)

    with OUTPUT_FILE.open("w", encoding="utf-8") as file:
        json.dump(template, file, indent=2)

    print(f"Template written to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
