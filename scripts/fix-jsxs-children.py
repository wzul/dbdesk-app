"""Repair jsxs() calls that pass children as a third positional argument.

react/jsx-runtime exports jsxs(type, props, key) — the third argument is the *key*, not
children. A call shaped jsxs('div', {...props}, [a, b]) therefore renders an element with
no children at all: the array is stringified into the key and props.children stays
undefined. That silently blanked the keyboard-shortcuts sheet and any other spot the
same way, so move those arrays into props.children.

Only calls whose third argument is an array literal are touched; jsx(type, props, 'key')
is the correct keyed form and is left alone.
"""

import re
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else "/root/dbdesk-standalone/ui/src/plugin.js"
APPLY = "--apply" in sys.argv

src = open(PATH).read()


def call_span(text, open_paren):
    """Return (end_index, [arg spans]) for the call whose '(' is at open_paren."""
    depth = 0
    args = []
    start = open_paren + 1
    i = open_paren
    in_str = None
    while i < len(text):
        ch = text[i]
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == in_str:
                in_str = None
        elif ch in "\"'`":
            in_str = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth == 0:
                args.append((start, i))
                return i, args
        elif ch == "," and depth == 1:
            args.append((start, i))
            start = i + 1
        i += 1
    raise ValueError("unbalanced")


edits = []
for m in re.finditer(r"\bjsxs\(", src):
    open_paren = m.end() - 1
    end, spans = call_span(src, open_paren)
    if len(spans) < 3:
        continue
    extra = src[spans[2][0]:spans[2][1]].strip()
    if not extra.startswith("["):
        continue
    props = src[spans[1][0]:spans[1][1]].strip()
    if not (props.startswith("{") and props.endswith("}")):
        continue
    inner = props[1:-1]
    if re.search(r"(^|,)\s*children\s*:", inner):
        print("SKIP (props already has children):", src[: m.start()].count("\n") + 1)
        continue
    line = src[: m.start()].count("\n") + 1
    new_props = "{ children: " + extra + ", " + inner.lstrip() + "}"
    # Replace props *and* the stray positional argument in one go, otherwise the call
    # keeps both and React treats the array as the key.
    edits.append((spans[1][0], spans[-1][1], new_props, line))

print(f"{len(edits)} repair(s)")

if APPLY:
    out = src
    for start, stop, new_props, line in sorted(edits, key=lambda e: -e[0]):
        out = out[:start] + new_props + out[stop:]
    open(PATH, "w").write(out)
    print("written", PATH)
else:
    for start, stop, new_props, line in edits:
        print(line, "->", new_props[:70].replace("\n", " ") + "…")
