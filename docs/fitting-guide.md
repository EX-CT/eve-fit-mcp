# Fitting workflow with eve-fit-mcp

The engine is **stateless and deterministic**: every tool takes the complete fit and returns numbers that
match Pyfa. Pass the same fit again and you get identical output, so compare and replay freely
(`request_hash` identifies a normalised request).

## Fit inputs (every fit tool)
* `eft`: EFT text as the game or Pyfa exports it.
* `dna`: ship DNA (`587:2889;3:…::`) or a `<url=fitting:…>` link.
* `fit`: contract FitRequest JSON. Names may replace ids anywhere, e.g.
  `{"ship":"Rifter","modules":["200mm AutoCannon II, EMP S","Damage Control II"],"drones":["Warrior II x2"]}`.
* `skills`: 0–5, `all_4`, or `{default_level, levels:{"Gunnery":4}}`. **Default: all V.**
* `damage_profile` (incoming, for EHP) and `target_profile` (for applied DPS): preset names
  (`list_presets`) or explicit objects.
* `implant_set`: e.g. `"High-grade Crystal"`.

## Typical loop
1. `get_ship`: slots, hardpoints, CPU/PG/calibration with skills.
2. `search_types` with `fits_ship` and `slot`: candidate modules. Jargon works: mwd, ab, lse, dc, scram, point, web, sebo, tp, neut, nos, bcs, dda…
3. `compute_fit`: compact summary + `metrics`; `detail:"full"` for every engine field.
4. `validate_fit`: violations with module names and fix hints, plus missing skills.
5. Improve:
   * `what_if`: try specific changes (replace module #i, change ammo/state, skills, implants), deltas in one batch.
   * `suggest_modules`: rank every module for a slot by a goal (`dps`, `ehp`, `tank`, `speed`, `align`,
     `cap_stability`, `lock_range`, … or a weighted list), dropping candidates that break fitting.
   * `optimize_fit`: greedy search over free slots and swaps under constraints (`min:{cap_stability:0}`,
     `max:{signature:150}`, `meta_max`, `lock`).
6. `compare_fits`: side-by-side table of alternatives; `evaluate_profiles`: DPS vs frigate…battleship
   targets and EHP vs NPC damage types.
7. `export_fit`: EFT / DNA / multibuy. `skill_requirements`: what to train.

## Reading the numbers
* Units are in key suffixes: `_m`, `_s`, `_gj_s`, `_au_s`. Resonance 1 = no resist. Summaries show resists in %.
* `tank` = sustained effective repair + passive shield regen (EHP/s), limited by capacitor. `burst_tank`
  ignores capacitor.
* `cap_stability` is a single sortable score: the stable % when the cap is stable, otherwise −10000 / seconds
  until empty.
* Volley is spooled (Pyfa convention). Local nosferatu counts as cap income.
