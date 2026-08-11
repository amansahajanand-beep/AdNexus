# Past + present storage

| Table | Holds |
|-------|--------|
| `report_present` | **Today** only (hourly cron) |
| `report_daily` | **Past presets**: yesterday, last 7 days, last 30 days, this month, last month |

## Window written to `report_daily`
`start of previous calendar month` → `yesterday`

That single window covers every past preset above.

## Jobs
- Hourly: `sync-today` → `report_present` (+ promote into `report_daily` at 23:00)
- Hourly: `sync-day` → yesterday into `report_daily`
- 2 AM: `sync-backfill` → full past window into `report_daily`
- Startup: fill any missing rich (country/device) days in that window

## Manual backfill
```bash
cd backend
node scripts/backfill-rich-history.js
```
