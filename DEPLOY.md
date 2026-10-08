# Deploying APPA Viewer on a server (runbook for an agent)

Goal: serve the static viewer and forecast data at **https://appa.isach.be** with Caddy.
Repo: `git@github.com:iSach/Appa-viewer.git` (branch `main`). Everything served is static files;
there is nothing to build, no Node, no Python needed on the web server.

## Facts you need
- Web root: `/srv/appa-viewer/web` (a git checkout of this repo's `web/` directory).
- Data: `/srv/appa-data` (written by `rsync` from the GPU machine, never by git). `web/data` is a symlink to it.
- Caddy config template: `deploy/Caddyfile` (already contains the hostname and cache rules).
- Do NOT put secrets in the repo or in Caddy's config. The viewer needs no API key.

## Steps
1. **Preconditions.** Confirm DNS: `appa.isach.be` has an A (and AAAA if the server has IPv6) record for this server,
   and ports 80 and 443 are open in the firewall. Caddy needs both to obtain the certificate.
   Check: `dig +short appa.isach.be`. If it does not resolve to this server, stop and report; do not work around it.
2. **Caddy.** If `caddy version` fails, install Caddy from the official packages for the distro
   (https://caddyserver.com/docs/install) and make sure the `caddy` systemd service is enabled.
3. **Create directories and fetch the code.**
   ```bash
   sudo mkdir -p /srv/appa-data/runs
   sudo git clone git@github.com:iSach/Appa-viewer.git /srv/appa-viewer
   sudo ln -sfn /srv/appa-data /srv/appa-viewer/web/data
   sudo chown -R "$DEPLOY_USER": /srv/appa-data /srv/appa-viewer     # the user that rsync/git will run as
   sudo chmod -R a+rX /srv/appa-viewer /srv/appa-data                # caddy must be able to read
   ```
   If cloning over SSH fails (no deploy key), use HTTPS: `https://github.com/iSach/Appa-viewer.git`
   (the repo may be private: then ask the user for a deploy key; do not invent credentials).
4. **Caddy config.** Merge `/srv/appa-viewer/deploy/Caddyfile` into `/etc/caddy/Caddyfile`.
   - If the server already serves other sites, **append** the `appa.isach.be { ... }` block; do not replace the file.
   - If `/etc/caddy/Caddyfile` already has a block for `appa.isach.be`, show it to the user instead of overwriting.
   - Then: `caddy validate --config /etc/caddy/Caddyfile` and `sudo systemctl reload caddy`.
5. **Smoke test** (see checklist below). Before any forecast data exists the page loads but shows
   "No forecast published yet": that is correct at this stage.

## Getting data onto the server (done from the GPU machine, not by the agent unless asked)
Install an SSH key for the deploy user, then on the machine that runs the forecasts:
```bash
deploy/push_data.sh /path/to/appa-live2/web/data  DEPLOY_USER@appa-server:/srv/appa-data
```
It uploads new runs first, the pointers (`latest.json`, `runs.json`) last, then removes pruned runs,
so visitors never see a half-uploaded run. Run it after each forecast (e.g. at the end of the cron job).
First-time test data: any run directory built with
`python -m appa_live2.build --era5 <zarr> --point-stride 2 --out web/data` (about 770 MB).

## Updating the viewer later
```bash
cd /srv/appa-viewer && git pull --ff-only     # no restart or reload needed
```

## Verification checklist (all must pass; report the actual outputs)
```bash
H=https://appa.isach.be
curl -sI $H/ | head -1                                   # HTTP/2 200
curl -sI $H/js/app.js | grep -i -E "^(HTTP|content-type|cache-control)"   # 200, text/javascript, no-cache
curl -s  $H/data/latest.json                             # JSON with run_id (once data exists)
RUN=$(curl -s $H/data/latest.json | python3 -c "import json,sys;print(json.load(sys.stdin)['run_id'])")
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" -H "Range: bytes=0-99" \
     $H/data/runs/$RUN/points/2m_temperature.u16         # 206 100   (Range support: required)
curl -sI $H/data/latest.json | grep -i cache-control     # no-store
curl -sI $H/data/runs/$RUN/fields/mean/2m_temperature.pack | grep -i -E "cache-control|content-encoding"   # immutable, no content-encoding
curl -sI http://appa.isach.be/ | head -2                 # redirects to https
```
Then open https://appa.isach.be in a browser: dark map with coastlines; once data exists, a coloured field,
wind particles and isobars should appear.

## Things not to do
- Do not enable directory listing (`browse`) or serve anything outside `/srv/appa-viewer/web`.
- Do not store keys, tokens or `.env` files under `/srv/appa-viewer` (it is web-readable).
- Do not run the forecast pipeline on this server unless asked; it only serves files.
