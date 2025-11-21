
/*
 * Route: api.innovationbound.com/analytics/sessions
 * Session replay and timeline viewer
 * Password protected via query parameter: ?key=your-secret-password
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb'

var dynamoDb = new DynamoDBClient({ region: 'us-east-1' })
var db = DynamoDBDocumentClient.from(dynamoDb)

// Password check (set this via environment variable)
var ACCESS_KEY = process.env.ACCESS_KEY || 'sessions2025'

export async function handler (event) {
  console.log('EVENT:', JSON.stringify(event))

  try {
    // Check authentication
    var key = event.queryStringParameters?.key || ''
    if (key !== ACCESS_KEY) {
      var format = event.queryStringParameters?.format || 'html'
      if (format === 'json') {
        return respondJSON(401, { error: 'Unauthorized', message: 'Invalid access key' })
      }
      return respondHTML(401, '<h1>401 Unauthorized</h1><p>Invalid access key. Add ?key=your-password to URL.</p>')
    }

    var sessionId = event.queryStringParameters?.id || null
    var pageUrl = event.queryStringParameters?.page || null
    var deleteFlag = event.queryStringParameters?.delete || null
    var format = event.queryStringParameters?.format || 'html'

    if (deleteFlag && event.httpMethod === 'POST') {
      // Delete session
      return await deleteSession(sessionId, key, format)
    } else if (sessionId) {
      // Show timeline for specific session
      if (format === 'json') {
        return await getSessionJSON(sessionId)
      }
      return await renderSessionTimeline(sessionId, key)
    } else {
      // List all sessions (optionally filtered by page)
      if (format === 'json') {
        return await getSessionsJSON(pageUrl)
      }
      return await renderSessionList(pageUrl, key)
    }

  } catch (error) {
    console.error('Error:', error)
    var format = event.queryStringParameters?.format || 'html'
    if (format === 'json') {
      return respondJSON(500, { error: 'Internal Server Error', message: error.message })
    }
    return respondHTML(500, '<h1>500 Error</h1><pre>' + error.message + '</pre>')
  }
}

// Query DynamoDB for all sessions (via page-analytics GSI)
async function getRecentSessions (pageUrl) {
  var params = {
    TableName: 'www.innovationbound.com',
    IndexName: 'page-analytics',
    Limit: 50,
    ScanIndexForward: false // Most recent first
  }

  if (pageUrl) {
    params.KeyConditionExpression = 'gsiPk = :page'
    params.ExpressionAttributeValues = {
      ':page': 'page#' + pageUrl
    }
  } else {
    // Get all pages - we'll need to scan or query specific page
    // For now, default to AI Power Hour page
    params.KeyConditionExpression = 'gsiPk = :page'
    params.ExpressionAttributeValues = {
      ':page': 'page#https://www.innovationbound.com/chatgpt-training/business-owner-ai-power-hour'
    }
  }

  var result = await db.send(new QueryCommand(params))

  // Group by sessionId
  var sessionsMap = {}
  result.Items.forEach(function(item) {
    if (!sessionsMap[item.sessionId]) {
      sessionsMap[item.sessionId] = {
        sessionId: item.sessionId,
        pageUrl: item.pageUrl,
        events: [],
        firstEvent: item.timestamp,
        lastEvent: item.timestamp
      }
    }
    sessionsMap[item.sessionId].events.push(item)
    if (item.timestamp < sessionsMap[item.sessionId].firstEvent) {
      sessionsMap[item.sessionId].firstEvent = item.timestamp
    }
    if (item.timestamp > sessionsMap[item.sessionId].lastEvent) {
      sessionsMap[item.sessionId].lastEvent = item.timestamp
    }
  })

  return Object.values(sessionsMap)
}

// Query DynamoDB for specific session events
async function getSessionEvents (sessionId) {
  var result = await db.send(new QueryCommand({
    TableName: 'www.innovationbound.com',
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: {
      ':pk': 'analytics-session#' + sessionId
    }
  }))

  return result.Items.sort(function(a, b) {
    return a.relativeTime - b.relativeTime
  })
}

// Delete all events for a session
async function deleteSession (sessionId, key, format) {
  try {
    // Get all events for this session
    var events = await getSessionEvents(sessionId)

    if (events.length === 0) {
      if (format === 'json') {
        return respondJSON(404, { error: 'Session not found', message: 'No events found for this session' })
      }
      return respondHTML(404, '<h1>Session Not Found</h1><p>No events found for this session.</p>')
    }

    // Delete in batches of 25 (DynamoDB limit)
    var batches = []
    for (let i = 0; i < events.length; i += 25) {
      var batch = events.slice(i, i + 25)
      var deleteRequests = batch.map(function(event) {
        return {
          DeleteRequest: {
            Key: {
              pk: event.pk,
              sk: event.sk
            }
          }
        }
      })

      await db.send(new BatchWriteCommand({
        RequestItems: {
          'www.innovationbound.com': deleteRequests
        }
      }))

      batches.push(batch.length)
    }

    console.log('Deleted session:', sessionId, 'Events deleted:', events.length)

    if (format === 'json') {
      return respondJSON(200, { success: true, message: 'Session deleted', eventsDeleted: events.length })
    }

    // Redirect back to session list
    return {
      statusCode: 302,
      headers: {
        'Location': '/analytics/sessions?key=' + key
      },
      body: ''
    }

  } catch (error) {
    console.error('Delete error:', error)
    if (format === 'json') {
      return respondJSON(500, { error: 'Internal Server Error', message: error.message })
    }
    return respondHTML(500, '<h1>500 Error</h1><pre>' + error.message + '</pre>')
  }
}

// Pure: Format milliseconds as MM:SS
function formatTime (ms) {
  var totalSeconds = Math.floor(ms / 1000)
  var minutes = Math.floor(totalSeconds / 60)
  var seconds = totalSeconds % 60
  return minutes + ':' + (seconds < 10 ? '0' : '') + seconds
}

// Pure: Format ISO timestamp as readable date
function formatDate (isoString) {
  var date = new Date(isoString)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  })
}

// Pure: Get color for event type
function getEventColor (eventType) {
  var colors = {
    'session-start': '#22c55e',
    'scroll': '#3b82f6',
    'click': '#f59e0b',
    'video-play': '#a855f7',
    'video-pause': '#ec4899',
    'video-seek': '#8b5cf6',
    'video-departure': '#ef4444',
    'form-focus': '#06b6d4',
    'form-blur': '#14b8a6',
    'departure': '#dc2626'
  }
  return colors[eventType] || '#6b7280'
}

// Pure: Get emoji for event type
function getEventEmoji (eventType) {
  var emojis = {
    'session-start': '🚀',
    'scroll': '📜',
    'click': '👆',
    'video-play': '▶️',
    'video-pause': '⏸️',
    'video-seek': '⏩',
    'video-departure': '📹',
    'form-focus': '✏️',
    'form-blur': '✅',
    'departure': '👋'
  }
  return emojis[eventType] || '•'
}

// Pure: Format event data for display
function formatEventData (event) {
  var data = event.eventData || {}
  var output = []

  switch(event.eventType) {
    case 'session-start':
      output.push('Viewport: ' + (data.viewport?.width || '?') + 'x' + (data.viewport?.height || '?'))
      output.push('Referrer: ' + (data.referrer || 'direct'))
      output.push('Language: ' + (data.language || '?'))
      break

    case 'scroll':
      output.push('Scroll Y: ' + data.scrollY + 'px')
      output.push('Scroll %: ' + data.scrollPercentage + '%')
      output.push('Page Height: ' + data.documentHeight + 'px')
      break

    case 'click':
      output.push('Element: ' + data.elementType)
      output.push('Text: "' + (data.elementText || '').substring(0, 50) + '"')
      output.push('Selector: ' + data.selector)
      output.push('Position: (' + data.x + ', ' + data.y + ')')
      break

    case 'video-play':
    case 'video-pause':
    case 'video-seek':
    case 'video-departure':
      output.push('Video: ' + data.videoId)
      output.push('Time: ' + Math.round(data.currentTime) + 's of ' + Math.round(data.duration) + 's')
      output.push('Watched: ' + data.percentWatched + '%')
      break

    case 'form-focus':
    case 'form-blur':
      output.push('Field: ' + data.fieldName)
      output.push('Type: ' + data.fieldType)
      break

    case 'departure':
      output.push('Reason: ' + data.reason)
      output.push('Time on page: ' + formatTime(data.timeOnPage))
      output.push('Final scroll: ' + data.scrollY + 'px')
      break
  }

  return output.join('\n')
}

// Render session list HTML
async function renderSessionList (pageUrl, key) {
  var sessions = await getRecentSessions(pageUrl)

  var rows = sessions.map(function(session) {
    var duration = new Date(session.lastEvent) - new Date(session.firstEvent)
    var durationFormatted = formatTime(duration)

    return `
      <tr>
        <td>${formatDate(session.firstEvent)}</td>
        <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis;">${session.pageUrl}</td>
        <td>${durationFormatted}</td>
        <td>${session.events.length}</td>
        <td>
          <a href="/analytics/sessions?key=${key}&id=${session.sessionId}">View Timeline →</a>
          <a href="#" onclick="if(confirm('Delete this session?')) window.location.href='/analytics/sessions?key=${key}&delete=${session.sessionId}'; return false;" style="margin-left: 1rem; opacity: 0.6;" title="Delete session">🗑️</a>
        </td>
      </tr>
    `
  }).join('')

  var html = `<!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Session Replay - All Sessions</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          padding: 2rem;
          background: #0f172a;
          color: #e2e8f0;
          line-height: 1.6;
        }
        h1 { margin-bottom: 2rem; font-size: 2rem; }
        table {
          width: 100%;
          border-collapse: collapse;
          background: #1e293b;
          border-radius: 8px;
          overflow: hidden;
        }
        th, td {
          padding: 1rem;
          text-align: left;
          border-bottom: 1px solid #334155;
        }
        th {
          background: #334155;
          font-weight: 600;
        }
        tr:last-child td { border-bottom: none; }
        tr:hover { background: #334155; }
        a {
          color: #60a5fa;
          text-decoration: none;
          font-weight: 500;
        }
        a:hover { text-decoration: underline; }
        .empty {
          text-align: center;
          padding: 3rem;
          color: #94a3b8;
        }
      </style>
    </head>
    <body>
      <h1>📊 Session Replay - Recent Sessions</h1>

      ${sessions.length === 0 ? `
        <div class="empty">
          <p>No sessions found yet.</p>
          <p>Visit the tracked page to generate session data.</p>
        </div>
      ` : `
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Page URL</th>
              <th>Duration</th>
              <th>Events</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      `}
    </body>
    </html>
  `

  return respondHTML(200, html)
}

// Render session timeline HTML
async function renderSessionTimeline (sessionId, key) {
  var events = await getSessionEvents(sessionId)

  if (events.length === 0) {
    return respondHTML(404, '<h1>Session Not Found</h1><p>No events found for this session ID.</p>')
  }

  var firstEvent = events[0]
  var lastEvent = events[events.length - 1]
  var duration = lastEvent.relativeTime - firstEvent.relativeTime

  var eventBlocks = events.map(function(event) {
    var color = getEventColor(event.eventType)
    var emoji = getEventEmoji(event.eventType)
    var timeFormatted = formatTime(event.relativeTime)
    var dataFormatted = formatEventData(event)

    return `
      <div class="event" style="border-left: 4px solid ${color};">
        <div class="event-header">
          <span class="emoji">${emoji}</span>
          <strong>${timeFormatted}</strong> - ${event.eventType}
        </div>
        <pre class="event-data">${dataFormatted}</pre>
      </div>
    `
  }).join('')

  var html = `<!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Session Replay - ${sessionId}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: #0f172a;
          color: #e2e8f0;
          line-height: 1.6;
          overflow: hidden;
          height: 100vh;
          display: flex;
          flex-direction: column;
        }

        header {
          padding: 1rem 2rem;
          background: #1e293b;
          border-bottom: 1px solid #334155;
        }
        h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
        .meta {
          color: #94a3b8;
          font-size: 0.85rem;
        }
        .session-id {
          font-family: 'Courier New', monospace;
          background: #0f172a;
          padding: 0.15rem 0.4rem;
          border-radius: 4px;
        }

        .content {
          display: flex;
          flex: 1;
          overflow: hidden;
        }

        .replay-container {
          flex: 2;
          display: flex;
          flex-direction: column;
          background: #1e293b;
          border-right: 1px solid #334155;
        }

        .iframe-container {
          flex: 1;
          position: relative;
          background: white;
          overflow: hidden;
        }

        #replay-iframe {
          width: 100%;
          height: 100%;
          border: none;
        }

        .click-overlay {
          position: absolute;
          pointer-events: none;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          z-index: 1000;
        }

        .click-marker {
          position: absolute;
          width: 40px;
          height: 40px;
          border: 3px solid #ef4444;
          border-radius: 50%;
          animation: clickPulse 0.6s ease-out;
          pointer-events: none;
        }

        @keyframes clickPulse {
          0% { transform: scale(0.5); opacity: 1; }
          100% { transform: scale(1.5); opacity: 0; }
        }

        .controls {
          padding: 1rem;
          background: #0f172a;
          border-top: 1px solid #334155;
          display: flex;
          align-items: center;
          gap: 1rem;
        }

        .play-pause-btn {
          width: 50px;
          height: 50px;
          border: none;
          background: #3b82f6;
          color: white;
          border-radius: 8px;
          cursor: pointer;
          font-size: 1.5rem;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .play-pause-btn:hover { background: #2563eb; }
        .play-pause-btn:disabled { background: #334155; cursor: not-allowed; }

        .time-display {
          font-family: 'Courier New', monospace;
          font-size: 1rem;
          color: #94a3b8;
        }

        .timeline-sidebar {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          min-width: 400px;
        }

        .events-header {
          padding: 1rem;
          background: #1e293b;
          border-bottom: 1px solid #334155;
          font-weight: 600;
        }

        .events-list {
          flex: 1;
          overflow-y: auto;
          padding: 1rem;
          background: #0f172a;
        }

        .event {
          background: #1e293b;
          border-radius: 6px;
          padding: 1rem;
          margin-bottom: 0.75rem;
          border-left: 4px solid #334155;
          transition: all 0.2s;
        }
        .event.active {
          background: #334155;
          border-left-color: #3b82f6;
          box-shadow: 0 0 0 2px #3b82f6;
        }
        .event-header {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
          font-size: 0.9rem;
        }
        .emoji { font-size: 1.1rem; }
        .event-data {
          font-family: 'Courier New', monospace;
          font-size: 0.75rem;
          color: #94a3b8;
          white-space: pre-wrap;
          margin-left: 1.75rem;
        }

        .back {
          display: inline-block;
          padding: 0.5rem 1rem;
          margin: 1rem;
          color: #60a5fa;
          text-decoration: none;
          font-weight: 500;
          background: #1e293b;
          border-radius: 6px;
        }
        .back:hover { background: #334155; }
      </style>
    </head>
    <body>
      <header>
        <h1>🎬 Session Replay</h1>
        <div class="meta">
          <span class="session-id">${sessionId}</span> •
          ${formatTime(duration)} •
          ${events.length} events •
          ${firstEvent.pageUrl}
        </div>
      </header>

      <div class="content">
        <div class="replay-container">
          <div class="iframe-container">
            <iframe id="replay-iframe" src="${firstEvent.pageUrl}" sandbox="allow-scripts allow-same-origin"></iframe>
            <div class="click-overlay" id="click-overlay"></div>
          </div>

          <div class="controls">
            <button class="play-pause-btn" id="play-pause-btn">▶️</button>
            <div class="time-display" id="time-display">0:00 / ${formatTime(duration)}</div>
          </div>
        </div>

        <div class="timeline-sidebar">
          <div class="events-header">Event Timeline</div>
          <div class="events-list" id="events-list">
            ${eventBlocks}
          </div>
        </div>
      </div>

      <a href="/analytics/sessions?key=${key}" class="back">← Back to all sessions</a>

      <script>
        var events = ${JSON.stringify(events)};
        var currentEventIndex = 0;
        var isPlaying = false;
        var startTime = null;
        var pausedAt = 0;

        var iframe = document.getElementById('replay-iframe');
        var playPauseBtn = document.getElementById('play-pause-btn');
        var timeDisplay = document.getElementById('time-display');
        var clickOverlay = document.getElementById('click-overlay');
        var eventsList = document.getElementById('events-list');

        function formatTime(ms) {
          var totalSeconds = Math.floor(ms / 1000);
          var minutes = Math.floor(totalSeconds / 60);
          var seconds = totalSeconds % 60;
          return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
        }

        function scrollIframe(scrollY) {
          // Use postMessage to communicate with iframe
          iframe.contentWindow.postMessage({
            type: 'replay-scroll',
            scrollY: scrollY
          }, '*');
        }

        function showClickMarker(x, y) {
          // Use postMessage to show click in iframe
          iframe.contentWindow.postMessage({
            type: 'replay-click',
            x: x,
            y: y
          }, '*');
        }

        function highlightEvent(index) {
          var eventElements = eventsList.querySelectorAll('.event');
          eventElements.forEach(function(el, i) {
            el.classList.toggle('active', i === index);
          });

          if (eventElements[index]) {
            eventElements[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }

        function processEvent(event) {
          highlightEvent(currentEventIndex);

          switch(event.eventType) {
            case 'scroll':
              scrollIframe(event.eventData.scrollY || 0);
              break;
            case 'click':
              showClickMarker(event.eventData.x || 0, event.eventData.y || 0);
              break;
          }
        }

        function tick() {
          if (!isPlaying) return;

          var currentTime = Date.now() - startTime + pausedAt;
          timeDisplay.textContent = formatTime(currentTime) + ' / ${formatTime(duration)}';

          // Process events that should happen at current time
          while (currentEventIndex < events.length && events[currentEventIndex].relativeTime <= currentTime) {
            processEvent(events[currentEventIndex]);
            currentEventIndex++;
          }

          // Check if replay is complete
          if (currentEventIndex >= events.length) {
            stop();
            return;
          }

          requestAnimationFrame(tick);
        }

        function play() {
          if (currentEventIndex >= events.length) {
            // Restart from beginning
            currentEventIndex = 0;
            pausedAt = 0;
            scrollIframe(0);
          }

          isPlaying = true;
          startTime = Date.now();
          playPauseBtn.textContent = '⏸️';
          tick();
        }

        function pause() {
          isPlaying = false;
          pausedAt = Date.now() - startTime + pausedAt;
          playPauseBtn.textContent = '▶️';
        }

        function stop() {
          isPlaying = false;
          playPauseBtn.textContent = '▶️';
        }

        playPauseBtn.addEventListener('click', function() {
          if (isPlaying) {
            pause();
          } else {
            play();
          }
        });

        // Wait for iframe to load
        iframe.addEventListener('load', function() {
          console.log('Iframe loaded, ready for replay');
          scrollIframe(0);
        });
      </script>
    </body>
    </html>
  `

  return respondHTML(200, html)
}

// Get sessions list as JSON
async function getSessionsJSON (pageUrl) {
  var sessions = await getRecentSessions(pageUrl)

  var sessionsData = sessions.map(function(session) {
    var duration = new Date(session.lastEvent) - new Date(session.firstEvent)
    return {
      sessionId: session.sessionId,
      pageUrl: session.pageUrl,
      timestamp: session.firstEvent,
      duration: duration,
      eventCount: session.events.length
    }
  })

  return respondJSON(200, sessionsData)
}

// Get session events as JSON
async function getSessionJSON (sessionId) {
  var events = await getSessionEvents(sessionId)

  if (events.length === 0) {
    return respondJSON(404, { error: 'Session not found', message: 'No events found for this session ID' })
  }

  var firstEvent = events[0]
  var lastEvent = events[events.length - 1]
  var duration = lastEvent.relativeTime - firstEvent.relativeTime

  return respondJSON(200, {
    sessionId: sessionId,
    pageUrl: firstEvent.pageUrl,
    duration: duration,
    eventCount: events.length,
    events: events
  })
}

function respondJSON (code, data) {
  return {
    statusCode: code,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body: JSON.stringify(data)
  }
}

function respondHTML (code, html) {
  return {
    statusCode: code,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body: html
  }
}
