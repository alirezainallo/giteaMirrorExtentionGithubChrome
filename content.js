const starredProfile = new URLSearchParams(location.search).get("tab") === "stars" && location.pathname.match(/^\/([^/]+)\/?$/)?.[1];
if (starredProfile && !document.getElementById("gitea-starred-mirror-helper")) {
  const root = document.createElement("div");
  root.id = "gitea-starred-mirror-helper";
  root.innerHTML = `<button id="gitea-starred-mirror-button">⇄ Mirror starred repositories</button><section id="gitea-starred-mirror-panel" hidden></section>`;
  document.body.append(root);
  const button = root.querySelector("button");
  const panel = root.querySelector("section");
  button.onclick = () => {
    panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    panel.innerHTML = `<h3>Mirror all starred repositories?</h3><p>Existing Gitea mirrors will be skipped. New mirrors are created one at a time.</p><button type="button">Start mirroring</button><div class="error"></div>`;
    panel.querySelector("button").onclick = async () => {
      const start = panel.querySelector("button");
      const resultBox = panel.querySelector(".error");
      start.disabled = true;
      start.textContent = "Processing starred repositories…";
      const result = await chrome.runtime.sendMessage({ type: "mirror-starred", profile: starredProfile });
      if (result.error) {
        resultBox.textContent = result.error;
        start.disabled = false;
        start.textContent = "Start mirroring";
      } else {
        resultBox.style.color = "#1a7f37";
        resultBox.textContent = `Done: ${result.created} created, ${result.skipped} already mirrored/skipped, ${result.failed.length} failed.${result.failed.length ? `\n${result.failed.join("\n")}` : ""}`;
        start.textContent = "Completed";
      }
    };
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
  function settingsForm(error = "") {
    panel.innerHTML = `<h3>Connect Gitea</h3><p>Tokens are stored only in this browser profile.</p><form><label>Gitea URL</label><input name="giteaUrl" placeholder="https://git.example.ir" required><label>Gitea username / owner</label><input name="giteaOwner" placeholder="your-username" required><label>Gitea access token</label><input name="giteaToken" type="password" required><label>GitHub token (for private repositories)</label><input name="githubToken" type="password"><button>Save</button></form><div class="error">${escapeHtml(error)}</div>`;
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
    panel.innerHTML = `<h3>${button.title}</h3><p>${mirror?.mirror_updated ? `Last Gitea update: ${new Date(mirror.mirror_updated).toLocaleString()}` : ""}</p><div class="gitea-mirror-actions">${current.config ? `<a href="${current.config.giteaUrl}/${current.config.giteaOwner}/${repo.name}" target="_blank">Open Gitea mirror</a>` : ""}${canSync ? `<button type="button" class="sync">Update mirror now</button>` : ""}</div><div class="error"></div>`;
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
  };
  refresh();
}
