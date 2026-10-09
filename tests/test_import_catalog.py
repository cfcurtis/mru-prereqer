import unittest

from import_catalog import extract_courses, normalize_code, parse_prerequisites


class CourseCodeTests(unittest.TestCase):
    def test_normalizes_spaced_and_compact_codes(self):
        self.assertEqual(normalize_code("comp2511"), ("COMP2511", "COMP 2511"))
        self.assertEqual(normalize_code("MATH 1200"), ("MATH1200", "MATH 1200"))


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


class CatalogExtractionTests(unittest.TestCase):
    def test_extracts_course_and_individual_catalog_link(self):
        html = """
        <div class="courseblock">
          <h3 class="courseblocktitle">
            <a href="preview_course_nopop.php?catoid=38&amp;coid=123">
              COMP 2511 Data Structures
            </a>
          </h3>
          <p>Prerequisite: one of COMP 1631 or COMP 1701</p>
        </div>
        """

        courses, issues = extract_courses(
            html, "COMP", "https://catalog.mtroyal.ca/content.php"
        )

        self.assertEqual(issues, [])
        self.assertEqual(len(courses), 1)
        self.assertEqual(courses[0].title, "Data Structures")
        self.assertEqual(
            courses[0].catalog_url,
            "https://catalog.mtroyal.ca/preview_course_nopop.php?catoid=38&coid=123",
        )


if __name__ == "__main__":
    unittest.main()
