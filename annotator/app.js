const state = {
  planId: "",
  rooms: [],
  doors: [],
  edges: [],
  history: [],
  clickSequence: [],
  drag: null,
  suppressClickUntil: 0,
};

const els = {
  planId: document.getElementById("planId"),
  loadPlanBtn: document.getElementById("loadPlanBtn"),
  status: document.getElementById("status"),
  entityName: document.getElementById("entityName"),
  svgHost: document.getElementById("svgHost"),
  roomsList: document.getElementById("roomsList"),
  doorsList: document.getElementById("doorsList"),
  edgesList: document.getElementById("edgesList"),
  fromRoom: document.getElementById("fromRoom"),
  toRoom: document.getElementById("toRoom"),
  viaDoor: document.getElementById("viaDoor"),
  addDirectEdgeBtn: document.getElementById("addDirectEdgeBtn"),
  addDoorEdgeBtn: document.getElementById("addDoorEdgeBtn"),
  undoBtn: document.getElementById("undoBtn"),
  clearBtn: document.getElementById("clearBtn"),
  exportBtn: document.getElementById("exportBtn"),
};

function setStatus(text) {
  els.status.textContent = text;
}

function getMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : "room";
}

function pushHistory(snapshotLabel) {
  state.history.push({
    snapshotLabel,
    rooms: JSON.parse(JSON.stringify(state.rooms)),
    doors: JSON.parse(JSON.stringify(state.doors)),
    edges: JSON.parse(JSON.stringify(state.edges)),
  });
}

function undo() {
  const prev = state.history.pop();
  if (!prev) {
    setStatus("History empty.");
    return;
  }
  state.rooms = prev.rooms;
  state.doors = prev.doors;
  state.edges = prev.edges;
  state.clickSequence = [];
  redraw();
  setStatus(`Undo: ${prev.snapshotLabel}`);
}

function clearAll() {
  pushHistory("clear all");
  state.rooms = [];
  state.doors = [];
  state.edges = [];
  state.clickSequence = [];
  redraw();
  setStatus("Cleared all annotations.");
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Number(Math.hypot(dx, dy).toFixed(3));
}

function svgPointToPlanCoords(svg, clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const transformed = pt.matrixTransform(svg.getScreenCTM().inverse());
  return { x: Number(transformed.x.toFixed(3)), y: Number(transformed.y.toFixed(3)) };
}

function nearestPoint(points, x, y, maxDist = 30) {
  if (!points.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const p of points) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return bestDist <= maxDist ? best : null;
}

function addRoom(name, x, y) {
  pushHistory("add room");
  state.rooms.push({ id: `room_${state.rooms.length + 1}`, name, x, y });
  redraw();
}

function addDoor(name, x, y) {
  pushHistory("add door");
  state.doors.push({ id: `door_${state.doors.length + 1}`, name, x, y });
  redraw();
}

function pairKey(a, b) {
  return [a, b].sort((x, y) => x.localeCompare(y)).join("::");
}

function upsertEdge(nextEdge) {
  const key = pairKey(nextEdge.from, nextEdge.to);
  const existingIdx = state.edges.findIndex((e) => pairKey(e.from, e.to) === key);
  if (existingIdx === -1) {
    state.edges.push(nextEdge);
    return;
  }
  const existing = state.edges[existingIdx];
  // If there is a door connection for the same pair, keep it as canonical.
  if (nextEdge.type === "viaDoor" || existing.type !== "viaDoor") {
    state.edges[existingIdx] = nextEdge;
  }
}

function addDirectEdge(fromRoomName, toRoomName) {
  const a = state.rooms.find((r) => r.name === fromRoomName);
  const b = state.rooms.find((r) => r.name === toRoomName);
  if (!a || !b || a.name === b.name) {
    setStatus("Direct edge requires two different rooms.");
    return;
  }
  pushHistory("add direct edge");
  upsertEdge({
    id: `edge_${state.edges.length + 1}`,
    type: "direct",
    from: a.name,
    to: b.name,
    viaDoor: null,
    distance: distance(a, b),
  });
  redraw();
}

function addDoorEdge(fromRoomName, doorName, toRoomName) {
  const a = state.rooms.find((r) => r.name === fromRoomName);
  const d = state.doors.find((r) => r.name === doorName);
  const b = state.rooms.find((r) => r.name === toRoomName);
  if (!a || !d || !b || a.name === b.name) {
    setStatus("Door edge requires room -> door -> room.");
    return;
  }
  pushHistory("add edge via door");
  upsertEdge({
    id: `edge_${state.edges.length + 1}`,
    type: "viaDoor",
    from: a.name,
    to: b.name,
    viaDoor: d.name,
    distance: Number((distance(a, d) + distance(d, b)).toFixed(3)),
  });
  redraw();
}

function edgeJson() {
  return state.edges.map((e) => ({
    from: [e.from],
    to: [e.to],
    distance: e.distance,
  }));
}

