from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent.parent
HERO_DOC_ROOT = ROOT / "design-data" / "design-heros"
HERO_IMAGE_ROOT = ROOT / "assets" / "images" / "heros"

SECTION_HEADERS = {"天生技能：", "技能1：", "技能2：", "技能3：", "技能4："}


def normalize_header(text: str) -> str:
    return text.strip().replace(":", "：")

CANVAS = (768, 768)
BG_BY_ATTR = {
    "力量": ("#5a1f1f", "#b94c37"),
    "敏捷": ("#154734", "#2e8f61"),
    "智力": ("#172b5f", "#497cd8"),
}


def walk_hero_docs() -> list[tuple[str, str, Path]]:
    heroes: list[tuple[str, str, Path]] = []
    for attr_dir in sorted(HERO_DOC_ROOT.iterdir(), key=lambda p: p.name):
        if not attr_dir.is_dir():
            continue
        for hero_file in sorted(attr_dir.iterdir(), key=lambda p: p.name):
            if hero_file.is_file():
                heroes.append((attr_dir.name, hero_file.name, hero_file))
    return heroes


def read_lines(file: Path) -> list[str]:
    return file.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n").split("\n")


def parse_expected_image_names(lines: list[str]) -> list[str]:
    expected = ["原画.png"]
    for index, line in enumerate(lines):
        if normalize_header(line) not in SECTION_HEADERS:
            continue
        next_non_empty = ""
        for probe in lines[index + 1 :]:
            probe = probe.strip()
            if probe:
                next_non_empty = probe
                break
        if not next_non_empty:
            continue
        image_name = next_non_empty
        image_name = image_name.removesuffix("：").strip()
        if "：" in image_name:
            image_name = image_name.split("：", 1)[0].strip()
        if ":" in image_name:
            image_name = image_name.split(":", 1)[0].strip()
        if not image_name:
            continue
        file_name = f"{image_name}.png"
        if file_name not in expected:
            expected.append(file_name)
    return expected


def ensure_dir(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)


def placeholder_kind(file_name: str) -> str:
    return "原画占位" if file_name == "原画.png" else "技能图占位"


def short_name(file_name: str) -> str:
    return Path(file_name).stem


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    preferred = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ]
    for candidate in preferred:
        if Path(candidate).exists():
            try:
                return ImageFont.truetype(candidate, size=size)
            except Exception:
                continue
    return ImageFont.load_default()


TITLE_FONT = load_font(92)
SUBTITLE_FONT = load_font(54)
BODY_FONT = load_font(42)
TAG_FONT = load_font(36)


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    if not text:
        return [""]
    lines: list[str] = []
    current = ""
    for char in text:
        probe = current + char
        bbox = draw.textbbox((0, 0), probe, font=font)
        width = bbox[2] - bbox[0]
        if current and width > max_width:
            lines.append(current)
            current = char
        else:
            current = probe
    if current:
        lines.append(current)
    return lines


def draw_placeholder(attr: str, hero: str, file_name: str, target: Path) -> None:
    start_hex, end_hex = BG_BY_ATTR.get(attr, ("#222222", "#666666"))
    image = Image.new("RGB", CANVAS, start_hex)
    draw = ImageDraw.Draw(image)

    width, height = image.size

    draw.ellipse((-120, -120, width * 0.7, height * 0.7), fill=end_hex)
    draw.ellipse((width * 0.35, height * 0.25, width + 80, height + 120), fill=(255, 255, 255, 20))
    draw.rectangle((0, height * 0.72, width, height), fill="#101010")

    for offset in range(0, width, 96):
        draw.line((offset, 0, 0, offset), fill=(255, 255, 255, 18), width=2)
        draw.line((width, offset, offset, height), fill=(255, 255, 255, 14), width=2)

    draw.rounded_rectangle((42, 42, width - 42, height - 42), radius=36, outline=(255, 255, 255), width=4)
    draw.rounded_rectangle((76, 76, width - 76, height - 76), radius=28, outline=(255, 255, 255), width=2)

    kind = placeholder_kind(file_name)
    skill = short_name(file_name)
    tag = f"{attr} / {hero}"

    title_box = draw.textbbox((0, 0), hero, font=TITLE_FONT)
    title_w = title_box[2] - title_box[0]
    draw.text(((width - title_w) / 2, 126), hero, fill="white", font=TITLE_FONT)

    subtitle_box = draw.textbbox((0, 0), kind, font=SUBTITLE_FONT)
    subtitle_w = subtitle_box[2] - subtitle_box[0]
    draw.text(((width - subtitle_w) / 2, 224), kind, fill=(245, 245, 245), font=SUBTITLE_FONT)

    tag_box = draw.textbbox((0, 0), tag, font=TAG_FONT)
    tag_w = tag_box[2] - tag_box[0]
    draw.rounded_rectangle(
        ((width - tag_w) / 2 - 20, 298, (width + tag_w) / 2 + 20, 352),
        radius=20,
        fill=(255, 255, 255),
    )
    draw.text(((width - tag_w) / 2, 308), tag, fill=(20, 20, 20), font=TAG_FONT)

    body_lines = wrap_text(draw, skill, BODY_FONT, max_width=width - 260)
    start_y = 430 - ((len(body_lines) - 1) * 24)
    for idx, line in enumerate(body_lines):
        line_box = draw.textbbox((0, 0), line, font=BODY_FONT)
        line_w = line_box[2] - line_box[0]
        draw.text(((width - line_w) / 2, start_y + idx * 58), line, fill=(255, 255, 255), font=BODY_FONT)

    footer = "PLACEHOLDER"
    footer_box = draw.textbbox((0, 0), footer, font=TAG_FONT)
    footer_w = footer_box[2] - footer_box[0]
    draw.text(((width - footer_w) / 2, 666), footer, fill=(255, 255, 255, 220), font=TAG_FONT)

    image.save(target, format="PNG")


def main() -> None:
    created = 0
    skipped = 0
    for attr, hero, hero_file in walk_hero_docs():
        hero_dir = HERO_IMAGE_ROOT / attr / hero
        ensure_dir(hero_dir)
        expected = parse_expected_image_names(read_lines(hero_file))
        for image_name in expected:
            target = hero_dir / image_name
            if target.exists():
                skipped += 1
                continue
            draw_placeholder(attr, hero, image_name, target)
            created += 1
    print(f"created={created}")
    print(f"skipped_existing={skipped}")


if __name__ == "__main__":
    main()
