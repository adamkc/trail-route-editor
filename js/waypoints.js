/**
 * waypoints.js — Place, manage, and export waypoint markers on the map
 */
const Waypoints = (() => {
  let map = null;
  let waypoints = [];   // { id, lngLat: [lng, lat], label, elevation }
  let nextId = 1;
  let placingMode = false;
  let clickHandler = null;

  function init(mapInstance) {
    map = mapInstance;

    // GeoJSON source for waypoint markers
    map.addSource('waypoints', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });

    // Circle markers
    map.addLayer({
      id: 'waypoint-circles',
      type: 'circle',
      source: 'waypoints',
      paint: {
        'circle-radius': 7,
        'circle-color': '#FFD700',
        'circle-stroke-color': '#000',
        'circle-stroke-width': 2
      }
    });

    // Text labels
    map.addLayer({
      id: 'waypoint-labels',
      type: 'symbol',
      source: 'waypoints',
      layout: {
        'text-field': ['get', 'label'],
        'text-offset': [0, 1.5],
        'text-size': 11,
        'text-anchor': 'top',
        'text-allow-overlap': true
      },
      paint: {
        'text-color': '#FFD700',
        'text-halo-color': '#000',
        'text-halo-width': 1.5
      }
    });

    // Right-click to delete a waypoint
    map.on('contextmenu', 'waypoint-circles', (e) => {
      e.preventDefault();
      if (e.features && e.features.length > 0) {
        const id = e.features[0].properties.id;
        if (confirm(`Delete waypoint "${e.features[0].properties.label}"?`)) {
          deleteWaypoint(id);
        }
      }
    });
  }

  function refreshSource() {
    if (!map || !map.getSource('waypoints')) return;
    const features = waypoints.map(wp => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: wp.lngLat },
      properties: { id: wp.id, label: wp.label, elevation: wp.elevation }
    }));
    map.getSource('waypoints').setData({
      type: 'FeatureCollection',
      features
    });
  }

  function startPlacing() {
    if (!map) return;
    placingMode = true;
    map.getCanvas().style.cursor = 'crosshair';

    clickHandler = async (e) => {
      const lngLat = [e.lngLat.lng, e.lngLat.lat];
      const label = prompt('Waypoint label:');
      if (!label) return; // cancelled

      let elevation = null;
      if (typeof DemSampler !== 'undefined' && DemSampler.isLoaded()) {
        elevation = await DemSampler.sampleAtLngLat(lngLat[0], lngLat[1]);
      }

      waypoints.push({
        id: nextId++,
        lngLat,
        label,
        elevation
      });
      refreshSource();
    };

    map.on('click', clickHandler);
  }

  function stopPlacing() {
    placingMode = false;
    if (map) {
      map.getCanvas().style.cursor = '';
      if (clickHandler) {
        map.off('click', clickHandler);
        clickHandler = null;
      }
    }
  }

  function isPlacing() { return placingMode; }

  function deleteWaypoint(id) {
    waypoints = waypoints.filter(wp => wp.id !== id);
    refreshSource();
  }

  function getWaypointsGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: waypoints.map(wp => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: wp.lngLat },
        properties: {
          name: wp.label,
          label: wp.label,
          elevation: wp.elevation
        }
      }))
    };
  }

  function loadWaypoints(features) {
    for (const f of features) {
      if (f.geometry && f.geometry.type === 'Point') {
        waypoints.push({
          id: nextId++,
          lngLat: f.geometry.coordinates.slice(0, 2),
          label: f.properties.name || f.properties.label || f.properties.Name || 'Waypoint',
          elevation: f.properties.elevation || null
        });
      }
    }
    refreshSource();
  }

  function clear() {
    waypoints = [];
    refreshSource();
  }

  function getCount() { return waypoints.length; }

  return { init, startPlacing, stopPlacing, isPlacing, deleteWaypoint,
           getWaypointsGeoJSON, loadWaypoints, clear, getCount };
})();
