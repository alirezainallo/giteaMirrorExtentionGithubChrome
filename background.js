const SETTINGS_KEY = "giteaMirrorSettings";
const STARRED_PROGRESS_KEY = "giteaStarredMirrorProgress";
const BATCH_PROGRESS_KEY = "giteaBatchMirrorProgress";
const PROFILE_STORE_KEY = "giteaMirrorProfiles";
let activeStarredRun = null;

async function settings() {
  const result = await chrome.storage.local.get([SETTINGS_KEY, PROFILE_STORE_KEY]);
  const store = result[PROFILE_STORE_KEY];
  if (store?.profiles?.length) return store.profiles.find((profile) => profile.id === store.activeProfileId) || store.profiles[0];
  return result[SETTINGS_KEY] || null;
}

async function profileStore() {
  const result = await chrome.storage.local.get([SETTINGS_KEY, PROFILE_STORE_KEY]);
  if (result[PROFILE_STORE_KEY]?.profiles?.length) return result[PROFILE_STORE_KEY];
  const legacy = result[SETTINGS_KEY];
  return legacy ? { activeProfileId: "default", profiles: [{ id: "default", name: "Default", ...legacy }] } : { activeProfileId: null, profiles: [] };
}

async function saveProfile(profile, activate = true) {
  const store = await profileStore();
  const id = profile.id || crypto.randomUUID();
  const cleaned = { ...profile, id, name: profile.name?.trim() || "Unnamed profile", giteaUrl: profile.giteaUrl.replace(/\/+$/, "") };
  const index = store.profiles.findIndex((item) => item.id === id);
  if (index === -1) store.profiles.push(cleaned); else store.profiles[index] = cleaned;
  if (activate) store.activeProfileId = id;
  await chrome.storage.local.set({ [PROFILE_STORE_KEY]: store, [SETTINGS_KEY]: store.profiles.find((item) => item.id === store.activeProfileId) || cleaned });
  return store;
}

async function permitGitea(url) {
  const origin = new URL(url).origin + "/*";
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error("Permission to reach your Gitea server was not granted.");
}

function apiBase(url) {
  return url.replace(/\/+$/, "") + "/api/v1";
}

function targetUrl(config, repo) {
  const base = config.giteaUrl.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(config.giteaOwner)}/${encodeURIComponent(repo.name)}`;
}

async function giteaFetch(config, path, init = {}) {
  const response = await fetch(apiBase(config.giteaUrl) + path, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `token ${config.giteaToken}`,
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gitea (${response.status}): ${body || response.statusText}`);
  }
  if (response.status === 204) return null;
  const body = await response.text();
  return body.trim() ? JSON.parse(body) : null;
}

async function githubRepo(repo, token, signal) {
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const request = (accessToken) => fetch(url, {
    signal,
    headers: { Accept: "application/vnd.github+json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }
  });
  let response = await request(token);
  // A restricted fine-grained token can return 404 even for a public repo.
  // Retrying anonymously keeps public mirroring usable in that case.
  if (token && response.status === 404) response = await request("");
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("GitHub cannot access this repository. For a private repository, edit your fine-grained token and add this repository under Repository access (with Contents: Read), or use a classic token with repo scope.");
    }
    throw new Error(`GitHub (${response.status}): cannot read this repository`);
  }
  return response.json();
}

