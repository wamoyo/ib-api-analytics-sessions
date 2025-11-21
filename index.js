/*
 * Route: api.innovationbound.com/analytics/sessions
 * Session replay viewer - JSON API only
 * Password protected via query parameter: ?key=sessions2025
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb'

var dynamoDb = new DynamoDBClient({ region: 'us-east-1' })
var db = DynamoDBDocumentClient.from(dynamoDb)
var ACCESS_KEY = process.env.ACCESS_KEY || 'sessions2025'

export async function handler (event) {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return respond(200, {})
  }

  // Check authentication
  var key = event.queryStringParameters?.key || ''
  if (key !== ACCESS_KEY) {
    return respond(401, { error: 'Unauthorized' })
  }

  var sessionId = event.queryStringParameters?.id
  var isDelete = event.queryStringParameters?.delete === 'true' && event.httpMethod === 'POST'

  try {
    if (isDelete && sessionId) {
      return await deleteSession(sessionId)
    } else if (sessionId) {
      return await getSession(sessionId)
    } else {
      return await listSessions()
    }
  } catch (error) {
    console.error('Error:', error)
    return respond(500, { error: error.message })
  }
}

// Get all sessions
async function listSessions () {
  var result = await db.send(new QueryCommand({
    TableName: 'www.innovationbound.com',
    IndexName: 'page-analytics',
    KeyConditionExpression: 'gsiPk = :page',
    ExpressionAttributeValues: {
      ':page': 'page#https://www.innovationbound.com/chatgpt-training/business-owner-ai-power-hour'
    },
    Limit: 50,
    ScanIndexForward: false
  }))

  var sessionsMap = {}
  result.Items.forEach(function(item) {
    if (!sessionsMap[item.sessionId]) {
      sessionsMap[item.sessionId] = {
        sessionId: item.sessionId,
        pageUrl: item.pageUrl,
        timestamp: item.timestamp,
        events: []
      }
    }
    sessionsMap[item.sessionId].events.push(item)
  })

  var sessions = Object.values(sessionsMap).map(function(session) {
    var duration = Math.max(...session.events.map(e => e.relativeTime)) - Math.min(...session.events.map(e => e.relativeTime))
    return {
      sessionId: session.sessionId,
      pageUrl: session.pageUrl,
      timestamp: session.timestamp,
      duration: duration,
      eventCount: session.events.length
    }
  })

  return respond(200, sessions)
}

// Get specific session
async function getSession (sessionId) {
  var result = await db.send(new QueryCommand({
    TableName: 'www.innovationbound.com',
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: {
      ':pk': 'analytics-session#' + sessionId
    }
  }))

  if (result.Items.length === 0) {
    return respond(404, { error: 'Session not found' })
  }

  var events = result.Items.sort(function(a, b) {
    return a.relativeTime - b.relativeTime
  })

  var duration = events[events.length - 1].relativeTime - events[0].relativeTime

  return respond(200, {
    sessionId: sessionId,
    pageUrl: events[0].pageUrl,
    duration: duration,
    eventCount: events.length,
    events: events
  })
}

// Delete session
async function deleteSession (sessionId) {
  var result = await db.send(new QueryCommand({
    TableName: 'www.innovationbound.com',
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: {
      ':pk': 'analytics-session#' + sessionId
    }
  }))

  if (result.Items.length === 0) {
    return respond(404, { error: 'Session not found' })
  }

  // Delete in batches of 25
  for (let i = 0; i < result.Items.length; i += 25) {
    var batch = result.Items.slice(i, i + 25)
    await db.send(new BatchWriteCommand({
      RequestItems: {
        'www.innovationbound.com': batch.map(function(item) {
          return {
            DeleteRequest: {
              Key: { pk: item.pk, sk: item.sk }
            }
          }
        })
      }
    }))
  }

  console.log('Deleted session:', sessionId, 'Events deleted:', result.Items.length)
  return respond(200, { success: true, eventsDeleted: result.Items.length })
}

// Pure: JSON response with CORS
function respond (statusCode, data) {
  return {
    statusCode: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body: JSON.stringify(data)
  }
}
