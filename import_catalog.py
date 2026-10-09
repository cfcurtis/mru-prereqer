#!/usr/bin/env python3
"""Build normalized course JSON from the Mount Royal University catalog."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable
from urllib.parse import urlencode

from bs4 import BeautifulSoup

CATALOG_BASE_URL = "https://catalog.mtroyal.ca/content.php"
DEFAULT_DEPARTMENTS = ("COMP", "MATH", "DATA")
COURSE_CODE_RE = re.compile(r"\b([A-Z]{2,8})\s*-?\s*(\d{4}[A-Z]?)\b", re.I)
REQUIREMENT_LABEL_RE = re.compile(
    r"(?:prerequisite|pre-requisite)s?\s*:\s*", re.I
)
NON_COURSE_RE = re.compile(
    r"\b(?:consent|permission|placement|standing|minimum grade|GPA|"
    r"program admission|department approval|with a grade)\b",
    re.I,
)
TRAILING_GRADE_NOTE_RE = re.compile(
    r"(?:;|,)\s*(?:all|each)?\s*with\b.*$",
    re.I,
)


@dataclass
class Issue:
    department: str
    kind: str
    message: str
    course_code: str | None = None


@dataclass
class Course:
    normalized_code: str
    display_code: str
    title: str
    catalog_url: str
    catalog_status: str
    source_prerequisite_text: str | None = None
    prerequisite_groups: list[dict[str, object]] = field(default_factory=list)
    parse_status: str = "not_applicable"
    issues: list[str] = field(default_factory=list)
    non_course_requirements: list[str] = field(default_factory=list)


def normalize_space(value: str) -> str:
    return " ".join(value.replace("\xa0", " ").split())


def format_course_code(subject: str, number: str) -> tuple[str, str]:
    subject, number = subject.upper(), number.upper()
    return f"{subject}{number}", f"{subject} {number}"


def normalize_code(value: str) -> tuple[str, str] | None:
    match = COURSE_CODE_RE.search(value)
    if not match:
        return None
    return format_course_code(*match.groups())


def build_catalog_url(department: str, catalog_id: str) -> str:
    query = urlencode(
        {
            "filter[27]": department,
            "filter[course_type]": "-1",
            "filter[32]": "1",
            "filter[cpage]": "1",
            "cur_cat_oid": catalog_id,
            "search_database": "Filter",
            "filter[exact_match]": "1",
        }
    )
    return f"{CATALOG_BASE_URL}?{query}"


def load_department_html(html_dir: Path, department: str, catalog_id: str) -> str:
    """Load a manually downloaded department page from the local filesystem."""
    candidates = (
        html_dir / f"{department}.html",
        html_dir / f"{catalog_id}-{department}.html",
    )
    source_path = next((path for path in candidates if path.is_file()), None)
    if source_path is None:
        expected = " or ".join(path.name for path in candidates)
        raise RuntimeError(f"Missing downloaded catalog HTML: {expected}")

    page = source_path.read_text(encoding="utf-8")
    if not page.strip():
        raise RuntimeError(f"Downloaded catalog HTML is empty: {source_path.name}")
    return page


def course_references(text: str) -> list[dict[str, str]]:
    references: list[dict[str, str]] = []
    seen: set[str] = set()
    for subject, number in COURSE_CODE_RE.findall(text):
        normalized, display = format_course_code(subject, number)
        if normalized in seen:
            continue
        seen.add(normalized)
        references.append({"normalized_code": normalized, "display_code": display})
    return references


def parse_prerequisites(text: str) -> tuple[list[dict[str, object]], str, list[str], list[str]]:
    """Parse simple AND/OR course requirements; preserve anything ambiguous."""
    clean = normalize_space(text)
    notes = [clean] if NON_COURSE_RE.search(clean) else []
    course_parts = REQUIREMENT_LABEL_RE.sub("", clean).strip(" .")
    if not course_parts:
        return [], "not_applicable", [], notes

    course_parts = TRAILING_GRADE_NOTE_RE.sub("", course_parts).strip()
    if ";" in course_parts:
        separators = re.findall(r";\s*(\w+)", course_parts, re.I)
        if not separators or any(separator.lower() != "and" for separator in separators):
            return [], "review_required", ["Unsupported semicolon-separated prerequisite expression."], notes
        course_parts = re.sub(r";\s*and\s+", " and ", course_parts, flags=re.I)
    if "(" in course_parts or ")" in course_parts:
        return [], "review_required", ["Nested or compound prerequisite expression."], notes

    and_parts = re.split(r"\s+(?:and|&)\s+", course_parts, flags=re.I)
    groups: list[dict[str, object]] = []
    for part in and_parts:
        references = course_references(part)
        if not references:
            if notes:
                return [], "not_applicable", [], notes
            return [], "review_required", ["Prerequisite text contains no recognizable course code."], notes
        operator = (
            "one_of"
            if re.search(r"\b(?:or|one\s+of)\b|/", part, re.I)
            else "all_of"
        )
        groups.append({"operator": operator, "courses": references})

    if notes:
        return groups, "parsed", [], notes

    unparsed_words = COURSE_CODE_RE.sub("", course_parts)
    unparsed_words = re.sub(r"\b(?:and|or|one|of|either|the|following|course|courses)\b", "", unparsed_words, flags=re.I)
    if re.sub(r"[\s,./-]", "", unparsed_words):
        return groups, "review_required", ["Prerequisite includes unmodeled conditions."], notes
    return groups, "parsed", [], notes


def prerequisite_text(block: object) -> str | None:
    match = re.search(
        r"Prerequisite\(s\):</em>\s*(?P<fragment>.*?)(?:<br\s*/?>|$)",
        str(block),
        re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return None
    return normalize_space(
        BeautifulSoup(match.group("fragment"), "html.parser").get_text(" ", strip=True)
    )


def extract_courses(html: str, department: str, source_url: str) -> tuple[list[Course], list[Issue]]:
    soup = BeautifulSoup(html, "html.parser")
    courses: list[Course] = []
    issues: list[Issue] = []

    for block in soup.find_all("li"):
        heading = block.find("h3")
        if heading is None:
            continue
        heading_text = normalize_space(heading.get_text(" ", strip=True))
        code = normalize_code(heading_text)
        if not code or code[1].split()[0] != department.upper():
            continue
        normalized_code, display_code = code
        title = re.sub(rf"^{re.escape(display_code)}\s*", "", heading_text, flags=re.I)
        requirement_text = prerequisite_text(block)
        groups, status, parse_issues, notes = parse_prerequisites(requirement_text or "")
        course = Course(
            normalized_code=normalized_code,
            display_code=display_code,
            title=title.strip(" -:"),
            catalog_url=source_url,
            catalog_status="returned_by_catalog",
            source_prerequisite_text=requirement_text,
            prerequisite_groups=groups,
            parse_status=status,
            issues=parse_issues,
            non_course_requirements=notes,
        )
        if parse_issues:
            issues.append(Issue(department, "parse", "; ".join(parse_issues), display_code))
        courses.append(course)

    if not courses:
        issues.append(
            Issue(department, "extraction", "No courses were found in the catalog response.")
        )
    return courses, issues


def unique_departments(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(value.upper() for value in values))


def run_import(arguments: argparse.Namespace) -> int:
    output_dir = Path(arguments.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    all_courses: list[Course] = []
    issues: list[Issue] = []
    successful_departments: list[str] = []

    for department in unique_departments(arguments.departments):
        source_url = build_catalog_url(department, arguments.catalog_id)
        try:
            html = load_department_html(
                Path(arguments.html_dir), department, arguments.catalog_id
            )
            courses, department_issues = extract_courses(html, department, source_url)
        except RuntimeError as error:
            issues.append(Issue(department, "fetch", str(error)))
            continue
        all_courses.extend(courses)
        issues.extend(department_issues)
        successful_departments.append(department)

    generated_at = datetime.now(UTC).isoformat()
    data = {
        "metadata": {
            "catalog_id": arguments.catalog_id,
            "generated_at": generated_at,
            "source_departments": successful_departments,
        },
        "courses": {course.normalized_code: asdict(course) for course in all_courses},
    }
    (output_dir / "courses.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    report = {
        "generated_at": generated_at,
        "successful_departments": successful_departments,
        "failed_departments": sorted({issue.department for issue in issues if issue.kind == "fetch"}),
        "course_count": len(all_courses),
        "issues": [asdict(issue) for issue in issues],
    }
    (output_dir / "import-report.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Wrote {len(all_courses)} courses to {output_dir / 'courses.json'}")
    print(f"Wrote import report to {output_dir / 'import-report.json'}")
    return 1 if report["failed_departments"] else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "departments",
        nargs="*",
        default=DEFAULT_DEPARTMENTS,
        help="Department codes to import (default: COMP MATH DATA).",
    )
    parser.add_argument("--catalog-id", default="38", help="Catalog edition ID (default: 38).")
    parser.add_argument("--output-dir", default="data", help="Output directory.")
    parser.add_argument(
        "--html-dir",
        default="catalog-html",
        help="Directory containing downloaded DEPT.html or CATALOG_ID-DEPT.html files.",
    )
    return run_import(parser.parse_args())


if __name__ == "__main__":
    sys.exit(main())
