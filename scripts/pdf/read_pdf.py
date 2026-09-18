#!/usr/bin/env python3
"""Read a PDF a customer sent on WhatsApp.

Two very different PDFs arrive in this trade:

  * a TYPED one — an order list exported from their software, a pending list,
    a quotation. The text is really in the file and pdfplumber lifts it out
    exactly, including the table layout, which is far more reliable than
    reading a picture of it.
  * a SCANNED one — someone photographed a paper order and saved it as a PDF.
    There is no text at all, only an image, and the only way through is to
    render the pages and let vision read them.

So: try text first, and when there is none, hand the pages back as PNGs for
the caller to send to Claude vision — the same path a photo already takes.

    python read_pdf.py FILE.pdf [--render-dir DIR]

Prints JSON on stdout:
    {"pages": n, "text": "...", "tables": [[[cell, ...], ...], ...],
     "images": ["/dir/page-1.png", ...], "how": "text" | "render" | "empty"}
"""
import json
import os
import sys

MAX_PAGES = 20  # a 90-page catalogue is not an order; read the front of it


def extract_text(path):
    try:
        import pdfplumber
    except ImportError:
        return None, None
    text_parts, tables = [], []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages[:MAX_PAGES]:
            t = page.extract_text() or ""
            if t.strip():
                text_parts.append(t)
            # A pending list is a table; keeping the grid keeps part numbers
            # and quantities in the same row, which flat text loses.
            for tbl in page.extract_tables() or []:
                rows = [[(c or "").strip() for c in row] for row in tbl]
                rows = [r for r in rows if any(r)]
                if rows:
                    tables.append(rows)
    return "\n".join(text_parts), tables


def render_pages(path, out_dir, limit=3):
    """Scanned PDF -> PNGs, for the vision path. Only the first few pages:
    an order that runs past three scanned pages needs a person anyway."""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return []
    os.makedirs(out_dir, exist_ok=True)
    made = []
    doc = fitz.open(path)
    for i, page in enumerate(doc[:limit]):
        # 150 dpi: enough for a printed part number, small enough to send.
        pix = page.get_pixmap(dpi=150)
        p = os.path.join(out_dir, "page-%d.png" % (i + 1))
        pix.save(p)
        made.append(p)
    doc.close()
    return made


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: read_pdf.py FILE.pdf [--render-dir DIR]"}))
        return 2
    path = sys.argv[1]
    render_dir = None
    if "--render-dir" in sys.argv:
        render_dir = sys.argv[sys.argv.index("--render-dir") + 1]

    if not os.path.exists(path):
        print(json.dumps({"error": "no such file"}))
        return 1

    try:
        text, tables = extract_text(path)
    except Exception as e:  # a corrupt or password-locked PDF is not a crash
        print(json.dumps({"error": "pdf read failed: %s" % str(e)[:160]}))
        return 1

    if text is None:
        print(json.dumps({"error": "pdfplumber not installed"}))
        return 1

    pages = 0
    try:
        import pdfplumber

        with pdfplumber.open(path) as pdf:
            pages = len(pdf.pages)
    except Exception:
        pass

    if text.strip():
        print(json.dumps({"pages": pages, "text": text, "tables": tables or [], "images": [], "how": "text"}))
        return 0

    images = render_pages(path, render_dir) if render_dir else []
    print(
        json.dumps(
            {
                "pages": pages,
                "text": "",
                "tables": [],
                "images": images,
                "how": "render" if images else "empty",
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
