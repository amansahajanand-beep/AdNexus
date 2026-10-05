/**
 * Call an existing Express router in-process, as the signed-in user.
 *
 * The analysis needs the same numbers a page shows. Re-using the real endpoints keeps every
 * permission rule, date restriction, visibility flag and cache exactly as the user sees them,
 * with none of the cost of a network hop. The caller's Authorization header is forwarded, so the
 * router's own auth middleware runs and the user can never see more here than on the page.
 */
const { EventEmitter } = require('events');

const DEFAULT_TIMEOUT_MS = 25_000;

function makeRes(resolve) {
  const res = new EventEmitter();
  const headers = {};
  let done = false;
  res.statusCode = 200;
  res.locals = {};
  res.headersSent = false;
  const finish = (body) => {
    if (done) return res;
    done = true;
    res.headersSent = true;
    resolve({ status: res.statusCode, body, headers });
    res.emit('finish');
    return res;
  };
  res.status = (code) => { res.statusCode = code; return res; };
  res.set = (k, v) => {
    if (k && typeof k === 'object') Object.entries(k).forEach(([a, b]) => { headers[a.toLowerCase()] = b; });
    else headers[String(k).toLowerCase()] = v;
    return res;
  };
  res.header = res.set;
  res.setHeader = res.set;
  res.append = res.set;
  res.type = () => res;
  res.getHeader = (k) => headers[String(k).toLowerCase()];
  res.removeHeader = (k) => { delete headers[String(k).toLowerCase()]; };
  res.json = (body) => finish(body);
  res.send = (body) => finish(body);
  res.end = (body) => finish(body);
  res.sendStatus = (code) => { res.statusCode = code; return finish(null); };
  return res;
}

/**
 * @param {import('express').Router} router
 * @param {object} opts
 * @param {string} opts.path          Path inside the router, e.g. "/overview".
 * @param {object} [opts.query]       Query params (arrays are joined with commas).
 * @param {string} opts.authorization The caller's Authorization header value.
 * @param {string} [opts.method]
 * @param {object} [opts.body]
 * @param {object} [opts.headers]       Extra request headers, e.g. x-gam-client-id to pin a network.
 * @returns {Promise<{status: number, body: any}>}
 */
function callRouter(router, {
  path, query = {}, authorization, method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, headers: extraHeaders = {},
  keepArrays = [],
}) {
  return new Promise((resolve, reject) => {
    const q = {};
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === '') continue;
      // Lists are joined with commas, except the ones the endpoint reads as repeated parameters (see keepArrays).
      q[k] = Array.isArray(v) ? (keepArrays.includes(k) ? v.map(String) : v.join(',')) : String(v);
    }
    const qs = new URLSearchParams(Object.entries(q).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))).toString();
    const headers = { authorization: authorization || '', 'user-agent': 'adnexus-ai-internal', ...extraHeaders };
    const req = {
      method,
      url: `${path}${qs ? `?${qs}` : ''}`,
      originalUrl: `${path}${qs ? `?${qs}` : ''}`,
      baseUrl: '',
      path,
      query: q,
      params: {},
      body: body || {},
      headers,
      ip: '127.0.0.1',
      connection: { remoteAddress: '127.0.0.1' },
      get(name) { return headers[String(name).toLowerCase()]; },
      header(name) { return headers[String(name).toLowerCase()]; },
    };
    const timer = setTimeout(() => reject(new Error(`internal call timed out: ${path}`)), timeoutMs);
    const res = makeRes((out) => { clearTimeout(timer); resolve(out); });
    res.req = req;
    req.res = res;
    router.handle(req, res, (err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ status: 404, body: { error: 'Not found' } });
    });
  });
}

module.exports = { callRouter };
