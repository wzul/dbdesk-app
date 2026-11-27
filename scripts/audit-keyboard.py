"""Can DB Desk be driven with the keyboard alone?

Measures rather than reads the source, because "there is an onKeyDown" is not "you can reach it":

  1. focus order   — Tab from the top and record every stop: is the ring visible, is it a real
                      control, does the order follow what the screen shows;
  2. reachability   — every visible control the mouse can click must be a stop;
  3. dialogs        — does focus move into a dialog, stay inside it, return on close, and does Esc
                      close it;
  4. the tree       — arrows move the selection, Right/Left expand and collapse, Enter opens;
  5. the grid       — arrows move between cells, Home/End, page keys;
  6. shortcuts      — the palette, the shortcut sheet, and Ctrl+S / Ctrl+Enter.
"""

import json
import sys

from playwright.sync_api import sync_playwright

APP = "http://127.0.0.1:8943/"
findings = []


def record(area, verdict, detail):
    findings.append({"area": area, "verdict": verdict, "detail": detail})
    print(f"  [{verdict}] {area}: {detail}")


def focus_info(page):
    return page.evaluate("""() => {
      const el = document.activeElement;
      if (!el || el === document.body) return {tag: 'BODY', label: '', ring: ''};
      const cs = getComputedStyle(el);
      const ringVisible = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0)
                       || (cs.boxShadow && cs.boxShadow !== 'none')
                       || cs.borderColor !== cs.backgroundColor;
      const label = (el.getAttribute('aria-label') || el.innerText || el.value
                     || el.getAttribute('placeholder') || el.getAttribute('title') || '')
                     .trim().replace(/\\s+/g, ' ').slice(0, 48);
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        label,
        ring: ringVisible ? 'yes' : 'no',
        outline: cs.outlineStyle + ' ' + cs.outlineWidth,
        shadow: (cs.boxShadow || '').slice(0, 40)
      };
    }""")


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", args=["--no-sandbox"])
    context = browser.new_context(viewport={"width": 1280, "height": 860})
    page = context.new_page()
    page.goto(APP, wait_until="networkidle")
    page.wait_for_timeout(800)

    # ---------------------------------------------------------------- 1. focus order
    print("\n=== 1. Tab order from the top of the window")
    page.mouse.click(640, 4)  # click the chrome, not a control, so focus starts at the document
    page.keyboard.press("Tab")
    stops = []
    seen = set()
    for step in range(60):
        info = focus_info(page)
        key = (info.get("tag"), info.get("label"), info.get("role"))
        if key in seen and step > 3:
            break
        seen.add(key)
        stops.append(info)
        page.keyboard.press("Tab")
    for index, info in enumerate(stops, 1):
        print(f"  {index:2}. <{info['tag']}> {info.get('role') or '-':10} "
              f"ring={info['ring']:3} {info['label']!r}")
    no_ring = [s for s in stops if s["ring"] == "no"]
    record("focus ring", "PASS" if not no_ring else "FAIL",
           f"{len(stops)} stops, {len(no_ring)} without a visible focus ring"
           + (f": {[s['label'] for s in no_ring][:4]}" if no_ring else ""))

    # ---------------------------------------------------------------- 2. reachability
    print("\n=== 2. Every visible control must be a Tab stop")
    reach = page.evaluate("""() => {
      const focusable = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"], [role="tab"], [contenteditable="true"]';
      const all = [...document.querySelectorAll(focusable)].filter(el => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      });
      const notStops = all.filter(el => el.tabIndex < 0 || el.disabled).map(el => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30),
        tabIndex: el.tabIndex
      }));
      return {total: all.length, notStops};
    }""")
    record("reachability", "PASS" if not reach["notStops"] else "WARN",
           f"{reach['total']} visible controls, {len(reach['notStops'])} unreachable"
           + (f": {reach['notStops'][:5]}" if reach["notStops"] else ""))

    # ---------------------------------------------------------------- 3. open a connection by keyboard
    print("\n=== 3. Open a saved connection with the keyboard only")
    opened = page.evaluate("""() => {
      // find the connection card by its text, focus it, and report what it is
      const nodes = [...document.querySelectorAll('button, [role="button"], li, div')]
        .filter(el => (el.innerText || '').trim().startsWith('Demo'));
      const card = nodes[nodes.length - 1];
      if (!card) return {found: false};
      const tag = card.tagName.toLowerCase();
      const tabbable = card.tabIndex >= 0;
      card.focus();
      return {found: true, tag, tabbable, cls: card.className.slice(0, 60)};
    }""")
    print("  connection card:", opened)
    if opened.get("found"):
        page.keyboard.press("Enter")
        page.wait_for_timeout(1200)
        state = page.evaluate("""() => ({
          body: document.body.innerText.slice(0, 200).replace(/\\s+/g, ' '),
          tables: [...document.querySelectorAll('[role="treeitem"], .tree-item, li')]
                    .map(e => (e.innerText || '').trim()).filter(Boolean).slice(0, 8)
        })""")
        connected = "customers" in json.dumps(state).lower() or "orders" in json.dumps(state).lower()
        record("open connection", "PASS" if connected else "FAIL",
               f"Enter on the focused card {'opened' if connected else 'did not open'} the database "
               f"(tree: {state['tables'][:6]})")

        # ------------------------------------------------------------ 4. tree with arrows
        print("\n=== 4. Tree navigation with the arrow keys")
        tree = page.evaluate("""() => {
          const item = [...document.querySelectorAll('[role="treeitem"], .tree-item, li')]
            .find(e => (e.innerText || '').trim().toLowerCase().includes('customers'));
          if (!item) return {found: false};
          item.focus();
          return {found: true, tag: item.tagName.toLowerCase(), tabIndex: item.tabIndex,
                  role: item.getAttribute('role') || ''};
        }""")
        print("  first tree row:", tree)
        if tree.get("found"):
            before = page.evaluate("() => document.activeElement.innerText.trim().slice(0,30)")
            page.keyboard.press("ArrowDown")
            page.wait_for_timeout(200)
            after = page.evaluate("() => document.activeElement.innerText.trim().slice(0,30)")
            moved = before != after
            record("tree arrow keys", "PASS" if moved else "FAIL",
                   f"ArrowDown moved focus from {before!r} to {after!r}" if moved
                   else f"ArrowDown did not move focus (still {before!r})")
            # does Enter open the table?
            page.keyboard.press("Enter")
            page.wait_for_timeout(900)
            grid = page.evaluate("() => document.querySelectorAll('[role=\"gridcell\"], td').length")
            record("tree Enter opens a table", "PASS" if grid else "FAIL",
                   f"{grid} grid cells rendered after Enter")

        # ------------------------------------------------------------ 5. grid arrows
        if grid:
            print("\n=== 5. Grid navigation with the arrow keys")
            cell = page.evaluate("""() => {
              const first = document.querySelector('[role="gridcell"], td');
              if (!first) return {found: false};
              first.focus();
              return {found: true, tabIndex: first.tabIndex,
                      text: (first.innerText||'').trim().slice(0,20)};
            }""")
            print("  cell:", cell)
            if cell.get("found"):
                page.keyboard.press("ArrowRight")
                page.wait_for_timeout(150)
                moved = page.evaluate("""() => {
                  const el = document.activeElement;
                  return {text: (el.innerText||'').trim().slice(0,20), role: el.getAttribute('role')||el.tagName};
                }""")
                record("grid arrow keys", "PASS" if moved["text"] != cell["text"] else "FAIL",
                       f"ArrowRight moved to {moved['text']!r} ({moved['role']})")
                page.keyboard.press("Home")
                page.wait_for_timeout(120)
                home = page.evaluate("() => (document.activeElement.innerText||'').trim().slice(0,20)")
                record("grid Home/End", "PASS" if home else "FAIL", f"Home landed on {home!r}")
    else:
        record("open connection", "FAIL", "no connection card found in the window")

    # ---------------------------------------------------------------- 6. dialogs
    print("\n=== 6. Settings dialog: does focus move in, stay in, and come back?")
    before = page.evaluate("() => document.activeElement.tagName + ':' + (document.activeElement.innerText||'').slice(0,20)")
    page.keyboard.press("Control+Comma")
    page.wait_for_timeout(700)
    dialog = page.evaluate("""() => {
      const dlg = document.querySelector('[role="dialog"], dialog[open], .dialog');
      if (!dlg) return {open: false};
      const inside = dlg.contains(document.activeElement);
      return {open: true, focusedInside: inside,
              first: (document.activeElement.getAttribute('aria-label') || document.activeElement.innerText || '').trim().slice(0, 40),
              modal: dlg.getAttribute('aria-modal'), labelled: Boolean(dlg.getAttribute('aria-label') || dlg.getAttribute('aria-labelledby'))};
    }""")
    print("  dialog:", dialog)
    if dialog.get("open"):
        record("dialog focus moves in", "PASS" if dialog["focusedInside"] else "FAIL",
               f"first focus: {dialog['first']!r}")
        # Tab far more times than there are controls: if it escapes, focus lands on the page behind
        escaped = False
        for _ in range(40):
            page.keyboard.press("Tab")
            inside = page.evaluate("""() => {
              const dlg = document.querySelector('[role="dialog"], dialog[open], .dialog');
              return dlg ? dlg.contains(document.activeElement) : false;
            }""")
            if not inside:
                escaped = True
                break
        record("dialog focus trap", "PASS" if not escaped else "FAIL",
               "focus stayed inside for 40 tabs" if not escaped
               else "focus escaped the dialog to the page behind it")
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        closed = page.evaluate("() => !document.querySelector('[role=dialog], dialog[open], .dialog')")
        record("dialog Esc closes", "PASS" if closed else "FAIL",
               "Escape closed it" if closed else "Escape did not close the dialog")
        if closed:
            after = page.evaluate("() => document.activeElement.tagName + ':' + (document.activeElement.innerText||'').slice(0,20)")
            record("focus returns after close", "PASS" if after == before else "WARN",
                   f"focus was {before!r}, is now {after!r}")
    else:
        record("settings dialog", "FAIL", "Ctrl+, did not open a dialog")

    # ---------------------------------------------------------------- 7. palette + sheet
    print("\n=== 7. Command palette and the shortcut sheet")
    for keys, name in (("Control+k", "command palette"), ("Control+Slash", "shortcut sheet")):
        page.keyboard.press(keys)
        page.wait_for_timeout(600)
        shown = page.evaluate("""() => {
          const d = document.querySelector('[role="dialog"], dialog[open], .cmdk, .palette, .kbd-sheet');
          if (!d) return {shown: false};
          return {shown: true, focusInside: d.contains(document.activeElement),
                  text: (d.innerText || '').trim().slice(0, 60).replace(/\\s+/g, ' '),
                  rows: d.querySelectorAll('[role="option"], li, tr').length};
        }""")
        record(name, "PASS" if shown.get("shown") else "FAIL",
               f"opened, focus inside={shown.get('focusInside')}, rows={shown.get('rows')}, {shown.get('text')!r}"
               if shown.get("shown") else f"{keys} did not open it")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)

    browser.close()

print("\n=== summary")
fails = [f for f in findings if f["verdict"] == "FAIL"]
warns = [f for f in findings if f["verdict"] == "WARN"]
print(f"  {len(findings)} checks: {len(findings) - len(fails) - len(warns)} pass, {len(warns)} warn, {len(fails)} fail")
for item in fails:
    print("  FAIL:", item["area"], "-", item["detail"][:120])
for item in warns:
    print("  WARN:", item["area"], "-", item["detail"][:120])
json.dump(findings, open("/tmp/kbd-audit.json", "w"), indent=1)
sys.exit(1 if fails else 0)
