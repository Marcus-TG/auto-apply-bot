# Iso City

Isometric city-builder / logistics / front-line warfare game. The current build plays
on a 120x120 island — three handcrafted maps: **Open Plains** (one long border),
**Rift Valley** (a river with two mountain-flanked passes), and **Highland Marches**
(a wandering mountain range with three gaps of different widths plus a heartland
lake), chosen from the top-bar New-game picker or `?map=<id>` — with player and
enemy territory, supply depots,
divisions on opposing fronts, tick-based civilian production, local building storage,
three-tier truck logistics (Anno-style building-owned carts with direct factory-to-factory
delivery, player long-haul routes up to 4 stops, market/depot supply), a rail tier
(player-laid track, Train Stations, and 150-unit trains running station-to-station —
the OpenTTD bulk rung above trucks), residence tiers with
per-need fulfillment, attrition, combat, retreat, encirclement, an enemy nation that
recruits/builds/defends by the player's own rules, and a full victory/defeat screen.

Balance values are intentionally rough in places. Roads, ground, trucks, and tank
tokens are sprite assets from [Kenney](https://kenney.nl) CC0 packs (see `ASSETS.md`
for the pack list and licensing). Buildings currently render minimal-style: a colored
footprint outline plus a role badge — the building's output good or a
hub/market/military/population icon — so the map reads at a glance without hovering.
(A full sprite-building mode — barns, lumber piles, factory chimneys, supply crates —
exists behind the `BUILDING_STYLE` toggle in `src/render.ts`, awaiting a coherent
single-style art pass.)

## Run

```sh
npm install
npm run dev
```

Useful checks:

```sh
npm run build
npm run smoke
```

## Controls

- Click a palette item (building / Road / Truck) to enter placement mode; ghost preview
  shows green for valid placement and red for invalid placement.
- Left-click places the selected item; with a building selected, **drag to lay an
  Anno-style row** (footprint-stepped ghosts, only valid spots place). Placement mode
  stays active — right-click or `Escape` exits. `Alt`-click any placed building to
  copy its type into placement (the pipette).
- The **Demolish tool** (pinned next to the palette tabs, hotkey `X`) clears things
  Anno-style: click a building or a road tile to remove it, or drag a rectangle to
  clear everything inside (your buildings and roads; enemy property is untouched).
  Targets highlight red before you commit. `Delete`/`Backspace` also demolishes the
  selected building.
- Roads go on empty tiles. Buildings and roads can only be placed on your own territory
  (enemy land shows a red ghost). Trucks can only be placed on road tiles, and placing a
  truck selects it.
- Rail (hotkey `L`) lays track with the same rules as roads (own territory, no
  buildings). A rail across a road tile — or a road under existing track — makes a
  **level crossing**: both networks pass through it. Trains place on rail tiles and route
  between **Train Stations** only; trucks treat stations as normal route stops, so
  the interchange pattern is warehouse → truck → station → train → station → truck.
  Trains carry 3 goods types at 50 units each and cannot be raided.
- Click a truck to select it, then build its trade route: click logistics nodes
  (Warehouse, Market, Supply Depot, or Train Station) to add stops (up to 4 — real milk runs: one loop
  can feed two districts), then use the per-good chips on each stop to cycle Load /
  Unload / off. The small badge next to an active instruction sets an exact per-visit
  amount (blank = full); the ✕ beside a stop removes just that stop. Long-haul trucks
  carry up to 3 goods types per trip and only move what the route says — nothing is
  inferred. Production buildings each own one automatic cart (orange truck, Anno-style)
  that hauls to/from warehouses in range and nearby factories — no route concept there.
- Selecting a Warehouse or Market highlights the streets within its range in green
  (Anno-style — the road network it can serve or be served through); Supply Depots
  show their field-supply radius. The Warehouse command card shows tier, bays,
  road-connected buildings, live bay-queue congestion, and a per-good **Flow/tick**
  readout (green filling / red draining — the number a route plan needs), plus an
  Upgrade button (+1 bay) paid from road-reachable stock. Markets, Supply Depots,
  and Train Stations show the same Flow/tick readout on their cards.
