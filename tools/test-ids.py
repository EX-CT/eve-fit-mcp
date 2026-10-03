#!/usr/bin/env python3
"""Regenerate docs/test-ids.json and docs/test-ids.md from the test titles in src/test/*.test.ts.
Existing entries keep their description (the title before ids were introduced) and inventory refs; new ids take the
current description. Inventory refs (eve-dogma-bench inventory/mcp-web-gaps.md / docs/19 item ids) are edited in
INVENTORY below or directly in test-ids.json (kept on regeneration)."""
import json, re, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = ["unit", "integration", "features", "adapters", "stats", "validation"]
INVENTORY = {
    "mcp.stats.defense-values": ["ENG-DEF-001", "UI-STAT-RST"],
    "mcp.stats.capacitor-values": ["ENG-CAP-001", "ENG-CAP-002", "UI-STAT-CAP"],
    "mcp.stats.navigation-values": ["ENG-NAV-001", "ENG-NAV-002 (partial)"],
    "mcp.stats.targeting-values": ["ENG-TGT-001", "ENG-TGT-004", "UI-STAT-TGT"],
    "mcp.stats.illegal-fit-computed": ["ENG-VAL-005", "ENG-VAL-001"],
    "mcp.stats.mining": ["ENG-OFF-006", "UI-STAT-MIN", "ENG-DRN-002"],
    "mcp.stats.remote-repair": ["ENG-PROJ-006", "UI-STAT-OUT"],
    "mcp.stats.remote-repair-spool": ["ENG-PROJ-006", "UI-STAT-OUT", "ENG-MOD-005"],
    "mcp.stats.bombing": ["ENG-OFF-007", "UI-STAT-BMB"],
    "mcp.stats.overheat": ["ENG-MOD-006", "ENG-MOD-007"],
    "mcp.stats.utility-modules": ["ENG-MISC-002"],
    "mcp.stats.drone-fighter-hp": ["ENG-DRN-003", "ENG-FTR-004"],
    "mcp.validation.charge-validity": ["ENG-VAL-006"],
    "mcp.validation.resource-overflow": ["ENG-VAL-001"],
    "mcp.validation.ship-restriction": ["ENG-VAL-003"],
    "mcp.validation.slots-hardpoints-groups": ["ENG-VAL-002", "ENG-VAL-003"],
    "mcp.validation.missing-skills": ["ENG-VAL-004"],
    "mcp.validation.validate-false": ["ENG-VAL-005", "UI-PREF-ENG (partial)"],
    "mcp.validation.allow-violations": ["ENG-VAL-005"],
    "mcp.integration.get-ship-traits": ["ENG-SHIP-006"],
    "mcp.integration.full-detail-sections": ["UI-STAT-CAP"],
    "mcp.features.projected-environment": ["ENG-PROJ-001", "ENG-ENV-001"],
    "mcp.features.mutated-fighters": ["ENG-FTR-001", "ENG-FTR-003", "ENG-MOD-008", "ENG-DEF-001"],
    "mcp.features.options-passthrough": ["UI-PREF-ENG", "ENG-MOD-004", "ENG-MOD-005", "ENG-DEF-004"],
    "mcp.features.security-status-passthrough": ["CHR-007 (partial)"],
    "mcp.features.security-status-value": ["CHR-007 (todo: engine lacks effect 6871)"],
    "mcp.features.second-dataset": ["SVC-004"],
    "mcp.features.second-dataset-runtime-engine": ["SVC-004"],
    "mcp.unit.empty-nested-arrays": ["ENG-PROJ-003", "ENG-FLT-002"],
    "mcp.unit.projected-fighter-default-quantity": ["ENG-PROJ-002"],
    "mcp.unit.price-inputs": ["ENG-PRICE-001"],
    "mcp.features.price-passthrough": ["ENG-PRICE-001", "PRC-003"],
    "mcp.features.price-fit-engine": ["ENG-PRICE-001", "PRC-002", "PRC-003"],
    "mcp.features.provenance": ["ENG-PRICE-001"],
    "mcp.features.batch-too-large-details": ["ENG-BATCH-001"],
    "mcp.features.compute-fit-full-verbatim": ["ENG-BATCH-001"],
    "mcp.features.batch-error-in-place": ["ENG-BATCH-001"],
    "mcp.features.builtin-profiles": ["ENG-BATCH-001"],
    "mcp.features.load-prices": ["ENG-PRICE-001"],
    "mcp.features.prices-env-latest": ["ENG-PRICE-001"],
    "mcp.unit.prices-flag": ["ENG-PRICE-001"],
    "mcp.unit.price-file-resolve": ["ENG-PRICE-001"],
    "mcp.unit.engine-error-details": ["ENG-BATCH-001"],
    "mcp.unit.batch-prepare": ["ENG-BATCH-001"],
    "mcp.unit.batch-table": ["ENG-BATCH-001"],
    "mcp.features.compute-batch": ["ENG-BATCH-001"],
}

title = re.compile(r'''\btest\(\s*(["'`])(mcp\.([a-z]+)\.[a-z0-9-]+): (.*?)\1''')
found = []
for f in sorted((ROOT / "src/test").glob("*.test.ts")):
    for m in title.finditer(f.read_text()):
        found.append({"id": m.group(2), "description": m.group(4).replace("\\\\", "\\"), "file": f"src/test/{f.name}"})
jp = ROOT / "docs/test-ids.json"
old = {t["id"]: t for t in json.loads(jp.read_text())["tests"]} if jp.exists() else {}
tests = []
for t in found:
    o = old.get(t["id"], {})
    e = {"id": t["id"], "description": o.get("description", t["description"]), "file": t["file"]}
    inv = INVENTORY.get(t["id"]) or o.get("inventory")
    if inv:
        e["inventory"] = inv
    tests.append(e)
fmt = "mcp.<file>.<slug>: <description>; file = " + "|".join(FILES)
jp.write_text(json.dumps({"schema": "mcp-test-ids/1", "format": fmt, "base": "64d6cd6", "tests": tests,
                          "suites": {"mcp-bench": {"tool": "tools/mcp-dogma-bench.py", "case_ids": "mcp-bench.<suite>.<case>",
                                                   "suites": ["core", "ext", "effects", "cap"]}}}, indent=1, ensure_ascii=False) + "\n")
rows = "\n".join(f"| `{t['id']}` | {t['description'].replace('|', '\\|')} | {', '.join(t.get('inventory', []))} |" for t in tests)
md = f"""# Test ids

Every `node --test` title in `src/test/*.test.ts` starts with a stable id, `mcp.<file>.<slug>: <description>`.
`<file>` is one of {", ".join(f"`{x}`" for x in FILES)}, and `<slug>` is short kebab-case. For tests that existed at base
`64d6cd6` the description is the title they had before ids were introduced, so references by description still match.
Cite tests by id (for example from eve-dogma-bench `inventory/tests.yaml`). Ids never change when a description is reworded.
`mcp.unit.test-ids` fails if a test has no id, names the wrong file, or reuses an id. Machine-readable list:
[`test-ids.json`](test-ids.json) (with the inventory item ids each test covers). Regenerate both with `python3 tools/test-ids.py`.

Bench replay suite **`mcp-bench`** (`tools/mcp-dogma-bench.py`, CI engine job): eve-dogma-bench core / ext / effects / cap cases
through `compute_fit detail:"full"`, case ids `mcp-bench.<suite>.<case>`, must match the engine run directly.

| id | description | inventory items |
|---|---|---|
{rows}
"""
(ROOT / "docs/test-ids.md").write_text(md)
print(len(tests), "tests;", sum(1 for t in tests if t["id"] not in old), "new")
