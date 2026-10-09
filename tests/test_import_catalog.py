import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from import_catalog import (
    Course,
    extract_courses,
    filter_missing_internal_references,
    load_department_html,
    normalize_code,
    parse_prerequisites,
)


class CourseCodeTests(unittest.TestCase):
    def test_normalizes_spaced_and_compact_codes(self):
        self.assertEqual(normalize_code("comp2511"), ("COMP2511", "COMP 2511"))
        self.assertEqual(normalize_code("MATH 1200"), ("MATH1200", "MATH 1200"))
        self.assertIsNone(normalize_code("MATH 0130"))


class PrerequisiteParserTests(unittest.TestCase):
    def test_parses_required_courses(self):
        groups, status, issues, notes = parse_prerequisites("COMP 1000 and MATH 1200")

        self.assertEqual(status, "parsed")
        self.assertEqual(issues, [])
        self.assertEqual(notes, [])
        self.assertEqual(
            groups,
            [
                {
                    "operator": "all_of",
                    "courses": [{"normalized_code": "COMP1000", "display_code": "COMP 1000"}],
                },
                {
                    "operator": "all_of",
                    "courses": [{"normalized_code": "MATH1200", "display_code": "MATH 1200"}],
                },
            ],
        )

    def test_parses_one_of_courses(self):
        groups, status, issues, notes = parse_prerequisites(
            "one of COMP 1631 or COMP 1701"
        )

        self.assertEqual(status, "parsed")
        self.assertEqual(issues, [])
        self.assertEqual(notes, [])
        self.assertEqual(groups[0]["operator"], "one_of")
        self.assertEqual(
            [course["normalized_code"] for course in groups[0]["courses"]],
            ["COMP1631", "COMP1701"],
        )

    def test_does_not_treat_grade_language_as_a_course_alternative(self):
        groups, status, issues, notes = parse_prerequisites(
            "MATH 1203 with a grade of C- or higher."
        )

        self.assertEqual(status, "parsed")
        self.assertEqual(issues, [])
        self.assertEqual(groups[0]["operator"], "all_of")
        self.assertEqual(len(notes), 1)

    def test_ignores_zero_prefixed_course_segments(self):
        groups, status, issues, notes = parse_prerequisites(
            "COOP 0001 and DATA 3463"
        )

        self.assertEqual(status, "parsed")
        self.assertEqual(issues, [])
        self.assertEqual(notes, [])
        self.assertEqual(
            groups,
            [
                {
                    "operator": "all_of",
                    "courses": [{"normalized_code": "DATA3463", "display_code": "DATA 3463"}],
                },
            ],
        )

    def test_parses_required_and_optional_courses_before_grade_note(self):
        groups, status, issues, notes = parse_prerequisites(
            "COMP 2631, MATH 2234, and one of MATH 1271 or MATH 2071; "
            "all with a minimum grade of C-."
        )

        self.assertEqual(status, "parsed")
        self.assertEqual(issues, [])
        self.assertEqual(
            [[course["normalized_code"] for course in group["courses"]] for group in groups],
            [["COMP2631", "MATH2234"], ["MATH1271", "MATH2071"]],
        )
        self.assertEqual([group["operator"] for group in groups], ["all_of", "one_of"])
        self.assertEqual(len(notes), 1)

    def test_parses_semicolon_and_required_groups_before_grade_note(self):
        groups, status, issues, notes = parse_prerequisites(
            "MATH 2234; and one of MATH 1271 or MATH 2071, and one of "
            "COMP 2631 or DATA 2402, all with a minimum grade of C-."
        )

        self.assertEqual(status, "parsed")
        self.assertEqual(issues, [])
        self.assertEqual(
            [[course["normalized_code"] for course in group["courses"]] for group in groups],
            [["MATH2234"], ["MATH1271", "MATH2071"], ["COMP2631", "DATA2402"]],
        )
        self.assertEqual(
            [group["operator"] for group in groups],
            ["all_of", "one_of", "one_of"],
        )
        self.assertEqual(len(notes), 1)

    def test_splits_required_courses_before_one_of_group(self):
        groups, status, issues, notes = parse_prerequisites(
            "MATH 1200, MATH 1203, one of MATH 2233 or MATH 2234, "
            "and one of MATH 2071 or MATH 1271, all with grades of C- or higher."
        )

        self.assertEqual(status, "parsed")
        self.assertEqual(issues, [])
        self.assertEqual(
            [
                (group["operator"], [course["normalized_code"] for course in group["courses"]])
                for group in groups
            ],
            [
                ("all_of", ["MATH1200", "MATH1203"]),
                ("one_of", ["MATH2233", "MATH2234"]),
                ("one_of", ["MATH2071", "MATH1271"]),
            ],
        )
        self.assertEqual(notes, [])

    def test_rejects_mixed_semicolon_alternatives(self):
        groups, status, issues, notes = parse_prerequisites(
            "Mathematics 30-1, MATH 0130 or equivalent with a grade of 65% or higher; "
            "or MATH 1283 or MATH 1285 with a grade of B- or higher; and "
            "MATH 31 or MATH 0131 with a grade of 50% or higher."
        )

        self.assertEqual(groups, [])
        self.assertEqual(status, "review_required")
        self.assertEqual(issues, ["Unsupported semicolon-separated prerequisite expression."])
        self.assertEqual(len(notes), 1)


