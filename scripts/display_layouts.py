from __future__ import annotations

import base64
import json
import math
from io import BytesIO
from pathlib import Path
from typing import Iterable, Optional

import matplotlib.pyplot as plt
import networkx as nx
from IPython.display import HTML, display


def _smallest_internal_angle(a, b, c) -> Optional[float]:
    ax, ay = a
    bx, by = b
    cx, cy = c

    v1 = (ax - bx, ay - by)
    v2 = (cx - bx, cy - by)

    n1 = math.hypot(v1[0], v1[1])
    n2 = math.hypot(v2[0], v2[1])
    if n1 == 0 or n2 == 0:
        return None

    dot = v1[0] * v2[0] + v1[1] * v2[1]
    cos_val = max(-1.0, min(1.0, dot / (n1 * n2)))
    angle_deg = math.degrees(math.acos(cos_val))
    return angle_deg


def _build_graph(plan: dict) -> nx.Graph:
    graph = nx.Graph()

    room_centers = {}
    for room in plan["rooms"]:
        center = room.get("centroid")
        graph.add_node(room["name"], centroid=center)
        room_centers[room["name"]] = center

    door_centers = {}
    for door in plan.get("door_centers", []):
        door_centers[door["name"]] = door.get("center")

    edge_meta = {}
    for ann in plan.get("edge_annotations", []):
        key = tuple(sorted([ann["from"], ann["to"]]))
        edge_meta.setdefault(key, []).append({
            "type": ann.get("type"),
            "via_door": ann.get("via_door"),
            "distance": ann.get("distance"),
        })

    for edge in plan["edges"]:
        distance = edge.get("distance")
        for src in edge["from"]:
            for dst in edge["to"]:
                if src == dst:
                    continue
                key = tuple(sorted([src, dst]))
                candidates = edge_meta.get(key, [])
                meta = {}
                if candidates:
                    # Берем аннотацию с ближайшей дистанцией к ребру из edges.
                    if isinstance(distance, (int, float)):
                        meta = min(
                            candidates,
                            key=lambda c: abs((c.get("distance") or 0) - distance),
                        )
                    else:
                        meta = candidates[0]
                door_name = meta.get("via_door")

                edge_type = meta.get("type")

                if edge_type == "direct":
                    angle = 180.0
                else:
                    src_center = room_centers.get(src)
                    dst_center = room_centers.get(dst)
                    door_center = door_centers.get(door_name) if door_name else None
                    if src_center and dst_center and door_center:
                        angle = _smallest_internal_angle(src_center, door_center, dst_center)
                    else:
                        angle = None

                graph.add_edge(
                    src,
                    dst,
                    distance=distance,
                    edge_type=edge_type,
                    via_door=door_name,
                    angle=angle,
                )

    return graph


def _graph_png_bytes(graph: nx.Graph, plan_id: str) -> bytes:
    fig, ax = plt.subplots(figsize=(7, 6))
    pos = nx.spring_layout(graph, seed=42)

    nx.draw_networkx_nodes(graph, pos, ax=ax, node_size=1700, node_color="#dbeafe")
    nx.draw_networkx_labels(graph, pos, ax=ax, font_size=10)
    nx.draw_networkx_edges(graph, pos, ax=ax, width=2, edge_color="#334155")

    edge_labels = {}
    for u, v, data in graph.edges(data=True):
        edge_type = data.get("edge_type") or "unknown"
        distance = data.get("distance")
        angle = data.get("angle")

        if isinstance(angle, (int, float)):
            angle_str = f"{angle:.1f}deg"
        else:
            angle_str = "-deg"

        if isinstance(distance, (int, float)):
            edge_labels[(u, v)] = f"{edge_type} | {distance:.1f} | {angle_str}"
        else:
            edge_labels[(u, v)] = f"{edge_type} | - | {angle_str}"

    nx.draw_networkx_edge_labels(graph, pos, edge_labels=edge_labels, ax=ax, font_size=8)
    ax.set_title(f"Graph {plan_id}")
    ax.axis("off")

    buffer = BytesIO()
    fig.savefig(buffer, format="png", dpi=140, bbox_inches="tight")
    plt.close(fig)
    return buffer.getvalue()


def _graph_png_base64(graph: nx.Graph, plan_id: str) -> str:
    return base64.b64encode(_graph_png_bytes(graph, plan_id)).decode("ascii")


def _try_svg_to_png(svg_text: str, out_png: Path) -> bool:
    """
    Best-effort SVG->PNG conversion.
    Returns True on success, False if conversion backend is unavailable.
    """
    try:
        import cairosvg  # type: ignore
    except Exception:
        return False

    cairosvg.svg2png(bytestring=svg_text.encode("utf-8"), write_to=str(out_png))
    return True


