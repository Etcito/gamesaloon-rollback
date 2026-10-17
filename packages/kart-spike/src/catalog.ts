// The scenario catalogue both simulations are run through, and its result shape (JSON-serialisable).
import * as S from "./scenarios.ts";
import type { Scenario, SimDriver, TrackId, Trace } from "./scenarios.ts";
import type { TrackData } from "./track.ts";

export interface CatalogResult {
  /** metrics per scenario id */
  metrics: Record<string, unknown>;
  /** 20 Hz traces of kart 0 for a few scenarios (plots, regression) */
  traces: Record<string, ReturnType<typeof S.downsample>>;
  dt: number;
}

export function scenarios(topSpeed: number): { sc: Scenario; kind: "straight" | "turn" | "drift" | "wall" | "lap" | "bump" }[] {
  return [
    { sc: S.straight(), kind: "straight" },
    { sc: S.steadyTurn(1), kind: "turn" },
    { sc: S.steadyTurn(0.5), kind: "turn" },
    { sc: S.steadyTurn(-1), kind: "turn" },
    { sc: S.driftScenario(0.8), kind: "drift" },
    { sc: S.wallHit(0.08, topSpeed), kind: "wall" },
    { sc: S.wallHit(0.2, topSpeed), kind: "wall" },
    { sc: S.wallHit(0.5, topSpeed), kind: "wall" },
    { sc: S.lapScenario(topSpeed), kind: "lap" },
    { sc: S.bumpScenario(topSpeed), kind: "bump" },
  ];
}

export function runCatalog(makeDriver: (sc: Scenario) => SimDriver, tracks: Record<TrackId, TrackData>, topSpeed: number): CatalogResult {
  const metrics: Record<string, unknown> = {};
  const traces: CatalogResult["traces"] = {};
  let dt = 0;
  for (const { sc, kind } of scenarios(topSpeed)) {
    const track = tracks[sc.track];
    const driver = makeDriver(sc);
    dt = driver.dt;
    const tr: Trace = S.runScenario(driver, sc, track);
    switch (kind) {
      case "straight": metrics[sc.id] = S.straightMetrics(tr, topSpeed); break;
      case "turn": metrics[sc.id] = S.turnMetrics(tr); break;
      case "drift": metrics[sc.id] = S.driftMetrics(tr); break;
      case "wall": metrics[sc.id] = S.wallMetrics(tr, track); break;
      case "lap": metrics[sc.id] = S.lapMetrics(tr, track, 3); break;
      case "bump": metrics[sc.id] = S.bumpMetrics(tr); break;
    }
    if (kind !== "bump") traces[sc.id] = S.downsample(tr, 20, 0);
  }
  return { metrics, traces, dt };
}
