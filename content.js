const starredProfile = new URLSearchParams(location.search).get("tab") === "stars" && location.pathname.match(/^\/([^/]+)\/?$/)?.[1];
if (starredProfile && !document.getElementById("gitea-starred-mirror-helper")) {
  const root = document.createElement("div");
  root.id = "gitea-starred-mirror-helper";
  root.innerHTML = `<button id="gitea-starred-mirror-button">⇄ Mirror starred repositories</button><section id="gitea-starred-mirror-panel" hidden></section>`;
  document.body.append(root);
  const button = root.querySelector("button");
  const panel = root.querySelector("section");
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  let progress = null;
  const render = () => {
    if (!progress || progress.profile !== starredProfile) {
      panel.innerHTML = `<h3>Mirror all starred repositories?</h3><p>Existing Gitea mirrors will be skipped. New mirrors are created one at a time.</p><button type="button" class="start">Start mirroring</button><div class="error"></div>`;
      panel.querySelector(".start").onclick = start;
      return;
    }
    const coverage = progress.total ? Math.round(((progress.mirrored + progress.queued) / progress.total) * 100) : 100;
    const completion = progress.total ? Math.round((progress.processed / progress.total) * 100) : 100;
    const visibleItems = progress.items.filter((item) => item.status !== "pending");
    panel.innerHTML = `<h3>Starred mirror dashboard</h3><div class="mirror-metrics"><strong>${coverage}%</strong><span>mirror coverage (${progress.mirrored + progress.queued}/${progress.total})</span><strong>${completion}%</strong><span>batch processed (${progress.processed}/${progress.total})</span></div><div class="mirror-progress"><i style="width:${completion}%"></i></div><p class="mirror-current">${progress.running ? `Now processing: <b>${escapeHtml(progress.current || "preparing next repository…")}</b>` : "Batch completed."}</p><div class="mirror-counts"><span>Existing mirrors: ${progress.mirrored}</span><span>Queued: ${progress.queued}</span><span>Non-mirror existing: ${progress.existing}</span><span>Failed: ${progress.failed}</span></div><h4>Live repository list</h4><ul class="mirror-live-list">${visibleItems.map((item) => `<li><span class="mirror-state ${item.status}">${item.status}</span><span>${escapeHtml(item.owner)}/${escapeHtml(item.name)}</span>${item.error ? `<small>${escapeHtml(item.error)}</small>` : ""}</li>`).join("") || "<li>Waiting to start…</li>"}</ul>${progress.running ? "" : `<button type="button" class="start">Run again</button>`}`;
    panel.querySelector(".start")?.addEventListener("click", start);
  };
  const start = async () => {
    const control = panel.querySelector(".start");
    if (control) { control.disabled = true; control.textContent = "Starting…"; }
    // The dashboard is updated through chrome.storage while this request remains open.
    chrome.runtime.sendMessage({ type: "mirror-starred", profile: starredProfile }).then(async (result) => {
      if (result?.alreadyRunning) {
        progress = await chrome.runtime.sendMessage({ type: "get-starred-progress" });
        render();
      } else if (result?.error) {
        const error = panel.querySelector(".error");
        if (error) error.textContent = result.error;
      }
    }).catch((error) => {
      const errorBox = panel.querySelector(".error");
      if (errorBox) errorBox.textContent = error.message;
    });
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.giteaStarredMirrorProgress) {
      progress = changes.giteaStarredMirrorProgress.newValue;
      if (!panel.hidden) render();
    }
  });
  button.onclick = () => {
    panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    chrome.runtime.sendMessage({ type: "get-starred-progress" }).then((saved) => { progress = saved; render(); });
  };
}

