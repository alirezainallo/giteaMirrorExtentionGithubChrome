const SETTINGS_KEY = "giteaMirrorSettings";
const STARRED_PROGRESS_KEY = "giteaStarredMirrorProgress";
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
