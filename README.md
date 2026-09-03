# Sea State data-host kit (temporary)

Inputs the permanent data host fetches at boot, parked on an orphan branch
of the public site repo so a plain `curl` can reach them while GitHub Pages
(which builds main only) never sees them.

- `build_dataset_waverys.py` - the WAVERYS emitter
- `era5_graft.partNN` - the ERA5 wind / diurnal-wind / ENSO graft
  (seastate_accum.npz). REAL data only: mean-wind fields cover 1980-2024,
  the direction rose / diurnal cycle / ENSO split cover 1980-2009 (the
  2010-2024 half of those three families awaits the wind-variables rerun).
  Replaced 2 Sep 26 - the first kit graft proved to be the synthetic
  self-test stub (5 m/s everywhere) and must never ship. Reassemble with
  `cat era5_graft.part* > seastate_accum.npz`; whole-file sha256:
  a2d0f1f0a670203c98afbd09f41a517423c011f23e1b7ee1604c228516abbde4
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
