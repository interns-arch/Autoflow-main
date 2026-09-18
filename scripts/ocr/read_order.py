"""Read text from a customer's order photo using Python OCR libraries.

Tries, in order:
  1. pytesseract   (pip install pytesseract + the Tesseract binary)
  2. easyocr       (pip install easyocr — heavier, no external binary)

Prints the recognized text to stdout. Exits 3 if no OCR library is
installed (the Node side then falls back to Windows built-in OCR / Claude).

Usage: python read_order.py <image-path>
"""
import sys


def try_pytesseract(path):
    try:
        import pytesseract
        from PIL import Image
    except ImportError:
        return None
    try:
        return pytesseract.image_to_string(Image.open(path))
    except Exception:
        return None  # library present but tesseract.exe missing/broken


def try_easyocr(path):
    try:
        import easyocr
    except ImportError:
        return None
    reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    return "\n".join(reader.readtext(path, detail=0))


def main():
    if len(sys.argv) < 2:
        print("usage: read_order.py <image>", file=sys.stderr)
        sys.exit(1)
    path = sys.argv[1]
    for fn in (try_pytesseract, try_easyocr):
        text = fn(path)
        if text and text.strip():
            print(text)
            return
    sys.exit(3)  # no OCR backend available


if __name__ == "__main__":
    main()
