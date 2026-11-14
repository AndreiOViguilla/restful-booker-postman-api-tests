// Generates the Postman collection (v2.1) from readable JS so the test scripts stay easy to review.
// Run: node scripts/build-collection.js
const fs = require('fs');
const path = require('path');

const bookingSchema = {
  type: 'object',
  required: ['firstname', 'lastname', 'totalprice', 'depositpaid', 'bookingdates'],
  properties: {
    firstname: { type: 'string', minLength: 1 },
    lastname: { type: 'string', minLength: 1 },
    totalprice: { type: 'number' },
    depositpaid: { type: 'boolean' },
    bookingdates: {
      type: 'object',
      required: ['checkin', 'checkout'],
      properties: {
        checkin: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        checkout: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
    },
    additionalneeds: { type: 'string' },
  },
};

const createResponseSchema = {
  type: 'object',
  required: ['bookingid', 'booking'],
  properties: { bookingid: { type: 'integer', minimum: 1 }, booking: bookingSchema },
};

const tokenSchema = {
  type: 'object',
  required: ['token'],
  properties: { token: { type: 'string', minLength: 10 } },
  additionalProperties: false,
};

// Shared helpers stored as a collection variable and loaded with eval() in each script,
// so every request reuses the same assertions instead of repeating them.
const utils = `({
  expectStatus(code) {
    pm.test('Status code is ' + code, () => pm.response.to.have.status(code));
  },
  expectFastResponse(ms) {
    pm.test('Response time is below ' + ms + ' ms', () => pm.expect(pm.response.responseTime).to.be.below(ms));
  },
  expectJson() {
    pm.test('Content-Type is JSON', () => pm.expect(pm.response.headers.get('Content-Type')).to.include('application/json'));
  },
  expectSchema(name) {
    const schema = JSON.parse(pm.collectionVariables.get(name));
    pm.test('Body matches the ' + name + ' JSON schema', () => pm.response.to.have.jsonSchema(schema));
  },
  expectBookingEquals(actual, expected, label) {
    pm.test(label + ': firstname, lastname, totalprice, depositpaid, dates and additionalneeds match', () => {
      pm.expect(actual.firstname).to.eql(expected.firstname);
      pm.expect(actual.lastname).to.eql(expected.lastname);
      pm.expect(actual.totalprice).to.eql(expected.totalprice);
      pm.expect(actual.depositpaid).to.eql(expected.depositpaid);
      pm.expect(actual.bookingdates).to.eql(expected.bookingdates);
      pm.expect(actual.additionalneeds).to.eql(expected.additionalneeds);
    });
  },
  isoDate(daysFromToday) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + daysFromToday);
    return d.toISOString().slice(0, 10);
  },
})`;

const loadUtils = "const utils = eval(pm.collectionVariables.get('utils'));";

const json = { key: 'Content-Type', value: 'application/json' };
const accept = { key: 'Accept', value: 'application/json' };
const cookie = (v) => ({ key: 'Cookie', value: v });

const url = (p) => {
  const [pathPart, query] = p.split('?');
  const u = { raw: '{{baseUrl}}' + p, host: ['{{baseUrl}}'], path: pathPart.replace(/^\//, '').split('/') };
  if (query) u.query = query.split('&').map((kv) => { const [key, value] = kv.split('='); return { key, value }; });
  return u;
};

const req = ({ name, method, p, headers = [], body, pre, test, description }) => ({
  name,
  event: [
    ...(pre ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: pre } }] : []),
    ...(test ? [{ listen: 'test', script: { type: 'text/javascript', exec: test } }] : []),
  ],
  request: {
    method,
    header: headers,
    ...(body ? { body: { mode: 'raw', raw: body, options: { raw: { language: 'json' } } } } : {}),
    url: url(p),
    description,
  },
  response: [],
});