const nwo = document.querySelector('meta[name="octolytics-dimension-repository_nwo"]')?.content;
const match = nwo?.match(/^([^/]+)\/([^/]+)$/) || location.pathname.match(/^\/([^/]+)\/([^/]+)\/?(?:$|tree\/|blob\/|issues|pulls|actions|commits|settings)/);
if (match && !document.getElementById("gitea-mirror-helper")) {
  const repo = { owner: match[1], name: match[2] };
  const root = document.createElement("div");
  root.id = "gitea-mirror-helper";
  root.innerHTML = `<button id="gitea-mirror-button" data-state="loading" title="Gitea mirror">⇄</button><section id="gitea-mirror-panel" hidden></section>`;
  document.body.append(root);
  const button = root.querySelector("button");
  const panel = root.querySelector("section");
  let current;

  const request = (message) => chrome.runtime.sendMessage(message);
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const setState = (result) => {
    current = result;
    button.dataset.state = result.state;
    const labels = { fresh: "Mirror is up to date", stale: "Mirror needs an update", missing: "Not mirrored", setup: "Configure Gitea Mirror Helper", loading: "Checking mirror…" };
    button.title = labels[result.state] || "Gitea mirror";
  };
  async function refresh() {
    setState({ state: "loading" });
    const result = await request({ type: "status", repo });
    setState(result.error ? { state: "setup", error: result.error } : result);
  }
  function settingsForm(error = "", prefill = {}) {
    panel.innerHTML = `<h3>Connect Gitea</h3><p>Tokens are stored only in this browser profile.</p><form><label>Gitea URL</label><input name="giteaUrl" placeholder="https://git.example.ir" required value="${escapeHtml(prefill.giteaUrl || "")}"><label>Gitea username / owner</label><input name="giteaOwner" placeholder="your-username" required value="${escapeHtml(prefill.giteaOwner || "")}"><label>Gitea access token</label><input name="giteaToken" type="password" required value="${escapeHtml(prefill.giteaToken || "")}"><label>GitHub token (for private repositories)</label><input name="githubToken" type="password" value="${escapeHtml(prefill.githubToken || "")}"><button>Save</button></form><div class="error">${escapeHtml(error)}</div>`;
    panel.querySelector("button").onclick = async (event) => {
      event.preventDefault();
      const config = Object.fromEntries(new FormData(panel.querySelector("form")).entries());
      try { const result = await request({ type: "save-settings", config }); if (result.error) throw new Error(result.error); panel.hidden = true; refresh(); } catch (e) { settingsForm(e.message); }
    };
  }
  button.onclick = async () => {
    panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    if (current?.state === "setup") return settingsForm(current.error || "");
    if (current?.state === "missing") {
      panel.innerHTML = `<h3>Mirror ${repo.owner}/${repo.name}?</h3><p>A mirror will be created in your configured Gitea account.</p><button>Create mirror</button><div class="error"></div>`;
      panel.querySelector("button").onclick = async () => { const r = await request({ type: "mirror", repo }); if (r.error) panel.querySelector(".error").textContent = r.error; else { panel.innerHTML = `<p>Mirror creation has started. Gitea may need a moment to clone it.</p>`; setTimeout(refresh, 3000); } };
      return;
    }
    const mirror = current.mirrored;
    const canSync = current?.state === "stale";
    panel.innerHTML = `<h3>${button.title}</h3><p>${mirror?.mirror_updated ? `Last Gitea update: ${new Date(mirror.mirror_updated).toLocaleString()}` : ""}</p><div class="gitea-mirror-actions">${current.config ? `<a href="${current.config.giteaUrl}/${current.config.giteaOwner}/${repo.name}" target="_blank">Open Gitea mirror</a>` : ""}${canSync ? `<button type="button" class="sync">Update mirror now</button>` : ""}<button type="button" class="edit-settings">Edit settings</button></div><div class="error"></div>`;
    if (canSync) panel.querySelector(".sync").onclick = async () => {
      const syncButton = panel.querySelector(".sync");
      const error = panel.querySelector(".error");
      syncButton.disabled = true;
      syncButton.textContent = "Update requested…";
      const result = await request({ type: "sync-mirror", repo });
      if (result.error) {
        error.textContent = result.error;
        syncButton.disabled = false;
        syncButton.textContent = "Update mirror now";
      } else {
        error.style.color = "#1a7f37";
        error.textContent = "Gitea accepted the update request. Checking again shortly…";
        setTimeout(refresh, 3000);
      }
    };
    panel.querySelector(".edit-settings").onclick = () => settingsForm("", current.config);
  };
  refresh();
}