async function starredRepos(profile) {
  const config = await settings();
  const token = config?.githubToken;
  const endpoint = token
    ? "https://api.github.com/user/starred"
    : `https://api.github.com/users/${encodeURIComponent(config?.githubUsername || profile)}/starred`;
  const repositories = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`${endpoint}?per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
    });
    if (!response.ok) throw new Error(`GitHub (${response.status}): cannot list starred repositories`);
    const batch = await response.json();
    repositories.push(...batch.map((item) => ({ owner: item.owner.login, name: item.name })));
    if (batch.length < 100) return repositories;
  }
}

async function listGithubRepos(kind, profile) {
  const config = await settings();
  const token = config?.githubToken;
  const username = config?.githubUsername || profile;
  if (!username) throw new Error("Configure a GitHub username first.");
  const endpoint = kind === "stars" ? (token ? "https://api.github.com/user/starred" : `https://api.github.com/users/${encodeURIComponent(username)}/starred`) : `https://api.github.com/users/${encodeURIComponent(profile)}/repos`;
  const repositories = [];
  for (let page = 1; page <= 100; page++) {
    const response = await fetch(`${endpoint}?per_page=100&page=${page}&sort=updated`, { headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (!response.ok) throw new Error(`GitHub (${response.status}): cannot list repositories`);
    const batch = await response.json();
    repositories.push(...batch.map(item => ({ owner: item.owner.login, name: item.name, private: item.private, description: item.description || "" })));
    if (batch.length < 100) return repositories;
  }
  throw new Error("Repository list exceeded 10,000 items.");
}

// Durable MV3 batch runner: one repository per alarm, with recovery after worker suspension.
const BATCH_ALARM = "gitea-batch-next";
const VERIFY_ALARM = "gitea-batch-verify";
const REQUEST_TIMEOUT_MS = 60000;
let activeBatch = null;
let batchBusy = false;

async function saveBatch(progress) {
  progress.updatedAt = Date.now();
  await chrome.storage.local.set({ [BATCH_PROGRESS_KEY]: progress });
}
function recalcBatch(progress) {
  for (const key of ["processed", "mirrored", "queued", "existing", "failed", "skipped", "cancelled"]) progress[key] = 0;
  for (const item of progress.items) {
    if (item.status !== "pending" && item.status !== "checking" && item.status !== "creating") progress.processed++;
    if (["mirrored", "queued", "existing", "failed", "skipped", "cancelled"].includes(item.status)) progress[item.status]++;
  }
}
function batchDestination(config, repo) {
  return `/repos/${encodeURIComponent(config.giteaOwner)}/${encodeURIComponent(repo.name)}`;
}
async function lookupDestination(config, repo, signal) {
  const timeout = AbortSignal.timeout(15000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try { return await giteaFetch(config, batchDestination(config, repo), { signal: combined }); }
  catch (error) { if (error.message.startsWith("Gitea (404):")) return null; throw error; }
}
function scheduleBatch(delayMinutes = 0.02) {
  chrome.alarms.create(BATCH_ALARM, { delayInMinutes: delayMinutes });
}
function scheduleVerify() {
  chrome.alarms.create(VERIFY_ALARM, { delayInMinutes: 1 });
}
async function startBatch(profile, kind, selected) {
  const previous = (await chrome.storage.local.get(BATCH_PROGRESS_KEY))[BATCH_PROGRESS_KEY];
  if (previous?.running) throw new Error("Another batch is already running. Resume or skip that batch first.");
  const config = await settings();
  if (!config) throw new Error("Configure Gitea first.");
  if (!Array.isArray(selected) || !selected.length) throw new Error("Select at least one repository.");
  const unique = [...new Map(selected.map(repo => [repositoryKey(repo), { owner: repo.owner, name: repo.name }])).values()];
  if (unique.some(repo => !/^[a-zA-Z0-9-]+$/.test(repo.owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo.name))) throw new Error("Invalid repository name.");
  const progress = { profile, kind, running: true, startedAt: Date.now(), completedAt: null,
    profileId: (await profileStore()).activeProfileId, current: null, total: unique.length,
    items: unique.map(repo => ({ ...repo, status: "pending" })) };
  recalcBatch(progress);
  await saveBatch(progress);
  scheduleBatch();
  return { ok: true };
}
async function advanceBatch() {
  if (batchBusy) return;
  batchBusy = true;
  try {
    const progress = (await chrome.storage.local.get(BATCH_PROGRESS_KEY))[BATCH_PROGRESS_KEY];
    if (!progress?.running) return;
    const store = await profileStore();
    const config = store.profiles.find(p => p.id === progress.profileId);
    if (!config) {
      progress.running = false; progress.error = "The batch's Gitea profile was removed.";
      await saveBatch(progress); return;
    }
    // The worker may have been terminated while an API call was underway.
    // Re-check Gitea before reissuing a migration request.
    const item = progress.items.find(i => ["checking", "creating", "pending"].includes(i.status));
    if (!item) {
      progress.running = false; progress.current = null; progress.completedAt = Date.now();
      recalcBatch(progress); await saveBatch(progress); scheduleVerify(); return;
    }
    const controller = new AbortController();
    activeBatch = { controller, key: repositoryKey(item) };
    progress.current = activeBatch.key;
    item.status = "checking";
    item.attempts = (item.attempts || 0) + 1;
    await saveBatch(progress);
    try {
      const existing = await lookupDestination(config, item, controller.signal);
      if (existing) {
        item.status = existing.mirror ? "mirrored" : "existing";
        if (existing.mirror) item.note = "Mirror exists in Gitea (clone completion not independently verified).";
      } else {
        item.status = "creating";
        await saveBatch(progress);
        // createMirror may wait until Gitea finishes initial migration.
        // It is safe to retry after timeout only after checking destination again.
        await createMirrorWithTimeout(item, config, controller);
        item.status = "queued";
      }
    } catch (error) {
      try {
        // If Gitea completed the migration despite a timeout/abort, don't duplicate it.
        const existing = await lookupDestination(config, item);
        if (existing) {
          item.status = existing.mirror ? "mirrored" : "existing";
          item.note = "Found on Gitea after interrupted request; check initial sync in Gitea.";
        } else if (item.cancelRequested) { item.status = "cancelled"; }
        else { item.status = "failed"; item.error = error.message; }
      } catch (checkError) {
        item.status = item.cancelRequested ? "cancelled" : "failed";
        item.error = `${error.message}. Destination verification failed: ${checkError.message}`;
      }
    } finally {
      // Merge user Skip operations made while this network request was in progress.
      const latest = (await chrome.storage.local.get(BATCH_PROGRESS_KEY))[BATCH_PROGRESS_KEY];
      if (latest?.startedAt === progress.startedAt) {
        for (const pending of progress.items) {
          const newer = latest.items.find(i => repositoryKey(i) === repositoryKey(pending));
          if (newer?.status === "skipped" && pending.status === "pending") pending.status = "skipped";
        }
      }
      activeBatch = null;
      progress.current = null;
      recalcBatch(progress);
      await saveBatch(progress);
      scheduleBatch();
    }
  } finally { batchBusy = false; }
}
async function createMirrorWithTimeout(item, config, controller) {
  const timer = setTimeout(() => controller.abort(new Error("Gitea migration timed out after 60 seconds")), REQUEST_TIMEOUT_MS);
  try {
    // Using the exact batch profile prevents profile switching from redirecting mirrors.
    const github = await githubRepo(item, config.githubToken, controller.signal);
    await giteaFetch(config, "/repos/migrate", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo_name: item.name, repo_owner: config.giteaOwner,
        name: item.name, private: github.private, mirror: true,
        clone_addr: sourceCloneUrl(item, config), description: github.description || "",
        auth_token: config.githubToken || undefined,
        auth_username: config.githubToken ? "x-access-token" : undefined })
    });
  } catch (error) {
    if (controller.signal.aborted && !item.cancelRequested) throw new Error("Migration request timed out or was interrupted");
    throw error;
  } finally { clearTimeout(timer); }
}
async function controlBatch(action, key) {
  const progress = (await chrome.storage.local.get(BATCH_PROGRESS_KEY))[BATCH_PROGRESS_KEY];
  if (!progress?.running) throw new Error("No active batch.");
  if (action === "skip") {
    const item = progress.items.find(i => repositoryKey(i) === key && i.status === "pending");
    if (!item) throw new Error("Item is not pending.");
    item.status = "skipped";
  } else if (action === "skip-remaining") {
    for (const item of progress.items) if (item.status === "pending") item.status = "skipped";
  } else if (action === "cancel-current") {
    const item = progress.items.find(i => ["checking", "creating"].includes(i.status));
    if (!item) throw new Error("No active request.");
    item.cancelRequested = true;
    if (activeBatch?.key === repositoryKey(item)) activeBatch.controller.abort();
    else { item.status = "pending"; item.cancelRequested = false; } // stopped worker; safely recheck Gitea
  } else throw new Error("Unknown action.");
  recalcBatch(progress); await saveBatch(progress);
  scheduleBatch();
  return { ok: true };
}
async function verifyQueued() {
  const progress = (await chrome.storage.local.get(BATCH_PROGRESS_KEY))[BATCH_PROGRESS_KEY];
  if (!progress?.items?.some(i => i.status === "queued")) return;
  const store = await profileStore();
  const config = store.profiles.find(p => p.id === progress.profileId);
  if (!config) return;
  // Verifies repository creation, NOT completion of its first Git pull.
  for (const item of progress.items.filter(i => i.status === "queued").slice(0, 10)) {
    try {
      const found = await lookupDestination(config, item);
      if (found?.mirror) { item.status = "mirrored"; item.note = "Mirror registered in Gitea; initial clone may still be processing."; }
      else if (found) { item.status = "existing"; item.error = "Repository exists but is not a pull mirror."; }
    } catch (error) { item.note = `Verification postponed: ${error.message}`; }
  }
  recalcBatch(progress); await saveBatch(progress);
  if (progress.items.some(i => i.status === "queued")) scheduleVerify();
}
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === BATCH_ALARM) void advanceBatch().catch(console.error);
  if (alarm.name === VERIFY_ALARM) void verifyQueued().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => { scheduleBatch(); scheduleVerify(); });
