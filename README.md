# Gitea Mirror Helper

A Manifest V3 Chrome extension that adds a floating mirror-status control to GitHub repository pages.

## Install

1. Open `chrome://extensions`, enable **Developer mode**, then choose **Load unpacked**.
2. Select this project folder.
3. Open a GitHub repository page. On first use, click the floating button and enter:
   - Your Gitea base URL and destination username/owner.
   - A Gitea personal access token with repository write access.
   - A GitHub fine-grained token with **Contents: Read** access for repositories you want to mirror (needed for private repositories; it also enables accurate freshness checks). Under **Repository access**, explicitly choose the repository (or “All repositories”).

The extension requests Chrome host permission only for the Gitea origin you enter. Tokens are held in `chrome.storage.local` and never put into a repository URL.

## Status colours

* Green: a Gitea mirror exists and is at least as recent as GitHub's latest push.
* Orange: a mirror exists but its recorded update is older than GitHub's latest push.
* Red: no Gitea mirror exists under the selected owner.
* Grey: setup is needed or a check is in progress.

Click red to create a mirror. Gitea performs the actual clone and subsequent pull-mirror schedule. Ensure your Gitea instance is reachable from the browser and is configured to allow repository migrations.
