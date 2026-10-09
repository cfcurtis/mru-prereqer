const state = {
  catalogId: null,
  courses: {},
  reverseIndex: new Map(),
  selectedCode: null,
};

const searchForm = document.querySelector("#course-search");
const courseInput = document.querySelector("#course-code");
const courseCodes = document.querySelector("#course-codes");
const searchMessage = document.querySelector("#search-message");
const selectedCourse = document.querySelector("#selected-course");
const courseNotes = document.querySelector("#course-notes");
const catalogLink = document.querySelector("#catalog-link");
const diagram = document.querySelector("#diagram");

function normalizeCode(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function courseLabel(code) {
  const course = state.courses[code];
  return course ? `${course.display_code} — ${course.title}` : code;
}

function catalogSearchUrl(course) {
  const query = new URLSearchParams({
    cur_cat_oid: state.catalogId,
    search_database: "Search",
    search_db: "Search",
    location: "3",
    "filter[keyword]": course.display_code,
    "filter[exact_match]": "1",
  });
  return `https://catalog.mtroyal.ca/search_advanced.php?${query}`;
}

function buildReverseIndex() {
  for (const course of Object.values(state.courses)) {
    for (const group of course.prerequisite_groups) {
      for (const prerequisite of group.courses) {
        const dependents = state.reverseIndex.get(prerequisite.normalized_code) ?? [];
        dependents.push({
          code: course.normalized_code,
          optional: group.operator === "one_of",
        });
        state.reverseIndex.set(prerequisite.normalized_code, dependents);
      }
    }
  }
}

function prerequisiteTree(code, path = new Set(), optional = false) {
  const course = state.courses[code];
  if (path.has(code)) {
    return {
      id: code,
      label: courseLabel(code),
      kind: "course",
      optional,
      cycle: true,
      children: [],
    };
  }
  const nextPath = new Set(path).add(code);
  const children = [];

  for (const [index, group] of (course?.prerequisite_groups ?? []).entries()) {
    if (group.operator === "one_of") {
      const choiceGroup = `${code}-choice-${index}`;
      children.push(
        ...group.courses.map((item) => ({
          ...prerequisiteTree(item.normalized_code, nextPath, true),
          choiceGroup,
        })),
      );
    } else {
      children.push(
        ...group.courses.map((item) =>
          prerequisiteTree(item.normalized_code, nextPath),
        ),
      );
    }
  }

  return {
    id: code,
    label: courseLabel(code),
    kind: "course",
    optional,
    cycle: false,
    children,
  };
}

function dependentTree(code, path = new Set(), optional = false) {
  if (path.has(code)) {
    return {
      id: code,
      label: courseLabel(code),
      kind: "course",
      optional,
      cycle: true,
      children: [],
    };
  }
  const nextPath = new Set(path).add(code);
  const children = (state.reverseIndex.get(code) ?? []).map((dependent) =>
    dependentTree(dependent.code, nextPath, dependent.optional),
  );

  return {
    id: code,
    label: courseLabel(code),
    kind: "course",
    optional,
    cycle: false,
    children,
  };
}

function layoutTree(tree, direction) {
  const root = d3.hierarchy(tree);
  d3.tree().nodeSize([58, 190])(root);
  const rootX = root.x;
  root.descendants().forEach((node) => {
    node.diagramX = node.y * direction;
    node.diagramY = node.x - rootX;
  });
  return root;
}

function drawTree(layer, root) {
  const choiceGroups = d3.groups(
    root.descendants().filter((node) => node.data.choiceGroup),
    (node) => node.data.choiceGroup,
  );
  const choiceLayer = layer.append("g").attr("class", "choice-groups");
  for (const [, nodes] of choiceGroups) {
    const minX = d3.min(nodes, (node) => node.diagramX) - 90;
    const maxX = d3.max(nodes, (node) => node.diagramX) + 90;
    const minY = d3.min(nodes, (node) => node.diagramY) - 38;
    const maxY = d3.max(nodes, (node) => node.diagramY) + 38;
    choiceLayer
      .append("rect")
      .attr("x", minX)
      .attr("y", minY)
      .attr("width", maxX - minX)
      .attr("height", maxY - minY)
      .attr("rx", 12);
    choiceLayer
      .append("text")
      .attr("x", minX + 12)
      .attr("y", minY + 17)
      .text("CHOOSE ONE");
  }

  const links = root.links();
  layer
    .selectAll("path")
    .data(links)
    .join("path")
    .attr("class", (link) => `link${link.target.data.optional ? " optional" : ""}`)
    .attr(
      "d",
      d3
        .linkHorizontal()
        .x((node) => node.diagramX)
        .y((node) => node.diagramY),
    );

  const nodes = root.descendants().filter((node) => node.depth > 0);
  const node = layer
    .selectAll("g.node")
    .data(nodes, (item) => `${item.data.id}-${item.depth}-${item.diagramY}`)
    .join("g")
    .attr(
      "class",
      (item) =>
        `node ${item.data.kind}${item.data.optional ? " optional" : ""}`,
    )
    .attr("transform", (item) => `translate(${item.diagramX},${item.diagramY})`)
    .attr("tabindex", (item) => (item.data.kind === "course" ? 0 : null))
    .attr("role", (item) => (item.data.kind === "course" ? "button" : null))
    .attr("aria-label", (item) =>
      item.data.kind === "course" ? `Show ${item.data.label}` : item.data.label,
    )
    .on("click", (_, item) => {
      if (item.data.kind === "course" && state.courses[item.data.id]) {
        selectCourse(item.data.id);
      }
    })
    .on("keydown", (event, item) => {
      if (
        item.data.kind === "course" &&
        state.courses[item.data.id] &&
        (event.key === "Enter" || event.key === " ")
      ) {
        event.preventDefault();
        selectCourse(item.data.id);
      }
    });

  node.append("rect").attr("x", -76).attr("y", -18).attr("width", 152).attr("height", 36).attr("rx", 7);
  node.append("text").attr("dy", 4).text((item) => item.data.kind === "choice" ? item.data.label : item.data.id);
}

function renderDiagram() {
  diagram.replaceChildren();
  const left = layoutTree(prerequisiteTree(state.selectedCode), -1);
  const right = layoutTree(dependentTree(state.selectedCode), 1);
  const nodes = [...left.descendants(), ...right.descendants()];
  const xValues = nodes.map((node) => node.diagramX);
  const yValues = nodes.map((node) => node.diagramY);
  const padding = 160;
  const horizontalExtent = Math.max(...xValues.map(Math.abs), 0) + padding;
  const verticalExtent = Math.max(...yValues.map(Math.abs), 0) + padding;
  const viewBox = [
    -horizontalExtent,
    -verticalExtent,
    horizontalExtent * 2,
    verticalExtent * 2,
  ];

  const svg = d3
    .select(diagram)
    .append("svg")
    .attr("viewBox", viewBox.join(" "))
    .attr("role", "img")
    .attr("aria-label", `Prerequisite pathway for ${courseLabel(state.selectedCode)}`);
  const canvas = svg.append("g");
  svg.call(d3.zoom().scaleExtent([0.35, 8]).on("zoom", (event) => canvas.attr("transform", event.transform)));

  drawTree(canvas.append("g"), left);
  drawTree(canvas.append("g"), right);

  const center = canvas.append("g").attr("class", "node selected").attr("transform", "translate(0,0)");
  center.append("rect").attr("x", -84).attr("y", -22).attr("width", 168).attr("height", 44).attr("rx", 8);
  center.append("text").attr("dy", 4).text(state.selectedCode);
}

function updateSummary(course) {
  selectedCourse.textContent = `${course.display_code} — ${course.title}`;
  courseNotes.textContent = course.non_course_requirements.join(" ");
  catalogLink.href = catalogSearchUrl(course);
  catalogLink.hidden = false;
}

function selectCourse(code) {
  state.selectedCode = code;
  courseInput.value = state.courses[code].display_code;
  searchMessage.textContent = "";
  updateSummary(state.courses[code]);
  renderDiagram();
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = normalizeCode(courseInput.value);
  if (!state.courses[code]) {
    searchMessage.textContent = `No course data is available for “${courseInput.value.trim()}”.`;
    return;
  }
  selectCourse(code);
});

async function loadCourses() {
  try {
    const response = await fetch("data/courses.json");
    if (!response.ok) {
      throw new Error(`Course data could not be loaded (${response.status}).`);
    }
    const data = await response.json();
    state.catalogId = data.metadata.catalog_id;
    state.courses = data.courses;
    Object.values(state.courses)
      .sort((left, right) => left.display_code.localeCompare(right.display_code))
      .forEach((course) => {
        const option = document.createElement("option");
        option.value = course.display_code;
        option.label = course.title;
        courseCodes.append(option);
      });
    buildReverseIndex();
    selectCourse(state.courses.COMP2511 ? "COMP2511" : Object.keys(state.courses)[0]);
  } catch (error) {
    selectedCourse.textContent = "Course data unavailable";
    searchMessage.textContent = error.message;
    catalogLink.hidden = true;
  }
}

loadCourses();
