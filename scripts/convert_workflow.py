#!/usr/bin/env python3
"""Convert a ComfyUI *UI-format* workflow JSON into *API/prompt-format* JSON.

The API/prompt format is what ComfyUI's `POST /prompt` expects:

    { "<node_id>": { "class_type": "<type>",
                     "inputs": { "<name>": value | ["<src_node_id>", <src_slot>] } }, ... }

This converter is offline (needs only the workflow file). It relies on the fact that modern
ComfyUI UI workflows list every widget as an entry in `node["inputs"]` with a `"widget"` key,
so widget *names* and *order* are authoritative and we do not need a running engine.

Usage:
    python scripts/convert_workflow.py <ui_workflow.json> <out_api.json>
"""
import json
import sys

# Values injected by the frontend for seed-like widgets (control_after_generate). These are a
# frontend concept and are NOT part of the API prompt, so we drop them.
CONTROL_KEYWORDS = {"fixed", "increment", "decrement", "randomize"}

# Node types that exist only in the editor and must not be sent to the backend.
UI_ONLY_TYPES = {"MarkdownNote", "Note", "Reroute", "PrimitiveNode"}


def build_link_map(workflow):
    """link_id -> [src_node_id_str, src_output_slot]."""
    link_map = {}
    for link in workflow.get("links", []):
        # [link_id, origin_id, origin_slot, target_id, target_slot, type]
        link_id, origin_id, origin_slot = link[0], link[1], link[2]
        link_map[link_id] = [str(origin_id), origin_slot]
    return link_map


def align_widget_values(names, values):
    """Pair widget names with widgets_values, tolerating control + trailing hidden values."""
    if isinstance(values, dict):
        return [(n, values[n]) for n in names if n in values]
    values = list(values or [])
    result = []
    vi = 0
    for name in names:
        if vi >= len(values):
            break
        result.append((name, values[vi]))
        vi += 1
        # If there is a surplus value that is a control keyword, consume (skip) it.
        remaining_values = len(values) - vi
        remaining_names = len(names) - len(result)
        if remaining_values > remaining_names and vi < len(values):
            v = values[vi]
            if isinstance(v, str) and v in CONTROL_KEYWORDS:
                vi += 1
    return result


def convert(workflow):
    link_map = build_link_map(workflow)
    prompt = {}

    for node in workflow.get("nodes", []):
        ntype = node.get("type")
        if ntype in UI_ONLY_TYPES:
            continue
        if node.get("mode", 0) not in (0,):  # skip muted (2) / bypassed (4) nodes
            continue

        node_id = str(node["id"])
        node_inputs = node.get("inputs", []) or []

        inputs = {}
        # 1) linked inputs (connections)
        for inp in node_inputs:
            link = inp.get("link")
            if link is not None and link in link_map:
                inputs[inp["name"]] = link_map[link]

        # 2) widget inputs (in declared order)
        widget_names = [inp["name"] for inp in node_inputs if "widget" in inp]
        for name, value in align_widget_values(widget_names, node.get("widgets_values", [])):
            # A widget that is also currently linked keeps the link (do not overwrite).
            if name not in inputs:
                inputs[name] = value

        prompt[node_id] = {"class_type": ntype, "inputs": inputs}

    return prompt


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, "r", encoding="utf-8") as f:
        workflow = json.load(f)
    prompt = convert(workflow)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(prompt, f, indent=2, ensure_ascii=False)
    print(f"Converted {len(prompt)} nodes -> {dst}")


if __name__ == "__main__":
    main()