- Click a division, building, or front tile to select it; the bottom-left command card
  is context-sensitive (truck: add escort / clear route; player front: toggle
  Hold/Advance stance, assign idle divisions, disband the front; player depot: recruit
  a division; player division: reinforce headcount / upgrade equipment tier / order
  retreat / disband for a partial manpower refund / front chips to reassign it to any
  player front or unassign it).
- With nothing selected, the Front Command card shows the war overview and diplomacy:
  Offer peace while at war (the enemy only accepts while its army is weaker), Declare
  war while at peace. The top bar always shows a Peace/War chip, and declarations
  raise a transient notification.
- `A` toggles the **Army Overview**: every division with condition (worst first),
  headcount, tier, and front; click one to select it and jump the camera there.
- `V` toggles the **Fleet Overview**: every truck and train with state, cargo, and
  stuck-vehicle notes (no path / enemy-held stop); click one to select and jump.
- The bottom-right minimap shows territory, roads, buildings, and division positions,
  plus a white outline marking the current camera view. Click it to jump the camera
  there (zooming in from full map view), or hold and drag to scrub across the map.
- Click Front, mark owned tiles, then press `Enter` to commit a player front. Unassigned
  player divisions are assigned to the new front.
- Select one of your Houses to see its needs and an Upgrade button: a House with every
  need met becomes a Townhouse (more population, adds a Clothing need) for Planks paid
  from a covering warehouse's reachable stock.
