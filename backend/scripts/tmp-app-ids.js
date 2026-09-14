const { query } = require('../src/db');

(async () => {
  const a = await query(`
    SELECT app_id, app_name, COUNT(*)::int n, SUM(revenue)::float8 rev
    FROM report_grain
    WHERE slice_key='app_id' AND report_date='2026-09-14' AND country_id<>0
    GROUP BY 1,2
    ORDER BY rev DESC NULLS LAST
    LIMIT 15`);
  console.log('top apps', a.rows);

  const b = await query(`
    SELECT COUNT(*)::int n
    FROM report_grain
    WHERE slice_key='app_id' AND report_date='2026-09-14'
      AND (app_id ILIKE '%284815942%' OR app_name ILIKE '%284815942%')`);
  console.log('numeric match', b.rows[0]);

  const c = await query(`
    SELECT DISTINCT LEFT(COALESCE(app_id,''), 60) AS id,
                    LEFT(COALESCE(app_name,''), 60) AS name
    FROM report_grain
    WHERE slice_key='app_id' AND report_date='2026-09-14'
      AND COALESCE(app_id,'') ~ '^[0-9]+$'
    LIMIT 15`);
  console.log('numeric app_ids', c.rows);

  // Mimic grain≈4: what filter would match only 4 rows?
  const d = await query(`
    SELECT COALESCE(NULLIF(TRIM(app_id),''), app_name) AS app, COUNT(*)::int n
    FROM report_grain
    WHERE slice_key='app_id' AND report_date='2026-09-14'
    GROUP BY 1
    HAVING COUNT(*) <= 4
    ORDER BY n DESC
    LIMIT 20`);
  console.log('tiny app groups', d.rows);

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
