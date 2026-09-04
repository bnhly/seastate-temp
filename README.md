# Sea State data-host kit (temporary)

Inputs the permanent data host fetches at boot, parked on an orphan branch
of the public site repo so a plain `curl` can reach them while GitHub Pages
(which builds main only) never sees them.

- `build_dataset_waverys.py` - the WAVERYS emitter
- `era5_graft.partNN` - the ERA5 wind / diurnal-wind / ENSO graft
  (seastate_accum.npz). REAL data only. Since 4 Sep 26 EVERY wind family
  covers 1980-2024: the 2010-2024 wind-variables rerun (release "wind")
  was welded onto the 45-year record with tools/weld_wind_graft.py (mean
  wind carried from the 45-year checkpoint, direction rose / diurnal cycle /
  ENSO split summed 1980-2009 + 2010-2024; every family holds 11,160
  January samples on an open-ocean cell, 45 years x 248). Reassemble with
  `cat era5_graft.part* > seastate_accum.npz`; whole-file sha256:
  d715c903874672249d40c17f05dfe720e415ecd802e5fdef842a857d80867b9f
  (the 2 Sep 26 graft, a2d0f1f0..., had the rose / diurnal / ENSO
  families for 1980-2009 only; refresh.sh replaces it by checksum)
- `cur_tiles.partNN` + `cur.sha256` - the currents tiles (too big for
  Pages), unzipped into data/cur on the host
- `kit.sha256` - per-file checksums
- `harden.sh`, `refresh.sh`, `README_KIT.md` (3 Sep 26) - the two console
  scripts for the running host: the /data/ gate + rate limit + CORS +
  robots.txt, and the catch-up that re-emits the WAVERYS tiles WITH the
  ERA5 graft (the first emit ran without it), installs the re-emitted
  currents tiles (nodal corrections, fixed tile filing) and runs harden.sh.
  README_KIT.md has the exact console lines.

Delete this branch once the data host is up and verified.