chrome.runtime.onInstalled.addListener(() => { scheduleBatch(); scheduleVerify(); });

function sourceCloneUrl(repo, config) {
  // Gitea receives the GitHub token separately; never place it in a clone URL.
  return `https://github.com/${repo.owner}/${repo.name}.git`;
}

function isFresh(github, gitea) {
  const sourceTime = new Date(github.pushed_at || github.updated_at || 0).getTime();
  const mirrorTime = new Date(gitea.mirror_updated || gitea.updated_at || 0).getTime();
  return mirrorTime >= sourceTime;
}

async function status(repo) {
  const config = await settings();
  if (!config) return { state: "setup" };
  const github = await githubRepo(repo, config.githubToken);
  try {
    const mirrored = await giteaFetch(config, `/repos/${encodeURIComponent(config.giteaOwner)}/${encodeURIComponent(repo.name)}`);
    if (!mirrored.mirror) return { state: "missing", config, github };
    return { state: isFresh(github, mirrored) ? "fresh" : "stale", config, github, mirrored };
  } catch (error) {
    if (error.message.includes("Gitea (404)")) return { state: "missing", config, github };
    throw error;
  }
}

async function createMirror(repo, signal) {
  const config = await settings();
  if (!config) return { state: "setup" };
  const github = await githubRepo(repo, config.githubToken, signal);
  const body = {
    name: repo.name,
    private: github.private,
    mirror: true,
    clone_addr: sourceCloneUrl(repo, config),
    auth_token: config.githubToken || undefined,
    auth_username: config.githubToken ? "x-access-token" : undefined,
    description: github.description || ""
  };
  // `/repos/migrate`, unlike repository creation, tells Gitea to clone and
  // maintain a pull mirror. `repo_owner` may be either the current user or an org.
  await giteaFetch(config, "/repos/migrate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, repo_name: repo.name, repo_owner: config.giteaOwner }),
    signal
  });
  return { state: "creating", target: targetUrl(config, repo) };
}

