import { ALGO_DEFAULTS } from "../algoParams";

function Slider({ label, hint, value, min, max, step, unit = "", precision = 2, defaultVal, onChange }) {
  const modified = Math.abs(value - defaultVal) > step * 0.5;
  return (
    <div className="s2f-slider">
      <div className="s2f-slider-top">
        <span className="s2f-slider-label">
          {label}
          {modified && <span className="s2f-mod">modified</span>}
        </span>
        <span className="s2f-slider-val">
          {Number(value).toFixed(precision)}
          {unit}
        </span>
      </div>
      {hint && <div className="s2f-hint">{hint}</div>}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function Switch({ label, hint, checked, onChange }) {
  return (
    <label className="s2f-switch-row">
      <span>
        <span className="s2f-slider-label">{label}</span>
        {hint && <span className="s2f-hint" style={{ display: "block" }}>{hint}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="s2f-switch" />
    </label>
  );
}

function Group({ title, children, onReset }) {
  return (
    <section className="s2f-group">
      <header className="s2f-group-title">
        <span>{title}</span>
        {onReset && (
          <button className="s2f-link" onClick={onReset} type="button">
            Reset
          </button>
        )}
      </header>
      <div className="s2f-group-body">{children}</div>
    </section>
  );
}

/**
 * sections: array of "stages" | "cleaning" | "detection" | "rooms"
 */
export default function AlgorithmSettings({ params, setParams, roomMode, setRoomMode, sections }) {
  const set = (k) => (v) => setParams((p) => ({ ...p, [k]: v }));
  const D = ALGO_DEFAULTS;
  const resetKeys = (keys) => () =>
    setParams((p) => {
      const n = { ...p };
      keys.forEach((k) => (n[k] = D[k]));
      return n;
    });

  return (
    <div className="s2f-algo">
      {sections.includes("stages") && (
        <Group title="Pipeline stages" onReset={resetKeys(["run_c2b", "run_slices", "detect_floors"])}>
          <Switch label="Cloud2BIM floor/slab detection" hint="Stages 3–4" checked={params.run_c2b} onChange={set("run_c2b")} />
          <Switch label="Extract wall slices" hint="Stage 5 — dense slices for wall detection" checked={params.run_slices} onChange={set("run_slices")} />
          <label className="s2f-field-row">
            <span className="s2f-slider-label">Only detect floors</span>
            <span className="s2f-hint">Comma separated indices, e.g. 0,1 — empty means all floors</span>
            <input
              className="s2f-input"
              value={params.detect_floors}
              placeholder="all"
              onChange={(e) => set("detect_floors")(e.target.value)}
            />
          </label>
        </Group>
      )}

      {sections.includes("cleaning") && (
        <Group title="Point cloud cleaning" onReset={resetKeys(["enable_cleaning", "clean_downsample_pct", "clean_span_min", "clean_span_max"])}>
          <Switch label="Enable cleaning" hint="Remove foreign objects" checked={params.enable_cleaning} onChange={set("enable_cleaning")} />
          {params.enable_cleaning && (
            <>
              <Slider label="Downsample" hint="Keep X % of points" value={params.clean_downsample_pct} min={1} max={100} step={1} unit="%" precision={0} defaultVal={D.clean_downsample_pct} onChange={set("clean_downsample_pct")} />
              <Slider label="Min wall height span" hint="Min share of storey height to retain" value={params.clean_span_min} min={0.5} max={1} step={0.05} defaultVal={D.clean_span_min} onChange={set("clean_span_min")} />
              <Slider label="Max wall height span" hint="Max share of room height to retain" value={params.clean_span_max} min={0.8} max={1.2} step={0.05} defaultVal={D.clean_span_max} onChange={set("clean_span_max")} />
            </>
          )}
        </Group>
      )}

      {sections.includes("detection") && (
        <Group
          title="Wall detection"
          onReset={() => {
            resetKeys(["grid_size", "threshold_frac", "min_wall_m", "max_wall_thickness", "dp_tolerance", "wall_reach_frac", "snap_to_axis"])();
          }}
        >
          <div>
            <div className="s2f-slider-label" style={{ marginBottom: 6 }}>Room shape</div>
            <div className="s2f-seg s2f-seg-full">
              {[
                { id: "polygon", label: "Polygon", hint: "True non-rectangular outlines" },
                { id: "rectangular", label: "Rectangular", hint: "Fast axis-aligned boxes" },
              ].map((o) => (
                <button key={o.id} className={roomMode === o.id ? "active" : ""} title={o.hint} onClick={() => setRoomMode(o.id)} type="button">
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <Slider label="Grid resolution" hint="Finer = more detail, slower" value={params.grid_size} min={0.01} max={0.1} step={0.005} unit=" m" defaultVal={D.grid_size} onChange={set("grid_size")} />
          <Slider label="Density threshold" hint="Lower = catch more walls" value={params.threshold_frac} min={0.001} max={0.05} step={0.001} precision={3} defaultVal={D.threshold_frac} onChange={set("threshold_frac")} />
          <Slider label="Min wall length" value={params.min_wall_m} min={0.1} max={2} step={0.05} unit=" m" defaultVal={D.min_wall_m} onChange={set("min_wall_m")} />
          <Slider label="Max wall thickness" value={params.max_wall_thickness} min={0.1} max={1.5} step={0.05} unit=" m" defaultVal={D.max_wall_thickness} onChange={set("max_wall_thickness")} />
          <Slider label="Simplification tolerance" value={params.dp_tolerance} min={0.01} max={0.2} step={0.005} unit=" m" precision={3} defaultVal={D.dp_tolerance} onChange={set("dp_tolerance")} />
          <Slider label="Wall height reach" hint="Min fraction of storey height" value={params.wall_reach_frac} min={0.1} max={1} step={0.05} defaultVal={D.wall_reach_frac} onChange={set("wall_reach_frac")} />
          <Switch label="Manhattan snap" hint="Force horizontal / vertical alignment" checked={params.snap_to_axis} onChange={set("snap_to_axis")} />
        </Group>
      )}

      {sections.includes("rooms") && (
        <Group title="Room detection" onReset={resetKeys(["wall_thickness", "extend_m", "min_seg_m", "min_room_m2", "min_room_width_m"])}>
          <Slider label="Wall thickness" value={params.wall_thickness} min={0.05} max={0.6} step={0.01} unit=" m" defaultVal={D.wall_thickness} onChange={set("wall_thickness")} />
          <Slider label="Wall extension" hint="Extend walls to close gaps" value={params.extend_m} min={0} max={1.5} step={0.05} unit=" m" defaultVal={D.extend_m} onChange={set("extend_m")} />
          <Slider label="Min segment length" value={params.min_seg_m} min={0.1} max={2} step={0.05} unit=" m" defaultVal={D.min_seg_m} onChange={set("min_seg_m")} />
          <Slider label="Min room area" value={params.min_room_m2} min={0.2} max={5} step={0.1} unit=" m²" precision={1} defaultVal={D.min_room_m2} onChange={set("min_room_m2")} />
          <Slider label="Min room width" value={params.min_room_width_m} min={0.2} max={2} step={0.05} unit=" m" defaultVal={D.min_room_width_m} onChange={set("min_room_width_m")} />
        </Group>
      )}
    </div>
  );
}

