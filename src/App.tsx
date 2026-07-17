function App() {
  return (
    <main className="app-shell">
      <div className="ambient ambient-top" aria-hidden="true" />
      <div className="ambient ambient-bottom" aria-hidden="true" />

      <section className="status-card" aria-labelledby="app-title">
        <div className="status-line">
          <span className="status-dot" aria-hidden="true" />
          <span>Foundation ready</span>
        </div>

        <p className="eyebrow">Desktop intelligence, kept close</p>
        <h1 id="app-title">Codexly</h1>
        <p className="lede">
          The secure Electron foundation is running. Authentication, overlay,
          capture, and conversation surfaces arrive in the next milestones.
        </p>

        <dl className="baseline-grid">
          <div>
            <dt>Runtime</dt>
            <dd>Electron 42</dd>
          </div>
          <div>
            <dt>Transport</dt>
            <dd>Codex app server</dd>
          </div>
          <div>
            <dt>Security</dt>
            <dd>Isolated renderer</dd>
          </div>
        </dl>
      </section>
    </main>
  )
}

export default App