async function deleteMirror(config, repo) {
  try {
    await giteaFetch(config, `/repos/${encodeURIComponent(config.giteaOwner)}/${encodeURIComponent(repo.name)}`, { method: "DELETE" });
  } catch (error) {
    // A cancellation may arrive before Gitea has created the repository. The
    // original migration request is still aborted locally in that case.
    if (!error.message.includes("Gitea (404)")) throw error;
  }
}

async function syncMirror(repo) {
  const config = await settings();
  if (!config) return { state: "setup" };
  await giteaFetch(
    config,
    `/repos/${encodeURIComponent(config.giteaOwner)}/${encodeURIComponent(repo.name)}/mirror-sync`,
    { method: "POST" }
  );
  return { ok: true };
}

async function saveStarredProgress(progress) {
  await chrome.storage.local.set({ [STARRED_PROGRESS_KEY]: progress });
}

function repositoryKey(repo) {
  return `${repo.owner}/${repo.name}`;
}

async function controlStarredMirror(action, profile, key) {
  const stored = (await chrome.storage.local.get(STARRED_PROGRESS_KEY))[STARRED_PROGRESS_KEY];
  const run = activeStarredRun?.progress?.profile === profile ? activeStarredRun : null;
  const progress = run?.progress || stored;
  if (!progress || progress.profile !== profile || !progress.running) throw new Error("No active starred mirror batch was found.");

  if (action === "skip") {
    const item = progress.items.find((candidate) => repositoryKey(candidate) === key);
    if (!item || item.status !== "pending") throw new Error("Only repositories that have not started can be skipped.");
    item.status = "skipped";
    progress.skipped += 1;
  } else if (action === "skip-remaining") {
    for (const item of progress.items) {
      if (item.status === "pending") {
        item.status = "skipped";
        progress.skipped += 1;
      }
    }
  } else if (action === "cancel-current") {
    const item = progress.items.find((candidate) => candidate.status === "checking" || candidate.status === "creating");
    if (!item || !run?.controller) throw new Error("There is no mirror request to cancel.");
    item.cancelRequested = true;
    run.controller.abort();
  } else {
    throw new Error("Unknown starred mirror control.");
  }
  await saveStarredProgress(progress);
  return progress;
}

