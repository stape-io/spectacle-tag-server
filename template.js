const sendHttpRequest = require('sendHttpRequest');
const JSON = require('JSON');
const getEventData = require('getEventData');
const getContainerVersion = require('getContainerVersion');
const getAllEventData = require('getAllEventData');
const getCookieValues = require('getCookieValues');
const setCookie = require('setCookie');
const getRequestHeader = require('getRequestHeader');
const getTimestampMillis = require('getTimestampMillis');
const logToConsole = require('logToConsole');
const generateRandom = require('generateRandom');
const parseUrl = require('parseUrl');
const getType = require('getType');
const makeString = require('makeString');
const makeInteger = require('makeInteger');
const BigQuery = require('BigQuery');

/*==============================================================================
==============================================================================*/
const eventData = getAllEventData();
const ANON_COOKIE_KEY = 'sp__anon_id';
const USER_COOKIE_KEY = 'sp__user_id';
const COOKIE_EXPIRY_DAYS = 365;
const url = eventData.page_location || getRequestHeader('referer');

if (!isConsentGivenOrNotRequired(data, eventData)) {
  return data.gtmOnSuccess();
}

if (url && url.lastIndexOf('https://gtm-msr.appspot.com/', 0) === 0) {
  return data.gtmOnSuccess();
}

// Main execution
const methodType = data.methodType;

// Execute the appropriate method
switch (methodType) {
  case 'page':
    handlePage();
    break;
  case 'identify':
    handleIdentify();
    break;
  case 'track':
    handleTrack();
    break;
  case 'group':
    handleGroup();
    break;
  default:
    logToConsole('Spectacle: Unknown method type', methodType);
    data.gtmOnFailure();
    break;
}

/*==============================================================================
  Vendor related functions
==============================================================================*/

function buildBasePayload(method) {
  const now = getTimestampMillis();
  const anonymousId = getOrCreateAnonymousId();
  const userId = getStoredUserId() || getEventData('user_id') || null;

  // Get page and campaign context
  const pageContext = buildPageContext();
  const campaign = extractCampaign(pageContext.url);

  // Get user agent from headers
  const userAgent = getEventData('user_agent') || getRequestHeader('user-agent') || '';

  // Get timezone from event data or default
  const timezone = getEventData('ga_session_data.timezone') || getEventData('timezone') || 'UTC';

  // Get locale
  const locale = getEventData('language') || getEventData('user_properties.language') || null;

  return {
    type: method,
    context: {
      timezone: timezone,
      campaign: campaign,
      userAgent: userAgent,
      page: pageContext,
      locale: locale
    },
    userId: userId,
    anonymousId: anonymousId,
    writeKey: data.workspaceId
  };
}

function handlePage() {
  const payload = buildBasePayload('page');

  // Get page data from event
  const pageLocation = getEventData('page_location') || '';
  const pageTitle = getEventData('page_title') || '';
  const parsedUrl = parseUrl(pageLocation);

  // Get screen dimensions if available
  const screenResolution = getEventData('screen_resolution') || '';
  let width = null;
  let height = null;

  if (screenResolution && screenResolution.indexOf('x') > -1) {
    const dimensions = screenResolution.split('x');
    width = makeInteger(dimensions[0]);
    height = makeInteger(dimensions[1]);
  }

  payload.properties = {
    title: pageTitle,
    url: pageLocation,
    path: parsedUrl ? parsedUrl.pathname : '',
    hash: parsedUrl ? parsedUrl.hash || '' : '',
    search: parsedUrl ? parsedUrl.search : '',
    width: width,
    height: height
  };

  return sendToSpectacle('/p', payload);
}

function handleIdentify() {
  const payload = buildBasePayload('identify');
  const traits = {};

  // Get user ID and store it
  const userId = data.userId || getEventData('user_id') || getEventData('user_data.email_address');

  if (userId) {
    payload.userId = makeString(userId);
    storeUserId(payload.userId);
  }

  // Extract email from various sources
  const email =
    data.email || getEventData('user_data.email_address') || getEventData('user_properties.email');
  if (email) traits.email = email;

  // Extract names
  const firstName =
    data.firstName ||
    getEventData('user_data.first_name') ||
    getEventData('user_properties.first_name');
  if (firstName) traits.firstName = firstName;

  const lastName =
    data.lastName ||
    getEventData('user_data.last_name') ||
    getEventData('user_properties.last_name');
  if (lastName) traits.lastName = lastName;

  // Extract phone
  const phone = getEventData('user_data.phone_number') || getEventData('user_properties.phone');
  if (phone) traits.phone = phone;

  // Add custom traits from template configuration
  if (data.userTraits && getType(data.userTraits) === 'array') {
    for (let i = 0; i < data.userTraits.length; i++) {
      const trait = data.userTraits[i];
      if (trait.key && trait.value) {
        traits[trait.key] = trait.value;
      }
    }
  }

  payload.traits = traits;

  return sendToSpectacle('/i', payload);
}