def _try_svg_to_png_bytes(svg_text: str) -> Optional[bytes]:
    try:
        import cairosvg  # type: ignore

        try:
            return cairosvg.svg2png(bytestring=svg_text.encode("utf-8"))
        except OSError:
            # Cairo shared library missing on some Windows setups.
            pass
    except Exception:
        pass

    # Fallback converter that does not rely on system cairo DLLs.
    try:
        from reportlab.graphics import renderPM  # type: ignore
        from svglib.svglib import svg2rlg  # type: ignore
    except Exception:
        return None

    try:
        drawing = svg2rlg(BytesIO(svg_text.encode("utf-8")))
        if drawing is None:
            return None
        return renderPM.drawToString(drawing, fmt="PNG")
    except Exception:
        return None


def _try_make_combined_png_bytes(svg_text: str, graph_png: bytes) -> Optional[bytes]:
    """
    Creates a single combined PNG (layout left + graph right).
    Requires cairosvg + Pillow. Returns PNG bytes or None if unavailable.
    """
    svg_png = _try_svg_to_png_bytes(svg_text)
    if svg_png is None:
        return None

    try:
        from PIL import Image  # type: ignore
    except Exception:
        return None

    layout_img = Image.open(BytesIO(svg_png)).convert("RGBA")
    graph_img = Image.open(BytesIO(graph_png)).convert("RGBA")

    target_h = max(layout_img.height, graph_img.height)
    if layout_img.height != target_h:
        layout_img = layout_img.resize((int(layout_img.width * (target_h / layout_img.height)), target_h))
    if graph_img.height != target_h:
        graph_img = graph_img.resize((int(graph_img.width * (target_h / graph_img.height)), target_h))

    combined = Image.new("RGBA", (layout_img.width + graph_img.width, target_h), (255, 255, 255, 255))
    combined.paste(layout_img, (0, 0), layout_img)
    combined.paste(graph_img, (layout_img.width, 0), graph_img)

    out = BytesIO()
    combined.convert("RGB").save(out, format="PNG")
    return out.getvalue()


def display_all_layouts(
    full_json_dir: str = "full_json",
    svg_root: str = "cubicasa5k/cubicasa5k/colorful",
    layout_ids: Optional[Iterable[str]] = None,
    output_dir: Optional[str] = None,
    save_combined_png: bool = True,
    flat_output: bool = True,
) -> None:
    """
    Показывает все планировки: слева SVG, справа граф связности.
    Вызов из Jupyter: display_all_layouts()
    """
    full_json_path = Path(full_json_dir)
    svg_root_path = Path(svg_root)
    out_root = Path(output_dir) if output_dir else None

    if layout_ids is None:
        json_files = sorted(full_json_path.glob("*.json"))
        ids = [p.stem for p in json_files]
    else:
        ids = [str(i) for i in layout_ids]

    for plan_id in ids:
        json_path = full_json_path / f"{plan_id}.json"
        svg_path = svg_root_path / plan_id / "model.svg"

        plan = json.loads(json_path.read_text(encoding="utf-8"))
        graph = _build_graph(plan)

        svg_markup = svg_path.read_text(encoding="utf-8")
        graph_png_bytes = _graph_png_bytes(graph, plan_id)
        graph_png_b64 = base64.b64encode(graph_png_bytes).decode("ascii")

        if out_root is not None:
            out_root.mkdir(parents=True, exist_ok=True)
            if save_combined_png:
                combined_bytes = _try_make_combined_png_bytes(svg_markup, graph_png_bytes)
                if combined_bytes is not None:
                    if flat_output:
                        out_path = out_root / f"{plan_id}.png"
                    else:
                        plan_out = out_root / str(plan_id)
                        plan_out.mkdir(parents=True, exist_ok=True)
                        out_path = plan_out / "combined.png"
                    out_path.write_bytes(combined_bytes)
                else:
                    # Fallback: сохраняем двумя файлами (плоско, без подпапок).
                    if flat_output:
                        (out_root / f"{plan_id}.svg").write_text(svg_markup, encoding="utf-8")
                        (out_root / f"{plan_id}_graph.png").write_bytes(graph_png_bytes)
                    else:
                        plan_out = out_root / str(plan_id)
                        plan_out.mkdir(parents=True, exist_ok=True)
                        (plan_out / "layout.svg").write_text(svg_markup, encoding="utf-8")
                        (plan_out / "graph.png").write_bytes(graph_png_bytes)

        html = f"""
        <div style="margin: 12px 0 24px 0;">
          <div style="font-weight: 600; margin-bottom: 8px;">plan_id: {plan_id}</div>
          <div style="display: flex; gap: 16px; align-items: flex-start;">
            <div style="flex: 1; min-width: 420px; border: 1px solid #ddd; padding: 6px;">
              {svg_markup}
            </div>
            <div style="flex: 1; min-width: 420px; border: 1px solid #ddd; padding: 6px;">
              <img src="data:image/png;base64,{graph_png_b64}" style="width: 100%; height: auto;" />
            </div>
          </div>
        </div>
        """
        display(HTML(html))