- Select one of your buildings and use its Demolish button to tear it down (no refund;
  a demolished building's cart despawns and routes drop the stop).
- Use Pause / 1x / 2x / 4x in the top bar, or keyboard shortcuts: `Space`, `1`, `2`, `3`.
- Save / Load in the top bar persist the whole game to one browser-storage slot:
  world, economy, armies, diplomacy, trucks and their routes, and the clock. Loading
  replaces the current session; trucks saved mid-drive re-path to their next stop.
- Hover a placed building for its recipe and local storage. The badge floating above
  each building shows its primary output good (producers) or role (hub / market /
  military supply / trade / population) in the same colors as the top-bar goods.

## Current Gameplay

- The economy has no spendable global resource pool. Buildings only use local
  input/output storage, and goods move by truck along roads in three tiers:
  - **Tier 1 (automatic, local — the Anno 1800 cart model)**: every production
    building owns one cart, and range works exactly as in Anno — it belongs to
    the *building* (20 tiles along the street network), never the warehouse. The
    cart hauls finished output to the closest warehouse **by road** with room —
    or hands it straight to a factory within its street range that needs the
    good, skipping the warehouse entirely — fetches missing recipe inputs from
    the closest warehouse stocking them, and drives home between errands.
    Warehouses are pure access points: tiers add loading bays only — when all
    bays are busy, carts queue visibly outside, so warehouse throughput is a
    felt constraint — and you extend coverage by building more warehouses along
    your streets, not by upgrading one hub. Direct factory-to-factory chains
    also work with no warehouse at all, which rewards Anno-style layout play.
  - **Tier 2 (player-assigned, long-haul)**: trucks running explicit trade routes —
    looping stop lists at Warehouses/Markets/Supply Depots with player-authored
    load/unload instructions per good (full or exact amounts), up to 3 goods types
    per trip at 20 units each — the bulk tier (carts stay small; long-haul trucks
    move district-scale loads). This is the layer raids threaten and escorts protect.
  - **Tier 3 (automatic, no truck)**: residences draw each need separately from
    the closest stocked Market **by road** within its street range (Houses need
    Food; Townhouses Food + Clothing) — a house with no street connection reaches
    no market at all, as in Anno. Divisions draw Ammo/Fuel/Clothing from a Supply
    Depot in radius — field supply stays area-based because divisions aren't on
    roads.
- Producers stall when local output storage reaches the cap (an isolated factory
  with no warehouse or consumer in range fills up and halts, as in Anno). Consumers
  stall when their local inputs are missing.
- Residences follow Anno's needs ladder: population scales with the fraction of needs
  currently met (full needs = full population, none = a small remnant), and a House
  with every need met can be upgraded to a Townhouse for Planks — more population, a
  new Clothing need. Production buildings consume labor slots before spare population
  turns into manpower; a building with no workers produces nothing and says so in its
  tooltip/command card.
- Supply Depots accept Ammo, Fuel, and Clothing. Divisions draw supply from nearby owned
  depots; full supply restores condition, partial or missing supply causes attrition. If
  the long-haul route feeding a depot breaks, the depot drains and its divisions starve.
- Fronts distribute assigned divisions across their front tiles. When opposing divisions
  occupy a tile, combat compares attacker strength against defender strength plus
  entrenchment.
- Starvation is attrition, not death: an unsupplied division bottoms out at 0% condition
  and stands its ground — it will lose any fight, and each lost fight pushes it back
  exactly one tile (all retreats move one tile, to the least-crowded adjacent friendly
  tile). A division is destroyed only when it breaks with no adjacent friendly tile to
  fall back to. Divisions below 50% condition cannot attack into enemy territory, so an
  army with cut supply stops advancing. A nation **capitulates** when it holds less
  than half the territory it started with (or loses every division) — conquering half
  the enemy homeland wins the war; losing half of yours loses it.
- Fronts track the live territorial boundary: winning fights and occupying ground flips
  tiles, and divisions redistribute onto the moved line. Fronts set to Advance push into
  adjacent enemy tiles where they currently have the strength edge.
- Capturing a tile also captures the building on it: taken enemy industry joins your
  economy (staffed by your labor, demolishable, depots recruitable) — and the same
  happens in reverse when the enemy takes your ground.
- War and peace: **the game opens at peace** — the HoI4-style build-up phase. At peace
  nothing fights, advances, annexes, or raids convoys; armies entrench and still consume
  supply, but a supply shortage only hollows a division out to a 40% condition floor
  (full starvation to 0% is wartime). The enemy never declares its first war before a
  grace period (~10 min at 1x) and only ever with a clear strength advantage — watch its
  division count grow and arm accordingly, or strike first. The enemy accepts peace only
  while losing, pulls back to its own territory on peace, and re-declares war after a
  truce if it rebuilds a clear strength advantage. Ordered retreats pull a division off
  its front to friendly ground; an ordered retreat with no escape route is cancelled and
  the division stays put instead of dying.
- Labor staffs the civilian loop first: producers of goods residences consume (Bakery,
  Tailor), then the civilian supply chains behind them, then military industry — a
  worker shortage slows the war effort instead of starving the city into a death spiral.
- A truck or train whose next stop was captured by the enemy parks with a note instead
  of delivering into enemy hands — reroute it (✕ the stop) or retake the ground.
- Loaded trucks near enemy territory can be raided (escort vs raider strength); escort
  points are bought with manpower per truck.
- Terrain is strategy: water and mountain tiles take no buildings, roads, or territory
  ownership, so no front forms across a river, an army pocketed against one is destroyed,
  and on Rift Valley the war funnels through two grass passes. Saves carry terrain, and
  the winner gets a full-screen Victory/Defeat banner (the game pauses; Continue returns
  to the frozen sandbox, New game reloads on the picked map).
- The enemy nation has a general on top of its minimal economy (heartland industry
  teleports output into its depots — capture the industry tiles or depots to starve it):
  it recruits divisions at its depots with the player's exact manpower + equipment
  costs (capped by frontage and by what its economy sustains), leapfrogs forward supply
  depots behind an advancing line, raises defensive fronts where its border is
  threatened, rebalances divisions onto unmanned fronts, and only orders an advance
  with a real strength advantage — otherwise it holds and entrenches. Its economy
  also grows: on a slow cadence it raises one new industry building for its scarcest
  war good, next to surviving industry districts and away from the border — so a
  partial capture heals over time, but capturing every factory breaks the enemy
  economy for good.

## Goods

| Good | Category |
| --- | --- |
| Wood | Civilian |
| Planks | Civilian |
| Wheat | Civilian |
| Food | Civilian |
| Clothing | Civilian |
| Ammo | Military |
| Fuel | Military |

## Buildings

| Building | Footprint | Role |
| --- | --- | --- |
| Lumberjack Hut | 2x2 | produces 1 Wood / tick |
| Sawmill | 4x2 | 2 Wood -> 1 Planks / tick |
| Farm | 4x4 | produces 1 Wheat / tick |
| Bakery | 2x2 | 2 Wheat -> 1 Food / tick |
| Tailor | 2x2 | 1 Planks -> 1 Clothing / tick |
| Munitions Works | 4x2 | 1 Planks -> 1 Ammo / tick |
| Fuel Refinery | 4x2 | 1 Wheat -> 1 Fuel / tick |
| Trade Post | 2x2 | allied trade: 1 Food + 1 Clothing -> 1 Ammo + 0.5 Fuel / tick |
| Warehouse | 4x4 | Tier 1 access point: buildings' carts deposit/fetch goods here (range is the building's, 20 tiles by road); tiers add loading bays |
| Train Station | 4x2 | rail interchange: stores all goods (150 cap); trains run station-to-station, trucks connect stations to the road network |
| Market | 2x2 | Tier 3 civilian node: stocks Food + Clothing, supplies road-connected residences within its street range (no truck for the last leg) |
| Supply Depot | 2x2 | Tier 3 military node: accepts Ammo, Fuel, and Clothing for nearby division supply |
| House | 2x2 | residence tier 1: population; needs Food from a Market in range; upgrades to Townhouse (4 Planks) when its needs are met |
| Townhouse | 2x2 | residence tier 2 (upgrade only): more population; needs Food + Clothing |