class CatalogExtractionTests(unittest.TestCase):
    def test_loads_manually_downloaded_department_html(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "COMP.html"
            source.write_text("<html>catalog</html>", encoding="utf-8")

            self.assertEqual(
                load_department_html(Path(directory), "COMP", "38"),
                "<html>catalog</html>",
            )

    def test_extracts_printer_friendly_course_block(self):
        html = """
        <ul><li>
          <h3>COMP 2511 - Data Structures</h3>
          <em>Prerequisite(s):</em>
          One of <a href="preview_course_nopop.php?catoid=38&amp;coid=123">
          COMP 1631</a> or COMP 1701 with a minimum grade of C-.
          <br>
        </li></ul>
        <a href="preview_course_nopop.php?catoid=38&amp;coid=456">COMP 2511</a>
        """

        courses, issues = extract_courses(
            html, "COMP", "https://catalog.mtroyal.ca/content.php"
        )

        self.assertEqual(issues, [])
        self.assertEqual(len(courses), 1)
        self.assertEqual(courses[0].title, "Data Structures")
        self.assertEqual(
            courses[0].catalog_url,
            "https://catalog.mtroyal.ca/preview_course.php?catoid=38&coid=456",
        )
        self.assertEqual(courses[0].parse_status, "parsed")
        self.assertEqual(len(courses[0].non_course_requirements), 1)


class ReferenceFilteringTests(unittest.TestCase):
    def test_removes_missing_internal_courses_and_keeps_external_courses(self):
        course = Course(
            normalized_code="COMP2000",
            display_code="COMP 2000",
            title="Example",
            catalog_url="https://example.com",
            catalog_status="returned_by_catalog",
            prerequisite_groups=[
                {
                    "operator": "all_of",
                    "courses": [
                        {"normalized_code": "MATH1283", "display_code": "MATH 1283"},
                        {"normalized_code": "GNED1101", "display_code": "GNED 1101"},
                        {"normalized_code": "COMP1000", "display_code": "COMP 1000"},
                    ],
                },
            ],
        )

        filter_missing_internal_references([course], {"COMP", "MATH", "DATA"})

        self.assertEqual(
            course.prerequisite_groups,
            [
                {
                    "operator": "all_of",
                    "courses": [{"normalized_code": "GNED1101", "display_code": "GNED 1101"}],
                },
            ],
        )


if __name__ == "__main__":
    unittest.main()
