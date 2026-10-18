// Batch selection for profile repositories and starred repositories.
const batchProfileMatch = location.pathname.match(/^\/([^/]+)\/?$/);
const batchTab = new URLSearchParams(location.search).get("tab");
const batchKind = batchTab === "stars" ? "stars" : (batchTab === "repositories" || batchTab === null ? "repos" : null);
const batchProfile = batchProfileMatch?.[1];
if (batchProfile && batchKind && !document.getElementById("gitea-batch-helper")) {
  const root=document.createElement("div");root.id="gitea-batch-helper";
  root.innerHTML='<button id="gitea-batch-button">↻ Mirror repositories</button><section id="gitea-batch-panel" hidden></section>';
  document.body.append(root);
  const button=root.querySelector("button"),panel=root.querySelector("section");
  const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const send=async m=>{const r=await chrome.runtime.sendMessage(m);if(r?.error)throw new Error(r.error);return r;};
  let items=[], selected=new Set(), progress=null, busy=false;
  const error=e=>{let node=panel.querySelector(".error");if(!node){node=document.createElement("div");node.className="error";panel.append(node);}node.textContent=e?.message||String(e);};
  const waiting=message=>{panel.innerHTML=`<p role="status">${esc(message)}</p><div class="error" role="alert"></div>`;};
  function preview(){
    panel.innerHTML=`<h3>${batchKind==="stars"?"Starred":"My"} repositories</h3><p>Select repositories, then click Start. No mirrors are created before confirmation.</p><div class="batch-toolbar"><button class="all">Select all</button><button class="none">Select none</button><span>${selected.size} / ${items.length} selected</span></div><ul class="batch-list">${items.map((r,i)=>`<li><label><input type="checkbox" data-index="${i}" ${selected.has(r.owner+"/"+r.name)?"checked":""}><span><b>${esc(r.owner)}/${esc(r.name)}</b><small>${esc(r.description)}</small></span></label></li>`).join("")||"<li>No repositories found.</li>"}</ul><div class="batch-toolbar"><button class="start" ${selected.size?"":"disabled"}>Start mirroring (${selected.size})</button><button class="reload">Refresh list</button></div><div class="error"></div>`;
    panel.querySelectorAll('input[type="checkbox"]').forEach(el=>el.onchange=()=>{const r=items[Number(el.dataset.index)],key=r.owner+"/"+r.name;el.checked?selected.add(key):selected.delete(key);preview();});
    panel.querySelector(".all").onclick=()=>{selected=new Set(items.map(r=>r.owner+"/"+r.name));preview();};
    panel.querySelector(".none").onclick=()=>{selected.clear();preview();};
    panel.querySelector(".reload").onclick=load;
    panel.querySelector(".start").onclick=async()=>{try{panel.querySelector(".start").disabled=true;await send({type:"start-batch",profile:batchProfile,kind:batchKind,selected:items.filter(r=>selected.has(r.owner+"/"+r.name))});progress=await send({type:"get-batch-progress"});renderProgress();}catch(e){error(e);}};
  }
  async function showReconnect(){
    try {
      const data=await send({type:"get-batch-profiles"});
      const choices=data.profiles||[];
      const issue=progress?.error||"Saved batch needs a Gitea profile.";
      panel.innerHTML=`<h3>Mirror queue paused</h3><p class="error">${esc(issue)}</p><p>Your saved queue is intact. Select the original Gitea destination to safely resume. No repositories will be deleted.</p><label for="gm-reconnect-profile">Gitea profile</label><select id="gm-reconnect-profile">${choices.map(p=>`<option value="${esc(p.id)}" ${p.id===data.activeProfileId?"selected":""}>${esc(p.name)} — ${esc(p.giteaUrl)}/${esc(p.giteaOwner)}</option>`).join("")}</select><div class="batch-toolbar"><button class="reconnect" ${choices.length?"":"disabled"}>Resume saved queue</button><button class="new-batch">New selection instead</button></div><p class="batch-note">Check the destination carefully. Older queues did not record their destination address.</p><div class="error" role="alert"></div>`;
      panel.querySelector(".reconnect").onclick=async()=>{try{const btn=panel.querySelector(".reconnect");btn.disabled=true;await send({type:"reconnect-batch",profileId:panel.querySelector("#gm-reconnect-profile").value});progress=await send({type:"get-batch-progress"});renderProgress();}catch(e){error(e);panel.querySelector(".reconnect").disabled=false;}};
      panel.querySelector(".new-batch").onclick=load;
    }catch(e){waiting("Cannot load saved queue profiles.");error(e);}
  }
  function renderProgress(){
    if(!progress)return preview();
    if(progress.error && !progress.running){void showReconnect();return;}
    const pct=progress.total?Math.round(progress.processed*100/progress.total):100;
    panel.innerHTML=`<h3>Mirror queue — ${progress.running?"Running":"Completed"}</h3><p>${progress.processed}/${progress.total} processed (${pct}%). ${progress.queued} awaiting verification, ${progress.mirrored} registered mirrors, ${progress.existing} existing, ${progress.failed} failed.</p><div class="mirror-progress"><i style="width:${pct}%"></i></div><p>Current: ${esc(progress.current||"None")}</p><p class="batch-note">A registered mirror may still be cloning on Gitea. Requests have a 60-second timeout and the queue resumes after Chrome suspends it.</p><div class="batch-toolbar">${progress.running?'<button class="cancel-current">Cancel current request</button><button class="skip-remaining">Skip remaining</button>':'<button class="new-batch">New selection</button>'}</div><ul class="batch-list">${progress.items.map(r=>`<li><span class="mirror-state ${esc(r.status)}">${esc(r.status)}</span> ${esc(r.owner)}/${esc(r.name)} ${r.status==="pending"?`<button class="skip" data-key="${esc(r.owner+"/"+r.name)}">Skip</button>`:""}${r.error?`<small>${esc(r.error)}</small>`:""}${r.note?`<small>${esc(r.note)}</small>`:""}</li>`).join("")}</ul><div class="error"></div>`;
    panel.querySelector(".new-batch")?.addEventListener("click",load);
    for(const action of ["cancel-current","skip-remaining"]){panel.querySelector("."+action)?.addEventListener("click",async()=>{try{await send({type:"control-batch",action});}catch(e){error(e);}});}
    panel.querySelectorAll(".skip").forEach(el=>el.onclick=async()=>{try{await send({type:"control-batch",action:"skip",key:el.dataset.key});}catch(e){error(e);}});
  }
  async function load(){if(busy)return;busy=true;panel.innerHTML="<p>Loading GitHub repositories…</p>";try{const r=await send({type:"list-batch-repos",kind:batchKind,profile:batchProfile});items=r.items;selected=new Set(items.map(r=>r.owner+"/"+r.name));progress=null;preview();}catch(e){panel.innerHTML='<div class="error"></div><button class="retry">Retry</button>';error(e);panel.querySelector(".retry").onclick=load;}finally{busy=false;}}
  async function openBatch(){
    waiting("Loading mirror queue…");
    try {
      // A rejected message must be visible instead of leaving an empty popup.
      const saved=await Promise.race([
        send({type:"get-batch-progress"}),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error("Background worker did not respond within 10 seconds. Reload the extension and retry.")),10000))
      ]);
      if(panel.hidden)return;
      if(saved?.profile===batchProfile&&saved.kind===batchKind){progress=saved;renderProgress();}
      else await load();
    }catch(e){
      if(panel.hidden)return;
      waiting("Cannot load mirror queue.");error(e);
      const retry=document.createElement("button");retry.type="button";retry.textContent="Retry";
      retry.addEventListener("click",openBatch);panel.append(retry);
    }
  }
  button.onclick=()=>{panel.hidden=!panel.hidden;if(!panel.hidden)void openBatch();};
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==="local"&&changes.giteaBatchMirrorProgress){const p=changes.giteaBatchMirrorProgress.newValue;if(p?.profile===batchProfile&&p.kind===batchKind&&progress){progress=p;if(!panel.hidden)renderProgress();}}});
}

