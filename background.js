const SETTINGS_KEY = "giteaMirrorSettings";

async function settings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return result[SETTINGS_KEY] || null;
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

async function githubRepo(repo, token) {
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const request = (accessToken) => fetch(url, {
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

async function createMirror(repo) {
  const config = await settings();
  if (!config) return { state: "setup" };
  const github = await githubRepo(repo, config.githubToken);
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
    body: JSON.stringify({ ...body, repo_name: repo.name, repo_owner: config.giteaOwner })
  });
  return { state: "creating", target: targetUrl(config, repo) };
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "get-settings") return { config: await settings() };
    if (message.type === "save-settings") {
      const config = message.config;
      const origin = new URL(config.giteaUrl).origin + "/*";
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error("Permission to reach your Gitea server was not granted.");
      config.giteaUrl = config.giteaUrl.replace(/\/+$/, "");
      await chrome.storage.local.set({ [SETTINGS_KEY]: config });
      return { ok: true };
    }
    if (message.type === "status") return await status(message.repo);
    if (message.type === "mirror") return await createMirror(message.repo);
    if (message.type === "sync-mirror") return await syncMirror(message.repo);
    throw new Error("Unknown request");
  })().then(sendResponse).catch((error) => sendResponse({ error: error.message }));
  return true;
});