async function mirrorStarred(profile) {
  const config = await settings();
  if (!config) return { error: "Configure Gitea Mirror Helper before mirroring starred repositories." };
  const previous = (await chrome.storage.local.get(STARRED_PROGRESS_KEY))[STARRED_PROGRESS_KEY];
  if (previous?.running) return { alreadyRunning: true };
  const repositories = await starredRepos(profile);
  const progress = {
    profile,
    running: true,
    startedAt: new Date().toISOString(),
    completedAt: null,
    current: null,
    total: repositories.length,
    processed: 0,
    mirrored: 0,
    queued: 0,
    existing: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    items: repositories.map((repo) => ({ ...repo, status: "pending" }))
  };
  activeStarredRun = { progress, controller: null };
  await saveStarredProgress(progress);
  // Process sequentially so Gitea is not flooded with clone jobs.
  for (const [index, repo] of repositories.entries()) {
    const item = progress.items[index];
    if (item.status === "skipped") {
      progress.processed += 1;
      await saveStarredProgress(progress);
      continue;
    }
    progress.current = `${repo.owner}/${repo.name}`;
    item.status = "checking";
    const controller = new AbortController();
    activeStarredRun.controller = controller;
    await saveStarredProgress(progress);
    try {
      // Any existing Gitea repository is left untouched, even if it is not a
      // mirror. This prevents an accidental migration attempt into a name clash.
      try {
        const existing = await giteaFetch(config, `/repos/${encodeURIComponent(config.giteaOwner)}/${encodeURIComponent(repo.name)}`);
        if (existing.mirror) {
          item.status = "mirrored";
          progress.mirrored += 1;
        } else {
          item.status = "existing";
          progress.existing += 1;
        }
        continue;
      } catch (error) {
        if (!error.message.includes("Gitea (404)")) throw error;
      }
      item.status = "creating";
      await saveStarredProgress(progress);
      await createMirror(repo, controller.signal);
      item.status = "queued";
      progress.queued += 1;
    } catch (error) {
      if (item.cancelRequested) {
        item.status = "cancelled";
        progress.cancelled += 1;
        try {
          await deleteMirror(config, repo);
        } catch (deleteError) {
          item.error = `The request was cancelled, but deleting its Gitea repository failed: ${deleteError.message}`;
        }
      } else {
        item.status = "failed";
        item.error = error.message;
        progress.failed += 1;
      }
    } finally {
      progress.processed += 1;
      progress.current = null;
      activeStarredRun.controller = null;
      await saveStarredProgress(progress);
    }
  }
  progress.running = false;
  progress.completedAt = new Date().toISOString();
  await saveStarredProgress(progress);
  activeStarredRun = null;
  return progress;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "list-batch-repos") return {items:await listGithubRepos(message.kind,message.profile)};
    if (message.type === "start-batch") return await startBatch(message.profile,message.kind,message.selected);
    if (message.type === "get-batch-progress") {
      const progress = (await chrome.storage.local.get(BATCH_PROGRESS_KEY))[BATCH_PROGRESS_KEY] || null;
      // Do not keep resetting the alarm whenever a dashboard opens.
      if (progress?.running && !(await chrome.alarms.get(BATCH_ALARM))) scheduleBatch();
      return progress;
    }
    if (message.type === "control-batch") return await controlBatch(message.action,message.key);
    if (message.type === "get-settings") return { config: await settings() };
    if (message.type === "save-settings") {
      const config = message.config;
      await permitGitea(config.giteaUrl);
      await saveProfile({ id: config.id || "default", name: config.name || "Default", ...config });
      return { ok: true };
    }
    if (message.type === "status") return await status(message.repo);
    if (message.type === "mirror") return await createMirror(message.repo);
    if (message.type === "sync-mirror") return await syncMirror(message.repo);
    if (message.type === "mirror-starred") return await mirrorStarred(message.profile);
    if (message.type === "control-starred-mirror") return await controlStarredMirror(message.action, message.profile, message.key);
    if (message.type === "get-starred-progress") return (await chrome.storage.local.get(STARRED_PROGRESS_KEY))[STARRED_PROGRESS_KEY] || null;
    if (message.type === "get-profiles") return await profileStore();
    if (message.type === "save-profile") {
      await permitGitea(message.profile.giteaUrl);
      return await saveProfile(message.profile, true);
    }
    if (message.type === "activate-profile") {
      const store = await profileStore();
      if (!store.profiles.some((profile) => profile.id === message.id)) throw new Error("Profile not found.");
      store.activeProfileId = message.id;
      await chrome.storage.local.set({ [PROFILE_STORE_KEY]: store, [SETTINGS_KEY]: store.profiles.find((profile) => profile.id === message.id) });
      return store;
    }
    if (message.type === "export-profile") {
      const store = await profileStore();
      const profile = store.profiles.find((item) => item.id === message.id);
      if (!profile) throw new Error("Profile not found.");
      return profile;
    }
    throw new Error("Unknown request");
  })().then(sendResponse).catch((error) => sendResponse({ error: error.message }));
  return true;
});
