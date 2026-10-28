"""Rasterize MdPersia's document/MD/RTL mark without a font dependency.

Pillow is a build-only dependency. Runtime and SVG use the same 256-unit geometry.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "src" / "fa_md_pdf" / "assets"
SCALE = 4
image = Image.new("RGBA", (256 * SCALE, 256 * SCALE))
draw = ImageDraw.Draw(image)


def points(coords):
    return [(x * SCALE, y * SCALE) for x, y in coords]


def line(coords, fill, width):
    draw.line(points(coords), fill=fill, width=width * SCALE, joint="curve")


draw.polygon(points([(48, 16), (160, 16), (208, 64), (208, 240), (40, 240), (40, 16)]),
             fill="white")
line([(48, 16), (160, 16), (208, 64), (208, 240), (40, 240), (40, 16), (48, 16)],
     "#111111", 12)
line([(156, 18), (156, 70), (206, 70)], "#111111", 10)
line([(66, 150), (66, 102), (90, 132), (114, 102), (114, 150)], "#111111", 12)
line([(136, 150), (136, 102), (151, 102)], "#111111", 12)
draw.arc((127*SCALE, 102*SCALE, 175*SCALE, 150*SCALE), -90, 90,
         fill="#111111", width=12*SCALE)
line([(151, 150), (136, 150)], "#111111", 12)
draw.rounded_rectangle((60*SCALE, 174*SCALE, 188*SCALE, 218*SCALE),
                       radius=8*SCALE, fill="#111111")
line([(161, 196), (88, 196), (103, 185)], "white", 8)
line([(88, 196), (103, 207)], "white", 8)
image = image.resize((256, 256), Image.Resampling.LANCZOS)
image.save(ASSETS / "mdpersia.png")
image.save(ASSETS / "mdpersia.ico", sizes=[(n, n) for n in (16, 20, 24, 32, 40, 48, 64, 128, 256)])
print("Generated mdpersia.png and mdpersia.ico (9 Windows icon sizes).")
