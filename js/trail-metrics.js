/**
 * trail-metrics.js — Slope/grade/elevation computation, ported from SimplifyTrail.R
 */
const TrailMetrics = (() => {

  // Diverging grade palette: green near 0, warm (red) uphill, cool (navy) downhill
  const UPHILL_CLASSES = [
    { min: 0,  max: 4,   color: '#1a9641', label: '0-4%',   cssClass: 'grade-up-0' },
    { min: 4,  max: 8,   color: '#a6d96a', label: '4-8%',   cssClass: 'grade-up-1' },
    { min: 8,  max: 12,  color: '#fee08b', label: '8-12%',  cssClass: 'grade-up-2' },
    { min: 12, max: 16,  color: '#fdae61', label: '12-16%', cssClass: 'grade-up-3' },
    { min: 16, max: Infinity, color: '#d73027', label: '>16%', cssClass: 'grade-up-4' }
  ];
  const DOWNHILL_CLASSES = [
    { min: 0,  max: 4,   color: '#1a9641', label: '0-4%',   cssClass: 'grade-dn-0' },
    { min: 4,  max: 8,   color: '#f0b27a', label: '4-8%',   cssClass: 'grade-dn-1' },
    { min: 8,  max: 12,  color: '#e74c9e', label: '8-12%',  cssClass: 'grade-dn-2' },
    { min: 12, max: 16,  color: '#d4145a', label: '12-16%', cssClass: 'grade-dn-3' },
    { min: 16, max: Infinity, color: '#ff00bf', label: '>16%', cssClass: 'grade-dn-4' }
  ];
  // Alias for backward compat (summary stats use absolute grades → uphill palette)
  const GRADE_CLASSES = UPHILL_CLASSES;

  function gradeClass(signedGradePct) {
    const abs = Math.abs(signedGradePct);
    const classes = signedGradePct >= 0 ? UPHILL_CLASSES : DOWNHILL_CLASSES;
    for (let i = 0; i < classes.length; i++) {
      if (abs < classes[i].max) return classes[i];
    }
    return classes[classes.length - 1];
  }

  /**
   * Compute per-segment metrics from coordinates and elevations.
   * coords: array of [lng, lat]
   * elevations: array of elevation values (meters)
   * Returns { segments: [...], summary: {...} }
   */
  function compute(coords, elevations) {
    const segments = [];
    let cumulDist = 0;

    for (let i = 1; i < coords.length; i++) {
      const dx = Projection.distanceM(coords[i - 1], coords[i]);
      if (dx < 1) continue; // skip near-duplicate vertices

      const elevStart = elevations[i - 1];
      const elevEnd = elevations[i];
      const de = (elevEnd != null && elevStart != null) ? elevEnd - elevStart : 0;
      const gradePct = (dx > 0) ? (de / dx) * 100 : 0;

      segments.push({
        index: i - 1,
        distStart: cumulDist,
        distEnd: cumulDist + dx,
        length: dx,
        elevStart: elevStart,
        elevEnd: elevEnd,
        elevChange: de,
        gradePct: gradePct,
        absGradePct: Math.abs(gradePct),
        direction: de >= 0 ? 'uphill' : 'downhill',
        gradeClass: gradeClass(gradePct)
      });

      cumulDist += dx;
    }

    // Summary stats
    const summary = computeSummary(segments, elevations, cumulDist);
    return { segments, summary };
  }

  function computeSummary(segments, elevations, totalLength) {
    if (segments.length === 0) {
      return {
        length_m: 0, elev_min_m: 0, elev_max_m: 0,
        elev_gain_m: 0, elev_loss_m: 0,
        avg_grade_pct: 0, max_grade_pct: 0,
        pct_over_8: 0, pct_over_12: 0,
        reversals_per_100m: 0
      };
    }

    const validElevs = elevations.filter(e => e != null);
    let gain = 0, loss = 0;
    segments.forEach(s => {
      if (s.elevChange > 0) gain += s.elevChange;
      else loss += Math.abs(s.elevChange);
    });

    const absGrades = segments.map(s => s.absGradePct);
    const avgGrade = absGrades.reduce((a, b) => a + b, 0) / absGrades.length;
    const maxGrade = Math.max(...absGrades);
    const over8 = absGrades.filter(g => g > 8).length / absGrades.length * 100;
    const over12 = absGrades.filter(g => g > 12).length / absGrades.length * 100;

    // Grade reversals
    const signs = segments.map(s => Math.sign(s.elevChange)).filter(s => s !== 0);
    let reversals = 0;
    for (let i = 1; i < signs.length; i++) {
      if (signs[i] !== signs[i - 1]) reversals++;
    }
    const revPer100 = totalLength > 0 ? reversals / (totalLength / 100) : 0;

    return {
      length_m: Math.round(totalLength * 10) / 10,
      elev_min_m: validElevs.length ? Math.round(Math.min(...validElevs) * 10) / 10 : 0,
      elev_max_m: validElevs.length ? Math.round(Math.max(...validElevs) * 10) / 10 : 0,
      elev_gain_m: Math.round(gain * 10) / 10,
      elev_loss_m: Math.round(loss * 10) / 10,
      avg_grade_pct: Math.round(avgGrade * 10) / 10,
      max_grade_pct: Math.round(maxGrade * 10) / 10,
      pct_over_8: Math.round(over8 * 10) / 10,
      pct_over_12: Math.round(over12 * 10) / 10,
      reversals_per_100m: Math.round(revPer100 * 10) / 10
    };
  }

  /**
   * Recompute only the segments adjacent to a moved vertex (index i).
   * Returns the updated segments array and new summary.
   */
  function recomputeAt(segments, allCoords, allElevations, vertexIndex) {
    // Find and update the segment ending at vertexIndex and starting at vertexIndex
    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      const i = seg.index;
      // Segment from vertex i to i+1
      if (i === vertexIndex - 1 || i === vertexIndex) {
        const i0 = i;
        const i1 = i + 1;
        if (i1 >= allCoords.length) continue;

        const dx = Projection.distanceM(allCoords[i0], allCoords[i1]);
        const de = (allElevations[i1] != null && allElevations[i0] != null)
          ? allElevations[i1] - allElevations[i0] : 0;
        const gradePct = dx > 0 ? (de / dx) * 100 : 0;

        seg.length = dx;
        seg.elevStart = allElevations[i0];
        seg.elevEnd = allElevations[i1];
        seg.elevChange = de;
        seg.gradePct = gradePct;
        seg.absGradePct = Math.abs(gradePct);
        seg.direction = de >= 0 ? 'uphill' : 'downhill';
        seg.gradeClass = gradeClass(gradePct);
      }
    }

    // Recalculate cumulative distances
    let cumDist = 0;
    for (const seg of segments) {
      seg.distStart = cumDist;
      seg.distEnd = cumDist + seg.length;
      cumDist += seg.length;
    }

    const summary = computeSummary(segments, allElevations, cumDist);
    return { segments, summary };
  }

  return { compute, recomputeAt, gradeClass, GRADE_CLASSES, UPHILL_CLASSES, DOWNHILL_CLASSES };
})();
