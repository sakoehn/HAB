// The numbers the Methods page states. tests/test_methods_page_facts.py
// checks them against the backend config, so the page cannot drift from it.

export const METHODS_FACTS = {
  // FastAPI/api/config.py CORRELATION_LAGS / LAG_HOURS_PER_SAMPLE
  correlationLags: [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6],
  lagHoursPerSample: 4,
  // FastAPI/api/correlation_sql.py CIRCULAR_SHIFT_SCREEN_TOP_N
  circularShiftScreenTopN: 200,
  // /correlations/family `limit` Query(default, le=max)
  familyLimitDefault: 50,
  familyLimitMax: 500,
}