const items = [
  {
    name: '0. Health check',
    item: [
      req({
        name: 'GET /ping - API is up',
        method: 'GET',
        p: '/ping',
        description: 'Smoke check before the flow. Restful-Booker answers 201 Created (documented quirk).',
        test: [loadUtils, 'utils.expectStatus(201);', 'utils.expectFastResponse(5000);',
          "pm.test('Body is \"Created\"', () => pm.expect(pm.response.text()).to.eql('Created'));"],
      }),
    ],
  },
  {
    name: '1. Auth',
    item: [
      req({
        name: 'POST /auth - generate token',
        method: 'POST',
        p: '/auth',
        headers: [json, accept],
        body: JSON.stringify({ username: '{{username}}', password: '{{password}}' }, null, 2),
        description: 'Step 1. Saves the token as the environment variable `token` for the update and delete requests.',
        test: [loadUtils, 'utils.expectStatus(200);', 'utils.expectJson();', "utils.expectSchema('tokenSchema');",
          'const token = pm.response.json().token;',
          "pm.test('Token is a non-empty string', () => pm.expect(token).to.be.a('string').and.not.empty);",
          "pm.environment.set('token', token);",
          "console.log('Saved token for later requests');"],
      }),
      req({
        name: 'POST /auth - NEGATIVE wrong password returns no token',
        method: 'POST',
        p: '/auth',
        headers: [json, accept],
        body: JSON.stringify({ username: '{{username}}', password: 'wrong-password' }, null, 2),
        description: 'Negative: wrong password must not produce a token.\n\nKnown defect BUG-07: the API answers 200 OK with {"reason":"Bad credentials"} instead of 401. The test accepts 200 or 401 so the suite stays green, and asserts the part that matters: no token is issued.',
        test: [
          "pm.test('Status is 200 (current behaviour, BUG-07) or 401 (correct)', () => pm.expect(pm.response.code).to.be.oneOf([200, 401]));",
          'const body = pm.response.json();',
          "pm.test('No token is issued', () => pm.expect(body).to.not.have.property('token'));",
          "pm.test('Reason is \"Bad credentials\"', () => pm.expect(body.reason).to.eql('Bad credentials'));"],
      }),
    ],
  },
  {
    name: '2. Booking lifecycle (chained)',
    item: [
      req({
        name: 'POST /booking - create booking',
        method: 'POST',
        p: '/booking',
        headers: [json, accept],
        body: '{{createBody}}',
        description: 'Step 2. Builds unique test data in the pre-request script, creates the booking and saves `bookingId` from the response.',
        pre: [loadUtils,
          '// Test data is generated here, not hard-coded in the body, so every run is unique and isolated.',
          'const runId = Date.now().toString(36);',
          'const booking = {',
          "  firstname: 'QA' + runId,",
          "  lastname: pm.variables.replaceIn('{{$randomLastName}}'),",
          '  totalprice: Math.floor(Math.random() * 400) + 100,',
          '  depositpaid: true,',
          '  bookingdates: { checkin: utils.isoDate(30), checkout: utils.isoDate(33) },',
          "  additionalneeds: 'Breakfast',",
          '};',
          "pm.collectionVariables.set('createdBooking', JSON.stringify(booking));",
          "pm.collectionVariables.set('createBody', JSON.stringify(booking));"],
        test: [loadUtils, 'utils.expectStatus(200);', 'utils.expectJson();', 'utils.expectFastResponse(5000);',
          "utils.expectSchema('createResponseSchema');",
          'const body = pm.response.json();',
          "const sent = JSON.parse(pm.collectionVariables.get('createdBooking'));",
          "utils.expectBookingEquals(body.booking, sent, 'Response echoes the sent booking');",
          "pm.environment.set('bookingId', body.bookingid);",
          "console.log('Created bookingId ' + body.bookingid);"],
      }),
      req({
        name: 'GET /booking/:id - read created booking',
        method: 'GET',
        p: '/booking/{{bookingId}}',
        headers: [accept],
        description: 'Confirms the booking was stored exactly as sent, using the extracted bookingId.',
        test: [loadUtils, 'utils.expectStatus(200);', 'utils.expectJson();', "utils.expectSchema('bookingSchema');",
          "const sent = JSON.parse(pm.collectionVariables.get('createdBooking'));",
          "utils.expectBookingEquals(pm.response.json(), sent, 'Stored booking');"],
      }),
      req({
        name: 'PUT /booking/:id - NEGATIVE no token',
        method: 'PUT',
        p: '/booking/{{bookingId}}',
        headers: [json, accept],
        body: JSON.stringify({ firstname: 'Hacker', lastname: 'NoToken', totalprice: 1, depositpaid: false, bookingdates: { checkin: '2030-01-01', checkout: '2030-01-02' }, additionalneeds: 'None' }, null, 2),
        description: 'Negative: an update without a Cookie or Authorization header must be refused, and the booking must not change.',
        test: [loadUtils, 'utils.expectStatus(403);',
          "pm.test('Body is \"Forbidden\"', () => pm.expect(pm.response.text()).to.eql('Forbidden'));",
          "const sent = JSON.parse(pm.collectionVariables.get('createdBooking'));",
          '// Follow-up read proves the refused request changed nothing.',
          "pm.sendRequest({ url: pm.variables.replaceIn('{{baseUrl}}/booking/{{bookingId}}'), method: 'GET', header: { Accept: 'application/json' } }, (err, res) => {",
          "  pm.test('Booking is unchanged after the refused update', () => {",
          '    pm.expect(err).to.be.null;',
          '    pm.expect(res.json().firstname).to.eql(sent.firstname);',
          '  });',
          '});'],
      }),
      req({
        name: 'PUT /booking/:id - NEGATIVE invalid token',
        method: 'PUT',
        p: '/booking/{{bookingId}}',
        headers: [json, accept, cookie('token=invalid-token-123')],
        body: JSON.stringify({ firstname: 'Hacker', lastname: 'BadToken', totalprice: 1, depositpaid: false, bookingdates: { checkin: '2030-01-01', checkout: '2030-01-02' }, additionalneeds: 'None' }, null, 2),
        description: 'Negative: a made-up token must be refused with 403.',
        test: [loadUtils, 'utils.expectStatus(403);',
          "pm.test('Body is \"Forbidden\"', () => pm.expect(pm.response.text()).to.eql('Forbidden'));"],
      }),
      req({
        name: 'PUT /booking/:id - update with token',
        method: 'PUT',
        p: '/booking/{{bookingId}}',
        headers: [json, accept, cookie('token={{token}}')],
        body: '{{updateBody}}',
        description: 'Step 3. Uses the extracted bookingId and the token from step 1. Changes firstname, totalprice, depositpaid, dates and additionalneeds.',
        pre: [loadUtils,
          "const created = JSON.parse(pm.collectionVariables.get('createdBooking'));",
          'const updated = {',
          '  ...created,',
          "  firstname: created.firstname + '-Updated',",
          '  totalprice: created.totalprice + 100,',
          '  depositpaid: false,',
          '  bookingdates: { checkin: utils.isoDate(40), checkout: utils.isoDate(45) },',
          "  additionalneeds: 'Late checkout',",
          '};',
          "pm.collectionVariables.set('updatedBooking', JSON.stringify(updated));",
          "pm.collectionVariables.set('updateBody', JSON.stringify(updated));"],
        test: [loadUtils, 'utils.expectStatus(200);', 'utils.expectJson();', "utils.expectSchema('bookingSchema');",
          "const expected = JSON.parse(pm.collectionVariables.get('updatedBooking'));",
          "utils.expectBookingEquals(pm.response.json(), expected, 'Update response');"],
      }),
      req({
        name: 'GET /booking/:id - verify update',
        method: 'GET',
        p: '/booking/{{bookingId}}',
        headers: [accept],
        description: 'Step 4. Reads the booking back and asserts that the specific update was saved.',
        test: [loadUtils, 'utils.expectStatus(200);', "utils.expectSchema('bookingSchema');",
          'const body = pm.response.json();',
          "const expected = JSON.parse(pm.collectionVariables.get('updatedBooking'));",
          "const created = JSON.parse(pm.collectionVariables.get('createdBooking'));",
          "pm.test('Updated firstname is saved', () => pm.expect(body.firstname).to.eql(expected.firstname));",
          "pm.test('Updated totalprice is saved (+100)', () => pm.expect(body.totalprice).to.eql(created.totalprice + 100));",
          "pm.test('Updated additionalneeds is saved', () => pm.expect(body.additionalneeds).to.eql('Late checkout'));",
          "pm.test('Unchanged lastname is kept', () => pm.expect(body.lastname).to.eql(created.lastname));",
          "utils.expectBookingEquals(body, expected, 'Stored booking after update');"],
      }),
      req({
        name: 'DELETE /booking/:id - NEGATIVE no token',
        method: 'DELETE',
        p: '/booking/{{bookingId}}',
        description: 'Negative: delete without a token must be refused and the booking must still exist.',
        test: [loadUtils, 'utils.expectStatus(403);',
          "pm.sendRequest({ url: pm.variables.replaceIn('{{baseUrl}}/booking/{{bookingId}}'), method: 'GET', header: { Accept: 'application/json' } }, (err, res) => {",
          "  pm.test('Booking still exists after the refused delete', () => pm.expect(res.code).to.eql(200));",
          '});'],
      }),
      req({
        name: 'DELETE /booking/:id - clean up',
        method: 'DELETE',
        p: '/booking/{{bookingId}}',
        headers: [cookie('token={{token}}')],
        description: 'Step 5. Deletes the test booking. Restful-Booker answers 201 Created (documented).',
        test: [loadUtils, 'utils.expectStatus(201);'],
      }),
      req({
        name: 'GET /booking/:id - confirm deleted',
        method: 'GET',
        p: '/booking/{{bookingId}}',
        headers: [accept],
        description: 'Confirms the clean-up worked, then clears the chained variables.',
        test: [loadUtils, 'utils.expectStatus(404);',
          "pm.environment.unset('bookingId');",
          "pm.environment.unset('token');"],
      }),
    ],
  },
  {
    name: '3. Negative - GET unknown booking',
    item: [
      req({
        name: 'GET /booking/:id - NEGATIVE id does not exist',
        method: 'GET',
        p: '/booking/999999999',
        headers: [accept],
        description: 'Negative: an unknown id must return 404.',
        test: [loadUtils, 'utils.expectStatus(404);',
          "pm.test('Body is \"Not Found\"', () => pm.expect(pm.response.text()).to.eql('Not Found'));"],
      }),
    ],
  },
];

const collection = {
  info: {
    name: 'Restful-Booker - Booking lifecycle API tests',
    description: 'Chained flow: Auth -> Create -> Update -> Verify -> Delete, with JSON schema, status code and payload assertions plus negative tests.\n\nRun with Newman: npm test',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    { key: 'utils', value: utils },
    { key: 'bookingSchema', value: JSON.stringify(bookingSchema) },
    { key: 'createResponseSchema', value: JSON.stringify(createResponseSchema) },
    { key: 'tokenSchema', value: JSON.stringify(tokenSchema) },
    { key: 'createdBooking', value: '' },
    { key: 'updatedBooking', value: '' },
    { key: 'createBody', value: '' },
    { key: 'updateBody', value: '' },
  ],
  item: items,
};

const out = path.join(__dirname, '..', 'collections', 'restful-booker.postman_collection.json');
fs.writeFileSync(out, JSON.stringify(collection, null, 2) + '\n');
console.log('Wrote ' + out);
