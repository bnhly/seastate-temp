# Sea State Explorer

Static site for Thrust Maritime's Sea State Explorer: click a sea location,
pick months, and read long-term wave, wind, weather-window and extreme-sea
statistics for marine operations planning. Served from this repo via GitHub
Pages; the app is plain HTML/JS with no build step (`index.html` at the root).

Current dataset: ERA5 reanalysis (ECMWF / Copernicus C3S), 2010-2024,
3-hourly, 0.5 degree grid, independently verified against the source
checkpoint. Longer spans and further layers (currents, cyclone exposure)
are added as their builds complete.

Data sources and licences (full attribution in the page footer):
- Waves and wind: ERA5, Copernicus Climate Change Service (C3S) licence.
- Depths: ETOPO 2022 (NOAA, public domain); bathymetry outlines Natural Earth.
- Offshore assets: US BOEM/BSEE (public domain), Norwegian Offshore
  Directorate (NLOD), Geoscience Australia (CC BY 4.0), OpenStreetMap (ODbL).

The repository's release tags carry pipeline checkpoints for the data
builds; they are not part of the served site.

Free to use for individual planning reference; automated bulk extraction of
the tool's data is not permitted. Statistics are climatology, not a
forecast, and not a substitute for a project-specific metocean study.
