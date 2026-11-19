import { useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";

const BYTES_PER_GB = 1024 ** 3;

function formatGb(bytes, fixed = 2) {
  if (!bytes || bytes <= 0) return null;
  const gb = bytes / BYTES_PER_GB;
  return gb >= 10 ? gb.toFixed(1) : gb.toFixed(fixed);
}

/**
 * Invisible R3F helper placed inside <Canvas> to measure FPS via useFrame
 * and sample browser JS heap usage roughly twice per second.
 */
export function PerfFrameTracker({ onSample, active }) {
  const trackerRef = useRef({ frames: 0, last: 0 });

  useFrame(() => {
    const state = trackerRef.current;
    if (!active) {
      state.frames = 0;
      state.last = 0;
      return;
    }

    const now = performance.now();
    if (state.last === 0) {
      state.last = now;
      return;
    }

    state.frames += 1;
    const elapsed = now - state.last;
    if (elapsed >= 500) {
      if (elapsed < 5000) {
        const fps = Math.round((state.frames * 1000) / elapsed);
        const browserHeapBytes = window.performance?.memory?.usedJSHeapSize ?? 0;
        onSample({ fps, browserHeapBytes });
      }
      state.frames = 0;
      state.last = now;
    }
  });

  return null;
}

/**
 * Compact, hideable FPS & RAM readout overlaid on the 3D Viewer.
 */
export function PerfOverlay({ fps, browserHeapBytes, backendMemory, visible, onToggle }) {
  const [ramMode, setRamMode] = useState("app"); // "app" | "sys"

  if (!visible) {
    return (
      <button
        type="button"
        className="s2f-perf collapsed"
        onClick={onToggle}
        onPointerDown={(e) => e.stopPropagation()}
        title="Show performance metrics"
      >
        FPS
      </button>
    );
  }

  const procRssBytes = backendMemory?.proc_rss_bytes ?? 0;
  const sysUsedBytes = backendMemory?.sys_used_bytes ?? 0;
  const sysTotalBytes = backendMemory?.sys_total_bytes ?? 0;
  const appBytes = (browserHeapBytes || 0) + procRssBytes;

  const appGb = formatGb(appBytes, 2);
  const sysUsedGb = formatGb(sysUsedBytes, 1);
  const sysTotalGb = formatGb(sysTotalBytes, 1);

  const showingSys = ramMode === "sys" || (!appGb && Boolean(sysUsedGb));
  const ramLabel = showingSys ? "SYS" : "RAM";
  const ramValue = showingSys ? (sysUsedGb ?? "—") : (appGb ?? "—");

  const tooltipLines = [];
  if (appBytes > 0) {
    const parts = [];
    const jsGb = formatGb(browserHeapBytes, 2);
    const procGb = formatGb(procRssBytes, 2);
    if (jsGb) parts.push(`JS ${jsGb} GB`);
    if (procGb) parts.push(`Backend ${procGb} GB`);
    tooltipLines.push(`App RAM: ${appGb} GB${parts.length ? ` (${parts.join(" + ")})` : ""}`);
  } else {
    tooltipLines.push("App RAM: unavailable in this browser");
  }
  if (sysUsedGb) {
    tooltipLines.push(
      `System RAM: ${sysUsedGb}${sysTotalGb ? ` / ${sysTotalGb}` : ""} GB`
    );
  }
  tooltipLines.push("Click RAM to switch App / System");

  return (
    <div
      className="s2f-perf"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span>{fps != null ? fps : "—"} FPS</span>
      <span className="s2f-perf-sep">·</span>
      <button
        type="button"
        className="s2f-perf-ram"
        onClick={() => setRamMode((m) => (m === "app" ? "sys" : "app"))}
        title={tooltipLines.join("\n")}
      >
        {ramLabel} {ramValue !== "—" ? `${ramValue} GB` : "—"}
      </button>
      <button
        type="button"
        className="s2f-perf-btn"
        onClick={onToggle}
        title="Hide performance metrics"
        aria-label="Hide performance metrics"
      >
        ×
      </button>
    </div>
  );
}
