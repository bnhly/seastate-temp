# Sea State data host: the two console scripts

Two scripts for the permanent data host (seastate-data.thrustm.com,
157.180.46.224). Both run as root from the Hetzner web console, the same
way preview.sh does, and both are safe to run more than once.

## The console and its quirks

The Hetzner web console mangles two characters: `:` comes out as `;` and
`|` comes out as `\`. Every line below is typed without either. The URLs
have no scheme (curl adds http, the site answers with a redirect to https
and `-L` follows it) and nothing is piped. Type the lines exactly as
written, one at a time. Log in as root first; the folder does not matter.

## harden.sh: gate, rate limit, CORS, robots.txt (a few seconds)

    curl -fsSL -L raw.githubusercontent.com/bnhly/seastate-temp/kit/harden.sh -o harden.sh
    bash harden.sh
    cat /root/seastate/webdata/status.txt

What it does:

- `/data/` answers only to requests that carry an Origin or Referer from
  the allowed list (the tool at seastate.thrustm.com, the thrustm.com site
  and any of its subdomains, the Pages address bnhly.github.io, the Wix
  editor and preview domains, this host's own address for the team
  preview). Everything else gets a 403. The four manifests
  (`/data/manifest.json`, `/data/cur/manifest.json`,
  `/data/joint/manifest.json`, `/data/cyc/manifest.json`) and
  `/status.txt` stay open to everyone, so a health check or a curious
  engineer still sees what the service is.
- Each address gets at most 30 data requests a second with a burst of 80
  (a map click fetches a few tiles). Excess gets a 429.
- Allowed browsers get the proper CORS answer for cross-origin fetches
  (needed once the site at seastate.thrustm.com reads its data from
  seastate-data.thrustm.com).
- `/robots.txt` on this host says do not index anything.
- Keeps everything the first build set up: the data root, the status page,
  gzip, the cache header, the preview's index.html, the https redirect for
  the domain name.

It rewrites two nginx files from scratch every run (the previous copies
are kept under `/root/seastate/nginx_backup/`), tests the new config with
`nginx -t` before reloading, and puts the old one back if the test fails.
It then probes itself on 127.0.0.1 and prints the results: the manifest
open, a tile refused without headers, the same tile allowed with the
site's Origin, the CORS header echoed, a burst of 120 requests showing
some 429s. A second run says "nothing to change".

Run it once now, and again after https works (the certificate appears a
few minutes after the DNS record points here; check
https://seastate-data.thrustm.com/status.txt loads with a padlock). The
second run adds the https server block in the same shape.

The gate is a deterrent, not a wall: the two headers are set by the
client, so a determined person forges them in one line. It stops the
cheap cases (hotlinking, a recursive wget, scrapers that never bother with
headers), and the rate limit is what protects the machine. That is the
intended level; the data is rebuildable from open sources.

## refresh.sh: the 3 Sep 26 catch-up (about an hour, runs in the background)

    curl -fsSL -L raw.githubusercontent.com/bnhly/seastate-temp/kit/refresh.sh -o refresh.sh
    bash refresh.sh
    cat /root/seastate/webdata/status.txt

The second line prints REFRESH STARTED within a few seconds and hands the
work to a background job. The console can then be closed; the job keeps
running. Come back to the third line (or open
http://157.180.46.224/status.txt in a browser) to follow it.

What it does, in order:

1. `1/5` pulls the public site repo into `/root/seastate/site` and copies
   its `data/` and `coast/` folders over the host's copies (over the top,
   nothing is deleted; the WAVERYS wave tiles the host already has are
   left alone, step 4 rewrites them).
2. `2/5` fetches the currents tiles from the kit (about 40 MB), checks the
   checksums, unpacks them next to the old set and swaps them in with one
   move. Skipped when the kit's set is the one already on the host.
3. `3/5` fetches the WAVERYS emitter from the kit and checks it against
   the checksum written inside refresh.sh; checks the ERA5 graft file and
   re-fetches it (0.4 GB) only if it is missing or damaged; checks the
   WAVERYS checkpoint and the python venv are there.
4. `4/5` re-emits every wave tile with the ERA5 wind graft. This is the
   hour. Tiles are rewritten in place and the manifest last, so the site
   keeps serving the whole time. The status line counts tiles as they are
   written. When it finishes, the new manifest is checked for
   `"wind": true`, the proof the graft went in.
5. `5/5` runs harden.sh if it sits in the same folder (fetch both scripts
   into the same folder and it does; otherwise run harden.sh yourself).

Then it writes a DONE line. Tell Claude when you see it.

How long: 1 to 1.5 hours, almost all of it step 4. Steps 1 to 3 take a
minute or two on a normal connection.

Running it twice is fine. A second copy started while one is running says
so and stops. It never deletes the WAVERYS checkpoint
(`wav_work/waverys_accum.npz`), the ERA5 graft
(`wav_work/seastate_accum.npz`) or the venv; if the checkpoint is missing
it stops and says so, because nothing on the host can rebuild it.

## Reading status.txt

`/root/seastate/webdata/status.txt` is one line, rewritten as things
happen: the time (UTC) and then the message. Also readable from a browser
at http://157.180.46.224/status.txt (or the https address once the
certificate is there).

- `refresh 1/5 ...` to `refresh 5/5 ...`: running. The `4/5` line updates
  every 30 seconds with the tiles written so far and the minutes elapsed.
- `DONE ...`: finished, with a summary of what changed. Tell Claude.
- `DONE harden ...`: harden.sh finished (refresh.sh writes its own DONE
  line after this one).
- `FAILED: ...`: stopped. The line says which step and why.
- A line that has not changed for more than 10 minutes during `4/5`
  means the emit is still grinding through a slow band; that is normal
  up to about 15 minutes. Longer than that, read the log (below).

## If something fails

1. Read the FAILED line.
2. Type

       tail -30 /root/seastate/refresh.log

   (for harden.sh, the error lines are printed straight to the console
   instead) and send that together with the FAILED line to Claude.
3. Fixing and re-running is the normal path. After a failure in steps 1
   to 3 nothing has been served differently, the host is exactly as it
   was. After a failure in step 4 the host serves a mix of old and new
   tiles under the old manifest, which the tool reads fine (wind stays
   hidden until a full emit succeeds); the next run redoes the emit.
   After a failure in step 5 (harden.sh) the previous nginx config was
   put back and nothing changed on the live server.
4. If the console dropped mid-way: refresh.sh does not care, it was
   running detached. Log back in and read status.txt.
5. `REFUSING TO RUN` at the start means the published script still has
   its checksum placeholder; that is a publishing mistake, not a host
   problem. Tell Claude.
6. `WRONG SERVER` means the script was started on some other machine;
   open the console of the data host (157.180.46.224).

## For whoever publishes the scripts

- refresh.sh carries `SHA_WAVERYS_PY=REPLACE_ME` near the top. Push the
  current build_dataset_waverys.py to the kit branch first, then put its
  sha256 there (`sha256sum build_dataset_waverys.py` on that exact copy).
  The script refuses to run while the placeholder is in place.
- Both scripts live at the root of the kit branch of bnhly/seastate-temp,
  next to preview.sh, so the console lines above resolve.
- harden.sh writes the same nginx shape the cloud-init now installs on a
  fresh host (`tools/vm_cloudinit_datahost.txt`); keep the two in step
  when the allowlist changes.