function exportJson() {
  const payload = {
    plan_id: state.planId,
    edges: edgeJson(),
    rooms: state.rooms.map((r) => ({
      name: r.name,
      centroid: [r.x, r.y],
    })),
    door_centers: state.doors.map((d) => ({
      name: d.name,
      center: [d.x, d.y],
    })),
    edge_annotations: state.edges.map((e) => ({
      type: e.type,
      from: e.from,
      to: e.to,
      via_door: e.viaDoor,
      distance: e.distance,
    })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.planId || "plan"}_annotated.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus("JSON downloaded.");
}

function renderOptions(selectEl, items, placeholder) {
  selectEl.innerHTML = "";
  const initial = document.createElement("option");
  initial.value = "";
  initial.textContent = placeholder;
  selectEl.appendChild(initial);
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.name;
    option.textContent = item.name;
    selectEl.appendChild(option);
  }
}

function redrawOverlay(svg) {
  const prev = svg.querySelector("#annotator-overlay");
  if (prev) prev.remove();

  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
  overlay.setAttribute("id", "annotator-overlay");

  for (const e of state.edges) {
    const from = state.rooms.find((r) => r.name === e.from);
    const to = state.rooms.find((r) => r.name === e.to);
    if (!from || !to) continue;

    if (e.type === "direct") {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", from.x);
      line.setAttribute("y1", from.y);
      line.setAttribute("x2", to.x);
      line.setAttribute("y2", to.y);
      line.setAttribute("stroke", "#00d084");
      line.setAttribute("stroke-width", "4");
      line.setAttribute("stroke-opacity", "0.9");
      overlay.appendChild(line);
    } else {
      const door = state.doors.find((d) => d.name === e.viaDoor);
      if (!door) continue;
      const l1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
      l1.setAttribute("x1", from.x);
      l1.setAttribute("y1", from.y);
      l1.setAttribute("x2", door.x);
      l1.setAttribute("y2", door.y);
      l1.setAttribute("stroke", "#ffd43b");
      l1.setAttribute("stroke-width", "4");
      l1.setAttribute("stroke-opacity", "0.9");

      const l2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
      l2.setAttribute("x1", door.x);
      l2.setAttribute("y1", door.y);
      l2.setAttribute("x2", to.x);
      l2.setAttribute("y2", to.y);
      l2.setAttribute("stroke", "#ffd43b");
      l2.setAttribute("stroke-width", "4");
      l2.setAttribute("stroke-opacity", "0.9");
      overlay.appendChild(l1);
      overlay.appendChild(l2);
    }
  }

  for (const r of state.rooms) {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", r.x);
    c.setAttribute("cy", r.y);
    c.setAttribute("r", "8");
    c.setAttribute("fill", "#3b82f6");
    c.setAttribute("stroke", "#fff");
    c.setAttribute("stroke-width", "2");
    c.setAttribute("data-kind", "room");
    c.setAttribute("data-name", r.name);
    c.style.cursor = "move";
    overlay.appendChild(c);
  }

  for (const d of state.doors) {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", d.x);
    c.setAttribute("cy", d.y);
    c.setAttribute("r", "6");
    c.setAttribute("fill", "#ef4444");
    c.setAttribute("stroke", "#fff");
    c.setAttribute("stroke-width", "2");
    c.setAttribute("data-kind", "door");
    c.setAttribute("data-name", d.name);
    c.style.cursor = "move";
    overlay.appendChild(c);
  }

  svg.appendChild(overlay);
}

function redraw() {
  const svg = els.svgHost.querySelector("svg");
  if (!svg) return;
  redrawOverlay(svg);

  els.roomsList.innerHTML = state.rooms
    .map((r) => `<li>${r.name}: [${r.x}, ${r.y}]</li>`)
    .join("");
  els.doorsList.innerHTML = state.doors
    .map((d) => `<li>${d.name}: [${d.x}, ${d.y}]</li>`)
    .join("");
  els.edgesList.innerHTML = state.edges
    .map(
      (e) =>
        `<li>${e.type} | ${e.from} -> ${e.to}${e.viaDoor ? ` via ${e.viaDoor}` : ""} | ${e.distance}</li>`
    )
    .join("");

  renderOptions(els.fromRoom, state.rooms, "choose room");
  renderOptions(els.toRoom, state.rooms, "choose room");
  renderOptions(els.viaDoor, state.doors, "optional door");
}

async function loadJsonIfExists(planId) {
  try {
    const res = await fetch(`../json_new/${planId}.json`);
    if (!res.ok) return false;
    const data = await res.json();
    state.rooms = (data.rooms || []).map((r, idx) => ({
      id: `room_${idx + 1}`,
      name: r.name,
      x: r.centroid[0],
      y: r.centroid[1],
    }));
    state.edges = [];
    for (const e of data.edges || []) {
      upsertEdge({
        id: `edge_${state.edges.length + 1}`,
        type: "direct",
        from: e.from[0],
        to: e.to[0],
        viaDoor: null,
        distance: e.distance,
      });
    }
    state.doors = [];
    return true;
  } catch (_) {
    return false;
  }
}

