// Phase 1 placeholder: proves the toolchain, base path and data/ serving work end to end.
// Replaced by the real bootstrap in Phase 3/4.
const app = document.getElementById('app');
if (app) {
  app.innerHTML = `
    <main style="font-family: system-ui, sans-serif; padding: 2rem; max-width: 40rem;">
      <h1 style="margin:0"><span class="spv-wordmark">SPV</span> <small style="font-weight:normal;opacity:.7">Spatial Viewer</small></h1>
      <p>Scaffold is up. Manifest: <code id="spv-manifest">loading…</code></p>
    </main>`;
  const el = document.getElementById('spv-manifest')!;
  fetch(`${import.meta.env.BASE_URL}data/datasets.json`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((m: { datasets: { id: string; size_bytes: number }[] }) => {
      el.textContent = m.datasets
        .map((d) => `${d.id} (${(d.size_bytes / 1e6).toFixed(1)} MB)`)
        .join(', ');
    })
    .catch((e: Error) => {
      el.textContent = `failed: ${e.message}`;
    });
}
