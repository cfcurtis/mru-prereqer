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
  d3.tree().nodeSize([58, 260])(root);
  const rootX = root.x;
  root.descendants().forEach((node) => {
    node.diagramX = node.y * direction;
    node.diagramY = node.x - rootX;
  });
  return root;
}

function deduplicateTree(root) {
  const occurrences = root.descendants();
  const canonicalById = new Map();

  for (const occurrence of occurrences) {
    const current = canonicalById.get(occurrence.data.id);
    if (
      !current ||
      occurrence.depth < current.depth ||
      (occurrence.depth === current.depth &&
        current.data.optional &&
        !occurrence.data.optional)
    ) {
      canonicalById.set(occurrence.data.id, occurrence);
    }
  }

  const nodes = [...canonicalById.values()].map((occurrence) => ({
    id: occurrence.data.id,
    label: occurrence.data.label,
    kind: occurrence.data.kind,
    optional: occurrences
      .filter((item) => item.data.id === occurrence.data.id)
      .every((item) => item.data.optional),
    depth: occurrence.depth,
    diagramX: occurrence.diagramX,
    diagramY: occurrence.diagramY,
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const linksByKey = new Map();

  for (const link of root.links()) {
    const source = byId.get(link.source.data.id);
    const target = byId.get(link.target.data.id);
    if (source === target) {
      continue;
    }
    const key = `${source.id}-${target.id}`;
    const existing = linksByKey.get(key);
    if (existing) {
      existing.optional &&= link.target.data.optional;
    } else {
      linksByKey.set(key, {
        source,
        target,
        optional: link.target.data.optional,
        choiceGroup: link.target.data.choiceGroup,
      });
    }
  }

  const columns = new Map();
  for (const node of nodes) {
    if (node.depth > 0) {
      const column = columns.get(node.depth) ?? [];
      column.push(node);
      columns.set(node.depth, column);
    }
  }

  for (const column of columns.values()) {
    const nodeIds = new Set(column.map((node) => node.id));
    const choiceBlocks = d3.groups(
      [...linksByKey.values()].filter(
        (link) => link.choiceGroup && nodeIds.has(link.target.id),
      ),
      (link) => link.choiceGroup,
    );
    const claimedNodes = new Set();
    const blocks = [];

    for (const [, links] of choiceBlocks) {
      const groupNodes = [...new Set(links.map((link) => link.target))].filter(
        (node) => node.depth === column[0].depth,
      );
      if (groupNodes.length < 2 || groupNodes.some((node) => claimedNodes.has(node))) {
        continue;
      }
      groupNodes.sort((left, right) => left.diagramY - right.diagramY);
      groupNodes.forEach((node) => claimedNodes.add(node));
      blocks.push({
        nodes: groupNodes,
        order: groupNodes[0].diagramY,
        isChoiceBlock: true,
      });
    }

    for (const node of column) {
      if (!claimedNodes.has(node)) {
        blocks.push({ nodes: [node], order: node.diagramY, isChoiceBlock: false });
      }
    }

    const orderedBlocks = blocks.sort((left, right) => left.order - right.order);
    const orderedNodes = [];
    let nextY = 0;
    for (const [index, block] of orderedBlocks.entries()) {
      for (const node of block.nodes) {
        node.diagramY = nextY;
        orderedNodes.push(node);
        nextY += 50;
      }
      const nextBlock = orderedBlocks[index + 1];
      if (nextBlock && (block.isChoiceBlock || nextBlock.isChoiceBlock)) {
        nextY += 40;
      }
    }
    const center = (orderedNodes[0].diagramY + orderedNodes.at(-1).diagramY) / 2;
    orderedNodes.forEach((node) => {
      node.diagramY -= center;
    });
  }

  return { nodes, links: [...linksByKey.values()] };
}

function relationshipPath(link) {
  const { source, target } = link;
  const sourceOffset = source.id === state.selectedCode ? 84 : 76;
  const targetOffset = target.id === state.selectedCode ? 84 : 76;
  if (source.diagramX !== target.diagramX) {
    const direction = Math.sign(target.diagramX - source.diagramX);
    return d3
      .linkHorizontal()
      .x((node) =>
        node === source
          ? node.diagramX + direction * sourceOffset
          : node.diagramX - direction * targetOffset,
      )
      .y((node) => node.diagramY)(link);
  }

  const side = source.diagramX < 0 ? -1 : 1;
  const laneX = source.diagramX + side * 156;
  return [
    `M${source.diagramX + side * sourceOffset},${source.diagramY}`,
    `C${laneX},${source.diagramY}`,
    `${laneX},${target.diagramY}`,
    `${target.diagramX + side * targetOffset},${target.diagramY}`,
  ].join(" ");
}

function drawTree(layer, graph, direction) {
  const choiceGroups = d3.groups(
    graph.links.filter((link) => link.choiceGroup),
    (link) => link.choiceGroup,
  );
  const choiceLayer = layer.append("g").attr("class", "choice-groups");
  for (const [, links] of choiceGroups) {
    const nodes = [...new Set(links.map((link) => link.target))];
    if (nodes.length < 2 || new Set(nodes.map((node) => node.depth)).size > 1) {
      continue;
    }
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

  layer
    .selectAll("path")
    .data(graph.links)
    .join("path")
    .attr("class", (link) => `link${link.optional ? " optional" : ""}`)
    .attr("d", (link) =>
      relationshipPath(direction < 0 ? { ...link, source: link.target, target: link.source } : link),
    )
    .attr("marker-end", (link) =>
      `url(#arrow-${link.optional ? "optional" : "required"})`,
    );

  const nodes = graph.nodes.filter((node) => node.depth > 0);
  const node = layer
    .selectAll("g.node")
    .data(nodes, (item) => item.id)
    .join("g")
    .attr(
      "class",
      (item) => `node ${item.kind}${item.optional ? " optional" : ""}`,
    )
    .attr("transform", (item) => `translate(${item.diagramX},${item.diagramY})`)
    .attr("tabindex", (item) => (item.kind === "course" ? 0 : null))
    .attr("role", (item) => (item.kind === "course" ? "button" : null))
    .attr("aria-label", (item) =>
      item.kind === "course" ? `Show ${item.label}` : item.label,
    )
    .on("click", (_, item) => {
      if (item.kind === "course" && state.courses[item.id]) {
        selectCourse(item.id);
      }
    })
    .on("keydown", (event, item) => {
      if (
        item.kind === "course" &&
        state.courses[item.id] &&
        (event.key === "Enter" || event.key === " ")
      ) {
        event.preventDefault();
        selectCourse(item.id);
      }
    });

  node.append("rect").attr("x", -76).attr("y", -18).attr("width", 152).attr("height", 36).attr("rx", 7);
  node.append("text").attr("dy", 4).text((item) => item.kind === "choice" ? item.label : item.id);
}

function renderDiagram() {
  diagram.replaceChildren();
  const left = deduplicateTree(layoutTree(prerequisiteTree(state.selectedCode), -1));
  const right = deduplicateTree(layoutTree(dependentTree(state.selectedCode), 1));
  const nodes = [...left.nodes, ...right.nodes];
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
  const defs = svg.append("defs");
  [
    ["required", "#5c967e"],
    ["optional", "#b26d12"],
  ].forEach(([name, color]) => {
    defs
      .append("marker")
      .attr("id", `arrow-${name}`)
      .attr("viewBox", "0 -4 8 8")
      .attr("refX", 8)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-4L8,0L0,4Z")
      .attr("fill", color);
  });
  const canvas = svg.append("g");
  svg.call(d3.zoom().scaleExtent([0.35, 8]).on("zoom", (event) => canvas.attr("transform", event.transform)));

  drawTree(canvas.append("g"), left, -1);
  drawTree(canvas.append("g"), right, 1);

  const center = canvas.append("g").attr("class", "node selected").attr("transform", "translate(0,0)");
  center.append("rect").attr("x", -84).attr("y", -22).attr("width", 168).attr("height", 44).attr("rx", 8);
  center.append("text").attr("dy", 4).text(state.selectedCode);
}

function updateSummary(course) {
  selectedCourse.textContent = `${course.display_code} — ${course.title}`;
  courseNotes.textContent = course.source_prerequisite_text ?? "";
  courseNotes.hidden = !course.source_prerequisite_text;
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
    selectCourse(state.courses.MATH2234 ? "MATH2234" : Object.keys(state.courses)[0]);
  } catch (error) {
    selectedCourse.textContent = "Course data unavailable";
    searchMessage.textContent = error.message;
    catalogLink.hidden = true;
  }
}

loadCourses();
