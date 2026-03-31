/**
 * FloorPlanViewer.jsx — Phase 4+5
 *
 * Controls:
 *  - Floor selector
 *  - Grid resolution  (5 cm / 10 cm)
 *  - Manhattan snapping (Snapped / Raw)
 *  - Wall slab width   (Tight 0.25 m / Loose 0.35 m)  — Phase 5
 *  - Single "Detect" button → walls + openings + DXF export
 *  - Result badges: N walls · N doors · N windows
 *  - SVG preview (walls=cyan, doors=green, windows=magenta)
 *  - Download DXF
 */
import { useState, useCallback } from 'react'

const RESOLUTIONS = [
  { label: '5 cm (fine)',  value: 0.05 },
  { label: '10 cm (fast)', value: 0.10 },
]

const SLAB_OPTIONS = [
  { label: 'Tight  0.25 m', value: 0.25, hint: 'Fewer false positives' },
  { label: 'Loose  0.35 m', value: 0.35, hint: 'Catches more openings' },
]

export default function FloorPlanViewer({ modelInfo, onClose }) {
  const floors    = modelInfo?.floor_levels ?? []
  const numFloors = floors.length

  // ── State ────────────────────────────────────────────────────────────────
  const [selectedFloor, setSelectedFloor] = useState(0)
  const [resolution,    setResolution]    = useState(0.05)
  const [snapEnabled,   setSnapEnabled]   = useState(true)
  const [wallSlab,      setWallSlab]      = useState(0.25)

  const [status,     setStatus]     = useState('idle')   // idle|running|done|error
  const [result,     setResult]     = useState(null)     // { lines_count, n_doors, n_windows }
  const [svgUrl,     setSvgUrl]     = useState(null)
  const [dxfUrl,     setDxfUrl]     = useState(null)
  const [errorMsg,   setErrorMsg]   = useState('')

  // ── Run pipeline (walls + openings + DXF in one POST) ─────────────────────
  const runDetect = useCallback(async () => {
    setStatus('running')
    setResult(null)
    setSvgUrl(null)
    setDxfUrl(null)
    setErrorMsg('')

    try {
      const resp = await fetch('/api/walls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          floor_idx:       selectedFloor,
          grid_size:       resolution,
          snap_to_axis:    snapEnabled,
          wall_thickness:  wallSlab,
          detect_openings: true,
        }),
      })
      if (!resp.ok) {
        const err = await resp.json()
        throw new Error(err.detail || 'Detection failed')
      }

      const data = await resp.json()
      setResult(data)
      // Cache-bust so browser reloads the SVG
      setSvgUrl(`/api/walls/${selectedFloor}/svg?t=${Date.now()}`)
      setDxfUrl(`/api/walls/${selectedFloor}/download`)
      setStatus('done')
    } catch (e) {
      setErrorMsg(e.message)
      setStatus('error')
    }
  }, [selectedFloor, resolution, snapEnabled, wallSlab])

  const isRunning = status === 'running'

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="floorplan-viewer">

      {/* ── Header ── */}
      <div className="fpv-header">
        <div className="fpv-title">
          <span className="fpv-icon">📐</span>
          <span>Floor Plan Generator</span>
        </div>
        <button className="fpv-close" onClick={onClose} title="Close">✕</button>
      </div>

      {/* ── Controls ── */}
      <div className="fpv-controls">

        {/* Floor selector */}
        <div className="fpv-row">
          <label className="fpv-label">Floor</label>
          <div className="fpv-floor-tabs">
            {numFloors > 0
              ? Array.from({ length: numFloors }, (_, i) => (
                <button
                  key={i}
                  className={`fpv-tab ${selectedFloor === i ? 'active' : ''}`}
                  onClick={() => { setSelectedFloor(i); setStatus('idle'); setSvgUrl(null) }}
                  disabled={isRunning}
                >
                  Floor {i}
                </button>
              ))
              : <span className="fpv-dim">No floors detected</span>
            }
          </div>
        </div>

        {/* Grid resolution */}
        <div className="fpv-row">
          <label className="fpv-label">Grid Resolution</label>
          <div className="fpv-floor-tabs">
            {RESOLUTIONS.map(r => (
              <button
                key={r.value}
                className={`fpv-tab ${resolution === r.value ? 'active' : ''}`}
                onClick={() => setResolution(r.value)}
                disabled={isRunning}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Manhattan snap */}
        <div className="fpv-row fpv-snap-row">
          <label className="fpv-label">Manhattan Snap</label>
          <div className="fpv-snap-group">
            <button
              className={`fpv-snap-btn ${snapEnabled ? 'active' : ''}`}
              onClick={() => setSnapEnabled(true)}
              disabled={isRunning}
              title="Force all walls to exactly 0° or 90°"
            >
              ✓ Snapped
            </button>
            <button
              className={`fpv-snap-btn ${!snapEnabled ? 'active' : ''}`}
              onClick={() => setSnapEnabled(false)}
              disabled={isRunning}
              title="Keep raw detected angles"
            >
              ≈ Raw
            </button>
          </div>
          <span className="fpv-dim fpv-snap-hint">
            {snapEnabled ? 'Walls forced to 0°/90°' : 'Raw scan angles preserved'}
          </span>
        </div>

        {/* Wall slab width — Phase 5 */}
        <div className="fpv-row fpv-snap-row">
          <label className="fpv-label">Opening Detection Slab</label>
          <div className="fpv-snap-group">
            {SLAB_OPTIONS.map(s => (
              <button
                key={s.value}
                className={`fpv-snap-btn ${wallSlab === s.value ? 'active' : ''}`}
                onClick={() => setWallSlab(s.value)}
                disabled={isRunning}
                title={s.hint}
              >
                {s.label}
              </button>
            ))}
          </div>
          <span className="fpv-dim fpv-snap-hint">
            {wallSlab === 0.25 ? 'Tight — fewer false positives' : 'Loose — catches more openings'}
          </span>
        </div>

        {/* Run button */}
        <button
          className={`fpv-run-btn ${isRunning ? 'running' : ''}`}
          onClick={runDetect}
          disabled={isRunning || numFloors === 0}
        >
          {isRunning
            ? '⏳ Detecting walls & openings…'
            : '▶  Detect Walls & Generate DXF'
          }
        </button>

        {/* Result badges */}
        {status === 'done' && result && (
          <div className="fpv-result-col">
            <div className="fpv-result-row">
              <div className="fpv-badges">
                <span className="fpv-badge wall">🧱 {result.lines_count} walls</span>
                <span className="fpv-badge door">🚪 {result.n_doors} doors</span>
                <span className="fpv-badge window">🪟 {result.n_windows} windows</span>
              </div>
              <a
                className="fpv-dl-btn"
                href={dxfUrl}
                download={`floor_${selectedFloor}.dxf`}
              >
                ↓ DXF
              </a>
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="fpv-error">⚠ {errorMsg}</div>
        )}
      </div>

      {/* ── SVG Preview ── */}
      <div className="fpv-preview">
        {svgUrl ? (
          <>
            <div className="fpv-preview-label">
              Floor {selectedFloor} — {snapEnabled ? 'Manhattan Snapped' : 'Raw'}
              {result && ` · ${result.n_doors + result.n_windows} openings`}
            </div>
            <img
              className="fpv-svg"
              src={svgUrl}
              alt={`Floor ${selectedFloor} plan`}
            />
          </>
        ) : (
          <div className="fpv-placeholder">
            {isRunning
              ? <div className="fpv-spinner" />
              : <span>Configure settings above and click <strong>Detect Walls</strong></span>
            }
          </div>
        )}
      </div>
    </div>
  )
}
