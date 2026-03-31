export default function LoadingOverlay({ label, progress }) {
  return (
    <div className="loading-overlay">
      <div className="loading-ring" />
      <div className="loading-label">
        <strong>{label || 'Loading…'}</strong>
        <br />
        <span style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
          This may take a moment for large files
        </span>
      </div>
      {progress !== null && progress !== undefined && (
        <div className="loading-progress-bar">
          <div
            className="loading-progress-fill"
            style={{ width: `${Math.max(2, progress)}%` }}
          />
        </div>
      )}
    </div>
  )
}
