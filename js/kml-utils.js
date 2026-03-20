/**
 * kml-utils.js — KML ↔ GeoJSON conversion (browser-native, no dependencies)
 *
 * Supports:
 *   - KML → GeoJSON: Placemarks with LineString, MultiLineString, Point, Polygon
 *   - GeoJSON → KML: Features with LineString, MultiLineString, Point, Polygon
 *   - Preserves name, description, and ExtendedData properties
 */
const KmlUtils = (() => {

  // ── KML → GeoJSON ──

  function kmlToGeoJSON(kmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(kmlText, 'text/xml');

    // Check for parse errors
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      throw new Error('Invalid KML: ' + parseError.textContent.slice(0, 200));
    }

    const features = [];
    const placemarks = doc.getElementsByTagName('Placemark');

    for (const pm of placemarks) {
      const feature = parsePlacemark(pm);
      if (feature) features.push(feature);
    }

    return {
      type: 'FeatureCollection',
      features
    };
  }

  function parsePlacemark(pm) {
    const properties = {};

    // Name
    const nameEl = pm.getElementsByTagName('name')[0];
    if (nameEl) properties.Name = nameEl.textContent.trim();

    // Description
    const descEl = pm.getElementsByTagName('description')[0];
    if (descEl) properties.description = descEl.textContent.trim();

    // ExtendedData → SimpleData fields
    const simpleData = pm.getElementsByTagName('SimpleData');
    for (const sd of simpleData) {
      const key = sd.getAttribute('name');
      if (key) properties[key] = sd.textContent.trim();
    }

    // ExtendedData → Data fields
    const dataEls = pm.getElementsByTagName('Data');
    for (const d of dataEls) {
      const key = d.getAttribute('name');
      const valEl = d.getElementsByTagName('value')[0];
      if (key && valEl) properties[key] = valEl.textContent.trim();
    }

    // Geometry
    const geometry = parseGeometry(pm);
    if (!geometry) return null;

    return { type: 'Feature', properties, geometry };
  }

  function parseGeometry(el) {
    // LineString
    const lineString = el.getElementsByTagName('LineString')[0];
    if (lineString) {
      const coords = parseCoordinates(lineString);
      if (coords.length > 0) return { type: 'LineString', coordinates: coords };
    }

    // MultiGeometry containing LineStrings
    const multiGeom = el.getElementsByTagName('MultiGeometry')[0];
    if (multiGeom) {
      const lines = multiGeom.getElementsByTagName('LineString');
      if (lines.length > 0) {
        const lineCoords = [];
        for (const line of lines) {
          const coords = parseCoordinates(line);
          if (coords.length > 0) lineCoords.push(coords);
        }
        if (lineCoords.length === 1) return { type: 'LineString', coordinates: lineCoords[0] };
        if (lineCoords.length > 1) return { type: 'MultiLineString', coordinates: lineCoords };
      }

      // MultiGeometry containing Points
      const points = multiGeom.getElementsByTagName('Point');
      if (points.length > 0) {
        const pointCoords = [];
        for (const pt of points) {
          const coords = parseCoordinates(pt);
          if (coords.length > 0) pointCoords.push(coords[0]);
        }
        if (pointCoords.length === 1) return { type: 'Point', coordinates: pointCoords[0] };
        if (pointCoords.length > 1) return { type: 'MultiPoint', coordinates: pointCoords };
      }
    }

    // Point
    const point = el.getElementsByTagName('Point')[0];
    if (point) {
      const coords = parseCoordinates(point);
      if (coords.length > 0) return { type: 'Point', coordinates: coords[0] };
    }

    // Polygon
    const polygon = el.getElementsByTagName('Polygon')[0];
    if (polygon) {
      const outerRing = polygon.getElementsByTagName('outerBoundaryIs')[0];
      if (outerRing) {
        const ring = outerRing.getElementsByTagName('LinearRing')[0];
        if (ring) {
          const coords = parseCoordinates(ring);
          const rings = [coords];
          const innerBounds = polygon.getElementsByTagName('innerBoundaryIs');
          for (const ib of innerBounds) {
            const ir = ib.getElementsByTagName('LinearRing')[0];
            if (ir) rings.push(parseCoordinates(ir));
          }
          return { type: 'Polygon', coordinates: rings };
        }
      }
    }

    return null;
  }

  function parseCoordinates(el) {
    const coordsEl = el.getElementsByTagName('coordinates')[0];
    if (!coordsEl) return [];

    const text = coordsEl.textContent.trim();
    const coords = [];

    // KML coordinates: "lng,lat,alt lng,lat,alt ..." (whitespace-separated tuples)
    const tuples = text.split(/\s+/);
    for (const tuple of tuples) {
      const parts = tuple.split(',');
      if (parts.length >= 2) {
        const lng = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        if (isNaN(lng) || isNaN(lat)) continue;
        if (parts.length >= 3 && !isNaN(parseFloat(parts[2]))) {
          coords.push([lng, lat, parseFloat(parts[2])]);
        } else {
          coords.push([lng, lat]);
        }
      }
    }
    return coords;
  }

  // ── GeoJSON → KML ──

  function geojsonToKML(geojson) {
    const features = geojson.features || [];
    let placemarks = '';

    for (const feature of features) {
      placemarks += featureToKML(feature);
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Exported Trails</name>
${placemarks}  </Document>
</kml>`;
  }

  function featureToKML(feature) {
    const props = feature.properties || {};
    const name = props.Name || props.name || '';
    const desc = props.description || '';
    const geom = feature.geometry;
    if (!geom) return '';

    let geomKml = '';
    switch (geom.type) {
      case 'LineString':
        geomKml = lineStringToKML(geom.coordinates);
        break;
      case 'MultiLineString':
        geomKml = '      <MultiGeometry>\n';
        for (const line of geom.coordinates) {
          geomKml += '        ' + lineStringToKML(line) + '\n';
        }
        geomKml += '      </MultiGeometry>';
        break;
      case 'Point':
        geomKml = `      <Point><coordinates>${coordToStr(geom.coordinates)}</coordinates></Point>`;
        break;
      case 'Polygon':
        geomKml = polygonToKML(geom.coordinates);
        break;
      default:
        return '';
    }

    // Build ExtendedData for extra properties
    let extData = '';
    const skip = new Set(['Name', 'name', 'description']);
    const extraKeys = Object.keys(props).filter(k => !skip.has(k));
    if (extraKeys.length > 0) {
      extData = '      <ExtendedData>\n';
      for (const k of extraKeys) {
        extData += `        <Data name="${escXml(k)}"><value>${escXml(String(props[k]))}</value></Data>\n`;
      }
      extData += '      </ExtendedData>\n';
    }

    return `    <Placemark>
      <name>${escXml(name)}</name>
      <description>${escXml(desc)}</description>
${extData}${geomKml}
    </Placemark>\n`;
  }

  function lineStringToKML(coords) {
    const str = coords.map(coordToStr).join('\n        ');
    return `      <LineString><coordinates>\n        ${str}\n      </coordinates></LineString>`;
  }

  function polygonToKML(rings) {
    let kml = '      <Polygon>\n';
    rings.forEach((ring, i) => {
      const tag = i === 0 ? 'outerBoundaryIs' : 'innerBoundaryIs';
      const str = ring.map(coordToStr).join('\n          ');
      kml += `        <${tag}><LinearRing><coordinates>\n          ${str}\n        </coordinates></LinearRing></${tag}>\n`;
    });
    kml += '      </Polygon>';
    return kml;
  }

  function coordToStr(c) {
    if (c.length >= 3) return `${c[0]},${c[1]},${c[2]}`;
    return `${c[0]},${c[1]},0`;
  }

  function escXml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return { kmlToGeoJSON, geojsonToKML };
})();
