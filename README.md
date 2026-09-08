# Gitea Mirror Helper

This extension adds a floating button to the bottom-right of GitHub repository pages. It creates a **pull mirror** in your Gitea server, so a copy of the repository remains available there and Gitea updates it on its own schedule.

> The extension never changes anything in GitHub. It only uses the GitHub and Gitea APIs to read repository information and create/check mirrors.

## 1. Install the extension in Chrome

1. Download or clone this project.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Open or refresh a repository page on `github.com`. The `⇄` button will appear in the bottom-right corner.

After changing extension files, click **Reload** for the extension on `chrome://extensions`.

## 2. Create a Gitea token

This token lets the extension create mirror repositories in your Gitea account and read their status.

1. Sign in to your Gitea instance.
2. Open the user menu and select **Settings**.
3. Open **Applications**.
4. In **Manage Access Tokens**, enter a name such as `chrome-mirror-helper` and click **Generate Token**.
5. Copy the token immediately; Gitea normally does not show it again.

The token must be able to create and read repositories. On Gitea versions that offer token scopes, grant the repository scope (usually `repo`). If mirrors will be created in an organization, the token owner also needs permission to create repositories in that organization.

## 3. Create a GitHub token

A GitHub token is required for private repositories. It is optional for public repositories, but improves the reliability of latest-push checks.

### Recommended: fine-grained personal access token

1. In GitHub, go to **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens**.
2. Click **Generate new token**.
3. Select the repository owner in **Resource owner**.
4. Under **Repository access**, choose **Only select repositories** and select the repositories you want to mirror, or choose **All repositories**.
5. Under **Repository permissions**, set **Contents** to **Read-only**.
6. Generate the token and copy it immediately.

If a private repository is not selected under **Repository access**, GitHub deliberately returns `404` even when the URL is correct. Organization-owned repositories may also require organization approval for the token.

### Alternative: classic personal access token

Go to **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**, create a token, and grant the `repo` scope. This is broader access; fine-grained tokens are safer when possible.

## 4. First-time setup

Open a GitHub repository, click the floating `⇄` button, and enter the following values:

| Field | Example | Description |
| --- | --- | --- |
| **Gitea URL** | `https://git.example.ir` | Your Gitea base URL, without `/api/v1` or a repository name |
| **Gitea username / owner** | `alireza` | Destination username; use the organization name for organization mirrors |
| **Gitea access token** | `…` | The token created in step 2 |
| **GitHub token** | `github_pat_…` | The token created in step 3; optional for public repositories |

When saving, Chrome asks for permission to access your Gitea domain; approve it. When the button is red, click **Create mirror**. Gitea performs the clone and future updates, so the Gitea server itself must be able to reach GitHub and have repository migration enabled.

## Status colors

| Color | Meaning |
| --- | --- |
| Green | A mirror exists and its latest update is at least as recent as GitHub's latest push. |
| Orange | A mirror exists but is behind GitHub's latest push. |
| Red | No mirror with that name exists under the selected Gitea owner. |
| Gray | The extension is checking status or has not been configured yet. |

When the status is orange, open the button panel and select **Update mirror now** to ask Gitea to queue an immediate pull-mirror synchronization. The button reports that the request was accepted; cloning/fetching still happens asynchronously on the Gitea server.

## Mirror starred repositories

On a GitHub profile's **Stars** tab (for example, `https://github.com/your-name?tab=stars`), the extension shows a **Mirror starred repositories** button. Confirming the action lists your starred repositories and handles them one at a time. Any repository that already exists in the configured Gitea owner is skipped; only missing mirrors are created. The live dashboard shows current repository, batch completion percentage, mirror coverage percentage, status counts, and an itemized list of existing, queued, and failed mirrors. A GitHub token is recommended for this feature and required when the starred list includes private repositories.

## Security and troubleshooting

- Tokens are stored only in `chrome.storage.local` in the current Chrome profile. They are never placed in a clone URL or repository.
- If you see `GitHub (404)`, verify that the fine-grained token has Repository access to that private repository, or select **All repositories**.
- For Gitea errors, verify the base URL, token validity, and permission to create a repository for the selected user or organization.
- You can revoke either token in GitHub or Gitea settings at any time and create a replacement.
