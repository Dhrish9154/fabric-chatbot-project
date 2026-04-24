import json
import os
from pathlib import Path

BASE_FOLDER = Path("fabric-images")
MAPPING_FILE = Path("data/design_code_map.json")


def normalize_code(code):
    return code.strip().upper().replace(" ", "_")


def load_mapping():
    if not MAPPING_FILE.exists():
        raise FileNotFoundError(
            "Missing data/design_code_map.json. Create it with the real code shown in each image."
        )

    with MAPPING_FILE.open("r", encoding="utf-8") as file:
        mapping = json.load(file)

    if not isinstance(mapping, dict):
        raise ValueError("design_code_map.json must contain an object keyed by quality.")

    return mapping


def rename_quality_images(quality_path, quality_mapping):
    seen_targets = set()

    for old_name, real_code in quality_mapping.items():
        if normalize_code(real_code) == "REVIEW_REQUIRED":
            print(f"Skipped: {old_name} marked REVIEW_REQUIRED")
            continue

        old_path = quality_path / old_name

        if not old_path.is_file():
            raise FileNotFoundError(f"File not found for rename: {old_path}")

        extension = old_path.suffix.lower()
        target_name = f"{normalize_code(real_code)}{extension}"
        target_path = quality_path / target_name

        if target_name in seen_targets:
            raise ValueError(f"Duplicate target filename detected: {target_name}")

        seen_targets.add(target_name)

        if old_path == target_path:
            print(f"Skipped: {old_name} already matches {target_name}")
            continue

        if target_path.exists():
            raise FileExistsError(f"Target file already exists: {target_path}")

        os.rename(old_path, target_path)
        print(f"Renamed: {old_name} -> {target_name}")


def main():
    mapping = load_mapping()

    for quality, quality_mapping in mapping.items():
        quality_path = BASE_FOLDER / quality.lower()

        if not quality_path.is_dir():
            raise FileNotFoundError(f"Quality folder not found: {quality_path}")

        if not isinstance(quality_mapping, dict):
            raise ValueError(f"Mapping for {quality} must be an object of filename -> real code.")

        rename_quality_images(quality_path, quality_mapping)


if __name__ == "__main__":
    main()
