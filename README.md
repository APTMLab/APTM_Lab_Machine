# Measurement WorkFlow Remote

This folder contains the remote-control pieces for Measurement WorkFlow.

## Website Name

Use this as the public mobile site name:

**Measurement WorkFlow Remote**

GitHub Pages repository name:

`measurement-workflow-remote`

The static website entry point is:

`Remote/index.html`

GitHub Pages can publish the repository root from the `main` branch.

## Why There Are Two Parts

GitHub Pages can host the phone interface, but it cannot securely store commands or login sessions. The app therefore uses a cloud relay:

`mobile website -> cloud relay -> lab PC desktop app -> equipment`

The lab PC only makes outbound HTTPS requests. Do not expose the lab PC directly to the public internet.

## Cloud Relay Backend

The relay backend is:

`Remote/cloudflare-worker/measurement-workflow-relay-worker.js`

Deploy it as a Cloudflare Worker with a KV namespace binding named:

`MW_REMOTE_KV`

If this repository is connected directly to Cloudflare Pages, the root `_worker.js`
contains the same relay API and mobile page together. In that setup, add the
same `MW_REMOTE_KV` binding and environment variables to the Cloudflare Pages
project, not only to a separate Worker project.

If this repository is connected directly to Cloudflare Workers from GitHub,
Cloudflare should use the root `wrangler.toml`. It points to `_worker.js` and
keeps dashboard variables during deployment.

Required Worker environment variables:

- `REMOTE_LAB_ID`: the Lab ID typed on the mobile login screen
- `REMOTE_PASSWORD_SHA256`: lowercase SHA-256 hash of the mobile login password
- `DESKTOP_KEY`: shared secret pasted into the desktop app Cloud Relay settings
- `TOKEN_SECRET`: long random string for login token signing

After deployment, paste the Worker URL into the desktop app Home page under:

`Mobile Control -> Cloud Relay -> Relay API URL`

Then set the same Lab ID and Desktop key, enable remote control, and save.

## Desktop Safety Gate

Remote commands only work while **Enable remote control** is checked in the desktop app. If it is off, the relay website can still exist, but the lab PC will not poll for commands.

## Mobile Commands

The mobile website supports:

- Apply scan inputs
- Apply & Run
- Pause / Resume
- Stop
- Outputs Off
- Reset Inputs

The desktop app still uses its normal readiness checks before running hardware.