function handleTrack() {
  const payload = buildBasePayload('track');

  // Get event name
  const eventName = data.eventName || getEventData('event_name');
  if (!eventName) {
    logToConsole('Spectacle: No event name provided for track call');
    data.gtmOnFailure();
    return;
  }

  payload.event = eventName;

  // Build properties
  const properties = {};

  // Add revenue if present
  if (data.revenue) {
    properties.revenue = data.revenue;
  }
  if (data.currency) {
    properties.currency = data.currency;
  }

  // Add custom properties from template
  if (data.eventProperties && getType(data.eventProperties) === 'array') {
    for (let i = 0; i < data.eventProperties.length; i++) {
      const prop = data.eventProperties[i];
      if (prop.key && prop.value) {
        properties[prop.key] = prop.value;
      }
    }
  }

  payload.properties = properties;

  return sendToSpectacle('/t', payload);
}

function handleGroup() {
  const payload = buildBasePayload('group');

  const groupId = data.groupId || getEventData('group_id');
  if (!groupId) {
    logToConsole('Spectacle: No group ID provided for group call');
    data.gtmOnFailure();
    return;
  }

  payload.groupId = makeString(groupId);

  // Build traits
  const traits = {};

  if (data.groupTraits && getType(data.groupTraits) === 'array') {
    for (let i = 0; i < data.groupTraits.length; i++) {
      const trait = data.groupTraits[i];
      if (trait.key && trait.value) {
        traits[trait.key] = trait.value;
      }
    }
  }

  payload.traits = traits;

  return sendToSpectacle('/g', payload);
}

function sendToSpectacle(endpoint, payload) {
  const url = data.baseUrl + endpoint;
  const options = {
    headers: {
      'Content-Type': 'text/plain',
      'User-Agent': payload.context.userAgent
    },
    method: 'POST',
    timeout: 5000
  };

  log({
    Name: 'SpectacleServerTag',
    Type: 'Request',
    EventName: makeString(payload.type),
    RequestMethod: 'POST',
    RequestUrl: url,
    RequestBody: JSON.parse(JSON.stringify(payload))
  });
  // Note: Server-side doesn't need no-cors mode
  sendHttpRequest(url, options, JSON.stringify(payload))
    .then((result) => {
      log({
        Name: 'SpectacleServerTag',
        Type: 'Response',
        EventName: makeString(payload.type),
        ResponseStatusCode: result.statusCode,
        ResponseHeaders: result.headers,
        ResponseBody: JSON.parse(JSON.stringify(result.body))
      });

      if (result.statusCode >= 200 && result.statusCode < 300) {
        data.gtmOnSuccess();
      } else {
        logToConsole('Spectacle: Error response', result.statusCode, result.body);
        data.gtmOnFailure();
      }
    })
    .catch((error) => {
      logToConsole('Spectacle: Request failed', error);
      log({
        Name: 'SpectacleServerTag',
        Type: 'Response',
        EventName: makeString(payload.type),
        Message: 'Spectacle Request failed.',
        Reason: JSON.stringify(error)
      });
      data.gtmOnFailure();
    });
}

/*==============================================================================
  Helpers
==============================================================================*/

function generateAnonymousId() {
  // Generate segments for UUID format
  const seg1 = generateRandom(10000000, 99999999);
  const seg2 = generateRandom(1000, 9999);
  const seg3 = generateRandom(1000, 9999);
  const seg4 = generateRandom(1000, 9999);
  const seg5 = generateRandom(100000000000, 999999999999);

  return seg1 + '-' + seg2 + '-' + seg3 + '-' + seg4 + '-' + seg5;
}

function getOrCreateAnonymousId() {
  // Try to get existing anonymous ID from cookies
  let anonymousId;

  const anonCookieValues = getCookieValues(ANON_COOKIE_KEY);
  if (anonCookieValues && anonCookieValues.length > 0) {
    anonymousId = anonCookieValues[0];
    if (data.logType === 'debug' || data.logType === 'always') {
      logToConsole('Spectacle: Found existing anonymous ID:', anonymousId);
    }
  }

  // Generate new ID if none exists
  if (!anonymousId) {
    anonymousId = generateAnonymousId();
    if (data.logType === 'debug' || data.logType === 'always') {
      logToConsole('Spectacle: Generated new anonymous ID:', anonymousId);
    }
  }

  // Set/refresh the cookie
  setCookie(ANON_COOKIE_KEY, anonymousId, {
    domain: getCookieDomain(data.cookieDomain),
    path: '/',
    'max-age': COOKIE_EXPIRY_DAYS * 24 * 60 * 60,
    secure: true,
    sameSite: 'lax'
  });

  return anonymousId;
}

function getStoredUserId() {
  const userCookieValues = getCookieValues(USER_COOKIE_KEY);
  if (userCookieValues && userCookieValues.length > 0) {
    return userCookieValues[0];
  }
  return null;
}

