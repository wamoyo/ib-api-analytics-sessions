# Session Replay Viewer

View user session timelines and events for analytics.

## Access

**URL:** `https://api.innovationbound.com/analytics/sessions?key=sessions2025`

**Default Password:** `sessions2025` (set via `ACCESS_KEY` environment variable)

## Features

### List All Sessions
`GET /analytics/sessions?key=sessions2025`

Shows table of recent sessions with:
- Date/time
- Page URL
- Duration
- Event count
- Link to timeline

### View Session Timeline
`GET /analytics/sessions?key=sessions2025&id=SESSION_ID`

Shows chronological event timeline with:
- 🚀 Session start (viewport, referrer, language)
- 📜 Scrolls (position, percentage)
- 👆 Clicks (element, text, coordinates)
- ▶️ Video plays (video ID, time, percentage)
- ⏸️ Video pauses
- ✏️ Form focus/blur
- 👋 Departures (reason, time on page)

## Deployment

```bash
cd api/analytics/sessions
npm install
npm run deploy
npm run logs
```

## Change Password

```bash
npm run reset-env "ACCESS_KEY=your-new-password"
```

## Implementation Details

- **Authentication:** Simple query parameter check (`?key=password`)
- **Data Source:** DynamoDB `www.innovationbound.com` table
- **Index Used:** `page-index` GSI (gsiPk + gsiSk)
- **Default Page:** AI Power Hour landing page
- **Session Limit:** 50 most recent sessions
- **Sorting:** Most recent first

## Example Session ID

From browser console:
```
📊 Session Tracking Active - Session ID: 550e8400-e29b-41d4-a716-446655440000
```

Then view:
```
https://api.innovationbound.com/analytics/sessions?key=sessions2025&id=550e8400-e29b-41d4-a716-446655440000
```