const starredProfile = new URLSearchParams(location.search).get("tab") === "stars" && location.pathname.match(/^\/([^/]+)\/?$/)?.[1];
if (starredProfile && !document.getElementById("gitea-batch-helper") && !document.getElementById("gitea-starred-mirror-helper")) {
  const root = document.createElement("div");
  root.id = "gitea-starred-mirror-helper";
  root.innerHTML = `<button id="gitea-starred-mirror-button">★ Mirror starred repositories</button><section id="gitea-starred-mirror-panel" hidden></section>`;
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
    const priority = { checking: 0, creating: 1, pending: 2, queued: 3, failed: 4, cancelled: 5, skipped: 6, mirrored: 7, existing: 8 };
    const visibleItems = [...progress.items].sort((left, right) => (priority[left.status] ?? 9) - (priority[right.status] ?? 9));
    const active = progress.items.find((item) => item.status === "checking" || item.status === "creating");
    const pendingCount = progress.items.filter((item) => item.status === "pending").length;
    panel.innerHTML = `<h3>Starred mirror dashboard</h3><div class="mirror-metrics"><strong>${coverage}%</strong><span>mirror coverage (${progress.mirrored + progress.queued}/${progress.total})</span><strong>${completion}%</strong><span>batch processed (${progress.processed}/${progress.total})</span></div><div class="mirror-progress"><i style="width:${completion}%"></i></div><p class="mirror-current">${progress.running ? `Now processing: <b>${escapeHtml(progress.current || "preparing next repository…")}</b>` : "Batch completed."}</p><div class="mirror-counts"><span>Existing mirrors: ${progress.mirrored}</span><span>Queued: ${progress.queued}</span><span>Non-mirror existing: ${progress.existing}</span><span>Skipped: ${progress.skipped || 0}</span><span>Cancelled: ${progress.cancelled || 0}</span><span>Failed: ${progress.failed}</span></div>${progress.running ? `<div class="starred-controls">${active ? `<button type="button" class="cancel-current">Cancel current mirror</button>` : ""}${pendingCount ? `<button type="button" class="skip-remaining">Skip ${pendingCount} remaining</button>` : ""}</div>` : ""}<h4>Repository list</h4><ul class="mirror-live-list">${visibleItems.map((item) => `<li><span class="mirror-state ${item.status}">${item.status}</span><span>${escapeHtml(item.owner)}/${escapeHtml(item.name)}</span>${item.status === "pending" && progress.running ? `<button type="button" class="skip-item" data-key="${escapeHtml(`${item.owner}/${item.name}`)}">Skip</button>` : ""}${item.error ? `<small>${escapeHtml(item.error)}</small>` : ""}</li>`).join("") || "<li>Waiting to start…</li>"}</ul>${progress.running ? "" : `<button type="button" class="start">Run again</button>`}<div class="error"></div>`;
    panel.querySelector(".start")?.addEventListener("click", start);
    const control = async (action, key, element) => {
      if (element) { element.disabled = true; element.textContent = "Updating…"; }
      const result = await chrome.runtime.sendMessage({ type: "control-starred-mirror", action, profile: starredProfile, key });
      if (result?.error) {
        const error = panel.querySelector(".error");
        if (error) error.textContent = result.error;
        if (element) { element.disabled = false; element.textContent = action === "cancel-current" ? "Cancel current mirror" : "Skip"; }
      }
    };
    panel.querySelector(".cancel-current")?.addEventListener("click", (event) => control("cancel-current", undefined, event.currentTarget));
    panel.querySelector(".skip-remaining")?.addEventListener("click", (event) => control("skip-remaining", undefined, event.currentTarget));
    panel.querySelectorAll(".skip-item").forEach((item) => item.addEventListener("click", (event) => control("skip", event.currentTarget.dataset.key, event.currentTarget)));
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
const pathMatch = location.pathname.match(/^\/([^/]+)\/([^/]+)\/?(?:$|tree\/|blob\/|issues|pulls|actions|commits|settings)/);
const githubReservedOwners = new Set(["settings", "notifications", "marketplace", "features", "topics", "orgs", "apps", "sponsors", "explore", "login", "signup", "site", "new", "search", "collections", "events", "about", "contact", "security", "pricing", "readme"]);
const match = nwo?.match(/^([^/]+)\/([^/]+)$/) || (pathMatch && !githubReservedOwners.has(pathMatch[1]) ? pathMatch : null);
if (!match && !starredProfile && !batchProfile && !document.getElementById("gitea-settings-helper")) {
  const root = document.createElement("div");
  root.id = "gitea-settings-helper";
  root.innerHTML = `<button id="gitea-settings-button" title="Gitea Mirror Helper settings">⚙</button><section id="gitea-settings-panel" hidden></section>`;
  document.body.append(root);
  const button = root.querySelector("button");
  const panel = root.querySelector("section");
  const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const render = (store, selectedId = store.activeProfileId) => {
    const profile = store.profiles.find((item) => item.id === selectedId) || {};
    panel.innerHTML = `<h3>⚙ Mirror profiles</h3><p>GitHub identity and Gitea destination can be different.</p><label>Active profile</label><select class="profile-select"><option value="">New profile…</option>${store.profiles.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selectedId ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select><form><input type="hidden" name="id" value="${escapeHtml(profile.id)}"><label>Profile name</label><input name="name" required value="${escapeHtml(profile.name)}" placeholder="Home Gitea"><label>Gitea URL</label><input name="giteaUrl" required value="${escapeHtml(profile.giteaUrl)}" placeholder="https://git.example.ir"><label>Gitea username / organization</label><input name="giteaOwner" required value="${escapeHtml(profile.giteaOwner)}"><label>Gitea access token</label><input name="giteaToken" type="password" required value="${escapeHtml(profile.giteaToken)}"><label>GitHub username (optional)</label><input name="githubUsername" value="${escapeHtml(profile.githubUsername)}" placeholder="used when no GitHub token is set"><label>GitHub token</label><input name="githubToken" type="password" value="${escapeHtml(profile.githubToken)}"><div class="settings-actions"><button type="submit">Save profile</button><button type="button" class="import">Import profile</button>${profile.id ? `<button type="button" class="export">Export profile</button>` : ""}</div><input class="import-file" type="file" accept="application/json,.json" hidden><div class="error"></div></form>`;
    panel.querySelector(".profile-select").onchange = async (event) => {
      const id = event.target.value;
      if (!id) return render(store, "");
      const updated = await chrome.runtime.sendMessage({ type: "activate-profile", id });
      render(updated, id);
    };
    panel.querySelector("form").onsubmit = async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const profileData = Object.fromEntries(new FormData(form).entries());
      try { const updated = await chrome.runtime.sendMessage({ type: "save-profile", profile: profileData }); render(updated, profileData.id || updated.activeProfileId); } catch (error) { form.querySelector(".error").textContent = error.message; }
    };
    panel.querySelector(".export")?.addEventListener("click", async () => {
      const exported = await chrome.runtime.sendMessage({ type: "export-profile", id: profile.id });
      const download = document.createElement("a");
      const exportUrl = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }));
      download.href = exportUrl;
      download.download = `${(profile.name || "gitea-mirror-profile").replace(/[^a-z0-9_-]/gi, "-")}.json`;
      download.click();
      setTimeout(() => URL.revokeObjectURL(exportUrl), 1000);
    });
    const importFile = panel.querySelector(".import-file");
    panel.querySelector(".import").addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", async () => {
      const error = panel.querySelector(".error");
      try {
        const source = importFile.files?.[0];
        if (!source) return;
        const parsed = JSON.parse(await source.text());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Choose a valid exported profile JSON file.");
        const imported = Object.fromEntries(["name", "giteaUrl", "giteaOwner", "giteaToken", "githubUsername", "githubToken"].map((field) => [field, typeof parsed[field] === "string" ? parsed[field] : ""]));
        if (!["giteaUrl", "giteaOwner", "giteaToken"].every((field) => typeof imported[field] === "string" && imported[field].trim())) throw new Error("The imported profile needs a Gitea URL, owner, and access token.");
        const updated = await chrome.runtime.sendMessage({ type: "save-profile", profile: imported });
        if (updated?.error) throw new Error(updated.error);
        render(updated, updated.activeProfileId);
      } catch (exception) {
        error.textContent = exception.message;
      } finally {
        importFile.value = "";
      }
    });
  };
  button.onclick = async () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) render(await chrome.runtime.sendMessage({ type: "get-profiles" }));
  };
}
if (match && !document.getElementById("gitea-mirror-helper")) {
  const repo = { owner: match[1], name: match[2] };
  const root = document.createElement("div");
  root.id = "gitea-mirror-helper";
  root.innerHTML = `<button id="gitea-mirror-button" data-state="loading" title="Gitea mirror">↻</button><section id="gitea-mirror-panel" hidden></section>`;
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
    panel.innerHTML = `<h3>Connect Gitea</h3><p>Tokens are stored only in this browser profile.</p><form><input type="hidden" name="id" value="${escapeHtml(prefill.id || "")}"><input type="hidden" name="name" value="${escapeHtml(prefill.name || "Default")}"><label>Gitea URL</label><input name="giteaUrl" placeholder="https://git.example.ir" required value="${escapeHtml(prefill.giteaUrl || "")}"><label>Gitea username / owner</label><input name="giteaOwner" placeholder="your-username" required value="${escapeHtml(prefill.giteaOwner || "")}"><label>Gitea access token</label><input name="giteaToken" type="password" required value="${escapeHtml(prefill.giteaToken || "")}"><label>GitHub username (optional)</label><input name="githubUsername" value="${escapeHtml(prefill.githubUsername || "")}"><label>GitHub token (for private repositories)</label><input name="githubToken" type="password" value="${escapeHtml(prefill.githubToken || "")}"><button>Save</button></form><div class="error">${escapeHtml(error)}</div>`;
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