async function loadSvg(planId) {
  const candidates = [
    `../cubicasa5k/cubicasa5k/colorful/${planId}/model.svg`,
    `../cubicasa5k/cubicasa5k/high_quality_architectural/${planId}/model.svg`,
  ];

  for (const path of candidates) {
    try {
      const res = await fetch(path);
      if (!res.ok) continue;
      const text = await res.text();
      els.svgHost.innerHTML = text;
      const svg = els.svgHost.querySelector("svg");
      if (!svg) continue;
      svg.style.cursor = "crosshair";
      svg.addEventListener("click", onSvgClick);
      svg.addEventListener("pointerdown", onSvgPointerDown);
      return path;
    } catch (_) {
      // no-op
    }
  }
  return null;
}

function onSvgPointerDown(evt) {
  const target = evt.target;
  if (!(target instanceof SVGCircleElement)) return;

  const kind = target.getAttribute("data-kind");
  const name = target.getAttribute("data-name");
  if (!kind || !name) return;

  const svg = els.svgHost.querySelector("svg");
  if (!svg) return;

  pushHistory(`move ${kind}`);
  const list = kind === "room" ? state.rooms : state.doors;
  const item = list.find((x) => x.name === name);
  if (!item) return;

  state.drag = { kind, name };
  evt.preventDefault();

  const onMove = (moveEvt) => {
    if (!state.drag) return;
    const p = svgPointToPlanCoords(svg, moveEvt.clientX, moveEvt.clientY);
    item.x = p.x;
    item.y = p.y;
    redraw();
  };

  const onUp = () => {
    state.drag = null;
    state.suppressClickUntil = Date.now() + 200;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function onSvgClick(evt) {
  if (Date.now() < state.suppressClickUntil) return;
  const svg = els.svgHost.querySelector("svg");
  if (!svg) return;
  const { x, y } = svgPointToPlanCoords(svg, evt.clientX, evt.clientY);
  const mode = getMode();

  if (mode === "room") {
    const name = (els.entityName.value || "").trim() || `room_${state.rooms.length + 1}`;
    addRoom(name, x, y);
    setStatus(`Room added: ${name}`);
    return;
  }

  if (mode === "door") {
    const name = (els.entityName.value || "").trim() || `door_${state.doors.length + 1}`;
    addDoor(name, x, y);
    setStatus(`Door added: ${name}`);
    return;
  }

  if (mode === "edgeDirect") {
    const picked = nearestPoint(state.rooms, x, y);
    if (!picked) {
      setStatus("Click closer to a room center point.");
      return;
    }
    state.clickSequence.push({ type: "room", name: picked.name });
    if (state.clickSequence.length === 2) {
      const [a, b] = state.clickSequence;
      state.clickSequence = [];
      addDirectEdge(a.name, b.name);
      setStatus(`Direct edge: ${a.name} -> ${b.name}`);
    } else {
      setStatus(`Selected first room: ${picked.name}`);
    }
    return;
  }

  if (mode === "edgeDoor") {
    const roomPick = nearestPoint(state.rooms, x, y);
    const doorPick = nearestPoint(state.doors, x, y);

    if (state.clickSequence.length === 0) {
      if (!roomPick) return setStatus("Step 1: click first room.");
      state.clickSequence.push({ type: "room", name: roomPick.name });
      return setStatus(`Step 1 done: ${roomPick.name}`);
    }
    if (state.clickSequence.length === 1) {
      if (!doorPick) return setStatus("Step 2: click door.");
      state.clickSequence.push({ type: "door", name: doorPick.name });
      return setStatus(`Step 2 done: ${doorPick.name}`);
    }
    if (state.clickSequence.length === 2) {
      if (!roomPick) return setStatus("Step 3: click second room.");
      const [a, d] = state.clickSequence;
      state.clickSequence = [];
      addDoorEdge(a.name, d.name, roomPick.name);
      return setStatus(`Via door edge: ${a.name} -> ${roomPick.name} via ${d.name}`);
    }
  }
}

async function loadPlan() {
  const planId = (els.planId.value || "").trim();
  if (!planId) {
    setStatus("Enter plan ID.");
    return;
  }
  state.planId = planId;
  state.rooms = [];
  state.doors = [];
  state.edges = [];
  state.history = [];
  state.clickSequence = [];

  setStatus("Loading SVG...");
  const path = await loadSvg(planId);
  if (!path) {
    setStatus("SVG not found for this plan ID.");
    return;
  }

  await loadJsonIfExists(planId);
  redraw();
  setStatus(`Loaded: ${path}`);
}

els.loadPlanBtn.addEventListener("click", loadPlan);
els.addDirectEdgeBtn.addEventListener("click", () => {
  addDirectEdge(els.fromRoom.value, els.toRoom.value);
});
els.addDoorEdgeBtn.addEventListener("click", () => {
  addDoorEdge(els.fromRoom.value, els.viaDoor.value, els.toRoom.value);
});
els.undoBtn.addEventListener("click", undo);
els.clearBtn.addEventListener("click", clearAll);
els.exportBtn.addEventListener("click", exportJson);
