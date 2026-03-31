import { useState } from 'react'

const FLOORS = [
  { label: 'Floor 1', color: '/model/colorplan_000.jpg',     ceiling: '/model/ceilingcolorplan_000.jpg' },
  { label: 'Floor 2', color: '/model/colorplan_001.jpg',     ceiling: '/model/ceilingcolorplan_001.jpg' },
]

export default function FloorPlanPanel({ floor, setFloor }) {
  const [view, setView] = useState('color') // 'color' | 'ceiling'
  const current = FLOORS[floor] ?? FLOORS[0]

  return (
    <div className="floorplan-panel">
      {/* Floor selector */}
      <div className="floorplan-tabs">
        {FLOORS.map((f, i) => (
          <button
            key={i}
            className={`fp-tab ${floor === i ? 'active' : ''}`}
            onClick={() => setFloor(i)}
          >
            {f.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button
          className={`fp-tab ${view === 'color' ? 'active' : ''}`}
          onClick={() => setView('color')}
        >
          Floor
        </button>
        <button
          className={`fp-tab ${view === 'ceiling' ? 'active' : ''}`}
          onClick={() => setView('ceiling')}
        >
          Ceiling
        </button>
      </div>

      <img
        className="floorplan-img"
        src={view === 'color' ? current.color : current.ceiling}
        alt={`${current.label} ${view} plan`}
        loading="lazy"
      />
    </div>
  )
}