function storeUserId(userId) {
  if (userId) {
    setCookie(USER_COOKIE_KEY, makeString(userId), {
      domain: getCookieDomain(data.cookieDomain),
      path: '/',
      'max-age': COOKIE_EXPIRY_DAYS * 24 * 60 * 60,
      secure: true,
      sameSite: 'lax'
    });
  }
}

function getCookieDomain(cookieDomain) {
  if (cookieDomain) {
    if (cookieDomain[0] !== '.') {
      cookieDomain = '.' + cookieDomain;
    }
    logToConsole('Spectacle: final cookie domain:', cookieDomain);
    return cookieDomain;
  }

  return 'auto';
}

function extractCampaign(url) {
  const campaign = {};

  if (!url) return campaign;

  const parsedUrl = parseUrl(url);
  if (!parsedUrl || !parsedUrl.searchParams) return campaign;

  // Check each UTM parameter directly
  if (parsedUrl.searchParams.utm_source) {
    campaign.source = parsedUrl.searchParams.utm_source;
  }
  if (parsedUrl.searchParams.utm_medium) {
    campaign.medium = parsedUrl.searchParams.utm_medium;
  }
  if (parsedUrl.searchParams.utm_campaign) {
    campaign.name = parsedUrl.searchParams.utm_campaign; // Note: maps to 'name'
  }
  if (parsedUrl.searchParams.utm_term) {
    campaign.term = parsedUrl.searchParams.utm_term;
  }
  if (parsedUrl.searchParams.utm_content) {
    campaign.content = parsedUrl.searchParams.utm_content;
  }

  return campaign;
}

function buildPageContext() {
  const pageLocation = getEventData('page_location') || '';
  const pageReferrer = getEventData('page_referrer') || '';
  const pageTitle = getEventData('page_title') || '';

  const parsedUrl = parseUrl(pageLocation);

  return {
    path: parsedUrl ? parsedUrl.pathname : '',
    referrer: pageReferrer,
    search: parsedUrl ? parsedUrl.search : '',
    title: pageTitle,
    url: pageLocation
  };
}

function isConsentGivenOrNotRequired(data, eventData) {
  if (data.adStorageConsent !== 'required') return true;
  if (eventData.consent_state) return !!eventData.consent_state.ad_storage;
  const xGaGcs = eventData['x-ga-gcs'] || ''; // x-ga-gcs is a string like "G110"
  return xGaGcs[2] === '1';
}

function logConsole(dataToLog) {
  logToConsole(JSON.stringify(dataToLog));
}

function log(rawDataToLog) {
  const logDestinationsHandlers = {};
  if (determinateIsLoggingEnabled()) logDestinationsHandlers.console = logConsole;
  if (determinateIsLoggingEnabledForBigQuery()) logDestinationsHandlers.bigQuery = logToBigQuery;

  rawDataToLog.TraceId = getRequestHeader('trace-id');

  const keyMappings = {
    // No transformation for Console is needed.
    bigQuery: {
      Name: 'tag_name',
      Type: 'type',
      TraceId: 'trace_id',
      EventName: 'event_name',
      RequestMethod: 'request_method',
      RequestUrl: 'request_url',
      RequestBody: 'request_body',
      ResponseStatusCode: 'response_status_code',
      ResponseHeaders: 'response_headers',
      ResponseBody: 'response_body'
    }
  };

  for (const logDestination in logDestinationsHandlers) {
    const handler = logDestinationsHandlers[logDestination];
    if (!handler) continue;

    const mapping = keyMappings[logDestination];
    const dataToLog = mapping ? {} : rawDataToLog;

    if (mapping) {
      for (const key in rawDataToLog) {
        const mappedKey = mapping[key] || key;
        dataToLog[mappedKey] = rawDataToLog[key];
      }
    }

    handler(dataToLog);
  }
}

function logToBigQuery(dataToLog) {
  const connectionInfo = {
    projectId: data.logBigQueryProjectId,
    datasetId: data.logBigQueryDatasetId,
    tableId: data.logBigQueryTableId
  };

  dataToLog.timestamp = getTimestampMillis();

  ['request_body', 'response_headers', 'response_body'].forEach((p) => {
    dataToLog[p] = JSON.stringify(dataToLog[p]);
  });

  BigQuery.insert(connectionInfo, [dataToLog], { ignoreUnknownValues: true });
}

function determinateIsLoggingEnabled() {
  const containerVersion = getContainerVersion();
  const isDebug = !!(
    containerVersion &&
    (containerVersion.debugMode || containerVersion.previewMode)
  );

  if (!data.logType) {
    return isDebug;
  }

  if (data.logType === 'no') {
    return false;
  }

  if (data.logType === 'debug') {
    return isDebug;
  }

  return data.logType === 'always';
}

function determinateIsLoggingEnabledForBigQuery() {
  if (data.bigQueryLogType === 'no') return false;
  return data.bigQueryLogType === 'always';
}
