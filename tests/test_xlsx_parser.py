from __future__ import annotations

import unittest
import unicodedata
import zipfile
from html import escape
from pathlib import Path
from tempfile import TemporaryDirectory

from csv_parser import StoryboardValidationError, parse_storyboard_file


def _inline_cell(reference: str, value: str) -> str:
    return (
        f'<c r="{reference}" t="inlineStr"><is><t>{escape(value)}</t></is></c>'
    )


def _number_cell(reference: str, value: float | int) -> str:
    return f'<c r="{reference}"><v>{value}</v></c>'


def _write_legacy_workbook(path: Path) -> None:
    headers = [
        unicodedata.normalize("NFD", value)
        for value in ("컷 번호", "시작 시간", "종료 시간", "길이(초)")
    ]
    sheet_rows = [
        '<row r="7">'
        + "".join(
            _inline_cell(f"{column}7", value)
            for column, value in zip("ABCD", headers, strict=True)
        )
        + "</row>",
        '<row r="8">'
        + _number_cell("A8", 1)
        + _number_cell("B8", 0)
        + _number_cell("D8", 3)
        + "</row>",
        '<row r="9">'
        + _number_cell("A9", 2)
        + _number_cell("B9", 0)
        + _number_cell("D9", 3)
        + "</row>",
        '<row r="10">'
        + _number_cell("A10", 3)
        + _number_cell("B10", 3 / 86400)
        + _number_cell("D10", 2)
        + "</row>",
    ]
    worksheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetData>{"".join(sheet_rows)}</sheetData></worksheet>'
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            "</Types>",
        )
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>",
        )
        archive.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="컷 시간표" sheetId="1" r:id="rId1"/></sheets>'
            "</workbook>",
        )
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            "</Relationships>",
        )
        archive.writestr("xl/worksheets/sheet1.xml", worksheet)


class XlsxStoryboardTests(unittest.TestCase):
    def test_legacy_korean_workbook_maps_cut_numbers_times_and_tracks(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "storyboard.xlsx"
            _write_legacy_workbook(path)
            items = parse_storyboard_file(path)

        self.assertEqual([item.file_name for item in items], ["1", "2", "3"])
        self.assertEqual([item.start_time for item in items], [0.0, 0.0, 3.0])
        self.assertEqual([item.duration for item in items], [3.0, 3.0, 2.0])
        self.assertEqual([item.track_index for item in items], [1, 2, 1])
        self.assertEqual([item.source_row for item in items], [8, 9, 10])

    def test_unknown_storyboard_extension_is_rejected(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "storyboard.xls"
            path.write_bytes(b"not an xlsx")
            with self.assertRaisesRegex(StoryboardValidationError, "Unsupported"):
                parse_storyboard_file(path)


if __name__ == "__main__":
    unittest.main()