## Structure

- `src/buildings.ts` - building/recipe data and tuning constants
- `src/sim.ts` - tick-based production, house upkeep, labor allocation, manpower growth
- `src/world.ts` - grid occupancy, road + rail networks, terrain (water/mountain),
  placement rules, tile ownership
- `src/pathfinding.ts` - A* over road tiles and cached routes
- `src/units.ts` - generic `Unit` movement base, long-haul `Truck` (multi-cargo,
  bay-aware), and `Train` (same route logic on the rail network, bigger slots)
- `src/routes.ts` - vehicle-agnostic trade routes: stop list + load/unload instructions,
  stop execution and loop advance (shared by trucks and trains)
- `src/warehouse.ts` - Tier 1 Anno cart model (building-owned carts, nearest-warehouse
  and direct factory-to-factory errands, warehouse tiers, loading-bay queue) and the
  shared Tier 3 radius-supply helpers
- `src/military.ts` - divisions, fronts, supply, attrition, combat, retreat, win state
- `src/convoys.ts` - convoy raid resolution (escort vs raider strength) on truck routes
- `src/ai.ts` - the enemy nation: teleport economy (industry output into depots, manpower
  reinforcement) plus the general (recruiting, forward depots, defensive fronts, stances)
- `src/scenario.ts` - the handcrafted map registry (Open Plains, Rift Valley): terrain,
  territory, depots, industry, fronts, divisions
- `src/save.ts` - versioned whole-game save schema and capture/apply order (each
  system serializes/restores itself; cross-references travel as building uids)
- `src/render.ts` + `src/iso.ts` - PixiJS rendering and isometric math
- `src/assets.ts` + `src/bootstrap.ts` - sprite registry (building stack + piece
  compositions, role-badge icons, road connection tiles, vehicle frames, unit tokens)
  and the load-before-main entry point; `public/assets/` holds the sprite files,
  `ASSETS.md` the pack sources and licenses
- `src/hud.ts` - DOM top bar, palette, tooltip, info panel, time controls
- `src/main.ts` - wiring, input, selection, route/front assignment, game loop, debug hooks
- `scripts/smoke.mjs` - headless browser smoke test for the seeded scenario

Module boundaries that matter for later phases: `units.ts` and `pathfinding.ts` do not
import rendering or production code, so future unit types can reuse movement/pathing
without touching truck cargo logic. The top-bar resource counts are informational
city-wide totals (sum of local storages plus cargo in transit), not spendable global
stock.
